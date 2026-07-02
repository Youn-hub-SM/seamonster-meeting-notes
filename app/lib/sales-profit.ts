// 채널별 매출·이익 — 파이썬 채널별_매출이익 계산 규칙 이식(값 그대로).
//  매출=sales_orders, 원가·중량=sales_sku_cost, 택배보냉비=RPC 계단, 여기선 수수료·배송비매출·이익 계산.

// 채널 판매수수료율(파이썬 CHANNEL_FEE_RATE). 미정의 채널(도매·팔도감 등)=0.
export const CHANNEL_FEE_RATE: Record<string, number> = {
  스마트스토어: 0.10, 쿠팡: 0.12, 카페24: 0.04, 토스: 0.12, 톡스토어: 0.12,
};
export const SHIPPING_FEE_PER_ORDER = 4000; // 배송비매출 = 주문수 × 4,000

export type ProfitInput = { channel: string; orders: number; pay_amount: number; product_cost: number; cooling: number };
export type ProfitRow = ProfitInput & {
  ship_revenue: number;   // 배송비매출
  gross_revenue: number;  // 총매출
  fee: number;            // 판매수수료
  total_cost: number;     // 총비용
  profit: number;         // 매출총이익
  margin_pct: number;     // 매출총이익률(%)
};

export function computeProfitRow(r: ProfitInput): ProfitRow {
  const ship_revenue = r.orders * SHIPPING_FEE_PER_ORDER;
  const gross_revenue = r.pay_amount + ship_revenue;
  const rate = CHANNEL_FEE_RATE[r.channel] ?? 0;
  const fee = gross_revenue * rate;
  const total_cost = r.product_cost + fee + r.cooling;
  const profit = gross_revenue - total_cost;
  const margin_pct = gross_revenue > 0 ? Math.round((profit / gross_revenue) * 10000) / 100 : 0;
  return { ...r, ship_revenue, gross_revenue, fee, total_cost, profit, margin_pct };
}

// 채널 합계행(전체).
export function computeProfitTotals(rows: ProfitRow[]): ProfitRow {
  const sum = (k: keyof ProfitInput | "ship_revenue" | "gross_revenue" | "fee" | "total_cost" | "profit") =>
    rows.reduce((a, r) => a + (Number(r[k as keyof ProfitRow]) || 0), 0);
  const gross_revenue = sum("gross_revenue");
  const profit = sum("profit");
  return {
    channel: "전체", orders: sum("orders"), pay_amount: sum("pay_amount"),
    ship_revenue: sum("ship_revenue"), gross_revenue, product_cost: sum("product_cost"),
    cooling: sum("cooling"), fee: sum("fee"), total_cost: sum("total_cost"), profit,
    margin_pct: gross_revenue > 0 ? Math.round((profit / gross_revenue) * 10000) / 100 : 0,
  };
}

export const PROFIT_COLS: { key: keyof ProfitRow; label: string; money?: boolean; pct?: boolean }[] = [
  { key: "channel", label: "판매처" },
  { key: "orders", label: "주문수" },
  { key: "pay_amount", label: "총결제금액", money: true },
  { key: "ship_revenue", label: "배송비매출", money: true },
  { key: "gross_revenue", label: "총매출", money: true },
  { key: "product_cost", label: "총상품원가", money: true },
  { key: "cooling", label: "총택배보냉비", money: true },
  { key: "fee", label: "판매수수료", money: true },
  { key: "total_cost", label: "총비용", money: true },
  { key: "profit", label: "매출총이익", money: true },
  { key: "margin_pct", label: "매출총이익률", pct: true },
];
