// 이익률 계산 — 포장비/보냉비 참조표 + 계산 로직.
//   매출 기준 = 도매가(sale_price)
//   배송 1건 비용(아이스박스+운반비+보냉비) = 박스당 수량으로 배분
//   부가세 = 과세 제품은 매출을 공급가(÷1.1)로 환산, 면세는 표시가 그대로
//
// 포장비(부피별)·보냉비(계절별)는 거의 안 바뀌는 정적표라 여기 상수로 둔다.
// (원본: [2026]seamonster_원가표 - 포장비/보냉비)

// ─────────────────────────────────────────────
// 계절 (보냉비 적용 기준)
// ─────────────────────────────────────────────
export const SEASONS = ["동절기", "하절기", "극하절기"] as const;
export type Season = (typeof SEASONS)[number];

// 동절기 12·1·2 / 하절기 3·4·5·6·10·11 / 극하절기 7·8·9
export function seasonForMonth(month: number): Season {
  if (month === 12 || month === 1 || month === 2) return "동절기";
  if (month === 7 || month === 8 || month === 9) return "극하절기";
  return "하절기";
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
//   부피는 0.1kg 단위 올림, 0.1~20kg 범위로 clamp.
// ─────────────────────────────────────────────
export function iceboxCost(volumeKg: number): number {
  const v = clampVolume(volumeKg);
  if (v <= 1.5) return 720;
  if (v <= 2.0) return 1210;
  if (v <= 3.0) return 1700;
  if (v <= 4.0) return 1820;
  if (v <= 5.0) return 2180;
  if (v <= 10.0) return 2370;
  if (v <= 12.0) return 2790;
  return 3390; // ~20kg
}

export function deliveryCost(volumeKg: number): number {
  const v = clampVolume(volumeKg);
  if (v <= 2.0) return 2700;
  if (v <= 2.1) return 3200; // 2.1kg 만 예외
  if (v <= 4.0) return 3300;
  return 3900;
}

function clampVolume(raw: number): number {
  const v = Math.round((Number(raw) || 0) * 10) / 10; // 0.1 단위 정규화
  if (v < 0.1) return 0.1;
  if (v > 20) return 20;
  return v;
}

// ─────────────────────────────────────────────
// 이익률 계산
// ─────────────────────────────────────────────
export interface MarginInput {
  salePrice: number;       // 도매가 (매출 기준)
  taxType: "taxable" | "exempt";
  costMaterial: number;    // 제품원가
  pkgInner: number;        // 내포장지
  pkgLabel: number;        // 라벨
  pkgOuter: number;        // 외포장지
  volumeKg: number | null; // 제품부피
  season: Season;
  unitsPerBox: number;     // 박스당 수량 (배송비 배분)
}

export interface MarginResult {
  hasVolume: boolean;
  revenue: number;         // 매출 (과세=공급가)
  vatExcluded: boolean;    // 과세라 ÷1.1 적용됐는지
  productCost: number;     // 제품 단위 원가 (제품원가+포장재)
  boxVolume: number;       // 배송 계산에 쓰인 박스 부피 (N×부피)
  icebox: number;
  delivery: number;
  cooling: number;
  shipPerBox: number;      // 배송 1건 비용
  shipPerUnit: number;     // 1개당 배분된 배송비
  totalCost: number;       // 총원가 (제품단위원가 + 1개당 배송비)
  profit: number;          // 이익
  marginPct: number;       // 이익률 %
}

export function computeMargin(input: MarginInput): MarginResult {
  const productCost =
    (Number(input.costMaterial) || 0) +
    (Number(input.pkgInner) || 0) +
    (Number(input.pkgLabel) || 0) +
    (Number(input.pkgOuter) || 0);

  const vatExcluded = input.taxType === "taxable";
  const revenue = vatExcluded ? (Number(input.salePrice) || 0) / 1.1 : Number(input.salePrice) || 0;

  const n = Math.max(1, Math.floor(Number(input.unitsPerBox) || 1));
  const hasVolume = input.volumeKg != null && Number(input.volumeKg) > 0;

  let boxVolume = 0,
    icebox = 0,
    delivery = 0,
    cooling = 0,
    shipPerBox = 0,
    shipPerUnit = 0;

  if (hasVolume) {
    boxVolume = clampVolume((Number(input.volumeKg) || 0) * n);
    icebox = iceboxCost(boxVolume);
    delivery = deliveryCost(boxVolume);
    cooling = coolingCost(input.season);
    shipPerBox = icebox + delivery + cooling;
    shipPerUnit = shipPerBox / n;
  }

  const totalCost = productCost + shipPerUnit;
  const profit = revenue - totalCost;
  const marginPct = revenue > 0 ? (profit / revenue) * 100 : 0;

  return {
    hasVolume,
    revenue,
    vatExcluded,
    productCost,
    boxVolume,
    icebox,
    delivery,
    cooling,
    shipPerBox,
    shipPerUnit,
    totalCost,
    profit,
    marginPct,
  };
}
