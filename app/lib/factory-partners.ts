// 파도소리 거래처·회사 정보·출고증 — 화면과 서버가 같이 쓰는 타입과 입력 정리(순수 함수).
//  거래처 칸은 씨몬스터 거래처와 같고(2026-11-20 대표), 매출처·매입처 구분만 더했다. 표는 따로 둔다(factory.partners).

export const PARTNER_KINDS = ["매출처", "매입처", "둘 다"] as const;
export type PartnerKind = (typeof PARTNER_KINDS)[number];

export interface FactoryPartner {
  id: string;
  name: string;
  kind: PartnerKind;
  biz_no: string | null;
  ceo_name: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  address: string | null;
  payment_terms: string | null;
  memo: string | null;
  created_at?: string;
  updated_at?: string;
}
export type PartnerInput = Omit<FactoryPartner, "id" | "created_at" | "updated_at">;
export const EMPTY_PARTNER: PartnerInput = {
  name: "", kind: "매출처", biz_no: null, ceo_name: null, contact_name: null, contact_phone: null, contact_email: null, address: null, payment_terms: null, memo: null,
};

const TEXT_FIELDS = ["biz_no", "ceo_name", "contact_name", "contact_phone", "contact_email", "address", "payment_terms", "memo"] as const;
const MAX: Record<(typeof TEXT_FIELDS)[number], number> = {
  biz_no: 20, ceo_name: 40, contact_name: 40, contact_phone: 30, contact_email: 100, address: 200, payment_terms: 100, memo: 500,
};
export const normPartnerName = (s: unknown) => String(s ?? "").trim().replace(/\s+/g, " ");

// 입력 정리 — partial 이면 보낸 칸만(수정). 이름은 60자까지(기록의 거래처 칸과 같은 한도).
export function parsePartnerInput(b: Record<string, unknown>, partial = false): { patch: Partial<PartnerInput>; error?: string } {
  const patch: Partial<PartnerInput> = {};
  if (!partial || b.name !== undefined) {
    const name = normPartnerName(b.name);
    if (!name) return { patch, error: "업체명을 입력하세요." };
    if (name.length > 60) return { patch, error: "업체명이 너무 깁니다(60자까지)." };
    patch.name = name;
  }
  if (!partial || b.kind !== undefined) {
    const kind = String(b.kind ?? "매출처") as PartnerKind;
    if (!PARTNER_KINDS.includes(kind)) return { patch, error: "구분이 올바르지 않습니다." };
    patch.kind = kind;
  }
  for (const f of TEXT_FIELDS) {
    if (partial && b[f] === undefined) continue;
    const v = String(b[f] ?? "").trim();
    if (v.length > MAX[f]) return { patch, error: "입력이 너무 깁니다." };
    patch[f] = v || null;
  }
  return { patch };
}

export const formatBizNo = (raw: string | null | undefined) => {
  const d = String(raw || "").replace(/\D/g, "");
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : raw || "";
};

// ── 회사 정보(출고증 아래에 찍힌다) — b2b_settings kv 'factory_company'. 그림은 data URL 로 둔다(각 300KB 까지) ──
export interface FactoryCompany { name: string; ceo: string; tel: string; fax: string; logo: string; seal: string }
export const EMPTY_COMPANY: FactoryCompany = { name: "", ceo: "", tel: "", fax: "", logo: "", seal: "" };
export const MAX_IMAGE_CHARS = 420000; // data URL 길이(약 300KB 그림)

// ── 출고증 ──
export interface OutDocLine {
  name: string; spec: string; vessel: string;
  memo: string;        // 적요 = 테잎색 + 원산지
  unit: string;        // '16KG' 또는 'KG'
  qty: number;         // 박스 수(단위가 KG 면 kg)
  in_date: string;     // 그 로트의 입고일
}
export interface OutDoc {
  doc_no: string;
  out_date: string;
  partner: string;
  issued_at: string;                                   // 번호를 처음 낸 시각
  sheets: { storage: string; lines: OutDocLine[] }[];  // 받는 곳(보관처)마다 한 묶음
  company: FactoryCompany;
}
export const OUT_DOC_ROWS = 12; // 출고증 한 장의 줄 수(실물 양식)
