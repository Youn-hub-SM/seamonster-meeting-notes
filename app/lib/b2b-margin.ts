// 이익률 계산.
//  (1) 제품 단위 이익률 — computeMargin: 매출(도매가) 대비 제품 단위 원가(제품원가+포장재).
//  (2) 발주 단위 이익률 — computeOrderMargin: 발주 전체 매출 − 제품원가 − 배송 박스 비용.
//      배송비 = 박스 수 × (아이스박스 + 운반비 + 보냉비). 보통 배송 박스 단위로 계산.
//  과세 제품은 매출을 공급가(÷1.1)로 환산.

// ─────────────────────────────────────────────
// (1) 제품 단위
// ─────────────────────────────────────────────
export interface MarginInput {
  salePrice: number;
  taxType: "taxable" | "exempt";
  cost: number; // 제품 단위 원가 (cost_price)
}
export interface MarginResult {
  revenue: number;
  vatExcluded: boolean;
  cost: number;
  profit: number;
  marginPct: number;
}
export function computeMargin(input: MarginInput): MarginResult {
  const vatExcluded = input.taxType === "taxable";
  const sale = Number(input.salePrice) || 0;
  const revenue = vatExcluded ? sale / 1.1 : sale;
  const cost = Number(input.cost) || 0;
  const profit = revenue - cost;
  const marginPct = revenue > 0 ? (profit / revenue) * 100 : 0;
  return { revenue, vatExcluded, cost, profit, marginPct };
}

// ─────────────────────────────────────────────
// 계절 (보냉비) — 동절기 12·1·2 / 하절기 3·4·5·6·10·11 / 극하절기 7·8·9
// ─────────────────────────────────────────────
export const SEASONS = ["동절기", "하절기", "극하절기"] as const;
export type Season = (typeof SEASONS)[number];

export function seasonForMonth(month: number): Season {
  if (month === 12 || month === 1 || month === 2) return "동절기";
  if (month === 7 || month === 8 || month === 9) return "극하절기";
  return "하절기";
}

// ISO 날짜(YYYY-MM-DD) → 계절. 빈 값이면 fallbackMonth(보통 현재월) 사용.
export function seasonForDate(iso: string | null | undefined, fallbackMonth: number): Season {
  const m = iso && /^\d{4}-(\d{2})/.test(iso) ? Number(iso.slice(5, 7)) : fallbackMonth;
  return seasonForMonth(m);
}

export const SEASON_MONTHS: Record<Season, string> = {
  동절기: "12·1·2월",
  하절기: "3·4·5·6·10·11월",
  극하절기: "7·8·9월",
};

// 보냉비 (박스 1건당): 라미백 + 아이스팩 + 드라이아이스 (부가세 포함)
export const COOLING_COST: Record<Season, { lami: number; icepack: number; dryice: number }> = {
  동절기: { lami: 220, icepack: 150, dryice: 660 },
  하절기: { lami: 220, icepack: 300, dryice: 660 },
  극하절기: { lami: 220, icepack: 300, dryice: 1320 },
};
export function coolingCost(season: Season): number {
  const c = COOLING_COST[season];
  return c.lami + c.icepack + c.dryice;
}

// ─────────────────────────────────────────────
// 포장비 (박스 부피 kg 별): 아이스박스 + 운반비 (부가세 포함)
// ─────────────────────────────────────────────
function clampVolume(raw: number): number {
  const v = Math.round((Number(raw) || 0) * 10) / 10;
  if (v < 0.1) return 0.1;
  if (v > 20) return 20;
  return v;
}
export function iceboxCost(volumeKg: number): number {
  const v = clampVolume(volumeKg);
  if (v <= 1.5) return 720;
  if (v <= 2.0) return 1210;
  if (v <= 3.0) return 1700;
  if (v <= 4.0) return 1820;
  if (v <= 5.0) return 2180;
  if (v <= 10.0) return 2370;
  if (v <= 12.0) return 2790;
  return 3390;
}
export function deliveryCost(volumeKg: number): number {
  const v = clampVolume(volumeKg);
  if (v <= 2.0) return 2700;
  if (v <= 2.1) return 3200;
  if (v <= 4.0) return 3300;
  return 3900;
}

// 부피로부터 권장 박스 수 (박스당 최대 20kg 가정)
export function suggestBoxes(volumeKg: number): number {
  const v = Number(volumeKg) || 0;
  return Math.max(1, Math.ceil(v / 20));
}

// ─────────────────────────────────────────────
// (2) 발주 단위
// ─────────────────────────────────────────────
export interface OrderMarginLine {
  unitPrice: number;
  qty: number;
  costAtOrder: number;
  taxType: "taxable" | "exempt";
  volumeKg: number; // 제품 1개 부피 (모르면 0)
}
export interface OrderMarginResult {
  revenue: number;      // 매출 (과세=공급가)
  productCost: number;  // 제품원가 합계 (제품 단위 원가 × 수량)
  volume: number;       // 총 부피(kg)
  boxes: number;        // 박스 수
  perBoxVolume: number; // 박스당 부피
  iceboxPerBox: number;
  deliveryPerBox: number;
  coolingPerBox: number;
  shipPerBox: number;   // 박스 1건 배송비
  shipping: number;     // 총 배송비 (박스 수 × 박스 1건)
  totalCost: number;    // 제품원가 + 배송비
  profit: number;
  marginPct: number;
}
export function computeOrderMargin(
  lines: OrderMarginLine[],
  boxCount: number,
  season: Season
): OrderMarginResult {
  let revenue = 0,
    productCost = 0,
    volume = 0;
  for (const l of lines) {
    const qty = Number(l.qty) || 0;
    const sale = (Number(l.unitPrice) || 0) * qty;
    revenue += l.taxType === "taxable" ? sale / 1.1 : sale;
    productCost += (Number(l.costAtOrder) || 0) * qty;
    volume += (Number(l.volumeKg) || 0) * qty;
  }

  const boxes = Math.max(1, Math.floor(Number(boxCount) || 1));
  const hasVolume = volume > 0;
  const perBoxVolume = hasVolume ? volume / boxes : 0;
  const iceboxPerBox = hasVolume ? iceboxCost(perBoxVolume) : 0;
  const deliveryPerBox = hasVolume ? deliveryCost(perBoxVolume) : 0;
  const coolingPerBox = hasVolume ? coolingCost(season) : 0;
  const shipPerBox = iceboxPerBox + deliveryPerBox + coolingPerBox;
  const shipping = hasVolume ? boxes * shipPerBox : 0;

  const totalCost = productCost + shipping;
  const profit = revenue - totalCost;
  const marginPct = revenue > 0 ? (profit / revenue) * 100 : 0;

  return {
    revenue,
    productCost,
    volume,
    boxes,
    perBoxVolume,
    iceboxPerBox,
    deliveryPerBox,
    coolingPerBox,
    shipPerBox,
    shipping,
    totalCost,
    profit,
    marginPct,
  };
}
