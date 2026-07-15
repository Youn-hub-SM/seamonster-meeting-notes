import { supabaseAdmin } from "./supabase";
import { signedQty } from "./inventory";
import { getAllBundles, expandBundleQty, type BundleComponent } from "./product-bundles";
import {
  RecipientInput,
  ShipmentScheduleInput,
  normalizeRecipient,
} from "./b2b-orders";

// 저장된 발주상품 (폼 인덱스 → DB id + 스냅샷). product_id 는 즉시출고 시 재고원장 기록용.
export type SavedOrderItem = { id: string; product_id: string | null; product_name: string; spec: string | null };

type SbClient = ReturnType<typeof supabaseAdmin>;
const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

// 발송 재저장은 '전체 삭제 후 재삽입'이라 도중 실패하면 옛 차수·송장·선점출고가 사라진 채 남는다.
//  DB 트랜잭션이 없으므로(마이그레이션 없이) 삭제 전에 스냅샷을 떠 두고, 실패 시 id 그대로 복원해 원자성을 흉내낸다.
type ShipSnapshot = { ships: Record<string, unknown>[]; items: Record<string, unknown>[]; txns: Record<string, unknown>[] };
async function snapshotOrderShipments(sb: SbClient, orderId: string): Promise<ShipSnapshot> {
  const { data: ships } = await sb.from("shipments").select("*").eq("order_id", orderId);
  const ids = (ships ?? []).map((s) => (s as { id: string }).id);
  const items = ids.length ? ((await sb.from("shipment_items").select("*").in("shipment_id", ids)).data ?? []) : [];
  let txns: Record<string, unknown>[] = [];
  if (ids.length) {
    const r = await sb.from("inventory_txns").select("*").in("shipment_id", ids);
    txns = r.error ? [] : (r.data ?? []); // shipment_id 컬럼 미적용(035 전) 환경이면 무시
  }
  return { ships: ships ?? [], items, txns };
}
async function restoreOrderShipments(sb: SbClient, orderId: string, snap: ShipSnapshot): Promise<void> {
  try {
    // 부분 삽입된 새 데이터를 걷어낸 뒤 옛 데이터를 id 그대로 재삽입 → FK(shipment_id) 관계까지 원상복구.
    await sb.from("shipments").delete().eq("order_id", orderId);
    if (snap.ships.length) await sb.from("shipments").insert(snap.ships);
    if (snap.items.length) await sb.from("shipment_items").insert(snap.items);
    if (snap.txns.length) await sb.from("inventory_txns").insert(snap.txns);
  } catch (e) {
    console.error("[b2b-shipments] 발송 재저장 실패 후 복원도 실패:", orderId, e);
  }
}

// 즉시출고 컬럼(035) 적용 여부 — shipments.stock_out + inventory_txns.shipment_id 둘 다 있어야 동작.
//  미적용이면 발주 저장은 그대로 되고 재고 차감만 비활성(컬럼 누락으로 저장이 깨지지 않게).
async function stockOutAvailable(sb: SbClient): Promise<boolean> {
  const a = await sb.from("shipments").select("stock_out").limit(1);
  if (a.error) return false;
  const b = await sb.from("inventory_txns").select("shipment_id").limit(1);
  return !b.error;
}

// 복수 발송(2건 이상) 발주의 상위 발송상태를 하위 차수 발송상태들로부터 도출.
//  전부 취소 → 취소 / 취소 제외 전부 발송완료 → 발송완료 / 하나라도 미발송 → 발송대기.
//  발송이 2건 미만이면 null(도출 안 함 — 일반 발주는 메인 발송상태를 직접 관리).
export function deriveParentStatus(statuses: string[]): string | null {
  if (statuses.length < 2) return null;
  const nonCancel = statuses.filter((s) => s !== "취소");
  if (nonCancel.length === 0) return "취소";
  return nonCancel.every((s) => s === "발송완료") ? "발송완료" : "발송대기";
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
  orderItems: SavedOrderItem[],
  orderBoxCount = 1
): Promise<{ earliestShipDate: string | null; derivedStatus: string | null; totalBoxes: number }> {
  const sb = supabaseAdmin();

  // 즉시출고(재고 선점) 가능 여부 + 거래처명(원장 표시용) 준비
  const canDeduct = await stockOutAvailable(sb);
  let partner: string | null = null;
  if (canDeduct) {
    const { data: ord } = await sb.from("orders").select("companies:company_id(name)").eq("id", orderId).single();
    const c = (ord as { companies?: { name?: string } | { name?: string }[] } | null)?.companies;
    partner = (Array.isArray(c) ? c[0]?.name : c?.name) ?? null;
  }
  // 번들(묶음) 정의 — 발주 라인이 번들이면 즉시출고를 구성품으로 전개(번들은 자체 재고 없음).
  const bundles = canDeduct ? await getAllBundles(sb) : new Map<string, BundleComponent[]>();
  const today = kstToday();

  // 재저장 도중 실패 시 복원할 수 있도록 옛 발송 상태를 먼저 스냅샷(아래 catch 에서 사용).
  const snap = await snapshotOrderShipments(sb, orderId);

  // 기존 발송 일정 전체 삭제 (PUT 재저장 대비).
  //  inventory_txns.shipment_id 는 on delete cascade → 이 차수들의 옛 즉시출고가 함께 삭제되어 재고가 원복됨.
  await sb.from("shipments").delete().eq("order_id", orderId);

  try {
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
    // 취소 차수는 재고 선점하지 않음. 035 미적용이면 비활성. (undefined=기본 켜짐, UI 체크박스와 일치)
    const wantStockOut = canDeduct && sch.stock_out !== false && sch.status !== "취소";
    const shipInsert: Record<string, unknown> = {
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
      box_count: boxCount,
      shipped_at: sch.status === "발송완료" ? new Date().toISOString() : null,
    };
    if (canDeduct) shipInsert.stock_out = wantStockOut;
    const { data: shipRow, error: shipErr } = await sb
      .from("shipments")
      .insert(shipInsert)
      .select("id")
      .single();
    if (shipErr) throw shipErr;
    inserted++;
    totalBoxes += boxCount;
    insertedStatuses.push(sch.status || "발송대기");

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

      // 재고 즉시 출고(선점) — 발송 잡는 순간 차감. shipment_id 로 묶여 차수 삭제/재저장 시 cascade 원복.
      //  B2B 발송이므로 '도매' 채널 재고에서 차감(036). 컬럼 미적용 환경이면 channel 빼고 재시도.
      if (wantStockOut) {
        // 번들이면 구성품으로 재귀 전개(expandBundleQty 공용 규칙 — 소매 출고와 동일).
        //  같은 품목이 여러 라인/구성품에 걸쳐 나오면 합산해 품목당 출고 1건으로.
        const perProduct = new Map<string, number>();
        for (const it of items) {
          const pid = orderItems[it.idx].product_id;
          if (pid && it.qty > 0) expandBundleQty(bundles, pid, it.qty, perProduct);
        }
        const txns: Record<string, unknown>[] = [...perProduct.entries()].map(([product_id, qty]) => ({
          product_id,
          type: "출고",
          channel: "도매",
          qty: signedQty("출고", qty),
          unit_amount: null,
          txn_date: sch.ship_date || today,
          partner,
          memo: "B2B 발송 선점",
          shipment_id: shipRow.id,
          created_by: "B2B 자동출고",
        }));
        if (txns.length > 0) {
          let txr = await sb.from("inventory_txns").insert(txns);
          if (txr.error && /channel/i.test(txr.error.message)) {
            for (const t of txns) delete t.channel;
            txr = await sb.from("inventory_txns").insert(txns);
          }
          if (txr.error) throw txr.error;
        }
      }
    }

    if (sch.ship_date && (!earliest || sch.ship_date < earliest)) earliest = sch.ship_date;
  }

  // 발송 일정이 하나도 없지만 배송 정보가 있으면, 배송 정보만 담은 기본 행을 생성해 보존.
  // (편집 화면에서는 날짜·상품이 없는 이 행을 발송 일정 카드로 노출하지 않음)
  //  박스 수는 발주 단위 box_count 를 물려받음 → 일정 없이 박스만 늘려도 송장 출력이 박스 수만큼 펼쳐짐.
  if (inserted === 0 && hasRecipient) {
    const fallbackBoxes = Math.max(1, Math.floor(Number(orderBoxCount) || 1));
    const { error: recErr } = await sb.from("shipments").insert({
      order_id: orderId,
      seq: 1,
      ship_date: null,
      status: "발송대기",
      recipient_name: rec.recipient_name || "(미지정)",
      recipient_phone: rec.recipient_phone || "",
      address: rec.address || "(주소 미입력)",
      delivery_memo: rec.delivery_memo,
      courier: rec.courier,
      tracking_no: null,
      box_count: fallbackBoxes,
      shipped_at: null,
    });
    if (recErr) throw recErr;
    totalBoxes += fallbackBoxes;
  }

  // 복수 발송(2건 이상)이면 상위발주 발송상태를 하위 차수들로부터 자동 도출.
  //  - 전부 취소 → 취소 / 취소 제외 전부 발송완료 → 발송완료 / 하나라도 미발송 → 발송대기.
  //  화면엔 상위 발송상태를 표시하지 않지만, 매출집계·필터가 동작하도록 DB 값은 일관되게 유지.
  const derivedStatus = deriveParentStatus(insertedStatuses);

  return { earliestShipDate: earliest, derivedStatus, totalBoxes };
  } catch (err) {
    // 재저장 도중 실패 → delete 로 사라진 옛 발송·송장·선점출고를 스냅샷에서 복원(부분 상태 방지) 후 재던짐.
    await restoreOrderShipments(sb, orderId, snap);
    throw err;
  }
}
