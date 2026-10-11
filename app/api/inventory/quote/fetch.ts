import { supabaseAdmin } from "@/app/lib/supabase";
import { isQuotePurchase, type QuoteTxn, type QuoteReturn } from "@/app/lib/inventory-quote";

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
  id?: string;
  product_id: string; qty: number; unit_amount: number | null; txn_date: string; partner: string | null;
  order_no?: string | null; status?: string | null; reason?: string | null; source?: string | null;
  products?: { sku: string | null; name: string; spec: string | null; origin?: string | null; purchase_price?: number | null; tax_type?: string | null } | null;
};

// 해당 월의 입고(매입) 원장을 제품 마스터와 조인해 반환. 마이그레이션 미적용 환경 대비 단계적 폴백.
//  ※ 도매 채널 입고는 제외한다(2026-08-28 대표 확정) — 소매↔도매 이전이 '도매 입고 +N, 단가 null' 을
//    원장에 남기는데 그건 외부 매입이 아니라 내부 이동이다. 세면 매입수량이 부풀고 가중평균 매입가가
//    0원에 끌려 내려간다. 채널 컬럼(036) 이 없는 옛 기록은 전부 소매라 폴백에서도 안전.
//  ※ '대기' 상태 입고도 제외한다 — 아직 받지 않은 물량이라 매입이 아니다.
//  ※ 칸 이동(소매↔도매·프로모션 등)·프로모션 마감 합류가 만든 입고도 제외한다 — 역이전(도매→소매)·합류는 '소매 입고'로 남는다.
//    판정은 출처 칸(source move·promo_close, 131)으로 하고, source 가 없는 옛 기록만 partner '채널이동'으로 본다(S11).
//  ── 확정 기준(2026-08-28 대표): 월간매입 결산 = 그 달에 생산·입고 경로로 소매에 실제 '입고 완료'된 것만.
//  ※ 고객 반품 재입고(reason '고객 반품' 또는 source 'customer_return', 2026-10-11 수동 절차)는 매입이 아니다 — 제외한다
//    (컬럼 미적용이면 조건 없이). 두 제외는 읽은 뒤 isQuotePurchase(inventory-quote)로 — 종합 리포트 월 매입액과 같은 규칙.
//  ── 읽기 규칙(S4): 컬럼 미적용으로 보이는 오류만 다음 select 로 폴백하고, 그 밖의 오류(일시 장애 등)는 던진다.
//    '오류 = 매입 0' 으로 넘기면 결산 화면이 0원을 보여 주고, 그 순간 [확정]이 기존 확정본을 0원으로 덮어쓴다.
//    서버 Max Rows(1000)가 .limit 보다 우선해 조용히 잘리므로 id 순 range 페이징으로 끝까지 읽는다.
const PAGE = 1000;
const MAX_PAGES = 200; // 20만 행 — 이보다 많으면 기간을 잘못 준 것. 잘린 채 계산하지 않고 던진다
const optionalColErr = (m: string) => /\b(channel|status|origin|purchase_price|order_no|reason|source|tax_type)\b/i.test(m) && /column|schema cache|could not find|relationship/i.test(m);
type Resp = { data: unknown; error: { message: string } | null };
async function pageAll<T>(q: (a: number, b: number) => PromiseLike<Resp>): Promise<T[]> {
  const out: T[] = [];
  for (let p = 0; p < MAX_PAGES; p++) {
    const { data, error } = await q(p * PAGE, p * PAGE + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
  throw new Error("한 달 입고 기록이 너무 많아 결산을 계산하지 못했습니다.");
}

export async function fetchQuoteTxns(month: string): Promise<QuoteTxn[]> {
  const sb = supabaseAdmin();
  const { from, to } = monthRange(month);

  // 1) 전체(order_no/status + 매입단가/원산지). 2) order_no/status 제외. 3) 매입단가/원산지 제외.
  //  각 단계는 reason(099)·source(131) 포함 → 미적용이면 뺀 것 순. 이동·합류·고객 반품은 읽은 뒤 여기서 거른다
  //  (source 가 없는 옛 행만 partner 로 보는 판정은 조회 조건으로 쓰기 어렵다 — 행 수가 한 달 입고뿐이라 부담 없다).
  const bases = [
    "id, order_no, status, product_id, qty, unit_amount, txn_date, partner, products(sku, name, spec, origin, purchase_price, tax_type)",
    "id, product_id, qty, unit_amount, txn_date, partner, products(sku, name, spec, origin, purchase_price, tax_type)",
    "id, product_id, qty, unit_amount, txn_date, partner, products(sku, name, spec, tax_type)",
  ];
  const selects = bases.flatMap((b) => [`${b}, reason, source`, `${b}, reason`, b]);
  // 조건 단계 — channel(036)·status(034) 미적용 환경은 그 조건을 덜어낸다
  const conds = [
    { channel: true, status: true },
    { channel: false, status: true },
    { channel: true, status: false },
    { channel: false, status: false },
  ];
  let lastErr: unknown = null;
  for (const sel of selects) {
    for (const c of conds) {
      try {
        const data = await pageAll<Row>((a, b) => {
          let q = sb.from("inventory_txns").select(sel)
            .eq("type", "입고").gte("txn_date", from).lte("txn_date", to);
          if (c.channel) q = q.neq("channel", "도매");
          if (c.status) q = q.eq("status", "완료");
          return q.order("id", { ascending: true }).range(a, b);
        });
        return toQuoteTxns(data.filter(isQuotePurchase));
      } catch (e) {
        const m = String((e as { message?: string } | null)?.message ?? e);
        if (!optionalColErr(m)) throw e; // 일시 오류·잘림 — 0원으로 넘기지 않는다
        lastErr = e;
      }
    }
  }
  throw lastErr ?? new Error("입고 원장을 읽지 못했습니다.");
}

function toQuoteTxns(data: Row[]): QuoteTxn[] {
  return data.map((r) => ({
    product_id: r.product_id, qty: r.qty, unit_amount: r.unit_amount, txn_date: r.txn_date, partner: r.partner,
    order_no: r.order_no ?? null, status: r.status ?? null,
    product: r.products ? {
      sku: r.products.sku, name: r.products.name, spec: r.products.spec,
      origin: r.products.origin ?? null, purchase_price: r.products.purchase_price ?? 0, tax_type: r.products.tax_type ?? "taxable",
    } : null,
  }));
}

// 해당 월의 제조사 반품(purchase_returns). 마이그레이션 087 미적용(테이블 없음)이면 빈 배열 — 결산은 그대로 돈다.
//  그 밖의 오류는 던진다(S4 — 반품을 '없음'으로 보면 매입이 부풀어 확정된다). range 페이징 전량.
//  제품 마스터를 조인해, 그 달 매입이 없는 품목의 반품(교차월)도 품목표에 행으로 만들 수 있게 한다.
const returnsMissing = (m: string) => /purchase_returns/i.test(m) && /does not exist|could not find|schema cache/i.test(m) && !/column|relationship/i.test(m);
export async function fetchQuoteReturns(month: string): Promise<QuoteReturn[]> {
  const sb = supabaseAdmin();
  const { from, to } = monthRange(month);
  type RetRow = { product_id: string; qty: number; unit_amount: number | null; products?: QuoteReturn["product"] };
  const read = (sel: string) => pageAll<RetRow>((a, b) => sb.from("purchase_returns").select(sel)
    .gte("return_date", from).lte("return_date", to).order("id", { ascending: true }).range(a, b));
  let rows: RetRow[];
  try {
    rows = await read("id, product_id, qty, unit_amount, products(sku, name, spec, origin, purchase_price, tax_type)");
  } catch (e) {
    const m = String((e as { message?: string } | null)?.message ?? e);
    if (returnsMissing(m)) return [];
    if (!optionalColErr(m)) throw e;
    rows = await read("id, product_id, qty, unit_amount"); // 조인 실패 폴백(구 스키마)
  }
  return rows.map((r) => ({
    product_id: r.product_id,
    qty: Number(r.qty) || 0,
    unit_amount: r.unit_amount == null ? null : Number(r.unit_amount),
    product: r.products ?? null,
  }));
}
