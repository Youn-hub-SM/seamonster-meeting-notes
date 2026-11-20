// 파도소리 기록 → ERP 엑셀 두 양식의 줄. 순수 함수(서버가 엑셀로 쓰고, 검증 스크립트도 같이 쓴다).
//  열 이름·순서는 ERP 에서 받은 파일과 같다 — 내려받은 파일을 [예상] 화면의 [데이터 올리기]에 그대로 넣을 수 있다.
//  기획·대응표: docs/factory-ledger-export-plan.md 2~3장.
//
//  구분 → 양식
//   입고·생산(구분 없는 옛 입고 포함)  → 매입생산 파일 '생산'
//   입고·매입                          → 매입생산 파일 '매입'
//   입고·반품                          → 출고 파일 '반품'(수량 음수)
//   출고·매출(구분 없는 옛 출고 포함)  → 출고 파일 '매출'
//   출고·현장투입                      → 출고 파일 '재료'(적요 앞에 '현장')
//   이동                               → 들어온 쪽 '생산'(적요 '○○이고') + 나간 쪽 '재료'(적요 '현장○○이고') — ERP 가 적는 방식 그대로
//   조정                               → 내보내지 않는다

import { DEFAULT_STORAGE, type TxnKind } from "./factory";

export const SHIP_HEADERS = ["매출일자", "매출처", "매입처", "매입일자", "입고일자", "보관처", "본선명", "적요", "품명", "규격", "단위", "원산지", "구분", "매출수량", "매출단가", "매출금액", "부가세", "매출총금액", "매입단가", "손익금액", "마진율", "손익단가", "매입비용", "출고중량", "수율", "차입처", "상환단가", "상환금액", "취급자", "상하차비", "입출고비", "냉장료", "냉동비", "발췌료", "노무비", "재료비", "전기세", "기타비"] as const;
export const PROD_HEADERS = ["매입일자", "매입구분", "입고일자", "매입처", "본선명", "보관처", "적요", "품명", "규격", "단위", "원산지", "매입수량", "중량", "수율", "매입단가", "매입금액", "부가세", "매입총금액", "수입신고번호", "수입신고일자", "소비기한", "상하차비", "입출고비", "냉장료", "냉동비", "발췌료", "노무비", "재료비", "전기세", "기타비"] as const;
export const SHIP_DATE_COLS = ["매출일자", "매입일자", "입고일자"];
export const PROD_DATE_COLS = ["매입일자", "입고일자"];
export const SELF = "파도소리㈜";

export type ExportTxn = {
  id: string; product_id: string; txn_date: string; type: "입고" | "출고" | "조정";
  mfg_date: string | null; kg: number; box_kg: number | null;
  partner: string | null; tape_color: string | null; created_by: string | null;
  kind: TxnKind | null; storage: string | null; unit_price: number | null; move_id: string | null;
};
export type ExportProduct = { name: string; spec: string | null; origin: string | null };
export type ExportCell = string | number | null;
export type ExportRow = Record<string, ExportCell>;

const lotKey = (t: { product_id: string; mfg_date: string | null; box_kg: number | null; storage: string | null }) =>
  `${t.product_id}|${t.mfg_date ?? ""}|${t.box_kg == null ? "" : Number(t.box_kg)}|${t.storage || DEFAULT_STORAGE}`;

// 단위·수량 — 박스 중량이 있고 박스 수가 딱 떨어지면 '16KG' × 박스 수, 아니면 'KG' × kg
function unitQty(kgAbs: number, box_kg: number | null): { unit: string; qty: number; unitKg: number } {
  if (box_kg && box_kg > 0) {
    const boxes = kgAbs / box_kg;
    if (Math.abs(boxes - Math.round(boxes)) < 1e-6) return { unit: `${Number(box_kg)}KG`, qty: Math.round(boxes), unitKg: box_kg };
  }
  return { unit: "KG", qty: Math.round(kgAbs * 1000) / 1000, unitKg: 1 };
}

// txns = 기간 안의 취소 안 된 기록. lotTxns = 로트의 입고일·테잎색을 찾을 입고 기록 전부(기간 밖 포함, 최신순). moves = 기간 안 이동의 짝 전부.
export function buildExportRows(
  txns: ExportTxn[],
  products: Map<string, ExportProduct>,
  lotIns: { product_id: string; mfg_date: string | null; box_kg: number | null; storage: string | null; txn_date: string; tape_color: string | null }[],
  moves: { move_id: string; type: "입고" | "출고"; storage: string | null }[],
): { ship: ExportRow[]; prod: ExportRow[] } {
  // 로트마다 가장 이른 입고일과 가장 최근에 적은 테잎색
  const firstIn = new Map<string, string>(), tape = new Map<string, string>();
  for (const t of lotIns) {
    const k = lotKey(t);
    if (!firstIn.has(k) || t.txn_date < firstIn.get(k)!) firstIn.set(k, t.txn_date);
    if (t.tape_color && !tape.has(k)) tape.set(k, t.tape_color);
  }
  const moveFrom = new Map<string, string>(), moveTo = new Map<string, string>();
  for (const m of moves) (m.type === "출고" ? moveFrom : moveTo).set(m.move_id, m.storage || DEFAULT_STORAGE);

  const ship: ExportRow[] = [], prod: ExportRow[] = [];
  for (const t of txns) {
    if (t.type === "조정") continue;
    const p = products.get(t.product_id);
    if (!p) continue;
    const storage = t.storage || DEFAULT_STORAGE;
    const kgAbs = Math.abs(t.kg);
    const { unit, qty, unitKg } = unitQty(kgAbs, t.box_kg);
    const price = t.unit_price == null ? null : Math.round(t.unit_price * unitKg);       // 단위당 단가
    const amount = t.unit_price == null ? null : Math.round(t.unit_price * kgAbs);
    const lk = lotKey(t);
    const tapeOf = t.tape_color || tape.get(lk) || "";
    const common = { 본선명: "", 보관처: storage, 품명: p.name, 규격: p.spec || ".", 단위: unit, 원산지: p.origin || "." };
    const kind: TxnKind = t.kind || (t.type === "입고" ? "생산" : "매출");

    if (t.type === "입고" && kind !== "반품") {
      const buy = kind === "매입";
      prod.push({
        ...common,
        매입일자: t.txn_date, 매입구분: buy ? "매입" : "생산", 입고일자: t.txn_date,
        매입처: buy ? t.partner || "" : SELF,
        적요: kind === "이동" ? `${moveFrom.get(t.move_id || "") || ""}이고` : tapeOf,
        매입수량: qty, 중량: kgAbs,
        매입단가: buy ? price : null, 매입금액: buy ? amount ?? 0 : 0, 매입총금액: buy ? amount ?? 0 : 0,
      });
      continue;
    }
    // 출고 파일 — 매출 · 재료(현장 투입·이동으로 나감) · 반품
    const sign = kind === "반품" ? -1 : 1;
    const material = kind === "현장투입" || kind === "이동";
    const inDate = firstIn.get(lk) || t.mfg_date || t.txn_date;
    ship.push({
      ...common,
      매출일자: t.txn_date,
      매출처: material ? SELF : t.partner || "",
      매입처: SELF, 매입일자: inDate, 입고일자: inDate,
      적요: kind === "이동" ? `현장${moveTo.get(t.move_id || "") || ""}이고` : material ? `현장${tapeOf}` : tapeOf,
      구분: kind === "반품" ? "반품" : material ? "재료" : "매출",
      매출수량: sign * qty,
      매출단가: material ? null : price,
      매출금액: material || amount == null ? null : sign * amount,
      매출총금액: material || amount == null ? 0 : sign * amount,
      출고중량: sign * kgAbs,
      취급자: t.created_by || "",
    });
  }
  const byDate = (col: string) => (a: ExportRow, b: ExportRow) => String(a[col]).localeCompare(String(b[col]));
  ship.sort(byDate("매출일자")); prod.sort(byDate("매입일자"));
  return { ship, prod };
}
