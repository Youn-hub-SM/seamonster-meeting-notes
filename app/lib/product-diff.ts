// 상품 마스터 변경 diff — 추적 대상 필드의 before→after 를 계산해 활동 로그(meta.changes)에 남김.
//  값 비교는 타입 흔들림(3 vs "3", null vs "")을 정규화해 '실제로 바뀐 것'만 잡는다.

export type ProductFieldChange = { field: string; label: string; from: string; to: string };

type FieldKind = "money" | "text" | "bool" | "num";
type FieldDef = { key: string; label: string; kind: FieldKind };

// products 테이블에서 사람이 바꾸는 컬럼(감사 대상). updated_at/created_at 등 시스템 컬럼 제외.
export const PRODUCT_DIFF_FIELDS: FieldDef[] = [
  { key: "name", label: "품목명", kind: "text" },
  { key: "sku", label: "SKU", kind: "text" },
  { key: "spec", label: "옵션", kind: "text" },
  { key: "unit", label: "단위", kind: "text" },
  { key: "cost_price", label: "원가", kind: "money" },
  { key: "purchase_price", label: "매입단가", kind: "money" },
  { key: "retail_price", label: "소비자가", kind: "money" },
  { key: "sale_price", label: "b2b도매가", kind: "money" },
  { key: "tax_type", label: "과세유형", kind: "text" },
  { key: "active", label: "사용여부", kind: "bool" },
  { key: "origin", label: "원산지", kind: "text" },
  { key: "attrs", label: "속성/분류", kind: "text" },
  { key: "notes", label: "비고", kind: "text" },
  { key: "cost_material", label: "제품원가", kind: "money" },
  { key: "pkg_inner", label: "내포장지", kind: "money" },
  { key: "pkg_label", label: "라벨", kind: "money" },
  { key: "pkg_outer", label: "외포장지", kind: "money" },
  { key: "volume_kg", label: "제품부피(kg)", kind: "num" },
  { key: "courier_name", label: "택배 상품명", kind: "text" },
  { key: "courier_weight", label: "택배 중량(kg)", kind: "num" },
  { key: "scan_name", label: "송장 스캔명", kind: "text" },
];

// 표시용 포맷
function fmt(v: unknown, kind: FieldKind): string {
  if (v === null || v === undefined || v === "") return "―";
  if (kind === "bool") return v ? "사용" : "미사용";
  if (kind === "money") return `${(Number(v) || 0).toLocaleString()}원`;
  return String(v);
}
// 비교용 정규화
function norm(v: unknown, kind: FieldKind): string {
  if (v === null || v === undefined) return "";
  if (kind === "bool") return v ? "1" : "0";
  if (kind === "money" || kind === "num") return String(Number(v) || 0);
  return String(v).trim();
}

// before/after 객체에서 바뀐 추적 필드만 반환. 부분 객체(일부 키만)도 안전 — 없는 키는 "" 취급.
export function diffProduct(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
  fields: FieldDef[] = PRODUCT_DIFF_FIELDS
): ProductFieldChange[] {
  const out: ProductFieldChange[] = [];
  for (const f of fields) {
    const b = before ? before[f.key] : undefined;
    const a = after ? after[f.key] : undefined;
    if (norm(b, f.kind) === norm(a, f.kind)) continue;
    out.push({ field: f.key, label: f.label, from: fmt(b, f.kind), to: fmt(a, f.kind) });
  }
  return out;
}
