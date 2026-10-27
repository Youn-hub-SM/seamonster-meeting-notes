// 단골·블랙 고객 메모(fulfill_customers, migration 156) — 택배 발주처리 ② 단계에서 그 고객의 주문을 찾아 확인(체크)을 받는다.
//  매칭 순서(주문 한 행 기준): ① 전화 일치(등록 전화 = 주문 전화 1·2 중 하나, 숫자만 비교)
//   ② 이름 일치 + 등록 주소가 주문 주소에 포함(공백 무시)
//   ③ 이름 일치만 — 등록 주소가 없고, 등록 전화가 없거나 주문 전화가 없을 때(네이버 050 안심번호·마스킹 번호).
//      등록 전화와 주문 전화가 둘 다 있는데 다르면 다른 사람으로 보고 잇지 않는다.
//  주문 단위(주문번호 × 고객)로 한 번만 담는다. 개인정보 표라 AI 비서 run_report 는 차단(156·report-schema).

import type { supabaseAdmin } from "./supabase";
import { normalizePhoneDigits } from "./sales-normalize";

import { CUSTOMER_KINDS, type CustomerKind } from "./customer-kind";
export { CUSTOMER_KINDS, type CustomerKind };
export type FlaggedCustomer = {
  id: string; kind: CustomerKind; name: string; phone_digits: string; address: string; memo: string;
  active: boolean; created_by: string | null; created_at: string; updated_at: string;
};
export type CustomerFlag = { rowNo: number; orderNo: string; name: string; kind: CustomerKind; memo: string; matchedBy: string; customerId: string };
export type CustomerIdx = { orderNo: number; name: number; addr: number; phone1: number; phone2: number };

type Sb = ReturnType<typeof supabaseAdmin>;

const normName = (s: unknown) => String(s ?? "").normalize("NFKC").replace(/\s+/g, "");
const normAddr = (s: unknown) => String(s ?? "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();

// 등록 전화 정규화 — 매출 PII 와 같은 규칙(9자리 미만·마스킹 번호는 '없음'). 화면 표시는 formatPhone.
export const customerPhoneDigits = (raw: unknown): string => normalizePhoneDigits(raw);
export function formatPhone(d: string): string {
  if (!d) return "";
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10) return d.startsWith("02") ? `${d.slice(0, 2)}-${d.slice(2, 6)}-${d.slice(6)}` : `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 9) return `${d.slice(0, 2)}-${d.slice(2, 5)}-${d.slice(5)}`;
  return d;
}

const missingTable = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "42P01" || e.code === "PGRST205" || /does not exist|could not find the table|schema cache/i.test(e.message || ""));

/** 사용 중인 고객 목록. 표가 없으면(156 미적용) missing=true 로 빈 목록, 그 밖의 조회 오류는 던진다 —
 *  블랙 고객을 못 읽은 채 '없음'으로 넘기면 확인 장치가 조용히 꺼진다(S4). */
export async function loadFlaggedCustomers(sb: Sb): Promise<{ list: FlaggedCustomer[]; missing: boolean }> {
  const { data, error } = await sb.from("fulfill_customers").select("*").eq("active", true).order("kind", { ascending: true }).order("name", { ascending: true });
  if (error) {
    if (missingTable(error)) return { list: [], missing: true };
    throw error;
  }
  return { list: (data ?? []) as FlaggedCustomer[], missing: false };
}

/** 주문 엑셀 행(A~M)에서 등록 고객의 주문을 찾는다. 순수 함수(테스트·재사용). */
export function matchFlaggedCustomers(rows: unknown[][], customers: FlaggedCustomer[], idx: CustomerIdx): CustomerFlag[] {
  if (!customers.length) return [];
  const byPhone = new Map<string, FlaggedCustomer[]>();
  const byName = new Map<string, FlaggedCustomer[]>();
  for (const c of customers) {
    if (c.phone_digits) byPhone.set(c.phone_digits, [...(byPhone.get(c.phone_digits) ?? []), c]);
    const n = normName(c.name);
    if (n) byName.set(n, [...(byName.get(n) ?? []), c]);
  }
  const out: CustomerFlag[] = [];
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    const orderNo = String(r[idx.orderNo] ?? "").trim();
    const rawName = String(r[idx.name] ?? "").trim();
    const name = normName(rawName);
    const addr = normAddr(r[idx.addr]);
    const phones = [r[idx.phone1], r[idx.phone2]].map(normalizePhoneDigits).filter(Boolean);
    const hits = new Map<string, { c: FlaggedCustomer; by: string }>();
    for (const p of phones) for (const c of byPhone.get(p) ?? []) hits.set(c.id, { c, by: "전화 일치" });
    if (name) {
      for (const c of byName.get(name) ?? []) {
        if (hits.has(c.id)) continue;
        const regAddr = normAddr(c.address);
        if (regAddr) { if (addr.includes(regAddr)) hits.set(c.id, { c, by: "이름·주소 일치" }); continue; }
        if (!c.phone_digits) hits.set(c.id, { c, by: "이름 일치" });
        else if (!phones.length) hits.set(c.id, { c, by: "이름 일치(주문 전화 없음)" });
      }
    }
    for (const { c, by } of hits.values()) {
      const key = `${orderNo || `row${i}`}||${c.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ rowNo: i + 1, orderNo, name: rawName, kind: c.kind, memo: c.memo, matchedBy: by, customerId: c.id });
    }
  });
  // 블랙 먼저, 그 다음 단골 — 주의할 것이 위에 오게
  return out.sort((a, b) => (a.kind === b.kind ? a.rowNo - b.rowNo : a.kind === "블랙" ? -1 : 1));
}
