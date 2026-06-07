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
  return {
    id: input.id,
    sku: clean(input.sku),
    name: input.name.trim(),
    spec: clean(input.spec),
    unit: input.unit?.trim() || "개",
    cost_price: Number(input.cost_price) || 0,
    sale_price: Number(input.sale_price) || 0,
    tax_type: input.tax_type === "exempt" ? "exempt" : "taxable",
    active: input.active !== false,
    notes: clean(input.notes),
  };
}
