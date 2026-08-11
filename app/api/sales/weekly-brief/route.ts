import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { getFeatureModel } from "@/app/lib/ai-model";
import { getKv, setKv } from "@/app/lib/b2b-settings";
import { computeWeeklyStats, maxOrderDate, type WeeklyStats } from "@/app/lib/sales-report";
import { getInventoryRows } from "@/app/lib/production-inventory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// 주간 매출 AI 브리핑 — 주간회의의 매출 분석을 대체하는 용도(대표 요청).
//  표를 읽어주는 요약이 아니라, 증감 분해·맥락(4주/전년)·품목 순위 변동·재고 리스크·B2B 까지
//  회의에서 짚을 재료를 모두 프롬프트에 담아 '논의 안건'이 되는 글을 받는다.
//  토큰 비용 원칙: 자동 호출 없음, 버튼 클릭 시 1회, 주 단위 KV 캐시.
const cacheKey = (weekStart: string) => `weekly_ai_brief_${weekStart}`;

type CachedBrief = { text: string; model: string; created_at: string; week_start: string; week_end: string };

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// 주 앵커 — 미리보기 라우트와 동일 규칙(가장 최근 완료된 주)
async function anchorBase(base: string | null): Promise<string | null> {
  if (base && /^\d{4}-\d{2}-\d{2}$/.test(base)) return base;
  const max = await maxOrderDate();
  if (!max) return null;
  const d = new Date(`${max}T00:00:00`);
  d.setDate(d.getDate() - d.getDay());
  return d.toISOString().slice(0, 10);
}

type Num = number;
const n = (v: unknown): Num => Number(v) || 0;

// 회의용 재료 일괄 수집 — computeWeeklyStats(이번주·전주 기본)에 더해
//  전주 상세(TOP·고객), 4주 추이, 전년 동기, 일별(이번주·전주), 원가 참고, 재고 커버, B2B 발주.
async function collectMeetingData(s: WeeklyStats) {
  const sb = supabaseAdmin();
  const ws = s.week_start, we = s.week_end;
  const pStart = addDays(ws, -7), pEnd = addDays(ws, -1);
  const w3Start = addDays(ws, -21);
  const yoyStart = addDays(ws, -364), yoyEnd = addDays(we, -364); // 364일 = 52주 — 같은 요일 정렬

  const [prevTop, prevNR, w2, w3, yoy, daily, prevDaily, profit, inv, b2bRes] = await Promise.all([
    sb.rpc("sales_top_sku", { p_from: pStart, p_to: pEnd, p_limit: 10 }),
    sb.rpc("sales_new_repeat", { p_from: pStart, p_to: pEnd }),
    sb.rpc("sales_summary", { p_from: addDays(ws, -14), p_to: addDays(ws, -8) }),
    sb.rpc("sales_summary", { p_from: w3Start, p_to: addDays(ws, -15) }),
    sb.rpc("sales_summary", { p_from: yoyStart, p_to: yoyEnd }),
    sb.rpc("sales_daily_breakdown", { p_from: ws, p_to: we }),
    sb.rpc("sales_daily_breakdown", { p_from: pStart, p_to: pEnd }),
    sb.rpc("sales_profit_summary", { p_from: ws, p_to: we }),
    getInventoryRows().catch(() => null),
    sb.from("orders")
      .select("total, status, companies:company_id(name)")
      .gte("order_date", ws).lte("order_date", we).neq("status", "취소"),
  ]);

  // 품목 순위 변동 — 전주 순위와 대조(신규 진입·이탈 포함)
  const prevRank = new Map(((prevTop.data ?? []) as { sku_code?: unknown }[]).map((r, i) => [String(r.sku_code), i + 1]));
  const topMoves = s.top10.slice(0, 5).map((t) => {
    const p = prevRank.get(t.code);
    return `${t.rank}위 ${t.code} ${Math.round(t.revenue)}원 (전주 ${p ? `${p}위` : "순위권 밖"})`;
  });

  // 재고 커버 — 상위 품목이 지금 재고로 며칠 버티는지(일평균 출고 기준)
  const invMap = new Map((inv?.rows ?? []).map((r) => [r.sku.toUpperCase(), r]));
  const coverage = s.top10.slice(0, 5).map((t) => {
    const r = invMap.get(t.code.toUpperCase());
    if (!r || r.stock == null) return `${t.code}: 재고 정보 없음`;
    const days = r.dailyOut > 0 ? Math.round(r.stock / r.dailyOut) : null;
    return `${t.code}: 현재고 ${r.stock}, 일평균 출고 ${r.dailyOut.toFixed(1)}${days != null ? `, 약 ${days}일치` : ""}`;
  });

  // 원가 참고 — 원가 미입력이면 통째로 생략(회의에서 틀린 이익 숫자가 도는 것이 없느니만 못하다)
  type ProfitRow = { channel?: unknown; pay_amount?: unknown; product_cost?: unknown; cooling?: unknown; fee_rate?: unknown };
  const profitRows = ((profit.data ?? []) as ProfitRow[]).map((r) => ({
    channel: String(r.channel ?? ""), pay: n(r.pay_amount), cost: n(r.product_cost), cooling: n(r.cooling), fee: n(r.fee_rate),
  }));
  const totalPay = profitRows.reduce((a, r) => a + r.pay, 0);
  const totalCost = profitRows.reduce((a, r) => a + r.cost, 0);
  const costUsable = totalPay > 0 && totalCost > totalPay * 0.05; // 원가가 매출의 5%도 안 되면 미입력으로 간주
  const profitLines = costUsable
    ? profitRows.filter((r) => r.pay > 0).map((r) =>
        `${r.channel}: 매출 ${r.pay}원, 상품원가 ${r.cost}원, 보냉·박스 ${r.cooling}원, 수수료율 ${(r.fee * 100).toFixed(1)}%`)
    : [];

  // B2B 주간 신규 발주(발주일 기준·취소 제외) — 원장의 '도매'(발송완료분)와 다른 축이므로 병기용
  type OrderRow = { total?: unknown; companies?: { name?: string } | { name?: string }[] | null };
  const b2bRows = ((b2bRes.data ?? []) as OrderRow[]);
  const b2bTotal = b2bRows.reduce((a, r) => a + n(r.total), 0);
  const byCompany = new Map<string, number>();
  for (const r of b2bRows) {
    const c = Array.isArray(r.companies) ? r.companies[0] : r.companies;
    const name = c?.name || "(미지정)";
    byCompany.set(name, (byCompany.get(name) || 0) + n(r.total));
  }
  const b2bTop = [...byCompany.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([name, v]) => `${name} ${v}원`);

  const dailyStr = (rows: unknown) => ((rows ?? []) as { d?: unknown; revenue?: unknown }[])
    .map((r) => `${String(r.d).slice(5)}: ${n(r.revenue)}원`).join(", ");
  const nrP = ((prevNR.data ?? []) as Record<string, unknown>[])[0] || {};

  return {
    topMoves, coverage, profitLines, costUsable,
    fourWeeks: [
      `3주 전: ${n(((w3.data ?? []) as Record<string, unknown>[])[0]?.revenue)}원`,
      `2주 전: ${n(((w2.data ?? []) as Record<string, unknown>[])[0]?.revenue)}원`,
      `전주: ${s.prev_week_sales}원`,
      `이번 주: ${s.week_sales}원`,
    ],
    yoy: n(((yoy.data ?? []) as Record<string, unknown>[])[0]?.revenue),
    daily: dailyStr(daily.data), prevDailyStr: dailyStr(prevDaily.data),
    prevCust: `신규 ${n(nrP.new_cust)}명, 재구매 ${n(nrP.repeat_cust)}명`,
    b2b: { count: b2bRows.length, total: b2bTotal, top: b2bTop },
  };
}

function buildPrompt(s: WeeklyStats, m: Awaited<ReturnType<typeof collectMeetingData>>): { system: string; user: string } {
  const system = `당신은 씨몬스터(냉동 수산물 이커머스·도매) 주간회의의 매출 분석 담당자입니다.
이 글이 회의에서 매출 안건을 대체합니다 — 표 낭독이 아니라 논의할 거리를 만드세요.

구조(굵은 소제목 없이 [ ] 표기, 총 800~1300자):
[총평] 2~3문장 — 이번 주를 한 눈에.
[증감 분해] 매출 증감을 주문수 요인과 객단가 요인으로 나누고, 어느 채널이 얼마나 기여했는지. 도매(B2B)는 별도 언급.
[맥락] 4주 흐름에서 이번 주의 위치, 전년 같은 주 대비(데이터 있으면). 일별 흐름에서 특이 요일.
[품목] 상위 품목의 순위 변동(오른 것·새로 진입한 것), 상위 집중도.
[고객] 신규/재구매 비율의 전주 대비 변화 — 소매 기준.
[재고] 상위 품목의 재고 커버 일수 — 품절 위험이 있으면 명확히 경고.
[B2B] 이번 주 신규 발주(발주일 기준) 규모·주요 업체 — 원장 도매 매출(발송완료분)과 축이 다름을 한 줄로.
[다음 주 체크] 회의에서 결정하거나 확인할 일 2~3개 — 실행 가능한 문장으로.

규칙:
- 제공 데이터에만 근거. 원인 단정 금지 — 알 수 없는 원인은 "확인 필요"로.
- 금액은 만원/억 단위로 읽기 좋게(왜곡 금지). 퍼센트는 소수 1자리.
- 데이터가 없는 섹션(전년·원가 등)은 그 섹션을 통째로 생략 — "데이터 없음"을 늘어놓지 말 것.
- 과장·인사말 금지. 한국어 존댓말.`;

  const chs = s.channels.map((c) => `${c.name}: 이번주 ${c.week}원, 전주 ${c.prev_week}원`).join("\n");
  const user = `[기간] ${s.week_start} ~ ${s.week_end} (월~일)
[주간 총매출] ${s.week_sales}원 (전주 ${s.prev_week_sales}원)
[주문] 이번주 ${s.order_count}건, 객단가 ${s.aov}원 / 최고 주문 ${s.max_order}원(${s.max_codes}), 최저 ${s.min_order}원
[4주 추이] ${m.fourWeeks.join(" → ")}
[전년 같은 주] ${m.yoy > 0 ? `${m.yoy}원` : "데이터 없음"}
[채널별]
${chs}
[일별 매출(이번주)] ${m.daily || "없음"}
[일별 매출(전주)] ${m.prevDailyStr || "없음"}
[상위 품목(이번주, 전주 순위 병기)]
${m.topMoves.join("\n")}
[고객] 이번주 신규 ${s.new_cust}명(${s.new_ratio.toFixed(1)}%), 재구매 ${s.repeat_cust}명(${s.repeat_ratio.toFixed(1)}%) / 전주 ${m.prevCust}
[상위 품목 재고 커버]
${m.coverage.join("\n")}
${m.costUsable ? `[채널별 원가 참고 — 정확한 이익은 '채널별 이익' 화면 기준]\n${m.profitLines.join("\n")}` : ""}
[B2B 이번 주 신규 발주(발주일·취소 제외)] ${m.b2b.count}건, 합계 ${m.b2b.total}원${m.b2b.top.length ? ` / 상위: ${m.b2b.top.join(", ")}` : ""}`;
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

    const m = await collectMeetingData(s);
    const model = await getFeatureModel("sales");
    const { system, user } = buildPrompt(s, m);
    const res = await anthropic.messages.create({
      model, max_tokens: 2500, system,
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
