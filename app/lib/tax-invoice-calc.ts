// 세금계산서 발행(볼타) — 발주 → 계산서 문서 초안 계산. 클라이언트·서버 공용(순수 함수, DB·fetch 없음).
//  2026-10-08 대표 결정: 발주 1건 = 1장(과세·면세가 섞이면 볼타 제약상 세금계산서 1장 + 계산서 1장),
//  작성일자 = 발송일, 입금완료 = 영수 · 그 외 = 청구, 미리보기 필수.
//
//  금액 규칙 = 거래명세표(/b2b/orders/[id]/statement)와 같은 값이 나오게:
//   · 발행 수량 = 주문 수량 − 취소 차수에 배정된 수량(부분취소). 단가 0원(증정) 줄은 빼고 비고에만.
//   · 세액 = orders.vat − round(취소 과세분 × 0.1)  (명세표·미수금·입금 매칭과 같은 방식)
//   · 할인(부가세 포함 총액에서 차감)은 문서별로 부가세 포함 금액 비율로 나누고, 과세 문서는 공급가액·세액으로 다시 나눈다
//     (볼타는 품목 공급가액이 1원 이상이라 마이너스 할인 줄을 못 넣는다 → 품목 금액에 녹인다).
//   · 품목 공급가액은 최대 잔여 방식으로 나눠 합이 정확히 맞고, 품목 세액은 10% 반올림 뒤 마지막 품목이 차이를 흡수.
//   · 품목은 문서당 16줄까지 — 넘으면 15줄 + '…외 N건' 한 줄로 합친다(금액 합은 그대로).
import { checkBizNo, formatPhone } from "./b2b-types";
import { isBusinessDay } from "./business-days";

export type TiItem = {
  id: string; product_name: string | null; option_label?: string | null; spec?: string | null;
  qty: number | string; unit_price: number | string; tax_type?: string | null; sort_order?: number | null;
};
export type TiShipment = {
  status: string | null; ship_date: string | null; shipped_at?: string | null;
  items?: { order_item_id: string | null; qty: number | string }[] | null;
};
export type TiOrder = {
  order_no: string; status: string; payment_status: string; tax_invoice_status?: string | null;
  ship_date: string | null; order_date?: string | null;
  subtotal: number | string; vat: number | string; total: number | string;
  discount_amount?: number | string | null; discount_reason?: string | null;
  items: TiItem[]; shipments?: TiShipment[] | null;
};
export type TaxTypeCode = "TAXABLE" | "TAX_FREE";
export type PurposeCode = "RECEIPT" | "CLAIM";
export type TiLine = {
  name: string; spec: string; quantity: number | null; unitPrice: number | null;
  supplyCost: number; tax: number | null; note: string;
};
export type TiDoc = { taxType: TaxTypeCode; lines: TiLine[]; supplyCost: number; tax: number | null; total: number; mergedNames: string[] };
export type TiDraft = {
  docs: TiDoc[];
  expectedTotal: number;    // 계산서 합계(= 거래명세표 합계금액)
  statementTotal: number;   // 거래명세표 합계금액(대조용)
  writeDate: string;        // 기본 작성일자(발송일)
  purpose: PurposeCode;     // 기본 영수/청구
  freebies: string[];       // 0원(증정) 줄 — 품목에서 빠짐
  blockers: string[];       // 발행 불가 사유
  warnings: string[];       // 확인할 것
};

export const MAX_LINES = 16;
export const TAX_TYPE_TITLE: Record<TaxTypeCode, string> = { TAXABLE: "세금계산서(과세)", TAX_FREE: "계산서(면세)" };
export const PURPOSE_LABEL: Record<PurposeCode, string> = { RECEIPT: "영수", CLAIM: "청구" };

const num = (v: unknown) => Number(v) || 0;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const roundHalfUp = (x: number) => Math.sign(x) * Math.floor(Math.abs(x) + 0.5); // 음수도 대칭 반올림
// 볼타는 U+FFFF 넘는 문자(이모지 등)를 400 으로 거부한다 — 보내기 전에 지운다
const bmp = (s: string) => s.replace(/[\u{10000}-\u{10FFFF}]/gu, "");
const cut = (s: string, n: number) => { const t = bmp(s); return t.length > n ? t.slice(0, n) : t; };
export const kstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const kstDateOf = (iso: string) => new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(0, 10);

// 정수 target 을 가중치 비율로 나눠 합이 정확히 target 인 정수 배열(최대 잔여 — 동률은 앞 줄 먼저)
export function largestRemainder(target: number, weights: number[]): number[] {
  const W = weights.reduce((s, w) => s + w, 0);
  if (!weights.length) return [];
  if (W <= 0) { const out = weights.map(() => 0); out[0] = target; return out; }
  const raw = weights.map((w) => (target * w) / W);
  const base = raw.map((x) => Math.floor(x));
  let left = target - base.reduce((s, x) => s + x, 0);
  const order = raw.map((x, i) => ({ i, f: x - Math.floor(x) })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) base[order[k].i] += 1;
  return base;
}

// 발행 마감일(대략) — 작성일 다음 달 10일, 주말·공휴일이면 다음 영업일. 실제 마감은 볼타 조회 API 가 정답.
export function approxDueDate(writeDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(writeDate)) return "";
  const [y, m] = writeDate.split("-").map(Number);
  let d = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 10)).toISOString().slice(0, 10);
  for (let i = 0; i < 10 && !isBusinessDay(d); i++) d = new Date(Date.parse(`${d}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
  return d;
}

export function buildTaxInvoiceDraft(order: TiOrder): TiDraft {
  const blockers: string[] = [], warnings: string[] = [], freebies: string[] = [];
  if (order.status === "취소") blockers.push("취소된 발주입니다.");
  else if (order.status !== "발송완료") warnings.push("아직 발송완료가 아닌 발주입니다.");

  // 부분취소 — 취소 차수에 배정된 수량
  const cancelledQty = new Map<string, number>();
  for (const s of order.shipments ?? []) {
    if (s.status !== "취소") continue;
    for (const si of s.items ?? []) if (si.order_item_id) cancelledQty.set(si.order_item_id, (cancelledQty.get(si.order_item_id) || 0) + num(si.qty));
  }
  type Acc = { taxable: boolean; name: string; spec: string; price: number; qty: number; e: number };
  const merged = new Map<string, Acc>();
  let cS = 0, cT = 0, hasTaxableItem = false;
  const items = [...(order.items ?? [])].sort((a, b) => num(a.sort_order) - num(b.sort_order));
  for (const it of items) {
    const qty = num(it.qty), price = num(it.unit_price);
    const taxable = it.tax_type !== "exempt";
    if (taxable) hasTaxableItem = true;
    const name = `${it.product_name || "품목"}${it.option_label ? ` (${it.option_label})` : ""}`;
    if (qty < 0 || price < 0) { blockers.push(`${name}: 수량·단가가 음수인 줄은 발행할 수 없습니다 — 할인 칸으로 옮기세요.`); continue; }
    const c = Math.min(qty, cancelledQty.get(it.id) || 0);
    cS += c * price;
    if (taxable) cT += c * price;
    const inv = r3(qty - c);
    if (inv <= 0) continue;
    if (price === 0) { freebies.push(name); continue; }
    const key = [taxable ? "T" : "E", name, it.spec || "", price].join("|");
    const acc = merged.get(key) ?? { taxable, name, spec: it.spec || "", price, qty: 0, e: 0 };
    acc.qty = r3(acc.qty + inv);
    acc.e += inv * price;
    merged.set(key, acc);
  }
  const T = [...merged.values()].filter((a) => a.taxable), E = [...merged.values()].filter((a) => !a.taxable);
  const hasT = T.length > 0, hasE = E.length > 0;

  let S_T0 = Math.round(T.reduce((s, a) => s + a.e, 0));
  let S_E0 = Math.round(E.reduce((s, a) => s + a.e, 0));
  const cancelledVat = Math.round(cT * 0.1);
  let V_T0 = hasT ? num(order.vat) - cancelledVat : 0;
  if (!hasT && hasTaxableItem && num(order.vat) - cancelledVat !== 0) warnings.push("과세 품목이 모두 취소·0원이라 부가세를 넣지 않았습니다.");
  const D = num(order.discount_amount);
  const statementTotal = Math.max(0, Math.round(num(order.total) - (cS + cancelledVat)));

  let G0 = S_T0 + V_T0 + S_E0;
  const Deff = D > 0 ? Math.min(D, G0) : D;
  // 소수 수량·단가로 생기는 1~2원 반올림 차이는 면세(없으면 과세) 공급가액으로 맞춘다 — 명세표 합계금액이 정답
  const diff = statementTotal - (G0 - Deff);
  if (diff !== 0 && Math.abs(diff) <= 2 && (hasT || hasE)) {
    if (hasE) S_E0 += diff; else S_T0 += diff;
    G0 = S_T0 + V_T0 + S_E0;
  } else if (diff !== 0 && (hasT || hasE)) {
    warnings.push(`거래명세표 합계금액과 ${Math.abs(diff).toLocaleString()}원 다릅니다 — 발주 금액을 확인하세요.`);
  }
  const G = G0 - Deff;
  if (!hasT && !hasE) blockers.push("발행할 품목이 없습니다(전량 취소·0원).");
  else if (G <= 0) blockers.push("발행 금액이 0원 이하입니다(할인이 합계 이상).");

  let S_T = S_T0, V_T = V_T0, S_E = S_E0;
  if (Deff !== 0 && G0 > 0) {
    const D_T = hasT && hasE ? roundHalfUp((Deff * (S_T0 + V_T0)) / G0) : hasT ? Deff : 0;
    const D_E = Deff - D_T;
    if (hasT) { const X = S_T0 + V_T0 - D_T; S_T = Math.floor((20 * X + 11) / 22); V_T = X - S_T; } // 공급가액 = round(X/1.1)
    if (hasE) S_E = S_E0 - D_E;
  }

  const docs: TiDoc[] = [];
  const makeDoc = (taxType: TaxTypeCode, accs: Acc[], S: number, V: number | null) => {
    if (S <= 0) { if (accs.length) blockers.push(`${TAX_TYPE_TITLE[taxType]} 공급가액이 0원 이하입니다.`); return; }
    const supplies = largestRemainder(S, accs.map((a) => a.e));
    // 볼타 수량·단가는 정수만 — 소수 수량이면 둘 다 비우고 비고에 수량을 적는다. 단가는 공급가액 = 수량 × 단가일 때만.
    let lines: TiLine[] = accs.map((a, i) => {
      const intQty = Number.isInteger(a.qty) && a.qty > 0;
      const exact = intQty && Number.isInteger(a.price) && a.price > 0 && supplies[i] === a.qty * a.price;
      const spread = !exact && Deff !== 0 ? "할인 배분" : "";
      const note = !intQty ? [`수량 ${a.qty}`, spread].filter(Boolean).join(" · ") : spread;
      return { name: a.name, spec: a.spec, quantity: intQty ? a.qty : null, unitPrice: exact ? a.price : null, supplyCost: supplies[i], tax: null, note };
    }).filter((l) => l.supplyCost > 0);
    if (taxType === "TAXABLE") {
      const vv = V ?? 0;
      let taxes = lines.map((l) => Math.round(l.supplyCost * 0.1));
      const gap = vv - taxes.reduce((s, x) => s + x, 0);
      if (lines.length) taxes[taxes.length - 1] += gap;
      if (taxes.some((t) => t < 0)) taxes = largestRemainder(vv, lines.map((l) => l.supplyCost));
      lines = lines.map((l, i) => ({ ...l, tax: taxes[i] }));
    }
    let mergedNames: string[] = [];
    if (lines.length > MAX_LINES) {
      const keep = lines.slice(0, MAX_LINES - 1), rest = lines.slice(MAX_LINES - 1);
      mergedNames = rest.map((l) => l.name);
      keep.push({
        name: cut(`${rest[0].name} 외 ${rest.length - 1}건`, 100), spec: "", quantity: null, unitPrice: null,
        supplyCost: rest.reduce((s, l) => s + l.supplyCost, 0),
        tax: taxType === "TAXABLE" ? rest.reduce((s, l) => s + (l.tax ?? 0), 0) : null, note: "",
      });
      lines = keep;
      warnings.push(`${TAX_TYPE_TITLE[taxType]} 품목이 ${MAX_LINES}줄을 넘어 ${MAX_LINES}번째부터 '외 ${rest.length - 1}건'으로 합쳤습니다.`);
    }
    const supplyCost = lines.reduce((s, l) => s + l.supplyCost, 0);
    const tax = taxType === "TAXABLE" ? lines.reduce((s, l) => s + (l.tax ?? 0), 0) : null;
    docs.push({ taxType, lines, supplyCost, tax, total: supplyCost + (tax ?? 0), mergedNames });
  };
  if (hasT) makeDoc("TAXABLE", T, S_T, V_T);
  if (hasE) makeDoc("TAX_FREE", E, S_E, null);
  if (docs.length === 2) warnings.push("과세·면세 품목이 섞여 세금계산서 1장과 계산서 1장으로 나눠 발행합니다.");
  if (Deff !== 0) warnings.push(`${D > 0 ? "할인" : "추가금"} ${Math.abs(Deff).toLocaleString()}원을 품목 금액에 나눠 넣었습니다.`);
  if (freebies.length) warnings.push(`0원 품목(${freebies.join(", ")})은 품목에서 빼고 비고에 적었습니다.`);
  const docsTotal = docs.reduce((s, d) => s + d.total, 0);
  if (docs.length && docsTotal !== G) blockers.push(`계산 오류 — 문서 합계 ${docsTotal.toLocaleString()}원 ≠ ${G.toLocaleString()}원. 관리자에게 알려 주세요.`);

  // 작성일자 = 발송일(헤더 발송일 = 가장 이른 비취소 차수) → 첫 발송완료 차수 → 실제 발송 시각
  const doneShips = (order.shipments ?? []).filter((s) => s.status === "발송완료");
  const firstDone = doneShips.map((s) => s.ship_date).filter((d): d is string => !!d).sort()[0];
  const shippedAt = doneShips.map((s) => s.shipped_at).filter((d): d is string => !!d).sort()[0];
  const writeDate = order.ship_date || firstDone || (shippedAt ? kstDateOf(shippedAt) : "");
  if (!writeDate) warnings.push("발송일이 없어 작성일자를 비워 뒀습니다 — 직접 넣으세요.");
  else if (firstDone && order.ship_date && firstDone !== order.ship_date) warnings.push(`발주 발송일(${order.ship_date})과 첫 발송완료일(${firstDone})이 다릅니다.`);

  const purpose: PurposeCode = order.payment_status === "입금완료" ? "RECEIPT" : "CLAIM";
  if (order.payment_status === "불필요") warnings.push("입금 '불필요' 발주라 '청구'로 두었습니다 — 필요하면 바꾸세요.");

  return { docs, expectedTotal: G, statementTotal, writeDate, purpose, freebies, blockers, warnings };
}

// 미리보기 지문 — 화면이 본 미리보기(거래처·기본 작성일자·영수/청구·문서 금액·품목)와 발행 순간 다시 계산한 것이
//  같은지 서버가 대조한다(FNV-1a). 다르면 그새 발주가 바뀐 것 — 거절하고 화면이 다시 불러온다.
export function draftFingerprint(d: TiDraft, companyId = ""): string {
  const src = JSON.stringify([companyId, d.writeDate, d.purpose, d.docs.map((x) => [x.taxType, x.supplyCost, x.tax, x.lines.map((l) => [l.name, l.spec, l.quantity, l.unitPrice, l.supplyCost, l.tax])])]);
  let h = 0x811c9dc5;
  for (let i = 0; i < src.length; i++) { h ^= src.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${h.toString(16).padStart(8, "0")}-${src.length.toString(36)}`;
}

// ── 공급자·공급받는자 ─────────────────────────────────────────
export type TiParty = {
  bizNo: string; name: string; ceo: string; address: string; bizType: string; bizItem: string;
  email: string; manager: string; phone: string;
};
// 볼타 스키마 그대로 — 이메일 패턴, 담당자 연락처는 휴대폰(010-0000-0000)만
const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const MOBILE_RE = /^010-\d{4}-\d{4}$/;
const mobileOf = (raw: string) => { const f = formatPhone(raw.trim()); return MOBILE_RE.test(f) ? f : ""; };
// 발행 전 검사 — 볼타 필수값·길이(문서 기준) 미리 막기. 이모지 등 볼타가 못 받는 문자는 지운 뒤 길이를 본다.
export function partyErrors(p: TiParty, role: "공급자" | "공급받는자"): string[] {
  const out: string[] = [];
  const d = (p.bizNo || "").replace(/\D/g, "");
  if (d.length !== 10) out.push(`${role} 사업자등록번호 10자리가 필요합니다.`);
  else if (checkBizNo(d) !== "valid") out.push(`${role} 사업자등록번호가 올바르지 않습니다(검증 실패).`);
  const name = bmp(p.name).trim(), ceo = bmp(p.ceo).trim(), email = p.email.trim();
  if (!name) out.push(`${role} 상호가 비었습니다.`);
  else if (name.length > 70) out.push(`${role} 상호는 70자까지입니다.`);
  if (!ceo) out.push(`${role} 대표자가 비었습니다.`);
  else if (ceo.length > 30) out.push(`${role} 대표자는 30자까지입니다.`);
  if (!email) out.push(`${role} 이메일이 비었습니다(계산서 수신·발송에 필요).`);
  else if (email.length > 40) out.push(`${role} 이메일은 40자까지입니다.`);
  else if (!EMAIL_RE.test(email)) out.push(`${role} 이메일 형식이 올바르지 않습니다.`);
  if (bmp(p.address).trim().length > 150) out.push(`${role} 주소는 150자까지입니다.`);
  if (bmp(p.bizType).trim().length > 100 || bmp(p.bizItem).trim().length > 100) out.push(`${role} 업태·종목은 각각 100자까지입니다.`);
  return out;
}
// 발행은 되지만 알아 둘 것 — 휴대폰이 아닌 연락처는 계산서에서 빠진다
export function partyWarnings(p: TiParty, role: "공급자" | "공급받는자"): string[] {
  return p.phone.trim() && !mobileOf(p.phone) ? [`${role} 연락처는 휴대폰(010-0000-0000)만 볼타가 받아 계산서에서 뺍니다.`] : [];
}
const partyBody = (p: TiParty) => {
  const b: Record<string, unknown> = {
    identificationNumber: p.bizNo.replace(/\D/g, ""),
    organizationName: cut(bmp(p.name).trim(), 70),
    representativeName: cut(bmp(p.ceo).trim(), 30),
  };
  const address = cut(p.address.trim(), 150).trim(), bizType = cut(p.bizType.trim(), 100).trim(), bizItem = cut(p.bizItem.trim(), 100).trim();
  if (address) b.address = address;
  if (bizType) b.businessType = bizType;
  if (bizItem) b.businessItem = bizItem;
  return b;
};
const managerBody = (p: TiParty) => {
  const m: Record<string, unknown> = { email: p.email.trim() };
  const name = cut(p.manager.trim(), 30).trim(), tel = mobileOf(p.phone);
  if (name) m.name = name;
  if (tel) m.telephone = tel;
  return m;
};

// 볼타 POST /v1/taxInvoices/issue 본문 — 문서 1장
export function toBoltaBody(doc: TiDoc, o: { writeDate: string; purpose: PurposeCode; supplier: TiParty; supplied: TiParty; description: string }) {
  const body: Record<string, unknown> = {
    date: o.writeDate,
    purpose: o.purpose,
    taxType: doc.taxType,
    supplier: { ...partyBody(o.supplier), manager: managerBody(o.supplier) },
    supplied: { ...partyBody(o.supplied), managers: [managerBody(o.supplied)] },
    items: doc.lines.map((l) => {
      const it: Record<string, unknown> = { date: o.writeDate, name: cut(l.name.trim(), 100).trim() || "품목", supplyCost: l.supplyCost };
      if (doc.taxType === "TAXABLE") it.tax = l.tax ?? 0;
      if (l.unitPrice != null) it.unitPrice = l.unitPrice;
      if (l.quantity != null) it.quantity = l.quantity;
      const spec = cut(l.spec.trim(), 60).trim(), note = cut(l.note.trim(), 100).trim();
      if (spec) it.specification = spec;
      if (note) it.description = note;
      return it;
    }),
  };
  const desc = cut(o.description.trim(), 150).trim();
  if (desc) body.description = desc;
  return body;
}
