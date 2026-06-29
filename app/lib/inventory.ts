// 재고관리 공용 상수·타입 — 클라이언트/서버 공용(DB 코드 없음).

export const INV_TXN_TYPES = ["입고", "출고", "조정"] as const;
export type InvTxnType = (typeof INV_TXN_TYPES)[number];

export const INV_TYPE_COLOR: Record<InvTxnType, { bg: string; fg: string }> = {
  입고: { bg: "var(--sm-success-bg)", fg: "var(--sm-success)" }, // 매입(+)
  출고: { bg: "var(--sm-info-bg)", fg: "var(--sm-info)" },       // 판매·소진(-)
  조정: { bg: "var(--sm-warning-bg)", fg: "var(--sm-warning)" }, // 실사 보정(±)
};

export interface InventoryTxn {
  id: string;
  product_id: string;
  product_name?: string;   // 조인 표시용
  sku?: string | null;
  type: InvTxnType;
  qty: number;             // 부호 있는 재고 변화량
  unit_amount: number | null;
  txn_date: string;
  partner: string | null;
  memo: string | null;
  created_by: string | null;
  created_at: string;
}

// 품목 + 현재고 (제품목록·부족알림 공용)
export interface InventoryRow {
  product_id: string;
  sku: string | null;
  name: string;
  spec: string | null;
  unit: string;
  cost_price: number;
  qty: number;             // 현재고 = Σ txn.qty
  min_qty: number;         // 안전재고(재고부족 기준)
  value: number;           // 재고자산 = qty × cost_price
  barcode: string | null;
  location: string | null;
  low: boolean;            // min_qty>0 이고 qty<=min_qty
}

// 입력값(양수 수량 또는 조정 델타) → 부호 있는 재고 변화량.
//  입고 = +수량, 출고 = -수량, 조정 = 입력값 그대로(부호 허용).
export function signedQty(type: InvTxnType, input: number): number {
  const n = Math.round(Number(input) || 0);
  if (type === "입고") return Math.abs(n);
  if (type === "출고") return -Math.abs(n);
  return n; // 조정
}
