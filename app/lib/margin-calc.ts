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

// 계산 스펙(레시피) — 리포트의 저장 SQL 에 해당. AI 가 질문을 이 표준 산식 파라미터로 번역해두면,
//  이후 재실행은 AI 없이 코드가 '현재' 원가·수수료·계절 단가로 즉시 계산한다.
export type MarginSpec = {
  sku: string | null;            // 상품 매칭(SKU 우선, 없으면 productName 으로)
  productName: string;
  channel: string;               // 채널명(수수료율은 재실행 시점 채널표에서 조회)
  feeRatePct: number | null;     // 채널표에 없어 AI 가 가정한 수수료율(%). null=채널표 조회
  priceBasis: "retail" | "wholesale" | "custom";
  customTotal: number | null;    // custom 일 때 총 결제가(원)
  discountPct: number;           // 할인율 %(retail/wholesale 기준가에 적용)
  qty: number;                   // 제공 수량(원가·부피 반영. 1+1이면 2)
  paidUnits: number;             // 결제 수량(매출 = 기준가×할인×이 수량. 1+1이면 1)
  boxes: number;                 // 박스 수(배송원가 ×boxes)
  extraCosts: { label: string; amount: number }[]; // 질문에 명시된 기타 비용
};

export type MarginResultItem = {
  label: string;                 // "쿠팡 · 대구순살 1kg · 20% 할인가"
  revenue: number;               // 매출액(고객 결제가, 원)
  supplyValue: number;           // 공급가액(과세=매출/1.1, 면세=매출)
  taxNote: string;               // 과세/면세 및 부가세 처리 설명
  expenses: { label: string; amount: number; note?: string }[]; // 지출 항목별 근거
  netProfit: number;             // 순이익(원)
  marginPct: number;             // 이익률(%)
  spec?: MarginSpec | null;      // 표준 산식으로 표현 가능하면 채워짐 → 저장 후 AI 없이 재계산
};
export type MarginResult = {
  scenario: string;              // 해석한 시나리오 한 줄
  product: string;               // 매칭한 상품(원가표 근거)
  results: MarginResultItem[];   // 보통 1개(질문이 여러 채널/가격이면 여러 개)
  strategy?: string;             // (구버전 호환 — 더는 생성하지 않음)
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
   "marginPct":이익률(소수 첫째,%),
   "spec":{"sku":"원가표 SKU 또는 null","productName":"상품명","channel":"채널명","feeRatePct":채널표에 없어 가정했으면 수수료율 아니면 null,"priceBasis":"retail|wholesale|custom","customTotal":custom이면 총결제가 아니면 null,"discountPct":할인율(없으면 0),"qty":제공수량,"paidUnits":결제수량,"boxes":박스수,"extraCosts":[{"label":"...","amount":정수}]}
 }],
 "assumptions":["데이터가 없어 추정한 부분·주의사항"]
}
- 모든 금액은 원 단위 정수, 이익률은 % 소수 첫째자리.
- expenses 는 매출→순이익으로 이어지는 모든 지출을 빠짐없이 투명하게 나열(합 = 매출 지출분).
- spec: 그 result 가 '기준가(소비자가/도매가/직접 지정가)×할인 − 원가 − 수수료 − 표준 배송원가 − 기타비용' 산식으로 재현 가능하면 반드시 채울 것
  (예: 정가 20% 할인 판매 → priceBasis:"retail", discountPct:20, qty:1, paidUnits:1, boxes:1). 1+1 은 qty:2·paidUnits:1.
  손익분기 역산·표준 산식 밖의 계산이면 spec:null.
- 원가표에서 상품을 못 찾으면 가장 가까운 후보로 계산하되 assumptions 에 명시. 여러 채널/가격을 물으면 results 를 여러 개로.
- 어떤 경우에도 JSON 외 텍스트를 출력하지 말 것. 정보가 부족해도 되묻는 문장을 쓰지 말고 합리적으로 가정해 계산하고 assumptions 에 명시.
  상품명이 아예 없어 계산이 불가능할 때만 results 를 빈 배열로 하고, scenario 에 "상품명을 함께 적어주세요" 안내 한 줄을 담을 것(JSON 유지).`;

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

// ── 코드 계산기 — 저장된 스펙(레시피)을 AI 없이 '현재' 데이터로 재계산 ──
//  단가표는 SHIP_POLICY(위 프롬프트 표)와 동일 값. 정책이 바뀌면 두 곳을 같이 고칠 것.

function parcelFee(volKg: number): number { return volKg <= 2.0 ? 2700 : volKg <= 2.1 ? 3200 : volKg <= 4.0 ? 3300 : 3900; }
function iceboxFee(volKg: number): number {
  return volKg <= 1.5 ? 720 : volKg <= 2.0 ? 1210 : volKg <= 3.0 ? 1700 : volKg <= 4.0 ? 1820 : volKg <= 5.0 ? 2180 : volKg <= 10 ? 2370 : volKg <= 12 ? 2790 : 3390;
}
function coolFee(month: number): { fee: number; season: string } {
  if (month === 12 || month <= 2) return { fee: 1030, season: "동절기" };
  if (month >= 7 && month <= 9) return { fee: 1840, season: "극하절기" };
  return { fee: 1180, season: "하절기" };
}

// 스펙 1건 → 결과 1건. 상품·채널을 '현재' 데이터에서 찾아 표준 산식으로 계산.
//  실패(상품 없음 등)는 throw — 호출부가 사유를 assumptions 로 모은다.
export function computeSpecItem(spec: MarginSpec, ref: MarginRefData): MarginResultItem {
  const skuU = (spec.sku || "").trim().toUpperCase();
  const product =
    (skuU && ref.products.find((p) => (p.sku || "").toUpperCase() === skuU)) ||
    ref.products.find((p) => p.name === spec.productName) ||
    ref.products.find((p) => p.name.includes(spec.productName) || spec.productName.includes(p.name));
  if (!product) throw new Error(`상품 '${spec.productName}' 을 원가표에서 찾을 수 없습니다`);

  const qty = Math.max(1, Math.round(spec.qty || 1));
  const paidUnits = Math.max(0, Math.round(spec.paidUnits || 1));
  const boxes = Math.max(1, Math.round(spec.boxes || 1));
  const discount = Math.min(100, Math.max(0, Number(spec.discountPct) || 0));

  const basisPrice = spec.priceBasis === "wholesale" ? product.wholesale : product.retail;
  const revenue = spec.priceBasis === "custom"
    ? Math.round(Number(spec.customTotal) || 0)
    : Math.round(basisPrice * (1 - discount / 100) * paidUnits);
  if (revenue <= 0) throw new Error(`'${product.name}' 판매가를 구할 수 없습니다(${spec.priceBasis === "wholesale" ? "도매가" : spec.priceBasis === "retail" ? "소비자가" : "지정가"} 미입력)`);

  const taxable = product.tax === "taxable";
  const supplyValue = taxable ? Math.round(revenue / 1.1) : revenue;

  const cost = Math.round(product.cost * qty);
  const ch = ref.channels.find((c) => c.channel === spec.channel);
  const feePct = ch ? ch.feeRatePct : Number(spec.feeRatePct) || 0;
  const fee = Math.round(revenue * feePct / 100);

  const volPerBox = ((product.volumeKg ?? 2.0) * qty) / boxes; // 부피 미입력 시 2kg 가정
  const cool = coolFee(ref.month);
  const parcel = parcelFee(volPerBox) * boxes;
  const icebox = iceboxFee(volPerBox) * boxes;
  const cooling = cool.fee * boxes;

  const extras = (spec.extraCosts || []).map((e) => ({ label: e.label, amount: Math.round(Number(e.amount) || 0) })).filter((e) => e.amount !== 0);
  const extraSum = extras.reduce((s, e) => s + e.amount, 0);
  const netProfit = supplyValue - cost - fee - parcel - icebox - cooling - extraSum;

  const priceLabel = spec.priceBasis === "custom" ? `${revenue.toLocaleString()}원` : discount > 0 ? `${discount}% 할인` : spec.priceBasis === "wholesale" ? "도매가" : "정가";
  return {
    label: `${spec.channel} · ${product.name} · ${priceLabel}`,
    revenue, supplyValue,
    taxNote: taxable ? "과세 상품 — 공급가액 = 매출 ÷ 1.1 (부가세 1/11 차감)" : "면세 상품 — 부가세 없음(공급가액=매출)",
    expenses: [
      { label: "상품원가", amount: cost, note: `단가 ${Math.round(product.cost).toLocaleString()} × ${qty}` },
      { label: `채널 수수료 ${feePct}%`, amount: fee, note: ch ? "채널표 기준" : "가정 수수료율" },
      { label: "택배비", amount: parcel, note: `부피 ${volPerBox.toFixed(1)}kg × ${boxes}박스` },
      { label: "아이스박스·운반", amount: icebox },
      { label: `보냉비(${cool.season})`, amount: cooling },
      ...extras,
    ],
    netProfit,
    marginPct: revenue > 0 ? Math.round((netProfit / revenue) * 1000) / 10 : 0,
    spec,
  };
}

// 참조 데이터(원가표·채널·현재 월) 로드 — 분석·재계산 라우트 공용.
export async function loadMarginRef(): Promise<MarginRefData> {
  const sb = supabaseAdmin();
  const [{ data: prods, error: pErr }, { data: chans }] = await Promise.all([
    sb.from("products").select("name, spec, sku, cost_price, retail_price, sale_price, volume_kg, tax_type").eq("active", true).order("name"),
    sb.from("sales_channel_config").select("channel, fee_rate, ship_mode, ship_fee, ship_free_over").order("channel"),
  ]);
  if (pErr) throw new Error(`상품 조회 오류: ${pErr.message}`);
  const products: MarginProduct[] = (prods ?? []).map((p) => ({
    name: p.name, spec: p.spec, sku: p.sku,
    cost: Number(p.cost_price) || 0, retail: Number(p.retail_price) || 0, wholesale: Number(p.sale_price) || 0,
    volumeKg: p.volume_kg == null ? null : Number(p.volume_kg),
    tax: p.tax_type === "exempt" ? "exempt" : "taxable",
  }));
  const channels: MarginChannel[] = (chans ?? []).map((c) => ({
    channel: c.channel, feeRatePct: Math.round((Number(c.fee_rate) || 0) * 1000) / 10, // 0.108 → 10.8
    shipMode: c.ship_mode, shipFee: Number(c.ship_fee) || 0, shipFreeOver: Number(c.ship_free_over) || 0,
  }));
  const month = new Date(Date.now() + 9 * 3600e3).getUTCMonth() + 1; // KST 월
  return { products, channels, month };
}

// 이어지는 대화 한 턴 — 이전 질문과 그때의 결과(JSON). 후속 질문("택배비 4천원이면?")의 문맥이 된다.
export type MarginTurn = { q: string; result: MarginResult };

export async function analyzeMargin(question: string, ref: MarginRefData, history: MarginTurn[] = []): Promise<MarginResult> {
  // 편집 가능한 지침(역할·계산 규칙·배송정책) + 고정 출력 규칙(JSON) 으로 시스템 프롬프트 조립.
  const framework = await getMarginPrompt();
  const hist = history.slice(-4); // 최근 4턴이면 후속 수정 문맥으로 충분(토큰 절약)
  const messages: Anthropic.MessageParam[] = [];
  if (hist.length) {
    messages.push({ role: "user", content: `${dataBlock(ref)}\n\n[질문]\n${hist[0].q.trim()}` });
    messages.push({ role: "assistant", content: JSON.stringify(hist[0].result) });
    for (const t of hist.slice(1)) {
      messages.push({ role: "user", content: `[이어지는 질문]\n${t.q.trim()}` });
      messages.push({ role: "assistant", content: JSON.stringify(t.result) });
    }
    messages.push({ role: "user", content: `[이어지는 질문]\n${question.trim()}` });
  } else {
    messages.push({ role: "user", content: `${dataBlock(ref)}\n\n[질문]\n${question.trim()}` });
  }
  const resp = await anthropic.messages.create({
    model: MODELS.opus, // 최고급 — 고급 계산·전략
    max_tokens: 4096,
    system: `${framework}\n\n${OUTPUT_RULES}`,
    messages,
  });
  const block = resp.content.find((b) => b.type === "text");
  const text = block && block.type === "text" ? block.text : "";
  const cleaned = text.replace(/^```json?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  try {
    return JSON.parse(cleaned) as MarginResult;
  } catch {
    // 모델이 규칙을 어기고 산문으로 답한 경우(질문이 모호할 때 되묻기 등) — 앞뒤 텍스트를 걷어내고 JSON 부분만 재시도.
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]) as MarginResult; } catch { /* fall through */ } }
    // 그래도 아니면 모델의 말을 안내문으로 그대로 보여준다(원시 파싱 에러 노출 방지).
    return { scenario: cleaned.slice(0, 300), product: "", results: [], strategy: "", assumptions: [] };
  }
}
