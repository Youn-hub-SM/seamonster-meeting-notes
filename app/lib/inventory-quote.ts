// 월간 매입 결산(견적서) 계산 — 서버 전용. 입고 원장 + 제품 마스터 → 면세/과세/임대료 요약 + SKU별 집계.
// 사용자 실제 양식(씨몬스터_매입 결산) 기준: 코드명·품목명·규격(g)·원산지·매입수량·매입가·총 매입금액·검증.

export type QuoteTax = "taxable" | "exempt";

export interface QuoteTxn {
  product_id: string;
  qty: number;                 // 부호 포함(입고는 +). 집계는 절댓값.
  unit_amount: number | null;
  txn_date: string;
  partner: string | null;
  order_no?: string | null;
  status?: string | null;
  product?: {
    sku: string | null;
    name: string;
    spec: string | null;
    origin: string | null;
    purchase_price: number | null;
    tax_type: QuoteTax | string | null;
  } | null;
}

export interface QuoteItem {
  product_id: string;
  sku: string | null;
  name: string;
  spec: string | null;
  origin: string | null;
  tax_type: QuoteTax;
  qty: number;            // 매입수량(Σ)
  amount: number;         // 공급가액(Σ 단가×수량, 순액)
  total: number;          // 총 매입금액(과세=공급가×1.1, 면세=공급가)
  unit_price: number;     // 매입가(가중평균 = round(amount/qty), 순액)
  ref_price: number;      // 기준 매입가(제품 마스터 purchase_price)
  match: "같음" | "다름" | "-"; // 검증: 기준가 대비
  price_varies: boolean;  // 한 달 안에 단가가 여러 개였는지
}

export interface QuoteRaw {
  order_no: string | null;
  status: string | null;
  txn_date: string;
  partner: string | null;
  sku: string | null;
  name: string;
  qty: number;
  unit_amount: number | null;
  amount: number;
}

export interface QuoteSummary {
  rentTotal: number; rentSupply: number; rentVat: number;
  exemptSupply: number; exemptEtc: number; exemptTotal: number;
  taxableSupply: number; taxableEtc: number; taxableVat: number; taxableTotal: number;
  deposit: number;       // 총 입금액 = 임대료 + 면세 + 과세
  itemCount: number; totalQty: number; totalAmount: number; // totalAmount = 품목표 총 매입금액 합(과세 VAT 포함)
}

export interface QuoteResult {
  month: string;
  items: QuoteItem[];
  raw: QuoteRaw[];
  summary: QuoteSummary;
}

const normTax = (v: unknown): QuoteTax => (String(v) === "exempt" ? "exempt" : "taxable");

// 입고 원장(제품 조인) → 결산 결과.
//  rent=임대료 총액(부가세 포함), exemptEtc=면세 기타(면세취급), taxableEtc=과세 기타 공급가액(스티로폼·택배비 등 부자재).
export function computeQuote(month: string, txns: QuoteTxn[], opts: { rent?: number; exemptEtc?: number; taxableEtc?: number } = {}): QuoteResult {
  const rent = Math.max(0, Number(opts.rent) || 0);
  const exemptEtc = Math.max(0, Number(opts.exemptEtc) || 0);
  const taxableEtc = Math.max(0, Number(opts.taxableEtc) || 0);

  const map = new Map<string, QuoteItem & { _prices: Set<number> }>();
  const raw: QuoteRaw[] = [];

  for (const t of txns) {
    const q = Math.abs(Math.round(Number(t.qty) || 0));
    if (!q) continue;
    const unit = t.unit_amount == null ? 0 : Math.round(Number(t.unit_amount) || 0);
    const amount = unit * q;
    const p = t.product;
    raw.push({
      order_no: t.order_no ?? null, status: t.status ?? null, txn_date: t.txn_date,
      partner: t.partner ?? null, sku: p?.sku ?? null, name: p?.name ?? "(삭제된 품목)",
      qty: q, unit_amount: t.unit_amount, amount,
    });

    const cur = map.get(t.product_id);
    if (cur) {
      cur.qty += q; cur.amount += amount; if (unit > 0) cur._prices.add(unit);
    } else {
      map.set(t.product_id, {
        product_id: t.product_id, sku: p?.sku ?? null, name: p?.name ?? "(삭제된 품목)",
        spec: p?.spec ?? null, origin: p?.origin ?? null, tax_type: normTax(p?.tax_type),
        qty: q, amount, total: 0, unit_price: 0, ref_price: Math.round(Number(p?.purchase_price) || 0),
        match: "-", price_varies: false, _prices: new Set(unit > 0 ? [unit] : []),
      });
    }
  }

  const items: QuoteItem[] = [...map.values()].map((it) => {
    const unit_price = it.qty > 0 ? Math.round(it.amount / it.qty) : 0;
    const match: QuoteItem["match"] = it.ref_price > 0 ? (it.ref_price === unit_price ? "같음" : "다름") : "-";
    const total = it.tax_type === "taxable" ? Math.round(it.amount * 1.1) : it.amount; // 과세는 부가세 포함
    const { _prices, ...rest } = it;
    return { ...rest, total, unit_price, match, price_varies: _prices.size > 1 };
  }).sort((a, b) => a.name.localeCompare(b.name, "ko") || (a.sku || "").localeCompare(b.sku || ""));

  raw.sort((a, b) => (b.txn_date || "").localeCompare(a.txn_date || "") || (b.order_no || "").localeCompare(a.order_no || ""));

  const exemptItems = items.filter((i) => i.tax_type === "exempt").reduce((s, i) => s + i.amount, 0);
  const taxableItems = items.filter((i) => i.tax_type === "taxable").reduce((s, i) => s + i.amount, 0);
  const exemptSupply = exemptItems;                  // 면세 공급가액(품목 합)
  const taxableSupply = taxableItems + taxableEtc;   // 과세 공급가액(품목 + 과세 기타)
  const taxableVat = taxableSupply * 0.1;
  const taxableTotal = taxableSupply + taxableVat;
  const exemptTotal = exemptSupply + exemptEtc;
  const rentSupply = rent > 0 ? rent / 1.1 : 0;
  const rentVat = rent - rentSupply;
  const deposit = rent + exemptTotal + taxableTotal;

  const summary: QuoteSummary = {
    rentTotal: rent, rentSupply, rentVat,
    exemptSupply, exemptEtc, exemptTotal,
    taxableSupply, taxableEtc, taxableVat, taxableTotal,
    deposit,
    itemCount: items.length,
    totalQty: items.reduce((s, i) => s + i.qty, 0),
    totalAmount: items.reduce((s, i) => s + i.total, 0), // 품목표 총 매입금액 합(과세 VAT 포함)
  };

  return { month, items, raw, summary };
}
