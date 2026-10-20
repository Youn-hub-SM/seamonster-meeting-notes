// 이익률 산식(2026-10-20 — 이익률 계산기 화면 삭제, AI 데이터 비서의 margin_calc 도구가 이 산식을 쓴다).
//  원가표(products)·채널표(sales_channel_config)·현재 월(계절 보냉비)을 읽어, 시나리오(MarginSpec)를 고정 산식으로 계산한다.
//  AI 호출 없음. 배송 단가표(택배·아이스박스·보냉)는 아래 parcelFee/iceboxFee/coolFee — 정책이 바뀌면 여기만 고친다.
import { supabaseAdmin } from "./supabase";

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
