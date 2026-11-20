// 파도소리 예상 화면 — ERP 엑셀 두 개(출고 파일 · 매입생산 파일)를 읽어 '흐름'으로 나눈다. 순수 함수(브라우저·서버 공용).
//  규칙의 근거와 검증 수치: docs/factory-shipment-analysis.md · docs/factory-forecast-plan.md 3장.
//
//  ■ 중량은 파일의 중량 칸을 쓰지 않는다 — 수량 × 단위로 다시 계산한다(중량 칸은 합계가 7~23% 부풀어 있다).
//  ■ 같은 날·같은 품명·같은 규격·같은 수량인 행끼리 짝을 지어 흐름을 가른다.
//     생산 ↔ 매출 짝 = 주문 생산(그날 만들어 그날 나감) · 재료 ↔ 매입 짝 = 사자마자 현장 투입
//     짝이 없고 보관처가 적힌 생산 = 창고 생산 · 재료 = 현장 출고(반제품 투입) · 매출 = 거래처 출고(창고)

import { readXlsxRows, excelDate, type XlsxCell } from "./factory-xlsx-stream";

export const FLOW_KINDS = ["buy", "prod_stock", "use_floor", "ship_stock", "ship_order", "ship_etc"] as const;
export type FlowKind = (typeof FLOW_KINDS)[number];
export const FLOW_LABEL: Record<FlowKind, string> = {
  buy: "매입",
  prod_stock: "창고 생산",
  use_floor: "현장 출고",
  ship_stock: "거래처 출고(창고)",
  ship_order: "거래처 출고(그날 생산)",
  ship_etc: "거래처 출고(그 밖)",
};

export const WASTE_ITEM = "수산물잔재물";
export const BIG_KG = 3000; // 한 줄이 이 이상이면 예상에서 뺀다(한 번뿐인 대량 거래)

// 품명에 가공 형태가 붙으면 가공품, 아니면 원물(생산 권장은 가공품에만 낸다)
const FORMS = ["순살", "토막", "채", "살", "포", "구이", "두절", "머리", "뼈", "봉", "알", "필렛", "조림", "강정", "슬라이스", "스테이크", "명란"];
export const isProcessed = (item: string) => FORMS.some((f) => item.includes(f));

// 단위 칸 → 한 단위의 kg. 'KG' = 1, '10KG'·'22.5kg' = 그 숫자, 'C/S'·'박스' 등 = 알 수 없음(null)
export function unitKg(unit: string): number | null {
  const u = unit.trim().toUpperCase();
  if (u === "KG") return 1;
  const m = /^(\d+(?:\.\d+)?)\s*KG$/.exec(u);
  return m ? Number(m[1]) : null;
}
export function fixedKg(unit: string, qty: number, recorded: number | null): number {
  const k = unitKg(unit);
  return k != null ? qty * k : recorded ?? 0;
}

export type SrcKind = "매출" | "반품" | "재료" | "생산" | "매입";
export type SrcRow = {
  kind: SrcKind; date: string; item: string; spec: string;
  qty: number; kg: number; recorded: number | null;
  partner: string; supplier: string; store: string;
};
export type SrcFile = { type: "ship" | "prod"; rows: SrcRow[]; from: string; to: string };

const str = (v: XlsxCell) => (v == null ? "" : String(v));
const num = (v: XlsxCell) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// 엑셀 하나를 읽는다. 머리글로 어느 파일인지 알아낸다(출고 파일 = '매출일자'·'구분', 매입생산 파일 = '매입구분').
export async function readSourceFile(file: Blob, onProgress?: (ratio: number) => void): Promise<SrcFile> {
  let type: "ship" | "prod" | null = null;
  let col: Record<string, number> = {};
  const rows: SrcRow[] = [];
  let from = "9999", to = "0000";
  await readXlsxRows(file, (c, rowNo) => {
    if (rowNo === 1) {
      const idx: Record<string, number> = {};
      c.forEach((h, i) => { const k = str(h).trim(); if (k && !(k in idx)) idx[k] = i; });
      const need = (names: string[]) => names.every((n) => n in idx);
      if (need(["매입구분", "매입일자", "매입처", "보관처", "품명", "규격", "단위", "매입수량", "중량"])) type = "prod";
      else if (need(["구분", "매출일자", "매출처", "매입처", "보관처", "품명", "규격", "단위", "매출수량", "출고중량"])) type = "ship";
      else throw new Error("머리글이 맞지 않습니다. ERP 에서 받은 '원료출고제품매출현황' 또는 '매입생산현황' 파일을 고르세요.");
      col = idx;
      return;
    }
    const ship = type === "ship";
    const date = excelDate(c[col[ship ? "매출일자" : "매입일자"]] ?? null);
    if (!date) return;
    const kind = str(c[col[ship ? "구분" : "매입구분"]] ?? null).trim() as SrcKind;
    if (ship ? !(kind === "매출" || kind === "반품" || kind === "재료") : !(kind === "생산" || kind === "매입")) return;
    const qty = num(c[col[ship ? "매출수량" : "매입수량"]] ?? null);
    const rv = c[col[ship ? "출고중량" : "중량"]] ?? null;
    const recorded = typeof rv === "number" ? rv : null;
    const unit = str(c[col["단위"]] ?? null);
    rows.push({
      kind, date,
      item: str(c[col["품명"]] ?? null), spec: str(c[col["규격"]] ?? null),
      qty, kg: fixedKg(unit, qty, recorded), recorded,
      partner: ship ? str(c[col["매출처"]] ?? null) : "",
      supplier: str(c[col["매입처"]] ?? null),
      store: str(c[col["보관처"]] ?? null).trim(),
    });
    if (date < from) from = date;
    if (date > to) to = date;
  }, onProgress);
  if (!type) throw new Error("빈 파일입니다.");
  if (!rows.length) throw new Error("읽을 수 있는 행이 없습니다.");
  return { type, rows, from, to };
}

// 저장 한 줄 = [일자, 흐름, 품명, 거래처, kg, 가공품(1/0), 대량(1/0)]
export type FlowTuple = [string, FlowKind, string, string, number, 0 | 1, 0 | 1];
export type FlowSummary = {
  from: string; to: string;
  srcRows: number;            // 두 파일의 원본 행 수
  rows: number;               // 합쳐서 저장할 줄 수
  items: number;              // 품명 수
  changed: number;            // 중량을 다시 계산해 파일 값과 달라진 행 수
  kg: Record<FlowKind, number>; // 흐름별 합계(대량 거래·잔재물 제외)
  big: number;                // 뺀 대량 거래 행 수(잔재물 제외)
  bigKg: number;
  wasteKg: number;            // 수산물잔재물 출고
};

type Tagged = SrcRow & { tag?: string };

// a 의 각 행을 b 에서 같은 열쇠(일자·품명·규격·수량)인 행 하나와 짝짓는다. 짝이 된 양쪽에 꼬리표를 단다.
function pair(a: Tagged[], b: Tagged[], tagA: string, tagB: string) {
  const key = (r: SrcRow) => `${r.date}|${r.item}|${r.spec}|${Math.round(r.qty * 1000)}`;
  const idx = new Map<string, Tagged[]>();
  for (const y of b) { const k = key(y); const l = idx.get(k); if (l) l.push(y); else idx.set(k, [y]); }
  for (const x of a) {
    const y = idx.get(key(x))?.pop();
    if (y) { x.tag = tagA; y.tag = tagB; }
  }
}

export function buildFlows(ship: SrcFile, prod: SrcFile): { rows: FlowTuple[]; summary: FlowSummary } {
  const sale = ship.rows.filter((r) => r.kind === "매출") as Tagged[];
  const back = ship.rows.filter((r) => r.kind === "반품");
  const mat = ship.rows.filter((r) => r.kind === "재료") as Tagged[];
  const made = prod.rows.filter((r) => r.kind === "생산") as Tagged[];
  const buy = prod.rows.filter((r) => r.kind === "매입") as Tagged[];
  pair(made, sale, "order", "order");
  pair(mat, buy, "direct", "direct");

  const agg = new Map<string, FlowTuple>();
  const items = new Set<string>();
  const kg: Record<FlowKind, number> = { buy: 0, prod_stock: 0, use_floor: 0, ship_stock: 0, ship_order: 0, ship_etc: 0 };
  let big = 0, bigKg = 0, wasteKg = 0;
  const add = (r: SrcRow, kind: FlowKind, partner: string) => {
    const waste = r.item === WASTE_ITEM;
    const isBig = waste || Math.abs(r.kg) >= BIG_KG;
    if (waste) { if (kind === "ship_order" || kind === "ship_stock" || kind === "ship_etc") wasteKg += r.kg; }
    else if (isBig) { big++; bigKg += r.kg; }
    else kg[kind] += r.kg;
    items.add(r.item);
    // 거래처는 창고 출고(몰림 표시용)와 대량 거래(목록 표시용)에만 남긴다 — 나머지는 일자 × 품명으로 합친다
    const p = kind === "ship_stock" || isBig ? partner : "";
    const k = `${r.date}|${kind}|${r.item}|${p}|${isBig ? 1 : 0}`;
    const cur = agg.get(k);
    if (cur) cur[4] += r.kg;
    else agg.set(k, [r.date, kind, r.item, p, r.kg, isProcessed(r.item) ? 1 : 0, isBig ? 1 : 0]);
  };
  for (const r of buy) add(r, "buy", r.supplier);
  for (const r of made) if (r.tag !== "order" && r.store) add(r, "prod_stock", "");
  for (const r of mat) if (r.tag !== "direct" && r.store) add(r, "use_floor", "");
  for (const r of sale) add(r, r.tag === "order" ? "ship_order" : r.store ? "ship_stock" : "ship_etc", r.partner);
  for (const r of back) add(r, "ship_etc", r.partner);

  const rows = [...agg.values()].filter((t) => Math.abs(t[4]) >= 0.0005);
  for (const t of rows) t[4] = Math.round(t[4] * 1000) / 1000;
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const all = [...ship.rows, ...prod.rows];
  const changed = all.filter((r) => r.recorded != null && Math.abs(r.kg - r.recorded) > Math.max(0.5, Math.abs(r.recorded) * 0.02)).length;
  for (const k of FLOW_KINDS) kg[k] = Math.round(kg[k]);
  return {
    rows,
    summary: {
      from: ship.from < prod.from ? ship.from : prod.from,
      to: ship.to > prod.to ? ship.to : prod.to,
      srcRows: all.length, rows: rows.length, items: items.size, changed, kg,
      big, bigKg: Math.round(bigKg), wasteKg: Math.round(wasteKg),
    },
  };
}

// 두 파일의 기간이 같아야 짝짓기가 맞는다 — 시작·끝이 사흘 넘게 다르면 올리지 못하게 한다
export function rangeProblem(ship: SrcFile, prod: SrcFile): string | null {
  const gap = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400e3;
  if (gap(ship.from, prod.from) > 3 || gap(ship.to, prod.to) > 3)
    return `두 파일의 기간이 다릅니다 — 출고 ${ship.from}~${ship.to}, 매입생산 ${prod.from}~${prod.to}. 같은 기간으로 받아 함께 올리세요.`;
  return null;
}
