// 도매 재고 생산 요청 — 공용 타입·상수(클라이언트/서버 공용, DB 코드 없음).
//  MD가 요청서 작성 → 생산담당자가 실제 생산량을 '입고 처리'(부분/초과/수정) → 도매 재고 반영.

export const PR_STATUSES = ["요청", "진행중", "완료", "취소"] as const;
export type PrStatus = (typeof PR_STATUSES)[number];

export const PR_STATUS_COLOR: Record<PrStatus, { bg: string; fg: string }> = {
  요청: { bg: "var(--sm-info-bg)", fg: "var(--sm-info)" },        // 접수 대기
  진행중: { bg: "var(--sm-warning-bg)", fg: "var(--sm-warning)" }, // 일부 입고됨
  완료: { bg: "var(--sm-success-bg)", fg: "var(--sm-success)" },   // 생산·입고 종료
  취소: { bg: "var(--sm-bg-subtle)", fg: "var(--sm-text-mid)" },   // 취소(기록 보존)
};

// 화면 표시 라벨 — DB status 문자열('진행중' 등)은 그대로 두고 '표시'만 바꾼다(로직·비교·알림은 raw 유지).
//  '진행중'은 생산담당자가 요청을 확인하고 생산에 착수한 단계임을 분명히 하려고 '담당자 확인/생산 중'으로 표기.
export const PR_STATUS_LABEL: Record<PrStatus, string> = {
  요청: "요청",
  진행중: "담당자 확인/진행 중",
  완료: "완료",
  취소: "취소",
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
export const PR_PURPOSES = ["재고 보충", "도매 납품", "프로모션", "도매 대량"] as const;
export type PrPurpose = (typeof PR_PURPOSES)[number];
// 화면 표시는 요청 대상 기준 제조사/도매 (DB 저장값·082 체크 제약은 기존 문자열 유지)
export const PR_PURPOSE_LABEL: Record<PrPurpose, string> = { "재고 보충": "제조사", "도매 납품": "도매", "프로모션": "프로모션", "도매 대량": "도매 대량" };

/** 문자열 → 용도. 모르는 값은 '재고 보충'(제조사) — 옛 데이터·미적용 환경 폴백. */
export function toPrPurpose(v: unknown): PrPurpose {
  const s = typeof v === "string" ? v.trim() : "";
  return (PR_PURPOSES as readonly string[]).includes(s) ? (s as PrPurpose) : "재고 보충";
}
/** 확정형 — 사람이 목표일과 수량을 알고 등록하는 용도. 이행 = 소매에서 그 칸으로 이동 + 배정. */
export const CONFIRMED_PURPOSES: readonly PrPurpose[] = ["프로모션", "도매 대량"];
/** 제조사 생산 대상(= 확정형도 도매 납품도 아닌 것). '도매 납품이 아니면 제조사' 식 분기를 대체한다. */
export function isFactoryPurpose(p: unknown): boolean { return toPrPurpose(p) === "재고 보충"; }
/** 그 용도가 확보하는 재고 칸. 재고 보충은 소매로 입고되므로 이동 대상이 아니다. */
export const PURPOSE_CHANNEL: Partial<Record<PrPurpose, string>> = { "도매 납품": "도매", "프로모션": "프로모션", "도매 대량": "도매 대량" };

/** 용도 한 줄 설명 — 요청서 상세·알림 본문용. */
/** 용도별 목표일(생산마감일 칸)의 뜻 — 확정형은 마감이 아니라 그날 물건이 있어야 하는 날이다. */
export const DUE_LABEL: Record<PrPurpose, string> = {
  "재고 보충": "생산종료일",
  "도매 납품": "생산마감일",
  "프로모션": "행사 시작일",
  "도매 대량": "출고(납품) 예정일",
};
export const PURPOSE_NOTE: Record<PrPurpose, string> = {
  "재고 보충": "제조사 생산 요청 — 입고로 이행",
  "도매 납품": "도매 보충 — 소매→도매 이동으로 이행",
  "프로모션": "행사 확보 — 소매→프로모션 이동으로 이행",
  "도매 대량": "선결제 대량 발주 확보 — 소매→도매 대량 이동으로 이행",
};
/** 탭 아래 안내 — 그 용도의 요청서가 무엇으로 채워지는지. */
export const FULFILL_NOTE: Record<PrPurpose, string> = {
  "재고 보충": "제조사에서 입고되면 자동으로 이행됩니다 (입고는 소매로 들어옵니다)",
  "도매 납품": "재고 옮기기에서 소매 → 도매 로 옮기며 배정하면 이행됩니다",
  "프로모션": "재고 옮기기에서 소매 → 프로모션 으로 옮기며 배정하면 이행됩니다",
  "도매 대량": "재고 옮기기에서 소매 → 도매 대량 으로 옮기며 배정하면 이행됩니다 (선결제 건이라 자동 합류는 없습니다)",
};

export interface ProductionRequest {
  id: string;
  req_no: string | null;
  title: string | null;
  purpose: PrPurpose;           // 생산 용도(082·113·115). 미적용 환경은 기본 재고 보충
  order_id?: string | null;     // 115 — 확정형(도매 대량)이 어느 발주 몫인지. 발주가 지워져도 요청서는 남는다
  company_id?: string | null;   // 115 — 발주가 아직 시스템에 없을 때(구두 확보 당일) 거래처만
  company_name?: string | null; // 조인 표시용(저장 안 함)
  requested_by: string | null;
  request_date: string;
  due_date: string | null;      // 생산종료일=마감(기본 요청일+7영업일, 급발주 시 수정 가능)
  prod_start?: string | null;  // 생산시작일(118) — 입고 자동 매칭 창의 시작(없으면 신청일 폴백). 제조사(재고 보충) 전용
  status: PrStatus;
  assignee: string | null;      // 생산 담당자(변경 가능)
  memo: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  items: PrItem[];
  // 진행 집계(목록용)
  total_requested: number;
  total_received: number;
}

// 요청서에 없던 품목이 그 주간에 입고됐을 때 자동으로 생기는 품목 줄의 메모(요청수량 0) — 2026-09-18 대표 확정.
//  입고 매칭(production-allocate)이 만들고, 화면·엑셀·합계는 이 줄을 '요청서에 없음'으로 구분한다.
export const UNREQUESTED_ITEM_MEMO = "[요청서에 없음]";

// 라인 진행 상태 판정 — 표시 색/라벨용.
export type PrLineState = "미입고" | "부분" | "완료" | "초과" | "요청서에 없음";
export function lineState(requested: number, received: number): PrLineState {
  if (requested <= 0 && received > 0) return "요청서에 없음"; // 요청 없이 입고만 있는 자동 줄
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
  "요청서에 없음": "var(--sm-info)",
};

// 요청서의 라인 입고 상황으로 '완료 제안' 여부(모든 라인 requested 이상).
export function allLinesFilled(items: Pick<PrItem, "requested_qty" | "received_qty">[]): boolean {
  return items.length > 0 && items.every((it) => it.received_qty >= it.requested_qty);
}
