import { supabaseAdmin } from "./supabase";
import { normalizeRow, type SalesOrderRow } from "./sales-normalize";

// 도매 발주가 '발송완료'되면 매출 라인을 Supabase 매출원장(sales_orders)에 반영.
//  (이전: 구글시트 Apps Script append → 지금: sales_orders 직접 적재)
//  - channel="도매", source="b2b", upload_batch="b2b-<발주id>"(발주 단위 태그 → 재동기화 대상 식별)
//  - 매출집계 엑셀(/api/b2b/reports/export)·구시트와 동일한 컬럼 매핑을 normalizeRow 로 재사용
//  - 라인 병합: 완전 동일한 라인(상품·옵션·SKU·단가)은 수량을 합산해 1행으로 → row_hash 충돌로 매출 누락 방지
//  - 재동기화(멱등 재빌드): 발송완료 발주가 수정돼도 매번 현재 라인으로 upsert + 없어진 옛 행 삭제 → 원장이 실제와 일치
//  - 이중집계 방지: row_hash 유니크 + 배치 단위 delete(간극 없이 upsert 후 stale 만 삭제)
//  - 재구매/고객 분석 오염 방지: 전화 미전달 → customer_key='' (매출액만 반영, sales_customers 미기록)
//  Node 런타임 전용(sales-normalize 의 crypto). 호출 라우트는 nodejs 여야 함.

const SEP = String.fromCharCode(1); // 병합 키 구분자(제어문자 SOH) — 상품명/옵션/SKU 본문에 없어 필드 경계 모호성 방지

type ProductJoin = { sku?: string | null };
type ItemJoin = {
  product_name: string;
  option_label: string | null;
  spec: string | null;
  qty: number;
  unit_price: number;
  sort_order: number;
  product?: ProductJoin | ProductJoin[] | null;
};
type OrderJoin = {
  id: string;
  order_no: string;
  order_date: string;
  status: string;
  order_items: ItemJoin[];
};

// 발주 1건을 매출원장에 반영/재동기화. status==='발송완료'일 때만 실제 반영.
//  반환: { synced, rows }. 실패 시 throw.
export async function syncOrderSales(orderId: string): Promise<{ synced: boolean; rows: number }> {
  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("orders")
    .select(
      "id, order_no, order_date, status, " +
        "order_items(product_name, option_label, spec, qty, unit_price, sort_order, product:product_id(sku))"
    )
    .eq("id", orderId)
    .maybeSingle();
  if (error) throw error;
  const o = data as unknown as OrderJoin | null;
  if (!o) return { synced: false, rows: 0 };
  if (o.status !== "발송완료") return { synced: false, rows: 0 }; // 발송완료 아님 → 반영/변경 없음

  // 완전 동일한 라인(상품명·옵션·SKU·단가)은 수량 합산 병합 → 동일 row_hash 충돌로 인한 매출 누락 방지
  const groups = new Map<string, { product_name: string; option_name: string; sku: string; price: number; qty: number }>();
  for (const it of (o.order_items ?? []).slice().sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))) {
    const product = Array.isArray(it.product) ? it.product[0] : it.product;
    const product_name = it.product_name ?? "";
    const option_name = it.spec || it.option_label || "";
    const sku = product?.sku ?? "";
    const price = Number(it.unit_price) || 0;
    const qty = Number(it.qty) || 0;
    const key = [product_name, option_name, sku, price].join(SEP);
    const g = groups.get(key);
    if (g) g.qty += qty;
    else groups.set(key, { product_name, option_name, sku, price, qty });
  }

  // 병합 라인 → 매출집계/구시트와 동일한 한글헤더 매핑으로 정규화. 전화 미포함 → customer_key=''
  const rows: SalesOrderRow[] = [];
  for (const g of groups.values()) {
    const nr = normalizeRow({
      "판매처": "도매",
      "주문일자": o.order_date, // YYYY-MM-DD → normalizeRow 가 yyyymmdd 로 변환
      "주문번호": o.order_no,
      "상품명": g.product_name,
      "옵션명": g.option_name,
      "관리코드": g.sku,
      "수량": g.qty,
      "판매가": g.price,
      "옵션금액": 0,
      "결제금액": g.qty * g.price,
      "배송비결제금액": 0,
    });
    if (nr.ok && nr.order) rows.push(nr.order);
  }

  const batch = `b2b-${o.id}`; // 발주 단위 태그(발주id — order_no 변경/충돌과 무관). 웹 업로드 되돌리기(web-*)와 무간섭
  const newHashes = new Set(rows.map((r) => r.row_hash));

  // (1) 현재 라인 upsert(멱등: 기존 동일 해시는 no-op, 변경/신규만 삽입) — 삭제보다 먼저 하여 매출 간극 없음
  if (rows.length) {
    const chunk = rows.map((r) => ({ ...r, source: "b2b", upload_batch: batch }));
    const { error: insErr } = await sb.from("sales_orders").upsert(chunk, { onConflict: "row_hash", ignoreDuplicates: true });
    if (insErr) throw insErr;
  }

  // (2) 이 발주의 옛 행 중 현재 구성에 없는 것 삭제(발송완료 후 수량·단가·품목 수정/삭제 반영)
  const { data: existing, error: exErr } = await sb.from("sales_orders").select("row_hash").eq("upload_batch", batch);
  if (exErr) throw exErr;
  const stale = (existing ?? []).map((r) => r.row_hash as string).filter((h) => !newHashes.has(h));
  if (stale.length) {
    const { error: delErr } = await sb.from("sales_orders").delete().eq("upload_batch", batch).in("row_hash", stale);
    if (delErr) throw delErr;
  }

  await sb.from("orders").update({ exported_at: new Date().toISOString() }).eq("id", orderId); // 최종 동기화 시각 마킹
  return { synced: rows.length > 0, rows: rows.length };
}

// 상태 변경 핸들러에서 호출(에러를 삼키고 응답을 막지 않음). 응답 전에 await 하여 요청 수명 내 완료 보장.
export async function syncOrderSalesSafe(orderId: string): Promise<void> {
  try {
    await syncOrderSales(orderId);
  } catch (e) {
    console.error("[b2b/sales-sync] 발송완료 매출 반영 실패:", orderId, e);
  }
}
