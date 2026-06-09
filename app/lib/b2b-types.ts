// B2B 관리툴 공용 타입.
// Supabase 테이블 스키마(supabase/migrations/001_b2b_init.sql)와 1:1 매칭.

export interface Company {
  id: string;
  name: string;
  biz_no: string | null;
  ceo_name: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  address: string | null;
  payment_terms: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  // 목록 API 에서만 채워짐 (업체별 가장 최근 발주일)
  last_order_date?: string | null;
}

export type CompanyInput = Omit<Company, "id" | "created_at" | "updated_at"> & {
  id?: string;
};

export const EMPTY_COMPANY: CompanyInput = {
  name: "",
  biz_no: "",
  ceo_name: "",
  contact_name: "",
  contact_phone: "",
  contact_email: "",
  address: "",
  payment_terms: "",
  notes: "",
};

export const TAX_TYPES = ["taxable", "exempt"] as const;
export type TaxType = (typeof TAX_TYPES)[number];

export const TAX_TYPE_LABEL: Record<TaxType, string> = {
  taxable: "과세",
  exempt: "면세",
};

export interface Product {
  id: string;
  sku: string | null;
  name: string;
  spec: string | null;
  unit: string;
  cost_price: number;
  sale_price: number;
  tax_type: TaxType;
  active: boolean;
  notes: string | null;
  // 이익률용 원가 상세 (migration 006)
  cost_material: number;   // 제품원가(제조)
  pkg_inner: number;       // 내포장지
  pkg_label: number;       // 라벨
  pkg_outer: number;       // 외포장지
  volume_kg: number | null; // 제품부피(kg)
  created_at: string;
  updated_at: string;
}

export type ProductInput = Omit<Product, "id" | "created_at" | "updated_at"> & {
  id?: string;
};

export const EMPTY_PRODUCT: ProductInput = {
  sku: "",
  name: "",
  spec: "",
  unit: "개",
  cost_price: 0,
  sale_price: 0,
  tax_type: "taxable",
  active: true,
  notes: "",
  cost_material: 0,
  pkg_inner: 0,
  pkg_label: 0,
  pkg_outer: 0,
  volume_kg: null,
};

export interface CostHistory {
  id: string;
  product_id: string;
  cost_price: number;
  changed_at: string;
  reason: string | null;
}

// 빈 문자열 → null 정규화 (DB 에 빈 문자열 대신 null 저장).
// 숫자 필드는 0 으로 강제.
export function normalizeCompany(input: CompanyInput): CompanyInput {
  const clean = <T extends keyof CompanyInput>(k: T): CompanyInput[T] => {
    const v = input[k];
    if (typeof v === "string" && v.trim() === "") return null as CompanyInput[T];
    return v;
  };
  return {
    id: input.id,
    name: input.name.trim(),
    biz_no: clean("biz_no"),
    ceo_name: clean("ceo_name"),
    contact_name: clean("contact_name"),
    contact_phone: clean("contact_phone"),
    contact_email: clean("contact_email"),
    address: clean("address"),
    payment_terms: clean("payment_terms"),
    notes: clean("notes"),
  };
}

export function normalizeProduct(input: ProductInput): ProductInput {
  const clean = (v: string | null | undefined): string | null => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s === "" ? null : s;
  };
  const numOr0 = (v: number | string | null | undefined): number => Number(v) || 0;
  const costMaterial = numOr0(input.cost_material);
  const pkgInner = numOr0(input.pkg_inner);
  const pkgLabel = numOr0(input.pkg_label);
  const pkgOuter = numOr0(input.pkg_outer);
  const volumeRaw = input.volume_kg;
  const volume = volumeRaw === null || volumeRaw === undefined || (volumeRaw as unknown as string) === ""
    ? null
    : Number(volumeRaw) || 0;

  // 원가 상세가 입력되면 cost_price(제품 단위 원가) = 제품원가 + 포장재 합으로 자동 산정.
  // 상세가 전부 0 이면 직접 입력한 cost_price 를 존중.
  const detailSum = costMaterial + pkgInner + pkgLabel + pkgOuter;
  const cost_price = detailSum > 0 ? detailSum : numOr0(input.cost_price);

  return {
    id: input.id,
    sku: clean(input.sku),
    name: input.name.trim(),
    spec: clean(input.spec),
    unit: input.unit?.trim() || "개",
    cost_price,
    sale_price: numOr0(input.sale_price),
    tax_type: input.tax_type === "exempt" ? "exempt" : "taxable",
    active: input.active !== false,
    notes: clean(input.notes),
    cost_material: costMaterial,
    pkg_inner: pkgInner,
    pkg_label: pkgLabel,
    pkg_outer: pkgOuter,
    volume_kg: volume,
  };
}
