import { supabaseAdmin } from "./supabase";

// ─────────────────────────────────────────────
// B2B 발송완료(과거 도매 출고) 수량을 SKU별로 집계 — 소매 판매속도 de-mix용.
//  두 경로를 합산(이중계상 없이):
//   (1) 분할발송 차수: shipments.status='발송완료' & shipped_at(없으면 ship_date) in [from,to]
//        의 shipment_items.qty → order_item_id→order_items.product_id→products.sku
//   (2) 통발송/빈차수: 위에서 shipment_items 로 잡히지 않은 발주 중 orders.status='발송완료'
//        & ship_date in [from,to] → order_items.qty 합산
//        (= 차수가 아예 없거나, 차수는 있어도 상품수량을 안 적은 발송완료 발주를 커버)
//  중복 방지: (1)에서 shipment_items 를 실제 기여한 발주(order_id)는 (2)에서 제외.
//  SKU 못 풀면 제외(차감 누락=과대생산 안전측). 시간창은 KST(+09:00) 기준.
// ─────────────────────────────────────────────

export interface B2bShippedResult {
  bySku: Record<string, number>;
  unresolvedQty: number;   // SKU 해석 실패 수량(차감에서 빠짐)
  shippedAtNull: number;   // shipped_at 없어 ship_date 로 폴백한 차수 수
  wholeOrderQty: number;   // 통발송/빈차수 경로로 잡힌 수량(참고/검증용)
}

export async function getB2bShippedInWindow(from: string, to: string): Promise<B2bShippedResult> {
  const empty: B2bShippedResult = { bySku: {}, unresolvedQty: 0, shippedAtNull: 0, wholeOrderQty: 0 };
  if (!from || !to || to < from) return empty;
  const sb = supabaseAdmin();

  // products: id → sku
  const { data: prods, error: pErr } = await sb.from("products").select("id, sku");
  if (pErr) throw pErr;
  const skuByProduct = new Map<string, string>();
  for (const p of prods ?? []) if (p.sku) skuByProduct.set(p.id as string, String(p.sku).toUpperCase());

  // 발송 차수: id→order_id 맵 + 발송완료&창내 shipIds. 시간창은 KST(+09:00) 경계.
  const fromStart = from + "T00:00:00+09:00";
  const toEnd = to + "T23:59:59.999+09:00";
  const { data: ships, error } = await sb.from("shipments").select("id, order_id, shipped_at, ship_date, status");
  if (error) throw error;
  const orderIdByShip = new Map<string, string>();
  let shippedAtNull = 0;
  const shipIds: string[] = [];
  for (const s of (ships ?? []) as { id: string; order_id: string | null; shipped_at: string | null; ship_date: string | null; status: string }[]) {
    if (s.order_id) orderIdByShip.set(s.id, s.order_id);
    if (s.status !== "발송완료") continue;
    let inWindow = false;
    if (s.shipped_at) {
      inWindow = s.shipped_at >= fromStart && s.shipped_at <= toEnd;
    } else if (s.ship_date) {
      inWindow = s.ship_date >= from && s.ship_date <= to;
      if (inWindow) shippedAtNull++;
    }
    if (inWindow) shipIds.push(s.id);
  }

  const bySku: Record<string, number> = {};
  let unresolvedQty = 0;
  const contributedOrderIds = new Set<string>(); // (1)에서 shipment_items 가 잡힌 발주

  // (1) 분할발송 차수 — shipment_items
  if (shipIds.length) {
    const { data: items, error: iErr } = await sb.from("shipment_items").select("shipment_id, order_item_id, qty").in("shipment_id", shipIds);
    if (iErr) throw iErr;
    const oiIds = [...new Set((items ?? []).map((x) => x.order_item_id).filter(Boolean))] as string[];
    const skuByOrderItem = new Map<string, string>();
    if (oiIds.length) {
      const { data: oi } = await sb.from("order_items").select("id, product_id").in("id", oiIds);
      for (const x of (oi ?? []) as { id: string; product_id: string | null }[]) {
        if (x.product_id && skuByProduct.has(x.product_id)) skuByOrderItem.set(x.id, skuByProduct.get(x.product_id)!);
      }
    }
    for (const it of (items ?? []) as { shipment_id: string; order_item_id: string | null; qty: number }[]) {
      const qty = Number(it.qty) || 0;
      if (qty <= 0) continue;
      const oid = orderIdByShip.get(it.shipment_id);
      if (oid) contributedOrderIds.add(oid); // 이 발주는 (2)에서 제외
      const sku = it.order_item_id ? skuByOrderItem.get(it.order_item_id) : undefined;
      if (sku) bySku[sku] = (bySku[sku] || 0) + qty;
      else unresolvedQty += qty;
    }
  }

  // (2) 통발송/빈차수 — (1)에서 shipment_items 가 안 잡힌 발송완료 발주 → order_items
  let wholeOrderQty = 0;
  const { data: orders, error: oErr } = await sb
    .from("orders")
    .select("id, order_items(product_id, qty)")
    .eq("status", "발송완료")
    .gte("ship_date", from)
    .lte("ship_date", to);
  if (oErr) throw oErr;
  for (const o of (orders ?? []) as unknown as { id: string; order_items: { product_id: string | null; qty: number }[] }[]) {
    if (contributedOrderIds.has(o.id)) continue; // 분할발송 차수로 이미 집계됨 — 이중계상 방지
    for (const it of o.order_items ?? []) {
      const qty = Number(it.qty) || 0;
      if (qty <= 0) continue;
      const sku = it.product_id ? skuByProduct.get(it.product_id) : undefined;
      if (sku) { bySku[sku] = (bySku[sku] || 0) + qty; wholeOrderQty += qty; }
      else unresolvedQty += qty;
    }
  }

  return { bySku, unresolvedQty, shippedAtNull, wholeOrderQty };
}
