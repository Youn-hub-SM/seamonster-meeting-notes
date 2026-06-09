// 이익률 계산 — 매출(도매가) 대비 제품 단위 원가 기준.
//   매출   = 도매가(sale_price). 과세 제품은 공급가(÷1.1)로 환산.
//   원가   = 제품 단위 원가 = 제품원가 + 포장재(내/라벨/외) = products.cost_price
//   이익   = 매출 − 원가,  이익률 = 이익 ÷ 매출
// (포장비·보냉비 등 배송 1건 비용은 이익률에 반영하지 않음 — 매출 기준 단순 이익률)

export interface MarginInput {
  salePrice: number;                 // 도매가
  taxType: "taxable" | "exempt";
  cost: number;                      // 제품 단위 원가 (cost_price)
}

export interface MarginResult {
  revenue: number;     // 매출 (과세=공급가)
  vatExcluded: boolean; // 과세라 ÷1.1 적용됐는지
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
