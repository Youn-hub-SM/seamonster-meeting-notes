import { supabaseAdmin } from "./supabase";
import {
  RecipientInput,
  ShipmentScheduleInput,
  normalizeRecipient,
} from "./b2b-orders";

// 저장된 발주상품 (폼 인덱스 → DB id + 스냅샷)
export type SavedOrderItem = { id: string; product_name: string; spec: string | null };

/**
 * 발주의 발송 일정(분할 발송)을 통째로 교체 저장.
 * - 기존 shipments 전부 삭제(shipment_items 는 cascade) 후 재삽입
 * - 각 일정: 공통 배송정보 + 발송예정일·상태·운송장 + 담긴 상품/수량(shipment_items)
 * - 반환: 가장 이른 발송예정일 (orders.ship_date 동기화용)
 */
export async function saveOrderShipments(
  orderId: string,
  recipient: RecipientInput,
  schedules: ShipmentScheduleInput[],
  orderItems: SavedOrderItem[]
): Promise<{ earliestShipDate: string | null }> {
  const sb = supabaseAdmin();

  // 기존 발송 일정 전체 삭제 (PUT 재저장 대비)
  await sb.from("shipments").delete().eq("order_id", orderId);

  const rec = normalizeRecipient(recipient || ({} as RecipientInput));
  let earliest: string | null = null;
  let seq = 1;

  for (const sch of schedules || []) {
    // 이 일정에 담긴 상품 (수량>0, 유효 인덱스만)
    const items = (sch.items || [])
      .map((it) => ({ idx: it.order_item_index, qty: Number(it.qty) || 0 }))
      .filter((it) => it.qty > 0 && orderItems[it.idx]);

    // 날짜·상품 둘 다 없는 빈 일정은 스킵
    if (!sch.ship_date && items.length === 0) continue;

    const { data: shipRow, error: shipErr } = await sb
      .from("shipments")
      .insert({
        order_id: orderId,
        seq: seq++,
        ship_date: sch.ship_date || null,
        status: sch.status || "발송대기",
        recipient_name: rec.recipient_name || "(미지정)",
        recipient_phone: rec.recipient_phone || "",
        address: rec.address || "(주소 미입력)",
        delivery_memo: rec.delivery_memo,
        courier: rec.courier,
        tracking_no: (sch.tracking_no || "").trim() || null,
        shipped_at: sch.status === "발송완료" ? new Date().toISOString() : null,
      })
      .select("id")
      .single();
    if (shipErr) throw shipErr;

    if (items.length > 0) {
      const rows = items.map((it) => ({
        shipment_id: shipRow.id,
        order_item_id: orderItems[it.idx].id,
        product_name: orderItems[it.idx].product_name,
        spec: orderItems[it.idx].spec,
        qty: it.qty,
      }));
      const { error: siErr } = await sb.from("shipment_items").insert(rows);
      if (siErr) throw siErr;
    }

    if (sch.ship_date && (!earliest || sch.ship_date < earliest)) earliest = sch.ship_date;
  }

  return { earliestShipDate: earliest };
}
