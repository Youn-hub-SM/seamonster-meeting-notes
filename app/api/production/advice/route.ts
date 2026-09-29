import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getFeatureModel, effortParams, readText } from "@/app/lib/ai-model";
import { getInventoryRows } from "@/app/lib/production-inventory";
import type { ScheduleHorizon } from "@/app/lib/production-schedule";
import { getLedgerVelocity } from "@/app/lib/production-velocity";

export const dynamic = "force-dynamic";
export const maxDuration = 120; // 최대 40개 품목 표 추론 + 생각(medium)

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// 예측 지평 = 권장 수식의 목표 일수(오늘 → 다음 요청일(수요일) 요청분 판매 가능일, production-schedule) — 고정 14일이던 것을 일정에 맞췄다.
function buildSystemPrompt(sc: ScheduleHorizon, inboundOk: boolean, wholesale = false): string {
  const H = sc.horizonDays;
  // 도매 탭: '오는중' = 이미 낸 도매 요청 중 아직 소매에서 옮겨 오지 않은 양(2026-09-29) — 제조사 생산이 아니다
  const inboundNote = wholesale
    ? (inboundOk
      ? `'오는중' = 이미 낸 도매 요청 중 아직 소매에서 옮겨 오지 않은 양입니다. 다시 요청하면 중복 요청이 되므로 권장 수량에서는 빼되, 시급도(안전재고 비교)는 현재고만으로 판단하세요(소매에 물건이 없으면 옮기지 못합니다). '창고소진일수'는 현재고만, '재고소진일수'는 현재고+오는중 기준입니다.`
      : `주의: 이번 실행은 '오는중'(이미 낸 도매 요청 잔여) 집계에 실패해 0 으로 왔습니다. 오는중을 빼지 말고, notes 에 "도매 요청 잔여 미반영 — 열린 도매 요청서를 확인하세요" 를 남기세요.`)
    : inboundOk
    ? `'오는중' = 이미 생산 요청서를 내서 생산·입고 예정인 미입고 물량입니다. 이 양은 다시 시키면 이중 발주가 되므로 반드시 재고처럼 빼고 판단하세요. '창고소진일수'는 현재고만, '재고소진일수'는 현재고+오는중 기준입니다.`
    : `주의: 이번 실행은 '오는중'(이미 시켜 둔 미입고 물량) 집계에 실패해 0 으로 왔습니다. 오는중을 빼지 말고, notes 에 "입고 예정 미반영 — 열린 생산 요청서를 확인하세요" 를 남기세요.`;
  return `당신은 씨몬스터(냉동 수산물 가공) 생산계획 어드바이저입니다.
생산담당자가 수요 예측을 잘 못해 재고 부족·과잉이 잦습니다. 데이터로 "무엇을 얼마나, 언제 만들지"를 구체적으로 짚어주세요.

생산 일정(영업일): 요청 D → 생산 시작 D+3 → 생산 마감 D+7 → 판매 가능 D+8. 요청서는 매주 수요일에 냅니다.
오늘(${sc.today}) 요청하면 ${sc.sellable}(${sc.leadDays}일 뒤)부터 팔 수 있고, 다음 요청일(${sc.nextDraft}) 요청분은 ${sc.nextSellable}(${H}일 뒤)부터 팔 수 있습니다.
참고: 안전재고 = 최근 일평균 출고 × ${sc.leadDays}일(오늘 요청분 판매 가능일까지 버틸 양). 현재고+오는중이 안전재고보다 적으면 지금 시켜도 판매 가능일 전에 바닥나는 쇼트 위험 신호입니다.
${inboundNote}

판단 근거(우선순위):
1) 현재고+오는중 < 안전재고 / 현재고 마이너스 → 즉시 보충 (재고부족 위험 최우선)
2) B2B 확정 발주(생산대기·생산중) → 반드시 생산해야 하는 물량
3) ${H}일 예측판매(판매속도×${H}일, 다음 요청분이 팔리기 시작할 때까지) → 이번 요청에 넣을 물량
권장량은 대략 (B2B수요 + ${H}일 예측판매 − 현재고 − 오는중) 기준으로, 안전재고는 시급도 판단에만 쓰고 예측판매와 합산하지 마세요. 현실적인 라운딩·우선순위로 제시.

규칙: 한국어 존댓말. 간결하고 행동가능하게. 추측·미사여구 금지. 데이터에 없는 건 지어내지 말 것.
priorities 는 정말 시급한 것부터 최대 12건만 추리세요(전 품목 나열 금지). qty 는 권장 생산 수량(정수).
순수 JSON만 반환(코드블록·설명 금지):
{"summary":"전체 상황 2~3문장","priorities":[{"sku":"","name":"","urgency":"높음|중간|낮음","qty":0,"byWhen":"즉시|이번 주|다음 주","reason":"한 줄 근거"}],"notes":["참고 한 줄"]}`;
}

interface AdviceRow {
  sku: string;
  name: string;
  stock: number | null;
  safety: number | null;
  b2bDemand: number;
  inbound: number;        // 입고 예정(열린 제조사 요청서 잔여) — 재고처럼 빼고 판단
  dailySales: number;     // 일평균 출고
  daysOfCover: number | null;
  predicted: number;      // 목표 일수(horizonDays) 예측 판매
}

export async function POST(req: Request) {
  try {
    let channel: "소매" | "도매" | undefined;
    try { const b = await req.json(); channel = b?.channel === "도매" ? "도매" : b?.channel === "소매" ? "소매" : undefined; } catch { /* body 없음 */ }
    // 재고(공유 로직) + 소진속도(자체 원장) 병렬 — 채널별
    const [inv, velocity] = await Promise.all([
      getInventoryRows(channel),
      getLedgerVelocity(undefined, channel),
    ]);

    const wholesale = channel === "도매";
    const rows: AdviceRow[] = inv.rows.map((r) => {
      const inbound = wholesale ? r.wholesaleReq : r.inbound; // 도매 = 도매 요청 잔여, 그 외 = 제조사 입고 예정
      const dailySales = velocity.perSku[r.sku] || 0;
      const predicted = Math.round(dailySales * inv.horizonDays);
      // 소진일수는 입고 예정까지 합친 재고 포지션 기준(시켜 둔 물량이 곧 들어온다)
      const daysOfCover = r.stock != null && dailySales > 0 ? Math.round((r.stock + inbound) / dailySales) : null;
      return {
        sku: r.sku,
        name: r.name,
        stock: r.stock,
        safety: r.leadSafety, // 시급도 기준(오늘 요청분 판매 가능일까지) — 목표(safety)는 예측판매와 겹친다
        b2bDemand: r.demand,
        inbound,
        dailySales: Math.round(dailySales * 10) / 10,
        daysOfCover,
        predicted,
      };
    });

    // Claude 에 보낼 행: 결정거리가 있는 것만(재고 매칭 + (권장>0 or 미달 or 판매有)), 우선순위순 상한 40
    const signal = rows
      // 시급도: 도매는 현재고만(재고 목록 도매 탭 부족 판정과 같은 기준 — 도매 요청 잔여는 옮겨야 들어온다)
      .filter((r) => r.stock != null && (r.b2bDemand > 0 || r.predicted > 0 || (r.safety != null && (wholesale ? r.stock : r.stock + r.inbound) < r.safety)))
      .sort((a, b) => {
        // 안전재고는 시급도(필터)에만 쓰고, 정렬 점수에는 예측판매만(중복 합산 방지). 입고 예정은 재고처럼 뺀다
        const na = (a.b2bDemand + a.predicted) - ((a.stock || 0) + a.inbound);
        const nb = (b.b2bDemand + b.predicted) - ((b.stock || 0) + b.inbound);
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

    const model = await getFeatureModel("production");
    const userPayload = {
      horizonDays: inv.horizonDays,
      salesWindowDays: velocity.spanDays,
      items: signal.map((r) => ({
        sku: r.sku,
        name: r.name,
        현재고: r.stock,
        오는중: r.inbound,
        안전재고: r.safety,
        B2B확정수요: r.b2bDemand,
        일평균출고: r.dailySales,
        창고소진일수: r.stock != null && r.dailySales > 0 ? Math.round(r.stock / r.dailySales) : null,
        재고소진일수: r.daysOfCover,
        [`${inv.horizonDays}일예측판매`]: r.predicted,
      })),
    };

    const response = await anthropic.messages.create({
      model,
      max_tokens: 12000, // 5.x 는 생각 토큰도 이 한도에 들어간다
      ...effortParams(model, "medium"), // 수량 산식·긴급도 순위 — 실제 생산 수량에 영향
      system: buildSystemPrompt(inv.schedule, wholesale ? inv.wholesaleReqOk : inv.inboundOk, wholesale),
      messages: [{ role: "user", content: JSON.stringify(userPayload) }],
    });
    const text = readText(response);
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
