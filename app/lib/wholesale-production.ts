// 도매 재고 생산 요청 — 공용 타입·상수(클라이언트/서버 공용, DB 코드 없음).
//  MD가 요청서 작성 → 생산담당자가 실제 생산량을 '입고 처리'(부분/초과/수정) → 도매 재고 반영.

export const PR_STATUSES = ["요청", "처리중", "완료", "취소"] as const;
export type PrStatus = (typeof PR_STATUSES)[number];

export const PR_STATUS_COLOR: Record<PrStatus, { bg: string; fg: string }> = {
  요청: { bg: "var(--sm-info-bg)", fg: "var(--sm-info)" },        // 접수 대기
  처리중: { bg: "var(--sm-warning-bg)", fg: "var(--sm-warning)" }, // 일부 입고됨
  완료: { bg: "var(--sm-success-bg)", fg: "var(--sm-success)" },   // 생산·입고 종료
  취소: { bg: "var(--sm-bg-subtle)", fg: "var(--sm-text-mid)" },   // 취소(기록 보존)
};

// 입고 1건(증거)
export interface PrReceipt {
  id: string;
  item_id: string;
  qty: number;              // 실제 입고 수량(부호 허용: 수정입고 시 음수)
  receipt_date: string;
  memo: string | null;
  received_by: string | null;
  created_at: string;
}

// 요청 품목(라인) + 입고 집계
export interface PrItem {
  id: string;
  product_id: string;
  sku: string | null;
  name: string;
  spec: string | null;
  unit: string;
  requested_qty: number;
  received_qty: number;     // Σ receipts.qty
  memo: string | null;
  receipts: PrReceipt[];
}

// 요청서(헤더) + 라인
export interface ProductionRequest {
  id: string;
  req_no: string | null;
  title: string | null;
  requested_by: string | null;
  request_date: string;
  status: PrStatus;
  memo: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  items: PrItem[];
  // 진행 집계(목록용)
  total_requested: number;
  total_received: number;
}

// 라인 진행 상태 판정 — 표시 색/라벨용.
export type PrLineState = "미입고" | "부분" | "완료" | "초과";
export function lineState(requested: number, received: number): PrLineState {
  if (received <= 0) return "미입고";
  if (received < requested) return "부분";
  if (received > requested) return "초과";
  return "완료";
}

export const PR_LINE_COLOR: Record<PrLineState, string> = {
  미입고: "var(--sm-text-light)",
  부분: "var(--sm-warning)",
  완료: "var(--sm-success)",
  초과: "var(--sm-danger)",
};

// 요청서의 라인 입고 상황으로 '완료 제안' 여부(모든 라인 requested 이상).
export function allLinesFilled(items: Pick<PrItem, "requested_qty" | "received_qty">[]): boolean {
  return items.length > 0 && items.every((it) => it.received_qty >= it.requested_qty);
}
