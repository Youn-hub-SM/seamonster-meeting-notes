import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getFeatureModel } from "@/app/lib/ai-model";
import { getKv, setKv } from "@/app/lib/b2b-settings";
import { computeWeeklyStats, maxOrderDate, type WeeklyStats } from "@/app/lib/sales-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// 주간 매출 AI 브리핑 — 표(숫자)를 읽어주는 것이 아니라 '무엇이 달라졌고 어디를 볼지'를 써 준다.
//  토큰 비용 원칙(대표 민감): 자동 호출 없음. 버튼을 눌렀을 때만 생성하고, 주 단위로 KV 에
//  캐시해 같은 주를 다시 열면 저장본을 보여준다. '다시 분석'만 재호출.
const cacheKey = (weekStart: string) => `weekly_ai_brief_${weekStart}`;

type CachedBrief = { text: string; model: string; created_at: string; week_start: string; week_end: string };

// 주 앵커 — 미리보기 라우트와 동일 규칙(가장 최근 완료된 주)
async function anchorBase(base: string | null): Promise<string | null> {
  if (base && /^\d{4}-\d{2}-\d{2}$/.test(base)) return base;
  const max = await maxOrderDate();
  if (!max) return null;
  const d = new Date(`${max}T00:00:00`);
  d.setDate(d.getDate() - d.getDay());
  return d.toISOString().slice(0, 10);
}

function buildPrompt(s: WeeklyStats, daily: { d: string; revenue: number }[]): { system: string; user: string } {
  const system = `당신은 씨몬스터(냉동 수산물 이커머스·도매) 대표를 위한 주간 매출 브리핑 작성자입니다.
대표는 표를 이미 화면에서 봅니다 — 숫자를 나열해 읽어주지 말고, 숫자들이 말하는 '변화와 볼 지점'을 짚으세요.

규칙:
- 한국어 존댓말, 400~700자. 소제목 없이 문단 2~3개 + 필요하면 짧은 불릿.
- 제공된 데이터에만 근거할 것. 원인 단정 금지 — 데이터로 알 수 없는 원인은 "확인해볼 점"으로 제안만.
- 금액은 만원/억 단위로 읽기 좋게 반올림해 쓰되 왜곡하지 말 것.
- 반드시 다룰 것: (1) 주간 총매출과 전주 대비 방향·폭, (2) 증감을 이끈 채널(도매=B2B 는 별도 언급),
  (3) 상위 품목에서 눈에 띄는 점, (4) 다음 주에 확인하거나 조치할 포인트 1~2개.
- 데이터 특성: 도매 매출은 발주일 기준·발송완료 시 반영이라 소급될 수 있음. 소매는 정산 데이터 적재 기준.
- 과장·미사여구·인사말 금지. 바로 본론.`;

  const chs = s.channels.map((c) => `${c.name}: 이번주 ${c.week}원, 전주 ${c.prev_week}원`).join("\n");
  const top = s.top10.map((t) => `${t.rank}위 ${t.code}: ${t.revenue}원`).join("\n");
  const days = daily.map((x) => `${x.d}: ${x.revenue}원`).join("\n");
  const user = `[기간] ${s.week_start} ~ ${s.week_end} (월~일)
[주간 총매출] ${s.week_sales}원 (전주 ${s.prev_week_sales}원)
[주문] ${s.order_count}건, 객단가 ${s.aov}원, 최고 주문 ${s.max_order}원, 최저 ${s.min_order}원
[고객] 신규 ${s.new_cust}명(${s.new_ratio.toFixed(1)}%), 재구매 ${s.repeat_cust}명(${s.repeat_ratio.toFixed(1)}%) — 소매 기준
[채널별]
${chs}
[상위 품목(품목코드)]
${top}
[일별 매출]
${days}`;
  return { system, user };
}

// GET ?base= — 그 주의 저장된 브리핑(있으면). 없으면 { brief: null }.
export async function GET(req: NextRequest) {
  try {
    const base = await anchorBase(req.nextUrl.searchParams.get("base"));
    if (!base) return NextResponse.json({ ok: true, brief: null });
    const s = await computeWeeklyStats(base);
    const raw = await getKv(cacheKey(s.week_start));
    const brief = raw ? (JSON.parse(raw) as CachedBrief) : null;
    return NextResponse.json({ ok: true, brief });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "브리핑 조회 실패") }, { status: 500 });
  }
}

// POST { base?, force? } — 브리핑 생성(캐시 있고 force 아니면 저장본 반환).
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json().catch(() => ({}))) as { base?: string; force?: boolean };
    const base = await anchorBase(b.base || null);
    if (!base) return NextResponse.json({ ok: false, error: "매출 데이터가 없습니다." }, { status: 400 });

    const s = await computeWeeklyStats(base);
    const key = cacheKey(s.week_start);
    if (!b.force) {
      const raw = await getKv(key);
      if (raw) return NextResponse.json({ ok: true, brief: JSON.parse(raw) as CachedBrief, cached: true });
    }
    if (s.week_sales === 0 && s.prev_week_sales === 0) {
      return NextResponse.json({ ok: false, error: "이 주에는 매출 데이터가 없어 브리핑을 만들 수 없습니다." }, { status: 400 });
    }

    // 일별 매출 — 요일 흐름까지 브리핑 재료로
    const { data: dailyRows } = await supabaseAdmin().rpc("sales_daily_breakdown", { p_from: s.week_start, p_to: s.week_end });
    const daily = ((dailyRows ?? []) as { d?: string; day?: string; revenue?: number }[]).map((r) => ({
      d: String(r.d ?? r.day ?? ""), revenue: Number(r.revenue) || 0,
    })).filter((r) => r.d);

    const model = await getFeatureModel("sales");
    const { system, user } = buildPrompt(s, daily);
    const res = await anthropic.messages.create({
      model, max_tokens: 1200, system,
      messages: [{ role: "user", content: user }],
    });
    const text = res.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n").trim();
    if (!text) throw new Error("AI 응답이 비었습니다.");

    const brief: CachedBrief = {
      text, model, created_at: new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " "),
      week_start: s.week_start, week_end: s.week_end,
    };
    await setKv(key, JSON.stringify(brief));
    return NextResponse.json({ ok: true, brief, cached: false });
  } catch (err) {
    console.error("[sales/weekly-brief]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "브리핑 생성 실패") }, { status: 500 });
  }
}
