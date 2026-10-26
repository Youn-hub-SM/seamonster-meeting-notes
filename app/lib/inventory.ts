// 재고관리 공용 상수·타입 — 클라이언트/서버 공용(DB 코드 없음).

export const INV_TXN_TYPES = ["입고", "출고", "조정"] as const;
export type InvTxnType = (typeof INV_TXN_TYPES)[number];

export const INV_TYPE_COLOR: Record<InvTxnType, { bg: string; fg: string }> = {
  입고: { bg: "var(--sm-success-bg)", fg: "var(--sm-success)" }, // 매입(+)
  출고: { bg: "var(--sm-info-bg)", fg: "var(--sm-info)" },       // 판매·소진(-)
  조정: { bg: "var(--sm-warning-bg)", fg: "var(--sm-warning)" }, // 실사 보정(±)
};

// 재고 주의 상태(종합 리포트 '재고 주의 품목' 표·KPI, 2026-10-13 대표 결정 3) — 재고 없음 = danger, 부족 = warning.
//  2026-10-26 대표: 창고 재고가 0 인 것은 '재고 없음'(채널의 '상품 품절'과 구분). 저장된 옛 리포트의 "품절" 값은 normInvState 로 읽는다.
//  같은 빨강이면 급한 것을 못 가른다. row = 표 행 톤(.b2b-table tr.is-overdue / .is-urgent). 화면에서 색을 새로 선언하지 않는다.
export type InvWatchState = "재고 없음" | "부족";
export const normInvState = (s: unknown): InvWatchState | null => (s === "재고 없음" || s === "품절") ? "재고 없음" : s === "부족" ? "부족" : null;
export const INV_WATCH_COLOR: Record<InvWatchState, { bg: string; fg: string; row: "is-overdue" | "is-urgent" }> = {
  "재고 없음": { bg: "var(--sm-danger-bg)", fg: "var(--sm-danger)", row: "is-overdue" },
  부족: { bg: "var(--sm-warning-bg)", fg: "var(--sm-warning)", row: "is-urgent" },
};

// 재고 채널(풀) — 같은 품목(SKU)이라도 풀별로 현재고를 따로 잡는다.
//  프로모션(113) = 행사 확보분. 자동 차감 경로가 없어 프로모션 요청서를 '마감'(= 소매 합류, 2026-10-06)할 때까지 보호되고,
//  입고는 '재고 이동'(소매→프로모션)로만 — 도매의 "입고는 이동뿐" 규칙과 동일.
//  도매 대량(115) = 선결제 대량 발주 확보분. 프로모션과 같은 보호 칸이지만 **마감 합류가 없다**
//   — 이미 팔린 물건이라 소매로 돌려보낼 근거가 없다(대표 확정 2026-09-22).
export const INV_CHANNELS = ["도매", "소매", "프로모션", "도매 대량"] as const;
export type InvChannel = (typeof INV_CHANNELS)[number];
export const INV_CHANNEL_COLOR: Record<InvChannel, { bg: string; fg: string }> = {
  도매: { bg: "var(--sm-orange-light)", fg: "var(--sm-orange)" },     // B2B
  소매: { bg: "var(--sm-info-bg)", fg: "var(--sm-info)" },            // 온라인몰
  프로모션: { bg: "var(--sm-warning-bg)", fg: "var(--sm-warning)" },  // 행사 확보분(보호)
  "도매 대량": { bg: "var(--sm-danger-bg)", fg: "var(--sm-danger)" }, // 선결제 확보분(보호, 합류 없음)
};
// 읽기(조회) 화면 필터 — 전체 = 전 풀 합산.
export const INV_CHANNEL_FILTERS = ["전체", "도매", "소매", "프로모션", "도매 대량"] as const;
export type InvChannelFilter = (typeof INV_CHANNEL_FILTERS)[number];

// 문자열 → 칸. 칸이 늘 때마다 삼항식을 파일마다 고치던 것을 한 곳으로 모은다
//  (115 에서 '도매 대량' 을 더하며 30곳을 손대야 했던 일이 되풀이되지 않게).
export function toInvChannel(v: unknown, fallback: InvChannel = "소매"): InvChannel {
  const s = typeof v === "string" ? v.trim() : "";
  return (INV_CHANNELS as readonly string[]).includes(s) ? (s as InvChannel) : fallback;
}
/** 조회 필터 → 칸. '전체'·빈값·모르는 값은 null(= 전 칸 합산).
 *  실사(조정)는 이 함수로 받아 null 이면 거절한다 — toInvChannel 의 소매 폴백으로 받으면 칸을 안 고른 실사가 소매에 덮어써진다(S8). */
export function toInvChannelParam(v: unknown): InvChannel | null {
  const s = typeof v === "string" ? v.trim() : "";
  return (INV_CHANNELS as readonly string[]).includes(s) ? (s as InvChannel) : null;
}
/** 입고가 직접 들어올 수 없는 칸 — 이동으로만 채운다. 제조사 입고는 언제나 소매로 들어온다. */
export const MOVE_ONLY_CHANNELS: readonly InvChannel[] = ["도매", "프로모션", "도매 대량"];
/** 임자가 정해진 보호 칸 — 자동 출고 경로가 닿지 않는다(도매 대량은 B2B 발송만 예외). */
export const RESERVED_CHANNELS: readonly InvChannel[] = ["프로모션", "도매 대량"];

export interface InventoryTxn {
  id: string;
  product_id: string;
  product_name?: string;   // 조인 표시용
  sku?: string | null;
  type: InvTxnType;
  channel?: InvChannel;    // 도매/소매 재고 채널(migration 036, 기존행=소매)
  group_id?: string | null; // 한 번에 기록된 묶음(재고 이동은 출발·도착 두 행이 같은 group_id)
  qty: number;             // 부호 있는 재고 변화량
  unit_amount: number | null;
  txn_date: string;
  partner: string | null;
  memo: string | null;
  created_by: string | null;
  created_at: string;
  status?: "대기" | "완료" | null; // 034 — '대기'는 현재고에 안 들어간다. 구 응답(status 없음)은 완료로 본다
}

// 품목 + 현재고 (제품목록·부족알림 공용)
export interface InventoryRow {
  product_id: string;
  sku: string | null;
  name: string;
  spec: string | null;
  unit: string;
  cost_price: number;
  purchase_price: number;  // 매입단가(구매 단가)
  origin: string | null;   // 원산지
  attrs: string | null;    // 속성/분류
  qty: number;             // Σ txn.qty(완료). asof 없으면 전체 원장 = 미래 발송일 선점까지 뺀 '가용'
  on_hand?: number;        // 현재고 = 오늘(KST)까지 원장 — asof 없이 조회했을 때만
  scheduled_out?: number;  // 출고 예정 = on_hand − qty(오늘 뒤 거래일로 이미 기록된 출고, 대부분 B2B 선점)
  min_qty: number;         // 안전재고(재고부족 기준)
  value: number;           // 재고자산 = qty × cost_price
  barcode: string | null;
  location: string | null;
  low: boolean;            // min_qty>0 이고 qty<=min_qty
  is_bundle?: boolean;     // 묶음(세트) 상품 여부 — 구매/판매 검색에서 제외 토글용
}

// 입력값(양수 수량 또는 조정 델타) → 부호 있는 재고 변화량.
//  입고 = +수량, 출고 = -수량, 조정 = 입력값 그대로(부호 허용).
export function signedQty(type: InvTxnType, input: number): number {
  const n = Math.round((Number(input) || 0) * 100) / 100; // 재고 수량은 소수 둘째자리까지 허용
  if (type === "입고") return Math.abs(n);
  if (type === "출고") return -Math.abs(n);
  return n; // 조정
}
