// 파도소리(제조사) 재고 원장 — 공용 타입·상수(클라이언트/서버 공용, DB 코드 없음).
//  단위는 품목이 아니라 **로트**다. 같은 품명이라도 규격·테잎색·원산지·입고일이 다르면 별도 로트로
//  관리한다(현재 쓰는 주간 재고장 엑셀의 한 행 = 로트 1개).
//  DB 접근은 factory-db.ts(서버 전용). 이 파일에 supabase import 를 넣지 말 것 —
//  화면이 이 파일을 import 하므로 서비스 키가 번들에 실린다.

// ── 거래 유형 ───────────────────────────────────────────────────────
// qty 는 부호 있는 수량(입고 +, 출고·생산투입 −, 조정 ±). 유형은 '왜'만 설명한다.
export const TXN_TYPES = ["입고", "출고", "생산투입", "이동", "조정"] as const;
export type TxnType = (typeof TXN_TYPES)[number];

// 화면에서 사람이 직접 고르는 출고 유형(이동은 전용 입력, 입고는 로트 등록에서 처리)
export const OUT_TYPES: TxnType[] = ["출고", "생산투입", "조정"];

// 색 지도(디자인 시스템 §4) — 배지·표는 화면에서 색을 새로 선언하지 말고 여기를 조회한다.
//  이동은 창고만 바뀌고 총량은 그대로라 중립색이다.
export const TXN_TYPE_COLOR: Record<TxnType, { bg: string; fg: string }> = {
  입고: { bg: "var(--sm-success-bg)", fg: "var(--sm-success)" },
  출고: { bg: "var(--sm-info-bg)", fg: "var(--sm-info)" },
  생산투입: { bg: "var(--sm-warning-bg)", fg: "var(--sm-warning)" },
  이동: { bg: "var(--sm-bg-subtle)", fg: "var(--sm-text-mid)" },
  조정: { bg: "var(--sm-danger-bg)", fg: "var(--sm-danger)" },
};

// 유형별 부호 — 조정만 사용자가 부호를 정한다.
export function signOf(type: TxnType): number {
  return type === "입고" ? 1 : type === "조정" ? 0 : -1;
}

// ── 입력 보조 목록 ──────────────────────────────────────────────────
// 재고장에 실제로 쓰이는 값들. 자유 입력을 막지는 않되(새 값이 계속 생긴다) 목록에서 고르게 해
// 표기 흔들림을 줄인다. 특히 원산지는 지금 국·러·원·원양산·극·구가 섞여 있어 집계가 어긋난다.
export const TAPE_COLORS = ["황", "백", "노", "청", "적", "투명", "녹"] as const;
export const ORIGINS = [
  "국산", "러시아", "원양산", "미국", "중국", "대만", "베트남", "인도네시아",
  "브라질", "칠레", "세네갈", "뉴질랜드", "노르웨이",
] as const;

// 생산투입의 행선지는 늘 '현장' 하나다 — 입력에서 자동으로 채운다.
export const SITE_DEST = "현장";

// ── 행 타입 ─────────────────────────────────────────────────────────
export interface Warehouse {
  id: string;
  name: string;
  is_own: boolean;
  sort: number;
  active: boolean;
}

// factory.lot_stock 뷰 1행 — 로트 + 현재수량
export interface LotStock {
  id: string;
  warehouse_id: string;
  warehouse: string;
  is_own: boolean;
  item_name: string;
  spec: string | null;
  tape_color: string | null;
  origin: string | null;
  note: string | null;
  supplier: string | null;
  box_kg: number | null;
  unit: string;
  first_in_date: string | null;
  prod_date: string | null;
  memo: string | null;
  origin_lot_id: string | null;
  qty: number;          // 현재수량 = Σ거래
  first_qty: number;    // 최초입고수량 = Σ입고
  last_out_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface LotTxn {
  id: string;
  lot_id: string;
  txn_date: string;
  type: TxnType;
  qty: number;          // 부호 있는 수량
  dest: string | null;
  move_id: string | null;
  memo: string | null;
  created_by: string | null;
  created_at: string;
}

// 이력 화면용 — 거래에 로트 정보를 붙인 형태
export interface LotTxnWithLot extends LotTxn {
  item_name: string;
  spec: string | null;
  tape_color: string | null;
  origin: string | null;
  warehouse: string;
}

// 로트 한 줄을 사람이 읽는 이름으로. 품명만으로는 구분이 안 된다(삼치순살이 16로트).
export function lotLabel(l: Pick<LotStock, "item_name" | "spec" | "tape_color" | "origin">): string {
  const tail = [l.spec, l.origin, l.tape_color].filter(Boolean).join(" · ");
  return tail ? `${l.item_name} (${tail})` : l.item_name;
}

// 박스 수 → 중량(kg). 박스중량이 없으면 null(0 이 아니라 '알 수 없음').
export function toKg(qty: number, boxKg: number | null): number | null {
  if (boxKg === null || !Number.isFinite(boxKg)) return null;
  return Math.round(qty * boxKg * 10) / 10;
}
