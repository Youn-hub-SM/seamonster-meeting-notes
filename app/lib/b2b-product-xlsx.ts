// 상품 마스터 엑셀 추출/업로드 공용 스키마 — export 와 import 가 같은 컬럼을 공유(드리프트 방지).
//  매칭 키는 ID(SKU 는 중복 허용이라 키로 못 씀). ID 가 비면 신규 등록.
import type { Product, ProductInput, TaxType } from "./b2b-types";

// 엑셀 헤더(순서 = 출력 순서). import 는 헤더 이름으로 셀을 찾으므로 열 순서가 바뀌어도 동작.
export const PRODUCT_XLSX_HEADERS = [
  "ID", "SKU", "품목명", "옵션", "단위", "과세유형",
  "소비자가", "b2b도매가", "매입단가",
  "제품원가", "내포장지", "라벨", "외포장지", "원가직접입력",
  "부피kg", "택배상품명", "택배중량kg", "송장스캔명", "사용(Y/N)", "원산지", "속성", "비고",
] as const;

const num = (v: unknown): number => {
  const s = String(v ?? "").replace(/[,\s₩]/g, "");
  return s === "" ? 0 : Number(s) || 0;
};

// 제품 → 엑셀 행(헤더 → 값)
export function productToRow(p: Product): Record<string, string | number> {
  return {
    ID: p.id,
    SKU: p.sku ?? "",
    품목명: p.name,
    옵션: p.spec ?? "",
    단위: p.unit,
    과세유형: p.tax_type === "exempt" ? "면세" : "과세",
    소비자가: Number(p.retail_price) || 0,
    b2b도매가: Number(p.sale_price) || 0,
    매입단가: Number(p.purchase_price) || 0,
    제품원가: Number(p.cost_material) || 0,
    내포장지: Number(p.pkg_inner) || 0,
    라벨: Number(p.pkg_label) || 0,
    외포장지: Number(p.pkg_outer) || 0,
    원가직접입력: Number(p.cost_price) || 0,
    부피kg: p.volume_kg == null ? "" : Number(p.volume_kg),
    택배상품명: p.courier_name ?? "",
    택배중량kg: Number(p.courier_weight) || 0,
    송장스캔명: p.scan_name ?? "",
    "사용(Y/N)": p.active ? "Y" : "N",
    원산지: p.origin ?? "",
    속성: p.attrs ?? "",
    비고: p.notes ?? "",
  };
}

// 엑셀 행(헤더→셀문자열 조회 함수) → ProductInput + id
export function rowToInput(get: (header: string) => string): { id: string; input: ProductInput } {
  const id = get("ID").trim();
  const tax: TaxType = /면/.test(get("과세유형")) ? "exempt" : "taxable";
  const volRaw = String(get("부피kg") ?? "").replace(/[,\s]/g, "");
  const activeRaw = get("사용(Y/N)").trim();
  const input: ProductInput = {
    id: id || undefined,
    sku: get("SKU"),
    name: get("품목명").trim(),
    spec: get("옵션"),
    unit: get("단위") || "개",
    tax_type: tax,
    retail_price: num(get("소비자가")),
    sale_price: num(get("b2b도매가")),
    purchase_price: num(get("매입단가")),
    cost_material: num(get("제품원가")),
    pkg_inner: num(get("내포장지")),
    pkg_label: num(get("라벨")),
    pkg_outer: num(get("외포장지")),
    cost_price: num(get("원가직접입력")),
    volume_kg: volRaw === "" ? null : Number(volRaw) || 0,
    courier_name: get("택배상품명").trim(),
    courier_weight: num(get("택배중량kg")),
    scan_name: get("송장스캔명").trim(),
    active: !/^(n|no|미사용|false|0|x)$/i.test(activeRaw),
    origin: get("원산지"),
    attrs: get("속성"),
    notes: get("비고") || get("메모"), // 구버전 양식('메모') 호환
  };
  return { id, input };
}

// 변경 비교용 필드(라벨) — 신규/변경 판정 및 diff 표시에 사용.
export const PRODUCT_DIFF_FIELDS: { key: keyof ProductInput; label: string }[] = [
  { key: "sku", label: "SKU" },
  { key: "name", label: "품목명" },
  { key: "spec", label: "옵션" },
  { key: "unit", label: "단위" },
  { key: "tax_type", label: "과세유형" },
  { key: "retail_price", label: "소비자가" },
  { key: "sale_price", label: "b2b도매가" },
  { key: "purchase_price", label: "매입단가" },
  { key: "cost_price", label: "원가(제품단위)" },
  { key: "volume_kg", label: "부피kg" },
  { key: "courier_name", label: "택배상품명" },
  { key: "courier_weight", label: "택배중량kg" },
  { key: "scan_name", label: "송장스캔명" },
  { key: "active", label: "사용" },
  { key: "origin", label: "원산지" },
  { key: "attrs", label: "속성" },
  { key: "notes", label: "비고" },
];

// 표시용 값 정규화(비교·diff 출력 공용)
export function displayValue(key: keyof ProductInput, v: unknown): string {
  if (key === "tax_type") return v === "exempt" ? "면세" : "과세";
  if (key === "active") return v === false ? "미사용" : "사용";
  if (v === null || v === undefined || v === "") return "-";
  if (typeof v === "number") return v.toLocaleString();
  return String(v);
}
