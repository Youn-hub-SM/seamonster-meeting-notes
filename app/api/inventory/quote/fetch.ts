import { supabaseAdmin } from "@/app/lib/supabase";
import type { QuoteTxn, QuoteReturn } from "@/app/lib/inventory-quote";

const MONTH_RE = /^\d{4}-\d{2}$/;

export function monthRange(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  const from = `${ym}-01`;
  // 말일 — Date.UTC 로 계산해야 서버 타임존과 무관하다(로컬 자정 기준이면 KST 환경에서 말일이 하루 밀린다)
  const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
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
//  ※ 도매 채널 입고는 제외한다(2026-08-28 대표 확정) — 소매↔도매 이전이 '도매 입고 +N, 단가 null' 을
//    원장에 남기는데 그건 외부 매입이 아니라 내부 이동이다. 세면 매입수량이 부풀고 가중평균 매입가가
//    0원에 끌려 내려간다. 채널 컬럼(036) 이 없는 옛 기록은 전부 소매라 폴백에서도 안전.
//  ※ '대기' 상태 입고도 제외한다 — 아직 받지 않은 물량이라 매입이 아니다.
//  ※ 채널이동(소매↔도매 이전)이 만든 입고도 제외한다 — 역이전(도매→소매)은 '소매 입고'로 남지만
//    partner='채널이동' 마커로 구분된다. null partner 를 살리기 위해 or 필터 사용.
//  ── 확정 기준(2026-08-28 대표): 월간매입 결산 = 그 달에 생산·입고 경로로 소매에 실제 '입고 완료'된 것만.
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
    const base = () => sb.from("inventory_txns").select(sel)
      .eq("type", "입고").gte("txn_date", from).lte("txn_date", to).limit(5000);
    const noMove = (q: ReturnType<typeof base>) => q.or("partner.is.null,partner.neq.채널이동"); // neq 단독은 null partner 를 탈락시킨다
    let res = await noMove(base().neq("channel", "도매").eq("status", "완료"));
    // 선택 컬럼 미적용 환경 폴백 — channel(036)·status(034) 순서로 조건을 덜어내며 재시도
    if (res.error && /channel/i.test(res.error.message)) res = await noMove(base().eq("status", "완료"));
    if (res.error && /status/i.test(res.error.message)) res = await noMove(base().neq("channel", "도매"));
    if (res.error && /channel|status/i.test(res.error.message)) res = await noMove(base());
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

// 해당 월의 제조사 반품(purchase_returns). 마이그레이션 087 미적용이면 빈 배열 — 결산은 그대로 돈다.
//  제품 마스터를 조인해, 그 달 매입이 없는 품목의 반품(교차월)도 품목표에 행으로 만들 수 있게 한다.
export async function fetchQuoteReturns(month: string): Promise<QuoteReturn[]> {
  const sb = supabaseAdmin();
  const { from, to } = monthRange(month);
  const base = (sel: string) => sb.from("purchase_returns").select(sel)
    .gte("return_date", from).lte("return_date", to).limit(5000);
  let res = await base("product_id, qty, unit_amount, products(sku, name, spec, origin, purchase_price, tax_type)");
  if (res.error) res = await base("product_id, qty, unit_amount"); // 조인 실패 폴백(구 스키마)
  if (res.error) return [];
  type RetRow = { product_id: string; qty: number; unit_amount: number | null; products?: QuoteReturn["product"] };
  return ((res.data ?? []) as unknown as RetRow[]).map((r) => ({
    product_id: r.product_id,
    qty: Number(r.qty) || 0,
    unit_amount: r.unit_amount == null ? null : Number(r.unit_amount),
    product: r.products ?? null,
  }));
}
