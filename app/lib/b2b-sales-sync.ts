import { supabaseAdmin } from "./supabase";
import { normalizeRow, rowHash, type SalesOrderRow } from "./sales-normalize";
import { fetchAllPages, fetchInChunks } from "./sales-paging";

// 도매 발주가 '발송완료'되면 매출 라인을 Supabase 매출원장(sales_orders)에 반영.
//  (이전: 구글시트 Apps Script append → 지금: sales_orders 직접 적재)
//  - channel="도매", source="b2b", upload_batch="b2b-<발주id>"(발주 단위 태그 → 재동기화 대상 식별)
//  - 매출집계 엑셀(/api/b2b/reports/export)도 같은 라인 계산(buildOrderSalesLines)을 쓴다 — 엑셀 합 = 원장 합
//  - 라인 병합: 완전 동일한 라인(상품·옵션·SKU·단가)은 수량을 합산해 1행으로 → row_hash 충돌로 매출 누락 방지
//  - 재동기화(결정적 재빌드): 매번 현재 상태로 행을 다시 계산해 원장을 그 행 집합과 똑같이 맞춘다
//    · 133 적용 시 sync_b2b_sales RPC 한 트랜잭션(발주 단위 잠금) — 중간 실패로 옛 행·새 행이 같이 남지 않는다
//    · 쓰고 나서 발주를 다시 읽어 같은 행인지 확인 — 다른 저장과 겹쳐 옛 상태로 썼으면 다시 맞춘다
//  - 재구매/고객 분석 오염 방지: 전화 미전달 → customer_key='' (매출액만 반영, sales_customers 미기록)
//  Node 런타임 전용(sales-normalize 의 crypto). 호출 라우트는 nodejs 여야 함.

const SEP = String.fromCharCode(1); // 병합 키 구분자(제어문자 SOH) — 상품명/옵션/SKU 본문에 없어 필드 경계 모호성 방지

type Sb = ReturnType<typeof supabaseAdmin>;
type ProductJoin = { sku?: string | null };
type ItemJoin = {
  id: string;
  product_name: string;
  option_label: string | null;
  spec: string | null;
  qty: number;
  unit_price: number;
  sort_order: number;
  tax_type?: string | null; // 'exempt' 면 면세 — 부가세 계산에서 제외
  product?: ProductJoin | ProductJoin[] | null;
};
type ShipmentJoin = { status: string; shipment_items: { order_item_id: string | null; qty: number }[] };
export type SalesOrderJoin = {
  id: string;
  order_no: string;
  order_date: string;
  ship_date: string | null;
  status: string;
  discount_amount?: number | null; // 발주 할인(095) — 미적용 환경에선 조회에서 빠져 undefined
  order_items: ItemJoin[];
  shipments?: ShipmentJoin[] | null;
};

const ITEMS_SEL =
  "order_items(id, product_name, option_label, spec, qty, unit_price, sort_order, tax_type, product:product_id(sku)), " +
  "shipments(status, shipment_items(order_item_id, qty))";
// 매출 라인 계산에 필요한 발주 칸(엑셀·대조 화면 공용). 095 미적용이면 discount_amount 를 빼고 다시 읽는다(withDiscountFallback).
export const SALES_ORDER_SELECT = "id, order_no, order_date, ship_date, status, discount_amount, " + ITEMS_SEL;
const SALES_ORDER_SELECT_NO_DISCOUNT = "id, order_no, order_date, ship_date, status, " + ITEMS_SEL;

export async function withDiscountFallback<T>(run: (cols: string) => Promise<T>): Promise<T> {
  try {
    return await run(SALES_ORDER_SELECT);
  } catch (e) {
    const msg = (e as { message?: string })?.message || "";
    if (/discount/i.test(msg)) return run(SALES_ORDER_SELECT_NO_DISCOUNT);
    throw e;
  }
}

export type SalesLine = { product_name: string; option_name: string; sku: string; price: number; qty: number; taxable: boolean; paid: number };

// 발주 1건 → 매출 라인(순수 계산 — 상태는 보지 않는다).
//  - 취소 차수에 배정된 수량은 라인별 감액(전량 취소 라인 제외)
//  - 결제금액 = 부가세 포함. VAT = 전량 과세 공급가의 VAT(095 트리거 orders.vat) − 취소분 과세 공급가의 VAT —
//    명세표·미수금(b2b-cancel)·매출 집계 화면과 같은 반올림 규칙이라 원장 합 = 실제 청구액
//  - 발주 할인(양수)/추가금(음수)은 VAT 포함 라인 금액에 비례 배분, 마지막 라인이 반올림 오차 흡수
export function buildOrderSalesLines(o: Pick<SalesOrderJoin, "order_items" | "shipments" | "discount_amount">): SalesLine[] {
  const cancelledQty = new Map<string, number>();
  for (const sh of o.shipments ?? []) {
    if (sh.status !== "취소") continue;
    for (const si of sh.shipment_items ?? []) {
      if (si.order_item_id) cancelledQty.set(si.order_item_id, (cancelledQty.get(si.order_item_id) || 0) + (Number(si.qty) || 0));
    }
  }

  let fullTaxable = 0;
  let cancelledTaxable = 0;
  const groups = new Map<string, { product_name: string; option_name: string; sku: string; price: number; qty: number; taxable: boolean }>();
  for (const it of (o.order_items ?? []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))) {
    const product = Array.isArray(it.product) ? it.product[0] : it.product;
    const product_name = it.product_name ?? "";
    const option_name = it.spec || it.option_label || "";
    const sku = product?.sku ?? "";
    const price = Number(it.unit_price) || 0;
    const taxable = it.tax_type !== "exempt";
    const qtyAll = Number(it.qty) || 0;
    const cut = Math.min(qtyAll, cancelledQty.get(it.id) || 0);
    if (taxable) { fullTaxable += qtyAll * price; cancelledTaxable += Math.max(0, cut) * price; }
    const qty = Math.max(0, qtyAll - (cancelledQty.get(it.id) || 0)); // 취소 차수 수량 차감
    if (qty === 0) continue; // 전량 취소된 라인은 원장에서 제외
    const key = [product_name, option_name, sku, price, taxable ? "t" : "x"].join(SEP);
    const g = groups.get(key);
    if (g) g.qty += qty;
    else groups.set(key, { product_name, option_name, sku, price, qty, taxable });
  }

  const entries = [...groups.values()];
  const supplyOf = (g: { qty: number; price: number }) => g.qty * g.price;
  const orderVat = Math.round(fullTaxable * 0.1) - Math.round(cancelledTaxable * 0.1);
  const vatOf: number[] = [];
  {
    let vatAcc = 0;
    const lastTaxable = entries.map((g) => g.taxable).lastIndexOf(true);
    for (let i = 0; i < entries.length; i++) {
      const g = entries[i];
      if (!g.taxable) { vatOf.push(0); continue; }
      const v = i === lastTaxable ? orderVat - vatAcc : Math.round(supplyOf(g) * 0.1);
      vatOf.push(v);
      vatAcc += v;
    }
  }
  const lineAmt = (g: { qty: number; price: number }, i: number) => supplyOf(g) + (vatOf[i] || 0);
  const gross = entries.reduce((s, g, i) => s + lineAmt(g, i), 0);
  const disc = Math.min(Number(o.discount_amount) || 0, gross); // 할인은 gross 상한, 음수(추가금)는 그대로 통과
  const out: SalesLine[] = [];
  let allocated = 0;
  for (let i = 0; i < entries.length; i++) {
    const line = lineAmt(entries[i], i);
    const paid = i === entries.length - 1
      ? gross - disc - allocated
      : Math.round(line * (gross > 0 ? 1 - disc / gross : 1));
    allocated += paid;
    out.push({ ...entries[i], paid });
  }
  return out;
}

// 발주 1건 → 원장 행. 발송완료가 아니면 빈 배열(취소·되돌림·발송대기 = 매출 없음).
//  정규화 실패를 조용히 빼면 매출이 빠진 채 '반영 완료'가 되므로 throw.
export function buildOrderSalesRows(o: SalesOrderJoin): SalesOrderRow[] {
  if (o.status !== "발송완료") return [];
  const rows: SalesOrderRow[] = [];
  for (const g of buildOrderSalesLines(o)) {
    const nr = normalizeRow({
      "판매처": "도매",
      // 매출 인식일 = 발송일(발송일 미입력 옛 발주만 발주일 폴백) — 발주일이 아니다(2026-09-08).
      //  날짜가 바뀌면 row_hash 도 바뀌므로, 다음 재동기화 때 새 날짜로 다시 적재된다.
      "주문일자": o.ship_date || o.order_date,
      "주문번호": o.order_no,
      "상품명": g.product_name,
      "옵션명": g.option_name,
      "관리코드": g.sku,
      "수량": g.qty,
      "판매가": g.price,
      "옵션금액": 0,
      "결제금액": g.paid,
      "배송비결제금액": 0,
    });
    if (!nr.ok || !nr.order) throw new Error(`매출 행 변환 실패(${o.order_no}): ${nr.error || "정규화 실패"}`);
    rows.push(nr.order);
  }
  return rows;
}

async function loadOrder(sb: Sb, orderId: string): Promise<SalesOrderJoin | null> {
  return withDiscountFallback(async (cols) => {
    const { data, error } = await sb.from("orders").select(cols).eq("id", orderId).maybeSingle();
    if (error) throw error;
    return (data as unknown as SalesOrderJoin | null) ?? null;
  });
}

const isMissingFn = (e: { code?: string; message?: string } | null) =>
  !!e && (e.code === "PGRST202" || (/sync_b2b_sales/.test(e.message || "") && /(could not find|does not exist|schema cache)/i.test(e.message || "")));

// 원장을 rows 와 똑같이 맞춘다. 발송완료·취소면 같은 주문번호의 다른 배치·백필(upload_batch 없음) 도매 행도 지운다 —
//  발송대기 등 미완료 발주에서 지우면 백필 매출이 대체 없이 사라져 그때는 두지 않는다(기존 규칙).
async function applyRows(sb: Sb, o: { id: string; order_no: string; status: string }, rows: SalesOrderRow[]): Promise<void> {
  const { error } = await sb.rpc("sync_b2b_sales", { p_order_id: o.id, p_order_no: o.order_no || "", p_status: o.status, p_rows: rows });
  if (!error) return;
  if (!isMissingFn(error)) throw error;

  // 133 미적용 폴백 — 단계별(중간 실패 시 다음 동기화가 바로잡는다)
  const batch = `b2b-${o.id}`;
  const chunk = rows.map((r) => ({ ...r, source: "b2b", upload_batch: batch }));
  if (chunk.length) {
    const { error: insErr } = await sb.from("sales_orders").upsert(chunk, { onConflict: "row_hash", ignoreDuplicates: true });
    if (insErr) throw insErr;
  }
  if ((o.status === "발송완료" || o.status === "취소") && o.order_no) {
    // upload_batch <> 'b2b-…' 만 쓰면 NULL(백필) 행이 빠진다 — is.null 을 같이 건다
    const { error: delErr, count } = await sb.from("sales_orders").delete({ count: "exact" })
      .eq("channel", "도매").eq("order_id", o.order_no).or(`upload_batch.is.null,upload_batch.neq.${batch}`);
    if (delErr) throw delErr;
    // 같은 해시가 다른 배치로 있어 위 넣기가 건너뛰었다면 방금 지워졌으므로 다시 넣는다
    if (count && chunk.length) {
      const { error: reErr } = await sb.from("sales_orders").upsert(chunk, { onConflict: "row_hash", ignoreDuplicates: true });
      if (reErr) throw reErr;
    }
  }
  const keep = new Set(rows.map((r) => r.row_hash));
  const existing = await fetchAllPages<{ row_hash: string }>((lo, hi) =>
    sb.from("sales_orders").select("row_hash").eq("upload_batch", batch).order("row_hash").range(lo, hi));
  const stale = existing.map((r) => r.row_hash).filter((h) => !keep.has(h));
  for (let i = 0; i < stale.length; i += 100) {
    const { error: sErr } = await sb.from("sales_orders").delete().eq("upload_batch", batch).in("row_hash", stale.slice(i, i + 100));
    if (sErr) throw sErr;
  }
}

// 발주 1건을 매출원장에 반영/재동기화. status==='발송완료'일 때만 행이 있고, 그 외엔 이 발주의 행을 모두 지운다.
//  쓰고 나서 다시 읽어 같은 행 집합이면 끝, 그 사이 발주가 바뀌었으면 새 상태로 다시 맞춘다(최대 3회).
//  반환: { synced, rows }. 실패 시 throw.
export async function syncOrderSales(orderId: string): Promise<{ synced: boolean; rows: number }> {
  const sb = supabaseAdmin();
  let written: string | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const o = await loadOrder(sb, orderId);
    if (!o) {
      // 발주가 지워졌으면 이 발주 배치 행만 지운다(주문번호를 모르므로 백필 행은 건드리지 않는다)
      await applyRows(sb, { id: orderId, order_no: "", status: "삭제" }, []);
      return { synced: false, rows: 0 };
    }
    const rows = buildOrderSalesRows(o);
    const sig = `${o.status}|${o.order_no}|${rows.map((r) => r.row_hash).sort().join(",")}`;
    if (sig === written) {
      await sb.from("orders").update({ exported_at: new Date().toISOString() }).eq("id", orderId); // 최종 동기화 시각 마킹
      return { synced: rows.length > 0, rows: rows.length };
    }
    if (attempt === 3) break;
    await applyRows(sb, o, rows);
    written = sig;
  }
  throw new Error("발주가 저장 중에 계속 바뀌어 매출 반영을 끝내지 못했습니다");
}

export type SalesSyncResult = { ok: true; rows: number } | { ok: false; error: string };
// 화면에 띄울 문구 — 호출 라우트가 응답에 sales_sync_failed 와 함께 싣는다
export const SALES_SYNC_FAILED_MSG = "매출 반영 실패 — 발주를 다시 저장하세요";

// 상태 변경 핸들러에서 호출. 응답을 막지 않지만 결과를 돌려준다 — 호출부는 ok:false 면
//  응답에 sales_sync_failed:true 를 실어 화면 경고를 띄운다(조용히 성공으로 보이면 매출이 빠진 걸 아무도 모른다).
export async function syncOrderSalesSafe(orderId: string): Promise<SalesSyncResult> {
  try {
    const r = await syncOrderSales(orderId);
    return { ok: true, rows: r.rows };
  } catch (e) {
    console.error("[b2b/sales-sync] 매출 반영 실패:", orderId, e);
    const msg = (e as { message?: string })?.message || String(e);
    return { ok: false, error: msg };
  }
}

// 발주 삭제 때 — 이 발주 배치 행 + 같은 주문번호의 도매 백필·다른 배치 행을 지운다. 실패 시 throw(삭제를 멈추게).
export async function deleteOrderSales(orderId: string, orderNo: string): Promise<void> {
  await applyRows(supabaseAdmin(), { id: orderId, order_no: orderNo || "", status: "취소" }, []);
}

// ─────────────────────────────────────────────
// 대조(S12) — 발주 기준 기대 원장과 실제 원장을 비교해 어긋난 발주만 돌려준다. 고치지 않는다.
// ─────────────────────────────────────────────
export type SalesMismatchKind = "missing" | "differs" | "backfill_dup" | "backfill_only" | "not_completed" | "stale_date";
export const SALES_MISMATCH_LABEL: Record<SalesMismatchKind, string> = {
  missing: "원장에 없음",
  differs: "원장 내용 다름",
  backfill_dup: "백필 행 중복",
  backfill_only: "백필 행만 있음",
  not_completed: "발송완료 아님",
  stale_date: "원장 날짜가 발송일과 다름",
};
export type SalesMismatch = {
  order_id: string; order_no: string; status: string; date: string | null;
  kind: SalesMismatchKind; expected: number; ledger: number;
  note?: string; // differs 의 실제 차이 — 날짜만 다름(원장 날짜) / 금액 다름 / 금액 같음·품목 구성 다름
};
type LedgerRow = { order_id: string; order_date: string; upload_batch: string | null; row_hash: string; subtotal_amount: number };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function reconcileB2BSales(from: string, to: string): Promise<{ checked: number; mismatches: SalesMismatch[] }> {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw new Error("기간 형식이 잘못되었습니다");
  const sb = supabaseAdmin();

  // 1) 기간 안 발송완료 발주(발송일 기준, 없으면 발주일)
  const orders = await withDiscountFallback((cols) =>
    fetchAllPages<SalesOrderJoin>((lo, hi) =>
      sb.from("orders").select(cols).eq("status", "발송완료")
        .or(`and(ship_date.gte.${from},ship_date.lte.${to}),and(ship_date.is.null,order_date.gte.${from},order_date.lte.${to})`)
        .order("id").range(lo, hi), { label: "발주" }));

  // 2) 그 발주들의 도매 원장 행 — 날짜 무관(백필 행은 발주일로, 발송일이 바뀐 행은 옛 날짜로 적혀 있다)
  const ledger = await fetchInChunks<LedgerRow>(orders.map((o) => o.order_no), (part, lo, hi) =>
    sb.from("sales_orders").select("id, order_id, order_date, upload_batch, row_hash, subtotal_amount")
      .eq("channel", "도매").in("order_id", part).order("id").range(lo, hi));
  const byNo = new Map<string, LedgerRow[]>();
  for (const r of ledger) { const a = byNo.get(r.order_id) || []; a.push(r); byNo.set(r.order_id, a); }

  const mismatches: SalesMismatch[] = [];
  const sum = (rows: { subtotal_amount: number }[]) => rows.reduce((s, r) => s + (Number(r.subtotal_amount) || 0), 0);
  for (const o of orders) {
    const exp = buildOrderSalesRows(o);
    const expected = sum(exp);
    const rows = byNo.get(o.order_no) || [];
    const batch = `b2b-${o.id}`;
    const own = rows.filter((r) => r.upload_batch === batch);
    const other = rows.filter((r) => r.upload_batch !== batch);
    let kind: SalesMismatchKind | null = null;
    if (own.length === 0 && other.length === 0) kind = exp.length ? "missing" : null;
    else if (other.length && own.length) kind = "backfill_dup";
    else if (other.length) kind = "backfill_only";
    else {
      const want = exp.map((r) => r.row_hash).sort().join(",");
      const have = own.map((r) => r.row_hash).sort().join(",");
      if (want !== have) kind = "differs";
    }
    const ledgerSum = sum(rows);
    let note: string | undefined;
    if (kind === "differs") {
      // 원장 날짜 하나로 기대 행을 다시 해시해 같으면 날짜만 다른 것(2026-09-08 전 발주일 기준으로 적힌 행 등)
      const dates = [...new Set(own.map((r) => r.order_date))];
      const have = own.map((r) => r.row_hash).sort().join(",");
      const reHashed = dates.length === 1
        ? exp.map((r) => rowHash({ ...r, order_date_int: Number(dates[0].replace(/-/g, "")) })).sort().join(",")
        : "";
      if (reHashed && reHashed === have) note = `날짜만 다름 · 원장 ${dates[0]}`;
      else if (expected !== ledgerSum) note = "금액 다름";
      else note = "금액 같음 · 품목 구성 다름";
    }
    if (kind) mismatches.push({ order_id: o.id, order_no: o.order_no, status: o.status, date: o.ship_date || o.order_date, kind, expected, ledger: ledgerSum, note });
  }

  // 3) 기간 안 b2b 행 중 위 발주에 속하지 않는 것 — 취소·되돌림·삭제된 발주, 발송일이 기간 밖으로 바뀐 발주
  const seen = new Set(orders.map((o) => `b2b-${o.id}`));
  const inRange = await fetchAllPages<LedgerRow>((lo, hi) =>
    sb.from("sales_orders").select("id, order_id, order_date, upload_batch, row_hash, subtotal_amount")
      .eq("channel", "도매").like("upload_batch", "b2b-%").gte("order_date", from).lte("order_date", to)
      .order("id").range(lo, hi), { label: "매출 원장" });
  const orphan = new Map<string, LedgerRow[]>();
  for (const r of inRange) {
    if (!r.upload_batch || seen.has(r.upload_batch)) continue;
    const a = orphan.get(r.upload_batch) || []; a.push(r); orphan.set(r.upload_batch, a);
  }
  if (orphan.size) {
    const ids = [...orphan.keys()].map((b) => b.slice(4));
    const found = await fetchInChunks<{ id: string; order_no: string; status: string; ship_date: string | null; order_date: string }>(ids, (part, lo, hi) =>
      sb.from("orders").select("id, order_no, status, ship_date, order_date").in("id", part).order("id").range(lo, hi));
    const byId = new Map(found.map((o) => [o.id, o]));
    for (const [b, rows] of orphan) {
      const id = b.slice(4);
      const o = byId.get(id);
      mismatches.push({
        order_id: id, order_no: o?.order_no || rows[0]?.order_id || "", status: o?.status || "삭제됨",
        date: o ? o.ship_date || o.order_date : rows[0]?.order_date || null,
        kind: o && o.status === "발송완료" ? "stale_date" : "not_completed",
        expected: 0, ledger: sum(rows),
      });
    }
  }
  mismatches.sort((a, b) => (a.date || "").localeCompare(b.date || "") || a.order_no.localeCompare(b.order_no));
  return { checked: orders.length, mismatches };
}
