import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "./config";
import { supabaseAdmin } from "./supabase";

// AI 이익률 계산기 — 자연어 시나리오(상품·채널·판매가/할인)를 받아 순이익·이익률·전략을 산출.
//  고급 계산·전략 판단이라 최고급 모델(opus) 고정(전역 모델 설정과 무관 — OCR 이 sonnet 고정인 것과 같은 방식).
//  Node 런타임 전용(@anthropic-ai/sdk). 호출 라우트는 nodejs.

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export type MarginProduct = { name: string; spec: string | null; sku: string | null; cost: number; retail: number; wholesale: number; volumeKg: number | null; tax: "taxable" | "exempt" };
export type MarginChannel = { channel: string; feeRatePct: number; shipMode: string; shipFee: number; shipFreeOver: number };
export type MarginRefData = { products: MarginProduct[]; channels: MarginChannel[]; month: number };

export type MarginResultItem = {
  label: string;                 // "쿠팡 · 대구순살 1kg · 20% 할인가"
  revenue: number;               // 매출액(고객 결제가, 원)
  supplyValue: number;           // 공급가액(과세=매출/1.1, 면세=매출)
  taxNote: string;               // 과세/면세 및 부가세 처리 설명
  expenses: { label: string; amount: number; note?: string }[]; // 지출 항목별 근거
  netProfit: number;             // 순이익(원)
  marginPct: number;             // 이익률(%)
};
export type MarginResult = {
  scenario: string;              // 해석한 시나리오 한 줄
  product: string;               // 매칭한 상품(원가표 근거)
  results: MarginResultItem[];   // 보통 1개(질문이 여러 채널/가격이면 여러 개)
  strategy: string;              // 최적 판매 전략 제언(마크다운)
  assumptions: string[];         // 가정·주의(데이터 없어 추정한 부분 등)
};

// 배송(택배+아이스박스+보냉) 정책 — b2b-margin.ts 기준을 프롬프트에 그대로 제공(부가세 포함, 1박스).
const SHIP_POLICY = `[택배비(주문 부피kg 기준, 1박스)] ≤2.0kg→2,700 · ≤2.1→3,200 · ≤4.0→3,300 · >4.0→3,900
[아이스박스+운반(부피kg 기준, 1박스)] ≤1.5→720 · ≤2.0→1,210 · ≤3.0→1,700 · ≤4.0→1,820 · ≤5.0→2,180 · ≤10→2,370 · ≤12→2,790 · >12→3,390
[보냉비(계절, 1박스: 라미백+아이스팩+드라이아이스)] 동절기(12·1·2월)→1,030 · 하절기(3·4·5·6·10·11월)→1,180 · 극하절기(7·8·9월)→1,840
→ 1박스 배송원가 = 택배비 + 아이스박스 + 보냉비. 별도 언급 없으면 1박스 가정.`;

// 편집 가능한 '지침'(역할·계산 규칙·배송정책). /sales/margin-calc 의 프롬프트 설정에서 수정 → 즉시 반영.
//  배송 단가·수수료 규칙 등 정책이 바뀌면 코드 수정 없이 여기서 갱신할 수 있음.
export const DEFAULT_MARGIN_PROMPT = `당신은 씨몬스터(순살 생선 전문 이커머스)의 '이익률 계산기'입니다.
제공된 원가표·채널 정책·배송/세무 규칙을 근거로, 사용자가 질문한 시나리오(상품·채널·판매가/할인)의 정확한 순이익(원)과 이익률(%)을 계산하고, 최적의 판매 전략을 제언합니다.

[계산 규칙]
1) 매출액 = 사용자가 지정한 판매가(할인 반영, 고객 결제가). 질문에 배송비 고객부담이 명시되면 매출에 포함하고 그 사실을 명시.
2) 부가세: 과세(taxable) 상품은 공급가액 = 매출 ÷ 1.1(부가세 1/11 차감). 면세(exempt) 상품은 부가세 없음(공급가액=매출). 순살 수산물은 대개 면세이나, 반드시 원가표의 tax 값을 따를 것.
3) 채널 수수료 = 매출(고객 결제가, 부가세 포함가) × 채널 수수료율. 질문의 채널이 채널표에 없으면 합리적으로 추정하고 assumptions 에 명시.
4) 상품 원가 = 원가표의 '원가'(제품원가+포장재 합).
5) 배송원가(택배+아이스박스+보냉) = 아래 정책표(부피·계절 기준). 현재 월 기준 계절 적용.
6) 순이익 = 공급가액 − 상품원가 − 채널수수료 − 배송원가 (− 질문에 명시된 기타비용).
7) 이익률(%) = 순이익 ÷ 매출액 × 100.

${SHIP_POLICY}`;

// 고정 출력 규칙(JSON 형식) — 화면이 이 구조를 파싱하므로 사용자 지침과 분리해 항상 시스템이 덧붙임.
const OUTPUT_RULES = `[출력] 설명 문장 없이 아래 JSON만 반환:
{
 "scenario":"해석한 시나리오 한 줄",
 "product":"매칭한 상품명(원가표 근거)",
 "results":[{
   "label":"채널 · 상품 · 가격조건",
   "revenue":매출액(정수,원),
   "supplyValue":공급가액(정수,원),
   "taxNote":"과세/면세 및 부가세 처리 설명",
   "expenses":[{"label":"상품원가","amount":정수,"note":"근거"},{"label":"채널 수수료 X%","amount":정수,"note":"매출×X%"},{"label":"택배비","amount":정수},{"label":"보냉비(계절)","amount":정수}],
   "netProfit":순이익(정수,원),
   "marginPct":이익률(소수 첫째,%)
 }],
 "strategy":"최적 판매 전략 제언(마크다운, 2~5줄: 가격/채널/원가 관점)",
 "assumptions":["데이터가 없어 추정한 부분·주의사항"]
}
- 모든 금액은 원 단위 정수, 이익률은 % 소수 첫째자리.
- expenses 는 매출→순이익으로 이어지는 모든 지출을 빠짐없이 투명하게 나열(합 = 매출 지출분).
- 원가표에서 상품을 못 찾으면 가장 가까운 후보로 계산하되 assumptions 에 명시. 여러 채널/가격을 물으면 results 를 여러 개로.`;

// ── 편집 가능한 지침 저장 — b2b_settings 'margin_calc_prompt' (CS 코치 프롬프트와 동일 방식) ──
const MARGIN_PROMPT_KEY = "margin_calc_prompt";

export async function getMarginPrompt(): Promise<string> {
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb.from("b2b_settings").select("value").eq("key", MARGIN_PROMPT_KEY).maybeSingle();
    if (error || !data) return DEFAULT_MARGIN_PROMPT;
    const v = data.value as string | { text?: string } | null;
    const text = typeof v === "string" ? v : v?.text;
    return text && text.trim() ? text : DEFAULT_MARGIN_PROMPT;
  } catch {
    return DEFAULT_MARGIN_PROMPT;
  }
}

// 빈 문자열로 저장하면 설정을 지워 기본값으로 복원.
export async function setMarginPrompt(prompt: string): Promise<void> {
  const sb = supabaseAdmin();
  if (!prompt || !prompt.trim()) {
    const { error } = await sb.from("b2b_settings").delete().eq("key", MARGIN_PROMPT_KEY);
    if (error) throw error;
    return;
  }
  const { error } = await sb
    .from("b2b_settings")
    .upsert({ key: MARGIN_PROMPT_KEY, value: prompt, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw error;
}

function dataBlock(ref: MarginRefData): string {
  const season = ref.month === 12 || ref.month <= 2 ? "동절기" : ref.month >= 7 && ref.month <= 9 ? "극하절기" : "하절기";
  const prodLines = ref.products.map((p) =>
    `${p.name}${p.spec ? ` | ${p.spec}` : ""} | SKU:${p.sku || "-"} | 원가:${p.cost} | 소비자가:${p.retail} | 도매가:${p.wholesale} | 부피:${p.volumeKg ?? "?"}kg | ${p.tax === "taxable" ? "과세" : "면세"}`
  ).join("\n");
  const chLines = ref.channels.length
    ? ref.channels.map((c) => `${c.channel} | 수수료 ${c.feeRatePct}% | 배송모드:${c.shipMode}${c.shipFee ? ` ${c.shipFee}원` : ""}`).join("\n")
    : "(채널 설정 없음 — 수수료율을 합리적으로 추정하고 assumptions 에 명시)";
  return [
    `[현재] ${ref.month}월 · 계절: ${season}`,
    `[채널 정책]\n${chLines}`,
    `[원가표(활성 상품)] 이름 | 규격 | SKU | 원가 | 소비자가 | 도매가 | 부피 | 과세여부\n${prodLines}`,
  ].join("\n\n");
}

export async function analyzeMargin(question: string, ref: MarginRefData): Promise<MarginResult> {
  // 편집 가능한 지침(역할·계산 규칙·배송정책) + 고정 출력 규칙(JSON) 으로 시스템 프롬프트 조립.
  const framework = await getMarginPrompt();
  const resp = await anthropic.messages.create({
    model: MODELS.opus, // 최고급 — 고급 계산·전략
    max_tokens: 4096,
    system: `${framework}\n\n${OUTPUT_RULES}`,
    messages: [{ role: "user", content: `${dataBlock(ref)}\n\n[질문]\n${question.trim()}` }],
  });
  const block = resp.content.find((b) => b.type === "text");
  const text = block && block.type === "text" ? block.text : "";
  const cleaned = text.replace(/^```json?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  return JSON.parse(cleaned) as MarginResult;
}
