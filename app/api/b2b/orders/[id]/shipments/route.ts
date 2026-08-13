import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { saveOrderShipments, type SavedOrderItem } from "@/app/lib/b2b-shipments";
import type { ShipmentScheduleInput, RecipientInput } from "@/app/lib/b2b-orders";
import { logShipmentScheduled } from "@/app/lib/b2b-activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// 발송 일정(차수) 전용 저장 — 발주 목록의 '발송일 등록' 창이 쓴다.
//  발주 등록 폼에서 발송 일정 섹션을 뺐으므로, 차수(날짜·박스 수·수량)는 여기 한 곳에서만 만든다.
//  GET  → 현재 차수 + 배송정보 + 발주 라인(수량 배정용)
//  POST → { schedules } 통째 교체. 도매 재고 차감·헤더 발송일/상태/박스 수 동기화까지 saveOrderShipments 가 처리.

type ShipRow = {
  id: string; seq: number; ship_date: string | null; status: string; tracking_no: string | null;
  box_count: number | null; stock_out?: boolean | null;
  recipient_name: string | null; recipient_phone: string | null; address: string | null;
  delivery_memo: string | null; courier: string | null;
  shipment_items?: { order_item_id: string; qty: number }[];
};

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const sb = supabaseAdmin();
    const [oi, sh] = await Promise.all([
      sb.from("order_items").select("id, product_name, spec, qty, sort_order").eq("order_id", id).order("sort_order", { ascending: true }),
      sb.from("shipments").select("id, seq, ship_date, status, tracking_no, box_count, stock_out, recipient_name, recipient_phone, address, delivery_memo, courier, shipment_items(order_item_id, qty)").eq("order_id", id).order("seq", { ascending: true }),
    ]);
    if (oi.error) throw oi.error;
    // stock_out 컬럼(035) 미적용이면 그 컬럼만 빼고 재조회
    let ships = (sh.data ?? []) as ShipRow[];
    if (sh.error) {
      const retry = await sb.from("shipments").select("id, seq, ship_date, status, tracking_no, box_count, recipient_name, recipient_phone, address, delivery_memo, courier, shipment_items(order_item_id, qty)").eq("order_id", id).order("seq", { ascending: true });
      if (retry.error) throw retry.error;
      ships = (retry.data ?? []) as ShipRow[];
    }
    const items = (oi.data ?? []).map((r) => ({ id: r.id as string, product_name: r.product_name as string, spec: (r.spec as string) ?? null, qty: Number(r.qty) || 0 }));
    const idxOf = new Map(items.map((it, i) => [it.id, i]));

    // 날짜·수량이 모두 없는 '배송정보 전용' 행은 차수로 보여주지 않는다(폼과 같은 규칙).
    const schedules = ships
      .filter((s) => s.ship_date || (s.shipment_items || []).some((x) => Number(x.qty) > 0))
      .map((s) => ({
        ship_date: s.ship_date || "",
        status: s.status,
        tracking_no: s.tracking_no || "",
        box_count: Math.max(1, Number(s.box_count) || 1),
        stock_out: s.stock_out !== false,
        items: (s.shipment_items || [])
          .map((x) => ({ order_item_index: idxOf.get(x.order_item_id) ?? -1, qty: Number(x.qty) || 0 }))
          .filter((x) => x.order_item_index >= 0 && x.qty > 0),
      }));
    const r0 = ships[0];
    const recipient = r0
      ? { recipient_name: r0.recipient_name || "", recipient_phone: r0.recipient_phone || "", address: r0.address || "", delivery_memo: r0.delivery_memo || "", courier: r0.courier || "" }
      : null;

    return NextResponse.json({ ok: true, items, schedules, recipient });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "발송 일정 조회 실패") }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { schedules?: ShipmentScheduleInput[] };
    const schedules = Array.isArray(body.schedules) ? body.schedules : [];
    // 빈 목록 = 일정 전체 삭제(허용) — 화면이 의도를 확인하고 보낸다.
    //  saveOrderShipments 가 기존 차수를 지우고(cascade 로 선점 재고 원복) 배송정보 행만 보존한다.
    const clearingAll = !schedules.some((s) => s.ship_date);
    const sb = supabaseAdmin();

    // 배송정보는 기존 차수(또는 배송정보 전용 행)에서 물려받는다 — 이 창에서는 배송지를 고치지 않는다.
    //  같은 조회로 저장 전 발송예정일 스냅샷도 뜬다(알림을 '실제로 바뀐 경우'에만 보내기 위해).
    const [oi, sh] = await Promise.all([
      sb.from("order_items").select("id, product_id, product_name, spec, sort_order").eq("order_id", id).order("sort_order", { ascending: true }),
      sb.from("shipments").select("recipient_name, recipient_phone, address, delivery_memo, courier, ship_date, status").eq("order_id", id).order("seq", { ascending: true }),
    ]);
    if (oi.error) throw oi.error;
    const savedItems: SavedOrderItem[] = (oi.data ?? []).map((r) => ({
      id: r.id as string, product_id: (r.product_id as string) ?? null,
      product_name: r.product_name as string, spec: (r.spec as string) ?? null,
    }));
    const prevShips = (sh.data ?? []) as ({ ship_date: string | null; status: string | null } & RecipientInput)[];
    const recipient = (prevShips[0] ?? {}) as RecipientInput;
    const datesOf = (rows: { ship_date?: string | null; status?: string | null }[]) =>
      rows
        .filter((r) => r.ship_date && r.status !== "취소")
        .map((r) => r.ship_date as string)
        .sort();
    const beforeDates = datesOf(prevShips);

    const { earliestShipDate, derivedStatus, totalBoxes } = await saveOrderShipments(id, recipient, schedules, savedItems);

    // 헤더 동기화 — 이익률·송장 입력칸 수가 쓰는 orders.box_count 를 실제 차수 박스 합으로 맞춘다.
    const patch: Record<string, unknown> = { ship_date: earliestShipDate };
    if (totalBoxes > 0) patch.box_count = totalBoxes;
    if (derivedStatus) patch.status = derivedStatus;
    // 일정을 전부 지웠으면 발주를 미발송 상태로 되돌린다.
    if (clearingAll) patch.status = "발송대기";
    const { error } = await sb.from("orders").update(patch).eq("id", id);
    if (error) throw error;

    // 알림 — 발송예정일이 실제로 달라졌을 때만. 수량 배분만 고치고 저장하는 경우가 잦아
    //  날짜가 그대로면 조용히 넘긴다(설정: 관리자 › 알림 › '발송일정 등록').
    const afterDates = datesOf(schedules);
    if (beforeDates.join("|") !== afterDates.join("|")) {
      await logShipmentScheduled(id, beforeDates, afterDates);
    }

    return NextResponse.json({ ok: true, ship_date: earliestShipDate, box_count: totalBoxes });
  } catch (err) {
    console.error("[b2b/orders/shipments]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "발송 일정 저장 실패") }, { status: 500 });
  }
}
