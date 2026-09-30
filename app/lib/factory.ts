// 파도소리(제조사) 재고 — 공용 타입·상수·표기(클라이언트/서버 공용, DB 코드 없음).
//  품목 마스터 1행 = SKU 1개. 재고는 박스 원장(factory.stock_txns) 합계이고, 같은 품목 안에서
//  [제조일자 × 박스 중량] 이 다르면 따로 센다(= 로트). 수량은 박스, 중량은 박스 수 × 박스 중량.
//  DB 접근은 factory-db.ts(서버 전용). 이 파일에 supabase import 를 넣지 말 것 —
//  화면이 이 파일을 import 하므로 서비스 키가 번들에 실린다.

export const TXN_TYPES = ["입고", "출고", "조정"] as const;
export type TxnType = (typeof TXN_TYPES)[number];

// 히스토리 이벤트 — 기록(입고·출고·조정) + 기록 취소 + 품목 변경(등록·수정·원가·판매가·삭제)
export type HistKind = TxnType | "취소" | "변경";

// 색 지도(디자인 시스템 §4) — 배지·숫자는 화면에서 색을 새로 선언하지 말고 여기를 조회한다.
//  씨몬스터 재고(INV_TYPE_COLOR)와 같은 뜻 = 같은 색. 취소·변경은 종결·기록성 이벤트라 중립 회색.
export const HIST_COLOR: Record<HistKind, { bg: string; fg: string }> = {
  입고: { bg: "var(--sm-success-bg)", fg: "var(--sm-success)" },
  출고: { bg: "var(--sm-info-bg)", fg: "var(--sm-info)" },
  조정: { bg: "var(--sm-warning-bg)", fg: "var(--sm-warning)" },
  취소: { bg: "var(--sm-bg-subtle)", fg: "var(--sm-text-mid)" },
  변경: { bg: "var(--sm-bg-subtle)", fg: "var(--sm-text-mid)" },
};

// 원산지 입력 보조 — 자유 입력은 막지 않되 목록에서 고르게 해 표기 흔들림(국·국산·국내산)을 줄인다.
export const ORIGINS = [
  "국산", "러시아", "원양산", "미국", "중국", "대만", "베트남", "인도네시아",
  "브라질", "칠레", "세네갈", "뉴질랜드", "노르웨이",
] as const;

// ── 행 타입 ─────────────────────────────────────────────────────────
export interface FactoryProduct {
  id: string;
  sku: string;
  name: string;
  origin: string | null;
  note: string | null;
  cost: number | null;
  price: number | null;
  stock_tracked: boolean;
  created_at?: string;
  updated_at?: string;
}

// 로트 = 품목 × 제조일자 × 박스 중량 (factory.stock_lots 뷰 1행)
export interface StockLot {
  mfg_date: string | null;
  box_kg: number;
  boxes: number;
  in_boxes: number;
  out_boxes: number;
  adj_boxes: number;
  in_date: string | null;       // 이 로트의 첫 입고일(입고 없이 조정으로 생긴 로트면 첫 기록일)
  last_in_date: string | null;
}

// 재고 화면 1행 — 품목 + 합계 + 로트
export interface StockRow extends FactoryProduct {
  boxes: number;                // 현재 수량(박스)
  kg: number;                   // 현재 중량
  in_boxes: number; in_kg: number;    // 총 입고(누적)
  out_boxes: number; out_kg: number;  // 총 출고(누적)
  adj_boxes: number;            // 조정 합(±)
  last_in_date: string | null;  // 최신 입고일
  oldest_in_date: string | null; // 최고령 입고일 = 남은 재고 중 가장 오래된 입고일
  lots: StockLot[];             // 잔량 있는 로트 먼저, 오래된 순
}

export interface HistEvent {
  key: string;
  kind: HistKind;
  date: string;                 // 기록 = 거래일, 취소·변경 = 한 날(KST)
  at: string;                   // 정렬용 시각
  who: string | null;
  sku: string | null;
  name: string | null;
  // 기록(입고·출고·조정)·취소
  txn_id?: string;
  txn_type?: TxnType;
  mfg_date?: string | null;
  box_kg?: number;
  boxes?: number;
  target?: number | null;       // 조정: 실사 박스 수(직전 = target − boxes)
  partner?: string | null;
  memo?: string | null;
  cancelled_at?: string | null;
  cancelled_by?: string | null;
  // 변경
  field?: string;
  old_value?: string | null;
  new_value?: string | null;
}

// ── 표기 ────────────────────────────────────────────────────────────
export const kgNum = (n: number) => Math.round(n * 100) / 100;
export const kgStr = (n: number) => `${kgNum(n).toLocaleString("ko-KR", { maximumFractionDigits: 2 })}kg`;
export const boxStr = (n: number) => `${n.toLocaleString("ko-KR")}박스`;

// 중량별 박스 — "16kg 3박스 · 10kg 2박스 · 총 68kg" (잔량 있는 로트만, 무거운 순)
export function weightBreakdown(lots: Pick<StockLot, "box_kg" | "boxes">[]): string {
  const by = new Map<number, number>();
  for (const l of lots) if (l.boxes !== 0) by.set(Number(l.box_kg), (by.get(Number(l.box_kg)) || 0) + l.boxes);
  if (by.size === 0) return "";
  const parts = [...by.entries()].sort((a, b) => b[0] - a[0]).map(([kg, b]) => `${kgStr(kg)} ${boxStr(b)}`);
  const total = [...by.entries()].reduce((s, [kg, b]) => s + kg * b, 0);
  return `${parts.join(" · ")} · 총 ${kgStr(total)}`;
}

// 로트 이름 — "제조 2026-09-01 · 16kg" (제조일자 없으면 '제조일 미상')
export function lotLabel(l: { mfg_date: string | null; box_kg: number }): string {
  return `${l.mfg_date ? `제조 ${l.mfg_date}` : "제조일 미상"} · ${kgStr(Number(l.box_kg))}`;
}

// 품목 변경 이력의 필드 이름
export const FIELD_LABEL: Record<string, string> = {
  등록: "품목 등록", 삭제: "품목 삭제",
  sku: "SKU", name: "품목", origin: "원산지", note: "비고",
  cost: "제품원가", price: "판매가", stock_tracked: "재고관리",
};

// ── 품목 입력 정리(등록·수정·엑셀 업로드 공용, 서버가 다시 검사) ──────────────────────────────────
export type ProductPatch = Partial<{
  sku: string; name: string; origin: string | null; note: string | null;
  cost: number | null; price: number | null; stock_tracked: boolean;
}>;
export const MASTER_FIELDS = ["sku", "name", "origin", "note", "stock_tracked"] as const; // 관리자만
export const PRICE_FIELDS = ["cost", "price"] as const;                                  // 모든 계정(이력 남김)

// 들어온 키만 정리한다(수정 = 부분 갱신). 잘못된 값은 error.
export function parseProductInput(b: Record<string, unknown>): { patch: ProductPatch; error?: string } {
  const patch: ProductPatch = {};
  const txt = (v: unknown) => { const s = String(v ?? "").trim(); return s || null; };
  if ("sku" in b) {
    const s = String(b.sku ?? "").trim().toUpperCase();
    if (!s) return { patch, error: "SKU 를 입력하세요." };
    if (s.length > 60) return { patch, error: "SKU 가 너무 깁니다." };
    patch.sku = s;
  }
  if ("name" in b) {
    const s = String(b.name ?? "").trim();
    if (!s) return { patch, error: "품목을 입력하세요." };
    patch.name = s;
  }
  if ("origin" in b) patch.origin = txt(b.origin);
  if ("note" in b) patch.note = txt(b.note);
  for (const k of PRICE_FIELDS) {
    if (!(k in b)) continue;
    const raw = String(b[k] ?? "").replace(/[,\s원]/g, "");
    if (!raw) { patch[k] = null; continue; }
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return { patch, error: `${k === "cost" ? "제품원가" : "판매가"}는 0 이상 숫자로 입력하세요.` };
    patch[k] = Math.round(n);
  }
  if ("stock_tracked" in b) patch.stock_tracked = b.stock_tracked !== false;
  return { patch };
}

// 변경 이력 값 — 문자열로 남긴다(null = 빈 값)
export function histValue(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v ? "사용" : "사용안함";
  return String(v);
}
