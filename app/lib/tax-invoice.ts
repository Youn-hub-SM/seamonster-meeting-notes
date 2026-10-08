// 세금계산서 발행(볼타) — 서버 전용 흐름. 화면: app/b2b/orders/TaxInvoiceModal.tsx, 라우트: /api/b2b/orders/[id]/tax-invoice
//  미리보기(getInvoiceContext) → 발행(issueOrderInvoices: 문서마다 기록 먼저 → 볼타 접수) → 결과(refresh·웹훅 → settleOrder).
//  라이브 키는 발주 세금계산서 상태를 미발행 → 발행대기('발행 중') → 발행완료(모두 실패면 미발행)로 바꾸고, 테스트 키는 발주 상태를 건드리지 않는다.
import type { SupabaseClient } from "@supabase/supabase-js";
import { getKv } from "./b2b-settings";
import { logTaxInvoiceIssue } from "./b2b-activity";
import { boltaConfig, boltaIssue, boltaGetInvoice, boltaIssueStatus, boltaDueDate, boltaIssuers, boltaRejected, BoltaError, type BoltaMode, type BoltaInvoice } from "./bolta";
import {
  buildTaxInvoiceDraft, draftFingerprint, toBoltaBody, partyErrors, approxDueDate, kstToday, TAX_TYPE_TITLE,
  type TiDraft, type TiDoc, type TiParty, type TaxTypeCode, type PurposeCode, type TiOrder,
} from "./tax-invoice-calc";

export type TaxInvoiceRow = {
  id: string; order_id: string | null; order_no: string | null; company_name: string | null;
  tax_type: TaxTypeCode; purpose: PurposeCode; write_date: string; supply_cost: number; tax: number | null; total: number;
  client_ref: string; issuance_key: string | null; status: "요청" | "발행완료" | "실패";
  nts_id: string | null; issued_at: string | null; fail_code: string | null; fail_message: string | null;
  mode: BoltaMode; key_fp: string | null; created_by: string | null; created_at: string; updated_at: string;
};
// 종류마다 대표 문서 — 살아 있는(발행완료 > 처리 중) 문서를 먼저, '볼타에선 발행됨' 실패 다음, 그 밖의 실패는 마지막.
//  같은 순위면 최신. 부분 유니크 인덱스라 종류마다 살아 있는 문서는 하나뿐이다. 화면(TaxInvoiceModal)도 같은 순위를 쓴다.
export const rowRank = (r: Pick<TaxInvoiceRow, "status" | "fail_code">) =>
  r.status === "발행완료" ? 3 : r.status === "요청" ? 2 : r.fail_code === "ISSUED_DUPLICATE" ? 1 : 0;
// 이 종류는 이미 국세청에 나갔(거나 나가는 중이)다 — 다시 발행하면 중복
export const rowActive = (r: Pick<TaxInvoiceRow, "status" | "fail_code">) => rowRank(r) > 0;
const ROW_COLS = "id, order_id, order_no, company_name, tax_type, purpose, write_date, supply_cost, tax, total, client_ref, issuance_key, status, nts_id, issued_at, fail_code, fail_message, mode, key_fp, created_by, created_at, updated_at";
export const isMissing128 = (e: { message?: string } | null | undefined) => !!e && /tax_invoices|biz_type|biz_address|tax_email|tax_manager/i.test(e.message || "");
const nowIso = () => new Date().toISOString();
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String((e as { message?: unknown } | null)?.message ?? e));

// ── 공급자(설정 › 기타 › 거래명세표) · 공급받는자(거래처) ──
export async function loadSupplier(): Promise<TiParty> {
  let s: Record<string, string> = {};
  try { const raw = await getKv("statement_supplier"); if (raw) s = JSON.parse(raw); } catch { /* 빈값 */ }
  return {
    bizNo: s.biz_no ?? "", name: s.name ?? "", ceo: s.ceo ?? "", address: s.addr ?? "",
    bizType: s.biz_type ?? "", bizItem: s.biz_item ?? "", email: s.email || "youn@seamonster.kr", manager: s.manager ?? "", phone: s.phone ?? "",
  };
}
type CompanyRow = Record<string, string | null | undefined> & { id: string; name: string };
export function suppliedFromCompany(c: CompanyRow | null | undefined): TiParty {
  const v = (k: string) => String(c?.[k] ?? "").trim();
  return {
    bizNo: v("biz_no"), name: v("name"), ceo: v("ceo_name"),
    address: v("biz_address") || v("address"),               // 사업장 주소 없으면 기본 배송지(확인 필요)
    bizType: v("biz_type"), bizItem: v("biz_item"),
    email: v("tax_email") || v("contact_email"),
    manager: v("tax_manager_name") || v("contact_name"),
    phone: v("tax_manager_phone") || v("contact_phone"),
  };
}

// 공급받는자 칸 중 전용 칸이 비어 기본값으로 채운 것 — 화면에서 확인을 권한다
function suppliedNotesOf(c: CompanyRow | null | undefined): string[] {
  const v = (k: string) => String(c?.[k] ?? "").trim();
  const out: string[] = [];
  if (!v("biz_address") && v("address")) out.push("사업장 주소가 없어 기본 배송지를 넣었습니다 — 사업자등록증 주소와 같은지 확인하세요.");
  if (!v("tax_email") && v("contact_email")) out.push("세금계산서 수신 이메일이 없어 담당자 이메일을 넣었습니다.");
  return out;
}

// ── 발주 읽기 ──
type LoadedOrder = TiOrder & { id: string; company_id: string; company: CompanyRow | null };
export async function loadOrderForInvoice(sb: SupabaseClient, orderId: string): Promise<LoadedOrder | null> {
  const { data: order, error } = await sb.from("orders").select("*, company:company_id(*)").eq("id", orderId).maybeSingle();
  if (error) throw error;
  if (!order) return null;
  const [it, sh] = await Promise.all([
    sb.from("order_items").select("*").eq("order_id", orderId).order("sort_order", { ascending: true }),
    sb.from("shipments").select("*, items:shipment_items(*)").eq("order_id", orderId).order("seq", { ascending: true }),
  ]);
  if (it.error) throw it.error;
  if (sh.error) throw sh.error;
  const rel = (order as { company?: CompanyRow | CompanyRow[] | null }).company;
  return { ...(order as object), company: Array.isArray(rel) ? rel[0] : rel ?? null, items: it.data ?? [], shipments: sh.data ?? [] } as LoadedOrder;
}
export async function loadInvoices(sb: SupabaseClient, orderId: string): Promise<{ rows: TaxInvoiceRow[]; migrated: boolean }> {
  const { data, error } = await sb.from("tax_invoices").select(ROW_COLS).eq("order_id", orderId).order("created_at", { ascending: true });
  if (error) { if (isMissing128(error)) return { rows: [], migrated: false }; throw error; }
  return { rows: (data ?? []) as TaxInvoiceRow[], migrated: true };
}

// ── 미리보기 ──
export type InvoiceContext = {
  order: { id: string; order_no: string; status: string; payment_status: string; tax_invoice_status: string; company_id: string; company_name: string; total: number };
  draft: TiDraft; fingerprint: string; supplier: TiParty; supplied: TiParty; suppliedNotes: string[]; invoices: TaxInvoiceRow[];
  migrated: boolean; configured: boolean; mode: BoltaMode | null;
  dueDate: string; dueExact: boolean;
  bolta: { issuer: "ok" | "missing" | "unknown"; certificate: "ok" | "missing" | "expired" | "unknown"; certExpiresAt: string | null };
};
export async function getInvoiceContext(sb: SupabaseClient, orderId: string): Promise<InvoiceContext | null> {
  const o = await loadOrderForInvoice(sb, orderId);
  if (!o) return null;
  const [{ rows, migrated }, supplier] = await Promise.all([loadInvoices(sb, orderId), loadSupplier()]);
  const draft = buildTaxInvoiceDraft(o);
  const cfg = boltaConfig();
  let dueDate = approxDueDate(draft.writeDate), dueExact = false;
  const bolta: InvoiceContext["bolta"] = { issuer: "unknown", certificate: "unknown", certExpiresAt: null };
  if (cfg) {
    const [due, issuers] = await Promise.allSettled([draft.writeDate ? boltaDueDate(draft.writeDate) : Promise.resolve(null), boltaIssuers()]);
    if (due.status === "fulfilled" && due.value) { dueDate = due.value; dueExact = true; }
    if (issuers.status === "fulfilled") {
      const mine = issuers.value.find((i) => String(i.identificationNumber || "").replace(/\D/g, "") === supplier.bizNo.replace(/\D/g, ""));
      bolta.issuer = mine ? "ok" : "missing";
      const exp = mine?.certificate?.expiresAt ?? null;
      bolta.certExpiresAt = exp;
      bolta.certificate = !mine ? "unknown" : !mine.certificate ? "missing" : exp && Date.parse(exp) < Date.now() ? "expired" : "ok";
    }
  }
  return {
    order: {
      id: o.id, order_no: o.order_no, status: o.status, payment_status: o.payment_status,
      tax_invoice_status: String(o.tax_invoice_status || "미발행"), company_id: o.company_id,
      company_name: o.company?.name ?? "(미지정)", total: Number(o.total) || 0,
    },
    draft, fingerprint: draftFingerprint(draft, o.company_id), supplier, supplied: suppliedFromCompany(o.company), suppliedNotes: suppliedNotesOf(o.company), invoices: rows,
    migrated, configured: !!cfg, mode: cfg?.mode ?? null, dueDate, dueExact, bolta,
  };
}

// ── 발행 ──
export type IssueInput = {
  writeDate: string; purpose: PurposeCode; supplied: TiParty; saveCompany: boolean; description: string;
  fingerprint: string;                                                     // 화면이 본 미리보기(draftFingerprint)
  lines?: Partial<Record<TaxTypeCode, { name: string; spec: string }[]>>;  // 품목명·규격만 고칠 수 있다(금액은 발주 기준)
};
export type IssueResult = { taxType: TaxTypeCode; ok: boolean; uncertain?: boolean; error?: string };
export class IssueRefused extends Error { constructor(m: string) { super(m); this.name = "IssueRefused"; } }

const GRACE_MS = 10 * 60e3;   // 응답을 못 받은 요청을 '접수 안 됨'으로 볼 때까지 기다리는 시간
const latestPerType = (rows: TaxInvoiceRow[], mode: BoltaMode) => {
  const m = new Map<TaxTypeCode, TaxInvoiceRow>();
  for (const r of rows.filter((x) => x.mode === mode)) {
    const cur = m.get(r.tax_type);
    if (!cur || rowRank(r) > rowRank(cur) || (rowRank(r) === rowRank(cur) && r.created_at > cur.created_at)) m.set(r.tax_type, r);
  }
  return m;
};
// 이 행을 지금 키로 확인할 수 있나 — 모드가 같고, 키 지문이 남아 있으면 같은 키여야 한다(키마다 접수 기록이 따로)
const sameKey = (r: TaxInvoiceRow, cfg: { mode: BoltaMode; keyFp: string } | null) =>
  !!cfg && r.mode === cfg.mode && (!r.key_fp || r.key_fp === cfg.keyFp);

// 거래처 계산서 칸 저장 — 바뀐 칸만. 전용 칸이 비어 있고 화면 값이 기본값(배송지·담당자)과 같으면 옮겨 적지 않는다
//  (배송지가 사업장 주소로 굳는 것 방지). 사업자번호·대표자는 비어 있을 때만 채운다(업체 원본을 미리보기에서 덮지 않게).
function companyPatch(c: CompanyRow, sp: TiParty): Record<string, string | null> {
  const v = (k: string) => String(c[k] ?? "").trim();
  const patch: Record<string, string | null> = {};
  const put = (col: string, val: string, fallback?: string) => {
    const next = val.trim();
    if (next === v(col)) return;
    if (!v(col) && fallback !== undefined && next === fallback) return;
    patch[col] = next || null;
  };
  put("biz_type", sp.bizType); put("biz_item", sp.bizItem);
  put("biz_address", sp.address, v("address"));
  put("tax_email", sp.email, v("contact_email"));
  put("tax_manager_name", sp.manager, v("contact_name"));
  put("tax_manager_phone", sp.phone, v("contact_phone"));
  if (!v("biz_no") && sp.bizNo.trim()) patch.biz_no = sp.bizNo.trim();
  if (!v("ceo_name") && sp.ceo.trim()) patch.ceo_name = sp.ceo.trim();
  return patch;
}

export async function issueOrderInvoices(sb: SupabaseClient, orderId: string, input: IssueInput, actor: string | null): Promise<IssueResult[]> {
  const cfg = boltaConfig();
  if (!cfg) throw new IssueRefused("볼타 API 키가 설정되지 않아 발행할 수 없습니다.");
  const o = await loadOrderForInvoice(sb, orderId);
  if (!o) throw new IssueRefused("발주를 찾을 수 없습니다.");
  const { rows, migrated } = await loadInvoices(sb, orderId);
  if (!migrated) throw new IssueRefused("migration 128 이 적용되지 않았습니다.");
  const draft = buildTaxInvoiceDraft(o);     // 금액은 화면 값이 아니라 지금 발주로 다시 계산
  if (draft.blockers.length) throw new IssueRefused(draft.blockers.join(" "));
  if (!input.fingerprint || input.fingerprint !== draftFingerprint(draft, o.company_id)) throw new IssueRefused("미리보기를 연 뒤 발주가 바뀌었습니다 — 새로 불러온 미리보기를 확인하고 다시 발행하세요.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.writeDate)) throw new IssueRefused("작성일자를 확인하세요.");
  if (input.writeDate > kstToday()) throw new IssueRefused("작성일자는 오늘 이후로 할 수 없습니다.");
  if (input.purpose !== "RECEIPT" && input.purpose !== "CLAIM") throw new IssueRefused("영수/청구를 고르세요.");
  const supplier = await loadSupplier();
  const errs = [...partyErrors(supplier, "공급자"), ...partyErrors(input.supplied, "공급받는자")];
  if (errs.length) throw new IssueRefused(errs.join(" "));

  // 발행할 문서 — 라이브: 아직 살아 있는(요청·발행완료) 문서가 없는 종류만(과세만 실패했으면 과세만 다시).
  //  테스트: 살아 있는 테스트 문서를 정리하고 전부 다시.
  let docs = draft.docs;
  const cur = String(o.tax_invoice_status || "미발행");
  if (cfg.mode === "live") {
    if (cur !== "미발행" && cur !== "발행대기") throw new IssueRefused(`세금계산서 상태가 '${cur}'입니다 — 미발행 발주만 발행합니다.`);
    const active = new Set(rows.filter((r) => r.mode === "live" && rowActive(r)).map((r) => r.tax_type));
    docs = draft.docs.filter((d) => !active.has(d.taxType));
    if (!docs.length) throw new IssueRefused("이미 발행(요청)된 문서가 있습니다 — 고칠 내용은 수정발행으로 처리합니다.");
  } else {
    const live = rows.filter((r) => r.mode === "test" && (r.status === "요청" || r.status === "발행완료"));
    if (live.length) {
      const { error } = await sb.from("tax_invoices").update({ status: "실패", fail_code: "TEST_RESET", fail_message: "테스트 재발행으로 정리", updated_at: nowIso() }).in("id", live.map((r) => r.id));
      if (error) throw error;
    }
  }

  if (input.saveCompany && o.company?.id) {
    const patch = companyPatch(o.company, input.supplied);
    if (Object.keys(patch).length) {
      const { error } = await sb.from("companies").update(patch).eq("id", o.company.id);
      if (error && !isMissing128(error)) throw error;
    }
  }

  const issueOne = async (doc0: TiDoc): Promise<IssueResult> => {
    const ov = input.lines?.[doc0.taxType] ?? [];
    const doc = { ...doc0, lines: doc0.lines.map((l, i) => ({ ...l, name: (ov[i]?.name ?? l.name).trim() || l.name, spec: (ov[i]?.spec ?? l.spec).trim() })) };
    const body = toBoltaBody(doc, { writeDate: input.writeDate, purpose: input.purpose, supplier, supplied: input.supplied, description: input.description });
    const attempt = rows.filter((r) => r.tax_type === doc.taxType && r.mode === cfg.mode).length + 1;
    const ref = `b2b-${o.order_no}-${doc.taxType === "TAXABLE" ? "T" : "E"}-${cfg.mode}-${attempt}-${Date.now().toString(36)}`;
    // 기록 먼저(관리번호 보관) → 볼타 접수. 응답을 못 받아도 관리번호로 접수 여부를 다시 확인할 수 있다.
    const { data: ins, error: ie } = await sb.from("tax_invoices").insert({
      order_id: o.id, order_no: o.order_no, company_name: o.company?.name ?? null, tax_type: doc.taxType, purpose: input.purpose,
      write_date: input.writeDate, supply_cost: doc.supplyCost, tax: doc.tax, total: doc.total, request: body,
      client_ref: ref, status: "요청", mode: cfg.mode, key_fp: cfg.keyFp, created_by: actor,
    }).select("id").single();
    if (ie) {
      if ((ie as { code?: string }).code === "23505") return { taxType: doc.taxType, ok: false, error: `${TAX_TYPE_TITLE[doc.taxType]}: 다른 사람이 방금 발행을 요청했습니다 — 새로고침하세요.` };
      throw ie;
    }
    const rowId = (ins as { id: string }).id;
    try {
      const { issuanceKey } = await boltaIssue(body, ref);
      await sb.from("tax_invoices").update({ issuance_key: issuanceKey, updated_at: nowIso() }).eq("id", rowId);
      return { taxType: doc.taxType, ok: true };
    } catch (e) {
      if (!boltaRejected(e)) {
        // 불확실(연결 끊김·시간 초과·5xx·응답 이상) — 접수됐을 수 있어 실패로 두지 않는다. 관리번호로 확인하고,
        //  모르면 '요청'으로 둔다(새로고침이 다시 보고, 10분 뒤에도 접수 기록이 없으면 실패로 바꾼다).
        try {
          const st = await boltaIssueStatus(ref);
          if (st.issuanceKey) {
            await sb.from("tax_invoices").update({ issuance_key: st.issuanceKey, updated_at: nowIso() }).eq("id", rowId);
            return { taxType: doc.taxType, ok: true };
          }
        } catch { /* 새로고침이 다시 본다 */ }
        return { taxType: doc.taxType, ok: true, uncertain: true };
      }
      const code = e instanceof BoltaError ? e.code : "ERROR";
      await sb.from("tax_invoices").update({ status: "실패", fail_code: code, fail_message: errMsg(e).slice(0, 500), updated_at: nowIso() }).eq("id", rowId);
      return { taxType: doc.taxType, ok: false, error: `${TAX_TYPE_TITLE[doc.taxType]}: ${errMsg(e)}` };
    }
  };
  // 문서끼리는 동시에(2장이어도 한 번 기다림) — 하나가 DB 오류로 멈춰도 다른 문서 결과는 남긴다
  const settled = await Promise.allSettled(docs.map(issueOne));
  const results: IssueResult[] = settled.map((s, i) => s.status === "fulfilled" ? s.value : { taxType: docs[i].taxType, ok: false, error: `${TAX_TYPE_TITLE[docs[i].taxType]}: ${errMsg(s.reason)}` });

  // 라이브 — 하나라도 접수(또는 접수됐을 수 있음)면 발주를 '발행대기'로(국세청 처리 중). 테스트는 발주 상태를 바꾸지 않는다.
  if (cfg.mode === "live" && results.some((r) => r.ok)) {
    const { data: flipped } = await sb.from("orders").update({ tax_invoice_status: "발행대기" }).eq("id", o.id).eq("tax_invoice_status", "미발행").select("id");
    if (flipped?.length) {
      const detail = docs.filter((d) => results.some((r) => r.ok && r.taxType === d.taxType)).map((d) => `- ${TAX_TYPE_TITLE[d.taxType]} ${d.total.toLocaleString()}원`).join("\n");
      try { await logTaxInvoiceIssue(o.id, "미발행", "발행대기", detail, actor); } catch { /* 알림 실패는 발행을 막지 않는다 */ }
    }
  }
  return results;
}

// 라이브로 발행(요청)된 문서가 있는가 — 발주 저장·상태 변경·삭제가 세금계산서를 덮지 못하게(128 미적용이면 false)
//  조회가 실패하면 잠긴 것으로 본다(128 미적용 = 발행 기록 자체가 없음만 풀림).
export async function taxInvoiceLocked(sb: SupabaseClient, orderId: string): Promise<boolean> {
  const { data, error } = await sb.from("tax_invoices").select("id, status, fail_code").eq("order_id", orderId).eq("mode", "live").in("status", ["요청", "발행완료", "실패"]);
  if (error) return !isMissing128(error);
  return (data ?? []).some((r) => rowActive(r as Pick<TaxInvoiceRow, "status" | "fail_code">));
}

// ── 결과 확인(새로고침·웹훅 공용) ──
async function markIssued(sb: SupabaseClient, r: TaxInvoiceRow, inv: BoltaInvoice, from: "요청" | "실패"): Promise<void> {
  const { error } = await sb.from("tax_invoices").update({
    status: "발행완료", nts_id: inv.ntsTransactionId ?? null, issued_at: inv.issuedAt ?? nowIso(),
    fail_code: null, fail_message: null, updated_at: nowIso(),
  }).eq("id", r.id).eq("status", from);
  // 실패로 본 문서가 볼타에선 발행됐는데 같은 종류를 이미 다시 발행한 경우 — 중복 발행 가능성을 남긴다
  if (error && (error as { code?: string }).code === "23505") {
    await sb.from("tax_invoices").update({
      fail_code: "ISSUED_DUPLICATE", nts_id: inv.ntsTransactionId ?? null, issued_at: inv.issuedAt ?? nowIso(), updated_at: nowIso(),
      fail_message: `볼타에서는 발행됨(승인번호 ${inv.ntsTransactionId ?? "-"}) — 같은 종류 문서가 또 있어 중복 발행인지 볼타에서 확인하세요.`,
    }).eq("id", r.id);
  }
}

async function checkRow(sb: SupabaseClient, r: TaxInvoiceRow): Promise<void> {
  if (r.status !== "요청" || !sameKey(r, boltaConfig())) return;   // 다른 키로 낸 문서는 이 키로 조회하면 '없음'이 나온다 — 건드리지 않는다
  let key = r.issuance_key;
  if (!key) {
    let st: { issuanceKey?: string; notFound?: boolean };
    try { st = await boltaIssueStatus(r.client_ref); } catch { return; }
    if (!st.issuanceKey) {
      // 응답을 못 받았고 볼타에도 접수 기록이 없다 — 잠깐 늦을 수 있어 10분이 지나야 실패로 본다
      if (st.notFound && Date.now() - Date.parse(r.created_at) > GRACE_MS) {
        await sb.from("tax_invoices").update({ status: "실패", fail_code: "NOT_RECEIVED", fail_message: "볼타에 접수되지 않았습니다(응답 유실) — 다시 발행하세요.", updated_at: nowIso() }).eq("id", r.id).eq("status", "요청");
      }
      return;
    }
    key = st.issuanceKey;
    await sb.from("tax_invoices").update({ issuance_key: key, updated_at: nowIso() }).eq("id", r.id);
  }
  try {
    const inv = await boltaGetInvoice(key);
    if (inv.ntsTransactionId || inv.issuedAt) await markIssued(sb, r, inv, "요청");
  } catch { /* 아직 국세청 처리 중 */ }
}

// 실패로 본 문서(웹훅·직접 처리)를 다시 조회 — 볼타에서 발행이 확인되면 발행완료로 바로잡는다(최근 7일만)
async function recheckFailed(sb: SupabaseClient, r: TaxInvoiceRow): Promise<void> {
  if (r.status !== "실패" || !r.issuance_key || r.fail_code === "TEST_RESET" || r.fail_code === "ISSUED_DUPLICATE" || !sameKey(r, boltaConfig())) return;
  if (Date.now() - Date.parse(r.updated_at) > 7 * 864e5) return;
  try {
    const inv = await boltaGetInvoice(r.issuance_key);
    if (inv.ntsTransactionId || inv.issuedAt) await markIssued(sb, r, inv, "실패");
  } catch { /* 발행 안 됨 */ }
}

// 발주 상태 맞추기(라이브만) — 지금 발주의 문서 종류(과세·면세)마다 마지막 문서가 모두 발행완료면 발행완료,
//  모두 실패(처리 중·완료 없음)면 미발행으로 되돌린다. 일부만 완료면 '발행대기'로 둔다(실패 문서만 다시 발행).
export async function settleOrder(sb: SupabaseClient, orderId: string, actor: string | null): Promise<void> {
  const [loaded, o] = await Promise.all([loadInvoices(sb, orderId), loadOrderForInvoice(sb, orderId)]);
  if (!o) return;
  let rows = loaded.rows;
  // '볼타에선 발행됨'인데 같은 종류 문서가 있어 실패로 남긴 행 — 그 종류에 살아 있는 문서가 없어졌으면 발행완료로 올린다
  const dup = [...latestPerType(rows, "live").values()].filter((r) => r.status === "실패" && r.fail_code === "ISSUED_DUPLICATE");
  if (dup.length) {
    for (const r of dup) {
      await sb.from("tax_invoices").update({ status: "발행완료", fail_code: null, fail_message: null, updated_at: nowIso() }).eq("id", r.id).eq("status", "실패");
    }
    rows = (await loadInvoices(sb, orderId)).rows;
  }
  const types = new Set(buildTaxInvoiceDraft(o).docs.map((d) => d.taxType));
  const all = [...latestPerType(rows, "live").values()];
  const scoped = all.filter((r) => types.has(r.tax_type));
  const latest = scoped.length ? scoped : all;   // 발주가 바뀌어 빠진 종류는 보지 않는다
  if (!latest.length) return;
  const need = types.size ? [...types] : latest.map((r) => r.tax_type);
  const byType = new Map(latest.map((r) => [r.tax_type, r]));
  const cur = String(o.tax_invoice_status || "");
  const detail = latest.map((r) => `- ${TAX_TYPE_TITLE[r.tax_type]} ${Number(r.total).toLocaleString()}원 · ${r.status}${r.nts_id ? ` · 승인번호 ${r.nts_id}` : ""}${r.fail_message ? ` · ${r.fail_message}` : ""}`).join("\n");
  if (need.every((t) => byType.get(t)?.status === "발행완료")) {
    if (cur === "발행완료") return;
    const { data: f } = await sb.from("orders").update({ tax_invoice_status: "발행완료" }).eq("id", orderId).in("tax_invoice_status", ["발행대기", "미발행"]).select("id");
    if (f?.length) { try { await logTaxInvoiceIssue(orderId, cur || "발행대기", "발행완료", detail, actor); } catch { /* 무시 */ } }
  } else if (cur === "발행대기" && latest.every((r) => r.status === "실패")) {
    const { data: f } = await sb.from("orders").update({ tax_invoice_status: "미발행" }).eq("id", orderId).eq("tax_invoice_status", "발행대기").select("id");
    if (f?.length) { try { await logTaxInvoiceIssue(orderId, "발행대기", "미발행", `발행 실패\n${detail}`, actor); } catch { /* 무시 */ } }
  }
}

export async function refreshOrderInvoices(sb: SupabaseClient, orderId: string, actor: string | null): Promise<void> {
  const cfg = boltaConfig();
  if (!cfg) return;
  const { rows } = await loadInvoices(sb, orderId);
  // 문서마다 따로 확인하고(서로 기다리지 않게) 발주 상태는 마지막에 한 번 — 테스트 키는 발주 상태를 건드리지 않는다
  await Promise.all(rows.filter((r) => sameKey(r, cfg)).map((r) => (r.status === "요청" ? checkRow(sb, r) : recheckFailed(sb, r))));
  if (cfg.mode === "live") await settleOrder(sb, orderId, actor);
}

// 직접 실패 처리 — 웹훅이 없어 실패 알림을 못 받은 채 '처리 중'에 멈춘 문서용(볼타 개발자센터에서 실패를 확인한 뒤).
//  요청 뒤 10분이 지나야 하고, 바꾸기 직전에 한 번 더 조회해 그새 발행됐으면 발행완료로 둔다.
export async function markInvoiceFailed(sb: SupabaseClient, orderId: string, rowId: string, actor: string | null): Promise<void> {
  if (!boltaConfig()) throw new IssueRefused("볼타 API 키가 설정되지 않았습니다.");
  const { data, error } = await sb.from("tax_invoices").select(ROW_COLS).eq("id", rowId).eq("order_id", orderId).maybeSingle();
  if (error) throw error;
  const r = data as TaxInvoiceRow | null;
  if (!r) throw new IssueRefused("문서를 찾을 수 없습니다.");
  if (r.status !== "요청") throw new IssueRefused("처리 중인 문서만 실패로 바꿀 수 있습니다.");
  if (!sameKey(r, boltaConfig())) throw new IssueRefused("지금 설정된 볼타 키와 다른 키(테스트/라이브)로 발행한 문서입니다 — 그 키가 설정된 곳에서 처리하세요.");
  if (Date.now() - Date.parse(r.created_at) < GRACE_MS) throw new IssueRefused("발행 요청 뒤 10분이 지나야 실패로 바꿀 수 있습니다 — 잠시 뒤 [상태 새로고침]을 누르세요.");
  await checkRow(sb, r);
  await sb.from("tax_invoices").update({ status: "실패", fail_code: "MANUAL", fail_message: `직접 실패 처리${actor ? `(${actor})` : ""}`, updated_at: nowIso() }).eq("id", r.id).eq("status", "요청");
  if (r.mode === "live") await settleOrder(sb, orderId, actor);
}

// 웹훅 — 서명이 없어(문서) 성공은 조회 API 로 다시 확인한다. 실패 알림은 수신 키(BOLTA_WEBHOOK_KEY)가 맞을 때만 믿고,
//  그때도 조회로 발행이 확인되면 성공으로 본다(키 없이 받은 실패 알림은 무시 — 위조로 멀쩡한 문서를 실패로 돌리지 않게).
export async function applyBoltaWebhook(sb: SupabaseClient, payload: Record<string, unknown>, trusted: boolean): Promise<{ handled: boolean; note?: string }> {
  const data = (payload.data ?? payload) as Record<string, unknown>;
  const key = String(data.issuanceKey ?? "");
  if (!key) return { handled: false, note: "issuanceKey 없음" };
  const { data: row, error } = await sb.from("tax_invoices").select(ROW_COLS).eq("issuance_key", key).maybeSingle();
  if (error) throw error;
  if (!row) return { handled: false, note: "모르는 문서" };
  const r = row as TaxInvoiceRow;
  if (!sameKey(r, boltaConfig())) return { handled: false, note: "다른 키로 발행한 문서" };
  const type = String(payload.type ?? payload.eventType ?? payload.event ?? "");
  if (/FAIL/i.test(type) && r.status === "요청" && trusted) {
    let issued = false;
    try { const inv = await boltaGetInvoice(key); issued = !!(inv.ntsTransactionId || inv.issuedAt); } catch { /* 발행 안 됨 */ }
    if (!issued) {
      const cause = (data.cause ?? {}) as Record<string, unknown>;
      await sb.from("tax_invoices").update({ status: "실패", fail_code: String(cause.code ?? "FAILURE"), fail_message: String(cause.message ?? "볼타 발행 실패").slice(0, 500), updated_at: nowIso() }).eq("id", r.id).eq("status", "요청");
      if (r.order_id && r.mode === "live") await settleOrder(sb, r.order_id, "볼타");
      return { handled: true };
    }
  }
  await (r.status === "요청" ? checkRow(sb, r) : recheckFailed(sb, r));
  if (r.order_id && r.mode === "live") await settleOrder(sb, r.order_id, "볼타");
  return { handled: true };
}
