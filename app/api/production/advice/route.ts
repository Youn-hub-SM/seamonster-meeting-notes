import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getCurrentModel } from "@/app/lib/ai-model";
import { getBoxheroToken } from "@/app/lib/boxhero";
import { getInventoryRows } from "@/app/lib/production-inventory";
import { getOrRefreshVelocity } from "@/app/lib/production-velocity";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const HORIZON_DAYS = 14; // 예측 지평(2주)

const SYSTEM_PROMPT = `당신은 씨몬스터(냉동 수산물 가공) 생산계획 어드바이저입니다.
생산담당자가 수요 예측을 잘 못해 재고 부족·과잉이 잦습니다. 데이터로 "무엇을 얼마나, 언제 만들지"를 구체적으로 짚어주세요.

판단 근거(우선순위):
1) 안전재고 미달 / 현재고 마이너스 → 즉시 보충 (재고부족 위험 최우선)
2) B2B 확정 발주(생산대기·생산중) → 반드시 생산해야 하는 물량
3) 판매속도(최근 일평균 출고) × ${HORIZON_DAYS}일 예측 수요 → 미리 만들어둘 물량
권장량은 대략 (B2B수요 + 안전재고 + ${HORIZON_DAYS}일 예측판매 − 현재고) 를 기준으로, 현실적인 라운딩과 우선순위로 제시.

규칙: 한국어 존댓말. 간결하고 행동가능하게. 추측·미사여구 금지. 데이터에 없는 건 지어내지 말 것.
priorities 는 정말 시급한 것부터 최대 12건만 추리세요(전 품목 나열 금지). qty 는 권장 생산 수량(정수).
순수 JSON만 반환(코드블록·설명 금지):
{"summary":"전체 상황 2~3문장","priorities":[{"sku":"","name":"","urgency":"높음|중간|낮음","qty":0,"byWhen":"즉시|이번 주|다음 주","reason":"한 줄 근거"}],"notes":["참고 한 줄"]}`;

interface AdviceRow {
  sku: string;
  name: string;
  stock: number | null;
  safety: number | null;
  b2bDemand: number;
  dailySales: number;     // 일평균 출고
  daysOfCover: number | null;
  predicted14: number;    // 14일 예측 판매
}

export async function POST() {
  try {
    const token = await getBoxheroToken();
    if (!token) {
      return NextResponse.json({ ok: false, error: "박스히어로가 연동되어 있지 않습니다. 설정에서 토큰을 등록하세요." }, { status: 400 });
    }

    // 재고+수요(공유 로직) + 판매속도(캐시/갱신) 병렬
    const [inv, velocity] = await Promise.all([
      getInventoryRows(token),
      getOrRefreshVelocity(token),
    ]);

    const rows: AdviceRow[] = inv.rows.map((r) => {
      const dailySales = velocity.perSku[r.sku] || 0;
      const predicted14 = Math.round(dailySales * HORIZON_DAYS);
      const daysOfCover = r.stock != null && dailySales > 0 ? Math.round(r.stock / dailySales) : null;
      return {
        sku: r.sku,
        name: r.name,
        stock: r.stock,
        safety: r.safety,
        b2bDemand: r.demand,
        dailySales: Math.round(dailySales * 10) / 10,
        daysOfCover,
        predicted14,
      };
    });

    // Claude 에 보낼 행: 결정거리가 있는 것만(재고 매칭 + (권장>0 or 미달 or 판매有)), 우선순위순 상한 40
    const signal = rows
      .filter((r) => r.stock != null && (r.b2bDemand > 0 || r.predicted14 > 0 || (r.safety != null && r.stock < r.safety)))
      .sort((a, b) => {
        const na = (a.b2bDemand + (a.safety || 0) + a.predicted14) - (a.stock || 0);
        const nb = (b.b2bDemand + (b.safety || 0) + b.predicted14) - (b.stock || 0);
        return nb - na;
      })
      .slice(0, 40);

    if (signal.length === 0) {
      return NextResponse.json({
        ok: true,
        advice: { summary: "지금 추가로 생산하거나 보충할 품목이 없습니다. 재고가 안정적입니다.", priorities: [], notes: [] },
        velocity: { computedAt: velocity.computedAt, spanDays: velocity.spanDays, txCount: velocity.txCount, capped: velocity.capped },
        rows: signal,
      });
    }

    const model = await getCurrentModel();
    const userPayload = {
      horizonDays: HORIZON_DAYS,
      salesWindowDays: velocity.spanDays,
      items: signal.map((r) => ({
        sku: r.sku,
        name: r.name,
        현재고: r.stock,
        안전재고: r.safety,
        B2B확정수요: r.b2bDemand,
        일평균출고: r.dailySales,
        재고소진일수: r.daysOfCover,
        [`${HORIZON_DAYS}일예측판매`]: r.predicted14,
      })),
    };

    const response = await anthropic.messages.create({
      model,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: JSON.stringify(userPayload) }],
    });
    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    // 코드블록 제거 후 첫 '{' ~ 마지막 '}' 만 추출 (앞뒤 잡텍스트 방어)
    const stripped = text.replace(/^```json?\s*/i, "").replace(/```\s*$/i, "").trim();
    const s = stripped.indexOf("{");
    const e = stripped.lastIndexOf("}");
    const candidate = s >= 0 && e > s ? stripped.slice(s, e + 1) : stripped;

    let advice;
    try {
      advice = JSON.parse(candidate);
    } catch {
      // 파싱 실패 시 요약만이라도 전달
      advice = { summary: stripped.slice(0, 800), priorities: [], notes: ["응답 형식 파싱 실패 — 요약만 표시합니다."] };
    }

    return NextResponse.json({
      ok: true,
      advice,
      velocity: { computedAt: velocity.computedAt, spanDays: velocity.spanDays, txCount: velocity.txCount, capped: velocity.capped },
      rows: signal,
    });
  } catch (err) {
    console.error("[production/advice]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "생산 조언 생성 실패") }, { status: 500 });
  }
}
