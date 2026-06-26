import { supabaseAdmin } from "./supabase";

// ─────────────────────────────────────────────
// B2B 발송완료(과거 도매 출고) 수량을 SKU별로 집계 — 소매 판매속도 de-mix용.
//  shipments.status='발송완료' 이고 shipped_at(실제 발송시각)이 [from,to] 안인 차수의
//  shipment_items qty 를 order_item_id→order_items.product_id→products.sku 로 묶어 합산.
//  shipped_at 이 없으면 ship_date 로 폴백. SKU 못 풀면 제외(차감 누락=과대생산 안전측).
// ─────────────────────────────────────────────

export interface B2bShippedResult {
  bySku: Record<string, number>;  // SKU(대문자) → 기간내 B2B 발송완료 수량
  unresolvedQty: number;          // SKU 해석 실패 수량(차감에서 빠짐)
  shippedAtNull: number;          // shipped_at 없어 ship_date 로 폴백한 차수 수
}

export async function getB2bShippedInWindow(from: string, to: string): Promise<B2bShippedResult> {
  const empty: B2bShippedResult = { bySku: {}, unresolvedQty: 0, shippedAtNull: 0 };
  if (!from || !to || to < from) return empty;
  const sb = supabaseAdmin();

  // 1) 발송완료 차수 — shipped_at(timestamptz) 우선, 없으면 ship_date(date) 로 창 매칭
  const fromStart = from + "T00:00:00Z";
  const toEnd = to + "T23:59:59.999Z";
  const { data: ships, error } = await sb
    .from("shipments")
    .select("id, shipped_at, ship_date")
    .eq("status", "발송완료");
  if (error) throw error;

  let shippedAtNull = 0;
  const shipIds: string[] = [];
  for (const s of (ships ?? []) as { id: string; shipped_at: string | null; ship_date: string | null }[]) {
    let inWindow = false;
    if (s.shipped_at) {
      inWindow = s.shipped_at >= fromStart && s.shipped_at <= toEnd;
    } else if (s.ship_date) {
      inWindow = s.ship_date >= from && s.ship_date <= to;
      if (inWindow) shippedAtNull++;
    }
    if (inWindow) shipIds.push(s.id);
  }
  if (shipIds.length === 0) return { ...empty, shippedAtNull };

  // 2) 그 차수의 아이템(수량 + order_item_id)
  const { data: items, error: iErr } = await sb
    .from("shipment_items")
    .select("order_item_id, qty")
    .in("shipment_id", shipIds);
  if (iErr) throw iErr;

  // 3) order_item_id → product_id → sku
  const orderItemIds = [...new Set((items ?? []).map((x) => x.order_item_id).filter(Boolean))] as string[];
  const skuByOrderItem = new Map<string, string>();
  if (orderItemIds.length) {
    const { data: oi } = await sb.from("order_items").select("id, product_id").in("id", orderItemIds);
    const productIds = [...new Set((oi ?? []).map((x) => x.product_id).filter(Boolean))] as string[];
    const skuByProduct = new Map<string, string>();
    if (productIds.length) {
      const { data: prods } = await sb.from("products").select("id, sku").in("id", productIds);
      for (const p of prods ?? []) if (p.sku) skuByProduct.set(p.id as string, String(p.sku).toUpperCase());
    }
    for (const x of (oi ?? []) as { id: string; product_id: string | null }[]) {
      if (x.product_id && skuByProduct.has(x.product_id)) skuByOrderItem.set(x.id, skuByProduct.get(x.product_id)!);
    }
  }

  // 4) SKU 별 합산 (못 푼 건 unresolved)
  const bySku: Record<string, number> = {};
  let unresolvedQty = 0;
  for (const it of (items ?? []) as { order_item_id: string | null; qty: number }[]) {
    const qty = Number(it.qty) || 0;
    if (qty <= 0) continue;
    const sku = it.order_item_id ? skuByOrderItem.get(it.order_item_id) : undefined;
    if (sku) bySku[sku] = (bySku[sku] || 0) + qty;
    else unresolvedQty += qty;
  }
  return { bySku, unresolvedQty, shippedAtNull };
}
