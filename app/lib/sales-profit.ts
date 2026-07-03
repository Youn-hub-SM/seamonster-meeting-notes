// 채널별 매출·이익 — 수수료율·배송비매출은 채널 설정(sales_channel_config)에서 RPC가 계산해 넘겨줌.
//  여기선 총매출·수수료·총비용·매출총이익만 조립(파이썬 계산식).

export type ProfitInput = { channel: string; orders: number; pay_amount: number; ship_revenue: number; product_cost: number; cooling: number; fee_rate: number };
export type ProfitRow = ProfitInput & {
  gross_revenue: number;  // 총매출 = 총결제금액 + 배송비매출
  fee: number;            // 판매수수료 = 총매출 × 수수료율
  total_cost: number;     // 총비용 = 총상품원가 + 수수료 + 총택배보냉비
  profit: number;         // 매출총이익
  margin_pct: number;     // 매출총이익률(%)
};

export function computeProfitRow(r: ProfitInput): ProfitRow {
  const gross_revenue = r.pay_amount + r.ship_revenue;
  const fee = gross_revenue * (Number(r.fee_rate) || 0);
  const total_cost = r.product_cost + fee + r.cooling;
  const profit = gross_revenue - total_cost;
  const margin_pct = gross_revenue > 0 ? Math.round((profit / gross_revenue) * 10000) / 100 : 0;
  return { ...r, gross_revenue, fee, total_cost, profit, margin_pct };
}

export function computeProfitTotals(rows: ProfitRow[]): ProfitRow {
  const sum = (k: keyof ProfitRow) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const gross_revenue = sum("gross_revenue"), profit = sum("profit");
  return {
    channel: "전체", orders: sum("orders"), pay_amount: sum("pay_amount"), ship_revenue: sum("ship_revenue"),
    product_cost: sum("product_cost"), cooling: sum("cooling"), fee: sum("fee"), fee_rate: 0,
    gross_revenue, total_cost: sum("total_cost"), profit,
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

// 채널 설정 타입 + 기본값(신규 채널 추가 시).
export type ChannelConfig = { channel: string; fee_rate: number; ship_mode: "flat" | "free_over" | "none"; ship_fee: number; ship_free_over: number; ship_free_over_sub: number };
export const SHIP_MODES: { value: ChannelConfig["ship_mode"]; label: string }[] = [
  { value: "flat", label: "정액(주문당)" },
  { value: "free_over", label: "N원 이상 무료" },
  { value: "none", label: "없음(0)" },
];
