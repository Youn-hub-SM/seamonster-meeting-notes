// 월간 매입 결산(견적서) 계산 — 서버 전용. 입고 원장 + 제품 마스터 → 면세/과세/임대료 요약 + SKU별 집계.
// 사용자 실제 양식(씨몬스터_매입 결산) 기준: 코드명·품목명·규격(g)·원산지·매입가·매입수량·반품수량·총 매입금액.

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
  qty: number;            // 매입수량(Σ, 반품 차감 전)
  return_qty: number;     // 반품수량(제조사 반품, Σ)
  net_qty: number;        // 정산수량 = 매입수량 − 반품수량 (반품이 더 많으면 음수)
  amount: number;         // 공급가액 = 매입액 − 반품액 (반품이 더 크면 음수)
  gross_amount: number;   // 반품 차감 전 공급가액 — 반품액 표시용
  return_amount: number;  // 반품 공급가액 — 반품 단가, 없으면 그 달 매입가, 교차월이면 마스터 매입단가
  total: number;          // 총 매입금액 = 공급가액 기준(부가세 미포함, 반품 차감 후).
                          //  입고 단가 = 공급가액(2026-09-02 대표 확정) — 부가세는 품목표가 아니라
                          //  요약 블록의 '과세품목 세액'에서만 붙는다.
  unit_price: number;     // 매입가(가중평균 = round(gross_amount/qty), 순액)
  ref_price: number;      // 기준 매입가(제품 마스터 purchase_price)
  price_varies: boolean;  // 한 달 안에 단가가 여러 개였는지
  no_price_qty: number;   // 단가를 안 적고 입고한 수량 — 가중평균 매입가를 끌어내리므로 화면에서 경고
}

// 제조사 반품 1건 — purchase_returns 행. unit_amount 가 null 이면 그 달 매입가를 쓴다.
//  product 는 교차월 반품(그 달 매입이 없는 품목) 행을 품목표에 만들 때 쓴다.
export interface QuoteReturn {
  product_id: string;
  qty: number;
  unit_amount: number | null;
  product?: {
    sku: string | null;
    name: string;
    spec: string | null;
    origin: string | null;
    purchase_price: number | null;
    tax_type: QuoteTax | string | null;
  } | null;
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
  itemCount: number; totalQty: number; totalAmount: number; // totalAmount = 품목표 총 매입금액 합(공급가액 기준)
  noPriceQty: number;      // 단가 미입력 입고 수량 합 — 0 보다 크면 매입가가 실제보다 낮게 나온다
  totalReturnQty: number;  // 반품수량 합
  returnAmount: number;    // 반품으로 깎인 공급가액 합(순액)
}

export interface QuoteResult {
  month: string;
  items: QuoteItem[];
  raw: QuoteRaw[];
  summary: QuoteSummary;
}

const normTax = (v: unknown): QuoteTax => (String(v) === "exempt" ? "exempt" : "taxable");

// 입고 원장(제품 조인) → 결산 결과.
//  rent=임대료 총액(부가세 포함), exemptEtc=면세 기타(면세취급), taxableEtc=과세 기타 공급가액(스티로폼·택배비 등 부자재),
//  returns=제조사 반품(그 달 purchase_returns). 반품은 매입수량에서 빼며 재고와는 무관하다.
export function computeQuote(
  month: string,
  txns: QuoteTxn[],
  opts: { rent?: number; exemptEtc?: number; taxableEtc?: number; returns?: QuoteReturn[] } = {},
): QuoteResult {
  const rent = Math.max(0, Number(opts.rent) || 0);
  const exemptEtc = Math.max(0, Number(opts.exemptEtc) || 0);
  const taxableEtc = Math.max(0, Number(opts.taxableEtc) || 0);

  // 품목별 반품 합계 — 단가를 적은 건은 그 단가로, 안 적은 건은 매입가로 금액을 매긴다.
  const retQty = new Map<string, number>();
  const retFixed = new Map<string, number>();   // 단가를 직접 적은 반품의 금액 합
  const retFixedQty = new Map<string, number>();
  const retProd = new Map<string, QuoteReturn["product"]>(); // 교차월 반품용 제품 정보
  for (const r of opts.returns ?? []) {
    const q = Math.abs(Math.round((Number(r.qty) || 0) * 100) / 100);
    if (!q) continue;
    retQty.set(r.product_id, (retQty.get(r.product_id) ?? 0) + q);
    if (r.product && !retProd.has(r.product_id)) retProd.set(r.product_id, r.product);
    if (r.unit_amount != null && Number(r.unit_amount) > 0) {
      retFixed.set(r.product_id, (retFixed.get(r.product_id) ?? 0) + Math.round(Number(r.unit_amount)) * q);
      retFixedQty.set(r.product_id, (retFixedQty.get(r.product_id) ?? 0) + q);
    }
  }

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
      cur.qty += q; cur.amount += amount; cur.gross_amount += amount; if (unit > 0) cur._prices.add(unit); else cur.no_price_qty += q;
    } else {
      map.set(t.product_id, {
        product_id: t.product_id, sku: p?.sku ?? null, name: p?.name ?? "(삭제된 품목)",
        spec: p?.spec ?? null, origin: p?.origin ?? null, tax_type: normTax(p?.tax_type),
        qty: q, return_qty: 0, net_qty: 0, amount, gross_amount: amount, return_amount: 0,
        total: 0, unit_price: 0, ref_price: Math.round(Number(p?.purchase_price) || 0),
        price_varies: false, no_price_qty: unit > 0 ? 0 : q, _prices: new Set(unit > 0 ? [unit] : []),
      });
    }
  }

  // 교차월 반품 — 그 달 매입이 없는 품목의 반품도 품목 행(매입 0)으로 추가해 차감한다
  //  (2026-09-02 대표 확정: 반품은 그 달 매입 유무와 무관하게 결산에 반영).
  for (const [pid, q] of retQty) {
    if (map.has(pid) || !q) continue;
    const p = retProd.get(pid);
    map.set(pid, {
      product_id: pid, sku: p?.sku ?? null, name: p?.name ?? "(삭제된 품목)",
      spec: p?.spec ?? null, origin: p?.origin ?? null, tax_type: normTax(p?.tax_type),
      qty: 0, return_qty: 0, net_qty: 0, amount: 0, gross_amount: 0, return_amount: 0,
      total: 0, unit_price: 0, ref_price: Math.round(Number(p?.purchase_price) || 0),
      price_varies: false, no_price_qty: 0, _prices: new Set(),
    });
  }

  const items: QuoteItem[] = [...map.values()].map((it) => {
    const unit_price = it.qty > 0 ? Math.round(it.gross_amount / it.qty) : 0;
    // 반품은 수량에서 뺀다 — 반품한 만큼 애초에 안 산 것으로 친다.
    //  단가를 적은 반품은 그 단가로, 안 적은 반품은 그 달 매입가로, 그 달 매입 자체가 없으면(교차월)
    //  마스터 매입단가로 금액을 매긴다. 매입보다 반품이 많으면 음수로 그대로 차감한다.
    //  ※ 마스터 폴백은 교차월(qty 0) 행에만 — 그 달 매입이 있는데 전부 단가 미입력인 품목까지
    //    마스터가로 깎으면 매입은 0원인데 반품만 값이 붙어 총액이 음수로 뒤집힌다.
    const return_qty = retQty.get(it.product_id) ?? 0;
    const fixedQty = retFixedQty.get(it.product_id) ?? 0;
    const fallbackUnit = unit_price > 0 ? unit_price : (it.qty === 0 ? it.ref_price : 0);
    const return_amount = (retFixed.get(it.product_id) ?? 0) + fallbackUnit * Math.max(0, return_qty - fixedQty);
    const net_qty = it.qty - return_qty;
    const amount = it.gross_amount - return_amount;
    // 품목표 금액은 과세·면세 모두 공급가액 그대로 — 부가세는 요약의 과세품목 세액에서만.
    //  (이전엔 과세에 ×1.1 을 얹어 품목표가 실제 매입 원장 금액과 어긋나 보였다 — 대표 정정 지시)
    const total = Math.round(amount);
    const { _prices, ...rest } = it;
    // 매입 없는 반품 행은 매입가 칸에 반품을 매긴 단가(마스터 매입단가)를 보여준다
    const shownUnit = it.qty > 0 ? unit_price : (return_qty > 0 ? Math.round(Math.abs(return_amount) / return_qty) : 0);
    return { ...rest, return_qty, net_qty, return_amount, amount, total, unit_price: shownUnit, price_varies: _prices.size > 1 };
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
    noPriceQty: items.reduce((s, i) => s + i.no_price_qty, 0),
    // 합계는 열마다 그 열을 그대로 더한다 — 매입수량은 반품 차감 전, 총 매입금액은 차감 후.
    totalQty: items.reduce((s, i) => s + i.qty, 0),
    totalReturnQty: items.reduce((s, i) => s + i.return_qty, 0),
    returnAmount: items.reduce((s, i) => s + i.return_amount, 0),
    totalAmount: items.reduce((s, i) => s + i.total, 0), // 품목표 총 매입금액 합(공급가액 기준)
  };

  return { month, items, raw, summary };
}
