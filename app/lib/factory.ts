// 파도소리(제조사) 재고 — 공용 타입·상수·표기(클라이언트/서버 공용, DB 코드 없음).
//  품목 마스터 1행 = SKU 1개. 재고는 원장(factory.stock_txns)의 kg 합계이고, 같은 품목 안에서
//  [제조일자 × 박스 중량]이 다르면 따로 센다(= 로트). 수량 기준은 kg(2026-10-22 대표: 원물 관리라 총 kg)이고
//  박스 수는 kg ÷ 박스 중량으로 보인다(소수 가능 — 대표: "박스가 보이면서 기준은 kg"). 박스 중량 없는 로트는 kg 만.
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
  spec: string | null;      // 규격(자유 입력, factory/006). 로트 구분에는 안 쓴다
  origin: string | null;
  note: string | null;
  cost: number | null;
  price: number | null;
  stock_tracked: boolean;
  created_at?: string;
  updated_at?: string;
}

// 로트 = 품목 × 제조일자 × 박스 중량 (factory.stock_lots 뷰 1행, 단위 kg · 박스 수 = kg ÷ box_kg)
export interface StockLot {
  mfg_date: string | null;
  box_kg: number | null;        // 박스 중량(없으면 kg 만)
  kg: number;                   // 현재 kg
  in_kg: number;
  out_kg: number;
  adj_kg: number;
  in_date: string | null;       // 이 로트의 첫 입고일(입고 없이 조정으로 생긴 로트면 첫 기록일)
  last_in_date: string | null;
}

// 재고 화면 1행 — 품목 + 합계 + 로트 (단위 kg)
export interface StockRow extends FactoryProduct {
  kg: number;                   // 현재 수량(kg)
  in_kg: number;                // 총 입고(누적)
  out_kg: number;               // 총 출고(누적)
  adj_kg: number;               // 조정 합(±)
  last_in_date: string | null;  // 최신 입고일
  oldest_in_date: string | null; // 최고령 입고일 = 남은 재고 중 가장 오래된 입고일
  lots: StockLot[];             // 잔량 있는 로트 먼저, 오래된 순
  // 기간(재고 목록 기간 탭) — 거래일이 기간 안인 입고·출고(취소 제외). 조정은 넣지 않는다(씨몬스터 재고 목록과 같은 뜻).
  period_in_kg: number;
  period_out_kg: number;
  daily_out_kg: number;         // 하루 출고(kg) = 기간 출고 ÷ 기간 일수
  depletion_days: number | null; // 예상소진(일) = 현재 kg ÷ 하루 출고. 기간 출고가 없으면 null
  value: number | null;         // 재고자산(원) = 남은 kg × kg당 제품원가. 원가 미입력이면 null
}

// 재고 목록 응답의 기간 정보
export interface StockMeta { from: string; to: string; periodDays: number }

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
  kg?: number;                  // 부호 있는 kg(입고 +, 출고 −, 조정 ±)
  target_kg?: number | null;    // 조정: 실사 kg(직전 = target_kg − kg)
  box_kg?: number | null;       // 참고: 박스 중량(입고 때 적은 값)
  boxes?: number | null;        // 참고: 박스 수(부호 있음)
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

// 부호 붙인 kg — "+340kg" / "−120kg"
export const signedKg = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${kgStr(Math.abs(n))}`;

// 박스 수 — kg ÷ 박스 중량(소수 둘째 자리). 박스 중량이 없으면 null
export const boxesOf = (kg: number, box_kg: number | null | undefined) =>
  box_kg && Number(box_kg) > 0 ? Math.round((kg / Number(box_kg)) * 100) / 100 : null;
// 소수 박스 표기 — "21.25박스"
export const boxQty = (n: number) => `${n.toLocaleString("ko-KR", { maximumFractionDigits: 2 })}박스`;
// kg 뒤에 박스를 괄호로 — "340kg (21.25박스)". 박스 중량이 없으면 kg 만
export function kgBox(kg: number, box_kg: number | null | undefined): string {
  const b = boxesOf(kg, box_kg);
  return b == null ? kgStr(kg) : `${kgStr(kg)} (${boxQty(Math.abs(b))})`;
}
// 박스 중량별 묶음 — 잔량 있는 로트만, 무거운 순. 중량 없는 로트는 box_kg=null, boxes=null(kg 만)
export function boxGroups(lots: Pick<StockLot, "box_kg" | "kg">[]): { box_kg: number | null; kg: number; boxes: number | null }[] {
  const by = new Map<number | null, number>();
  for (const l of lots) if (l.kg !== 0) by.set(l.box_kg, (by.get(l.box_kg) || 0) + l.kg);
  return [...by.entries()].sort((a, b) => (b[0] ?? -1) - (a[0] ?? -1))
    .map(([box_kg, kg]) => ({ box_kg, kg: kgNum(kg), boxes: boxesOf(kg, box_kg) }));
}
const groupLabel = (g: { box_kg: number | null; kg: number; boxes: number | null }) =>
  g.box_kg && g.boxes != null ? `${kgStr(g.box_kg)} ${boxQty(g.boxes)}` : `중량 미상 ${kgStr(g.kg)}`;

// 박스 중량별 박스 수 전체 — "16kg 21.25박스 · 10kg 10박스" (툴팁·펼침용)
export function boxBreakdown(lots: Pick<StockLot, "box_kg" | "kg">[]): string {
  return boxGroups(lots).map(groupLabel).join(" · ");
}
// 한 줄 요약 — 중량이 2종 이하면 전부, 3종 이상이면 "총 7박스 · 4종"(중량 미상분은 종수에만). 목록·표처럼 자리가 좁은 곳용.
//  전체는 boxBreakdown 으로 툴팁이나 펼침에 보여 준다. (2026-10-22 대표: 중량 종류가 많아지면 목록이 길어져 레이아웃이 깨진다)
export function boxSummary(lots: Pick<StockLot, "box_kg" | "kg">[], max = 2): string {
  const gs = boxGroups(lots);
  if (gs.length === 0) return "";
  if (gs.length <= max) return gs.map(groupLabel).join(" · ");
  const total = Math.round(gs.reduce((s, g) => s + (g.boxes ?? 0), 0) * 100) / 100;
  return `총 ${boxQty(total)} · ${gs.length}종`;
}

// 같은 품목 판정 키 = 품목명·규격·원산지 셋이 모두 같을 때(공백 정리·대소문자 무시, 2026-10-22 대표 규칙).
//  상품마스터 등록·수정과 입고 창 즉시 등록(quick)이 같은 키를 쓴다.
export const productKey = (p: { name: string; spec?: string | null; origin?: string | null }) =>
  [p.name, p.spec || "", p.origin || ""].map((v) => String(v).trim().replace(/\s+/g, " ").toLowerCase()).join("|");

// 품목 표기 — 규격이 있으면 "갈치두절 150/200" (화면·알림 공용)
export function productLabel(p: { name: string; spec?: string | null }): string {
  return p.spec ? `${p.name} ${p.spec}` : p.name;
}

// 로트 이름 — "제조 2026-09-01 · 16kg박스" (제조일자 없으면 '제조일 미상', 박스 중량 없으면 날짜만)
export function lotLabel(l: { mfg_date: string | null; box_kg?: number | null }): string {
  const d = l.mfg_date ? `제조 ${l.mfg_date}` : "제조일 미상";
  return l.box_kg ? `${d} · ${kgStr(Number(l.box_kg))}박스` : d;
}

// 품목 변경 이력의 필드 이름
export const FIELD_LABEL: Record<string, string> = {
  등록: "품목 등록", 삭제: "품목 삭제",
  sku: "SKU", name: "품목", spec: "규격", origin: "원산지", note: "비고",
  cost: "제품원가", price: "판매가", stock_tracked: "재고관리",
};

// ── 품목 입력 정리(등록·수정·엑셀 업로드 공용, 서버가 다시 검사) ──────────────────────────────────
export type ProductPatch = Partial<{
  sku: string; name: string; spec: string | null; origin: string | null; note: string | null;
  cost: number | null; price: number | null; stock_tracked: boolean;
}>;
export const MASTER_FIELDS = ["sku", "name", "spec", "origin", "note", "stock_tracked"] as const; // 관리자만
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
  if ("spec" in b) {
    const v = txt(b.spec);
    if (v && v.length > 60) return { patch, error: "규격이 너무 깁니다(60자까지)." };
    patch.spec = v;
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
