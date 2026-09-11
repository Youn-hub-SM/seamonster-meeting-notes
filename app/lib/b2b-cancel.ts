import { supabaseAdmin } from "./supabase";

// 부분취소 감액 — orders.total(095 트리거: order_items 전량 + VAT - 할인)은 취소 차수를 모른다.
//  '취소 차수에 배정된 수량'의 공급가+부가세(과세만)를 계산해 청구·미수금에서 차감한다.
//  매출 3소비처(집계 화면·엑셀·원장 sync)의 취소 감액과 같은 규칙: 라인 수량 상한, exempt 제외 10%.
//  (전량 취소 발주는 미수금 집계에서 status=취소로 아예 제외되므로 여기 대상은 '부분'취소가 주다)
type Sb = ReturnType<typeof supabaseAdmin>;

export async function cancelledDeductionByOrder(sb: Sb, orderIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (orderIds.length === 0) return out;
  const [shipsRes, itemsRes] = await Promise.all([
    sb.from("shipments")
      .select("order_id, status, items:shipment_items(order_item_id, qty)")
      .in("order_id", orderIds)
      .eq("status", "취소"),
    sb.from("order_items").select("id, order_id, qty, unit_price, tax_type").in("order_id", orderIds),
  ]);
  // 조회 실패 시 감액 0(전액 청구 유지) — 미수금이 줄어드는 방향의 오류보다 안전
  if (shipsRes.error || itemsRes.error) return out;

  const cancelledQty = new Map<string, number>(); // order_item_id → 취소 배정 수량 합
  for (const s of shipsRes.data ?? []) {
    const items = (s as { items?: { order_item_id: string | null; qty: number }[] }).items ?? [];
    for (const si of items) {
      if (!si.order_item_id) continue;
      cancelledQty.set(si.order_item_id, (cancelledQty.get(si.order_item_id) || 0) + (Number(si.qty) || 0));
    }
  }
  if (cancelledQty.size === 0) return out;

  const supplyByOrder = new Map<string, number>();
  const taxableByOrder = new Map<string, number>();
  for (const raw of itemsRes.data ?? []) {
    const it = raw as { id: string; order_id: string; qty: number; unit_price: number; tax_type: string | null };
    const c = Math.min(Number(it.qty) || 0, cancelledQty.get(it.id) || 0);
    if (c <= 0) continue;
    const supply = c * (Number(it.unit_price) || 0);
    supplyByOrder.set(it.order_id, (supplyByOrder.get(it.order_id) || 0) + supply);
    if (it.tax_type !== "exempt") {
      taxableByOrder.set(it.order_id, (taxableByOrder.get(it.order_id) || 0) + supply);
    }
  }
  for (const [oid, supply] of supplyByOrder) {
    out.set(oid, supply + Math.round((taxableByOrder.get(oid) || 0) * 0.1));
  }
  return out;
}
