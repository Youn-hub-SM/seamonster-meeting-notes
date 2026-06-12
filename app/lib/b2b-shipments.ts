import { supabaseAdmin } from "./supabase";
import {
  RecipientInput,
  ShipmentScheduleInput,
  normalizeRecipient,
} from "./b2b-orders";

// 저장된 발주상품 (폼 인덱스 → DB id + 스냅샷)
export type SavedOrderItem = { id: string; product_name: string; spec: string | null };

// 복수 발송(2건 이상) 발주의 상위 상태를 하위 차수 상태들로부터 도출.
//  전부 취소 → 취소 / 그 외 → 취소 제외 차수 중 '가장 덜 진행된' 상태(= 가장 느린 차수 기준).
//  발송이 2건 미만이면 null(도출 안 함 — 일반 발주는 상태를 직접 관리).
const STATUS_RANK: Record<string, number> = {
  "발주확인/생산대기": 0,
  "생산요청/생산중": 1,
  "생산완료/발송대기": 2,
  "발송완료": 3,
};
export function deriveParentStatus(statuses: string[]): string | null {
  if (statuses.length < 2) return null;
  const nonCancel = statuses.filter((s) => s !== "취소");
  if (nonCancel.length === 0) return "취소";
  let min = nonCancel[0];
  for (const s of nonCancel) {
    if ((STATUS_RANK[s] ?? 0) < (STATUS_RANK[min] ?? 0)) min = s;
  }
  return min;
}

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
): Promise<{ earliestShipDate: string | null; derivedStatus: string | null; totalBoxes: number }> {
  const sb = supabaseAdmin();

  // 기존 발송 일정 전체 삭제 (PUT 재저장 대비)
  await sb.from("shipments").delete().eq("order_id", orderId);

  const rec = normalizeRecipient(recipient || ({} as RecipientInput));
  const hasRecipient = !!(
    rec.recipient_name || rec.recipient_phone || rec.address || rec.delivery_memo || rec.courier
  );
  let earliest: string | null = null;
  let seq = 1;
  let inserted = 0;
  let totalBoxes = 0;
  const insertedStatuses: string[] = [];

  for (const sch of schedules || []) {
    // 이 일정에 담긴 상품 (수량>0, 유효 인덱스만)
    const items = (sch.items || [])
      .map((it) => ({ idx: it.order_item_index, qty: Number(it.qty) || 0 }))
      .filter((it) => it.qty > 0 && orderItems[it.idx]);

    // 날짜·상품 둘 다 없는 빈 일정은 스킵
    if (!sch.ship_date && items.length === 0) continue;

    const boxCount = Math.max(1, Math.floor(Number(sch.box_count) || 1));
    const { data: shipRow, error: shipErr } = await sb
      .from("shipments")
      .insert({
        order_id: orderId,
        seq: seq++,
        ship_date: sch.ship_date || null,
        status: sch.status || "발주확인/생산대기",
        recipient_name: rec.recipient_name || "(미지정)",
        recipient_phone: rec.recipient_phone || "",
        address: rec.address || "(주소 미입력)",
        delivery_memo: rec.delivery_memo,
        courier: rec.courier,
        tracking_no: (sch.tracking_no || "").trim() || null,
        box_count: boxCount,
        shipped_at: sch.status === "발송완료" ? new Date().toISOString() : null,
      })
      .select("id")
      .single();
    if (shipErr) throw shipErr;
    inserted++;
    totalBoxes += boxCount;
    insertedStatuses.push(sch.status || "발주확인/생산대기");

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

  // 발송 일정이 하나도 없지만 배송 정보가 있으면, 배송 정보만 담은 기본 행을 생성해 보존.
  // (편집 화면에서는 날짜·상품이 없는 이 행을 발송 일정 카드로 노출하지 않음)
  if (inserted === 0 && hasRecipient) {
    const { error: recErr } = await sb.from("shipments").insert({
      order_id: orderId,
      seq: 1,
      ship_date: null,
      status: "발주확인/생산대기",
      recipient_name: rec.recipient_name || "(미지정)",
      recipient_phone: rec.recipient_phone || "",
      address: rec.address || "(주소 미입력)",
      delivery_memo: rec.delivery_memo,
      courier: rec.courier,
      tracking_no: null,
      shipped_at: null,
    });
    if (recErr) throw recErr;
  }

  // 복수 발송(2건 이상)이면 상위발주 상태를 하위 차수들로부터 자동 도출.
  //  - 전부 취소 → 취소 / 취소 제외 전부 발송완료 → 발송완료 / 그 외 → 생산완료/발송대기(진행중)
  //  화면엔 상위 상태를 표시하지 않지만, 매출집계·필터가 동작하도록 DB 값은 일관되게 유지.
  const derivedStatus = deriveParentStatus(insertedStatuses);

  return { earliestShipDate: earliest, derivedStatus, totalBoxes };
}
