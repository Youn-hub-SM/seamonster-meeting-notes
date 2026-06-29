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
  biz_doc_path: string | null;   // 사업자등록증 첨부 (Storage 경로)
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
  biz_doc_path: null,
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
  retail_price: number;  // 소비자 판매가
  sale_price: number;    // B2B 도매가(소비자가의 10% 할인가)
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
  retail_price: 0,
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
    biz_doc_path: clean("biz_doc_path"),
  };
}

// ─────────────────────────────────────────────
// 표시용 포맷 (저장값이 숫자만이든 하이픈 포함이든 보기 좋게)
// ─────────────────────────────────────────────
// 전화번호 → 010-0000-0000 (모바일 11자리), 지역번호·8자리 등도 보정
export function formatPhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const d = String(raw).replace(/\D/g, "");
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10) {
    if (d.startsWith("02")) return `${d.slice(0, 2)}-${d.slice(2, 6)}-${d.slice(6)}`;
    return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  }
  if (d.length === 9 && d.startsWith("02")) return `${d.slice(0, 2)}-${d.slice(2, 5)}-${d.slice(5)}`;
  if (d.length === 8) return `${d.slice(0, 4)}-${d.slice(4)}`;
  return String(raw); // 알 수 없는 형식은 원본 그대로
}

// 사업자등록번호 → 000-00-00000 (10자리)
export function formatBizNo(raw: string | null | undefined): string {
  if (!raw) return "";
  const d = String(raw).replace(/\D/g, "");
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
  return String(raw);
}

// 사업자등록번호 체크섬 검증 (국세청 알고리즘).
//  가중치 [1,3,7,1,3,7,1,3,5], 9번째 자리×5의 10의자리 보정 후 (10 - 합%10)%10 == 마지막자리
//  반환: "valid" | "invalid"(형식은 10자리지만 체크섬 불일치 — OCR 오류 의심) | "incomplete"(10자리 아님)
export type BizNoCheck = "valid" | "invalid" | "incomplete";
export function checkBizNo(raw: string | null | undefined): BizNoCheck {
  const d = String(raw ?? "").replace(/\D/g, "");
  if (d.length !== 10) return "incomplete";
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(d[i]) * w[i];
  sum += Math.floor((Number(d[8]) * 5) / 10);
  const check = (10 - (sum % 10)) % 10;
  return check === Number(d[9]) ? "valid" : "invalid";
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
    retail_price: numOr0(input.retail_price),
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
