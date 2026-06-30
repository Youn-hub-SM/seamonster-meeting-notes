import { supabaseAdmin } from "@/app/lib/supabase";
import type { QuoteTxn } from "@/app/lib/inventory-quote";

const MONTH_RE = /^\d{4}-\d{2}$/;

export function monthRange(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  const from = `${ym}-01`;
  const to = new Date(y, m, 0).toISOString().slice(0, 10); // 말일
  return { from, to };
}

export function validMonth(ym: string | null): string | null {
  return ym && MONTH_RE.test(ym) ? ym : null;
}

type Row = {
  product_id: string; qty: number; unit_amount: number | null; txn_date: string; partner: string | null;
  order_no?: string | null; status?: string | null;
  products?: { sku: string | null; name: string; spec: string | null; origin?: string | null; purchase_price?: number | null; tax_type?: string | null } | null;
};

// 해당 월의 입고(매입) 원장을 제품 마스터와 조인해 반환. 마이그레이션 미적용 환경 대비 단계적 폴백.
export async function fetchQuoteTxns(month: string): Promise<QuoteTxn[]> {
  const sb = supabaseAdmin();
  const { from, to } = monthRange(month);

  // 1) 전체(order_no/status + 매입단가/원산지). 2) order_no/status 제외. 3) 매입단가/원산지 제외.
  const selects = [
    "order_no, status, product_id, qty, unit_amount, txn_date, partner, products(sku, name, spec, origin, purchase_price, tax_type)",
    "product_id, qty, unit_amount, txn_date, partner, products(sku, name, spec, origin, purchase_price, tax_type)",
    "product_id, qty, unit_amount, txn_date, partner, products(sku, name, spec, tax_type)",
  ];
  let data: Row[] | null = null;
  for (const sel of selects) {
    const res = await sb.from("inventory_txns").select(sel)
      .eq("type", "입고").gte("txn_date", from).lte("txn_date", to).limit(5000);
    if (!res.error) { data = res.data as unknown as Row[]; break; }
  }
  if (!data) data = [];

  return data.map((r) => ({
    product_id: r.product_id, qty: r.qty, unit_amount: r.unit_amount, txn_date: r.txn_date, partner: r.partner,
    order_no: r.order_no ?? null, status: r.status ?? null,
    product: r.products ? {
      sku: r.products.sku, name: r.products.name, spec: r.products.spec,
      origin: r.products.origin ?? null, purchase_price: r.products.purchase_price ?? 0, tax_type: r.products.tax_type ?? "taxable",
    } : null,
  }));
}
