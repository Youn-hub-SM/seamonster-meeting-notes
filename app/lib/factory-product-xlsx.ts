// 파도소리 상품마스터 엑셀 추출/업로드 공용 스키마 — 씨몬스터 상품 마스터(b2b-product-xlsx.ts)와 같은 방식.
//  추출과 업로드가 같은 열을 쓴다(드리프트 방지). 매칭 키는 ID — ID 가 비면 SKU 로 찾고, 그래도 없으면 신규.
//  파일에 없는 열은 건드리지 않는다(열을 지운 양식을 올려도 기존 값이 지워지지 않게). 변경은 바뀐 칸만 보낸다.
//  DB 코드 없음(서버·화면 공용). 매칭 규칙은 planFactoryImport 한 곳 — 라우트는 파일 읽기와 DB 조회만.
import { parseProductInput, histValue, type FactoryProduct, type ProductPatch } from "./factory";

// 엑셀 헤더(순서 = 출력 순서). 업로드는 헤더 이름으로 칸을 찾으므로 열 순서가 바뀌어도 된다.
export const FACTORY_XLSX_HEADERS = ["ID", "SKU", "품목", "원산지", "비고", "제품원가", "판매가", "재고관리(Y/N)"] as const;
export type FactoryXlsxHeader = (typeof FACTORY_XLSX_HEADERS)[number];

// 비교·미리보기에 쓰는 칸(엑셀 헤더 이름을 그대로 라벨로)
export const FACTORY_DIFF_FIELDS: { key: "sku" | "name" | "origin" | "note" | "cost" | "price" | "stock_tracked"; label: string }[] = [
  { key: "sku", label: "SKU" },
  { key: "name", label: "품목" },
  { key: "origin", label: "원산지" },
  { key: "note", label: "비고" },
  { key: "cost", label: "제품원가" },
  { key: "price", label: "판매가" },
  { key: "stock_tracked", label: "재고관리" },
];

// 품목 → 엑셀 행
export function factoryProductToRow(p: FactoryProduct): Record<FactoryXlsxHeader, string | number> {
  return {
    ID: p.id,
    SKU: p.sku,
    품목: p.name,
    원산지: p.origin ?? "",
    비고: p.note ?? "",
    제품원가: p.cost == null ? "" : Number(p.cost),
    판매가: p.price == null ? "" : Number(p.price),
    "재고관리(Y/N)": p.stock_tracked === false ? "N" : "Y",
  };
}

// '재고관리(Y/N)' 칸의 '안 씀' 값 — 씨몬스터 상품 마스터(b2b-product-xlsx)와 같은 목록 + 파도소리 화면 표기(사용안함)
const TRACK_OFF = /^(n|no|안함|안 함|사용안함|사용 안함|미사용|false|0|x)$/i;

// 엑셀 행(헤더 → 셀 문자열) → 입력값. 검증·정리는 parseProductInput 이 한다.
//  has(h)=false 인 열(파일에 없는 열)은 넣지 않는다 — 그 칸은 기존 값 그대로. SKU·품목은 필수 열.
export function factoryRowToInput(get: (h: string) => string, has: (h: string) => boolean): { id: string; input: Record<string, unknown> } {
  const input: Record<string, unknown> = { sku: get("SKU"), name: get("품목") || get("품목명") };
  if (has("원산지")) input.origin = get("원산지");
  if (has("비고")) input.note = get("비고");
  if (has("제품원가")) input.cost = get("제품원가");
  if (has("판매가")) input.price = get("판매가");
  if (has("재고관리(Y/N)")) input.stock_tracked = !TRACK_OFF.test(get("재고관리(Y/N)").trim());
  return { id: get("ID").trim(), input };
}

// 미리보기 표시값
export function factoryDisplayValue(key: string, v: unknown): string {
  if (key === "stock_tracked") return v === false ? "사용안함" : "사용";
  if (v === null || v === undefined || v === "") return "(없음)";
  if ((key === "cost" || key === "price") && Number.isFinite(Number(v))) return `${Number(v).toLocaleString("ko-KR")}원`;
  return String(v);
}

// ── 업로드 미리보기 계획(순수 함수) ─────────────────────────────────
// 변경 행 = id + 바뀐 칸만(+ 메시지용 label — 저장하지 않는다). 신규 행 = 파일의 전 칸.
export type ImportRow = ProductPatch & { id?: string; label?: string };
export type ImportChange = { label: string; from: string; to: string };
export type ImportPlan = {
  summary: { creates: number; updates: number; unchanged: number; errors: number };
  creates: { name: string; row: ImportRow }[];
  updates: { id: string; name: string; changes: ImportChange[]; row: ImportRow }[];
  errors: { line: number; msg: string }[];
};

// rows: 엑셀 데이터 행(line = 엑셀 행 번호, get = 헤더 이름으로 셀 문자열). existing: DB 의 전 품목. has = 파일에 있는 열인가.
//  매칭: ID → (ID 가 비면) SKU(대소문자 무시) → 둘 다 없으면 신규.
//  막는 것: 없는 ID · 파일 안 SKU 중복 · 파일 안 같은 품목 두 번 · 다른 품목이 쓰는 SKU · 값 오류(행 단위로 제외).
export function planFactoryImport(
  rows: { line: number; get: (h: string) => string }[],
  existing: FactoryProduct[],
  has: (h: string) => boolean,
): ImportPlan {
  const byId = new Map<string, FactoryProduct>();
  const bySku = new Map<string, FactoryProduct>();
  for (const p of existing) { byId.set(p.id, p); bySku.set(String(p.sku).toUpperCase(), p); }
  const skuInFile = new Map<string, number>();
  const targetInFile = new Map<string, number>();
  const plan: ImportPlan = { summary: { creates: 0, updates: 0, unchanged: 0, errors: 0 }, creates: [], updates: [], errors: [] };
  const err = (line: number, msg: string) => plan.errors.push({ line, msg });

  for (const { line, get } of rows) {
    if (!get("ID") && !get("SKU") && !get("품목") && !get("품목명")) continue; // 빈 행
    const { id, input } = factoryRowToInput(get, has);
    const { patch, error: bad } = parseProductInput(input);
    if (bad) { err(line, bad); continue; }
    const skuKey = patch.sku!.toUpperCase();

    let prev: FactoryProduct | undefined;
    if (id) {
      prev = byId.get(id);
      if (!prev) { err(line, `ID 를 찾을 수 없습니다(${id.slice(0, 8)}…). 신규면 ID 칸을 비우세요.`); continue; }
    } else prev = bySku.get(skuKey);

    const dupSku = skuInFile.get(skuKey);
    if (dupSku !== undefined) { err(line, `SKU '${patch.sku}' 가 이 파일의 ${dupSku}행과 중복됩니다.`); continue; }
    if (prev) {
      const dupT = targetInFile.get(prev.id);
      if (dupT !== undefined) { err(line, `같은 품목(${prev.name})이 이 파일의 ${dupT}행에도 있습니다.`); continue; }
    }
    const owner = bySku.get(skuKey);
    if (owner && owner.id !== prev?.id) { err(line, `SKU '${patch.sku}' 는 이미 다른 품목(${owner.name})이 쓰고 있습니다.`); continue; }
    skuInFile.set(skuKey, line);
    if (prev) targetInFile.set(prev.id, line);

    if (!prev) {
      if (!("stock_tracked" in patch)) patch.stock_tracked = true;
      plan.creates.push({ name: patch.name!, row: patch });
      continue;
    }
    // 바뀐 칸만 — 미리보기 뒤 다른 곳(재고 화면 가격 수정 등)에서 바꾼 칸을 파일 값으로 되돌리지 않게
    const changes: ImportChange[] = [];
    const row: ImportRow = { id: prev.id, label: prev.name };
    for (const { key, label } of FACTORY_DIFF_FIELDS) {
      if (!(key in patch)) continue; // 파일에 없는 열
      const a = (prev as unknown as Record<string, unknown>)[key];
      const b = (patch as Record<string, unknown>)[key];
      if (histValue(a) !== histValue(b)) {
        changes.push({ label, from: factoryDisplayValue(key, a), to: factoryDisplayValue(key, b) });
        (row as Record<string, unknown>)[key] = b;
      }
    }
    if (changes.length === 0) { plan.summary.unchanged++; continue; }
    plan.updates.push({ id: prev.id, name: patch.name ?? prev.name, changes, row });
  }
  plan.summary.creates = plan.creates.length;
  plan.summary.updates = plan.updates.length;
  plan.summary.errors = plan.errors.length;
  return plan;
}
