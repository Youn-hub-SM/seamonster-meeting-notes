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
  orderBoxCount = 1,
  headerShipDate?: string | null,
  headerStatus?: ShipmentScheduleInput["status"] | null
): Promise<{ earliestShipDate: string | null; derivedStatus: string | null; totalBoxes: number }> {
  const sb = supabaseAdmin();

  // 발주 헤더의 '발송예정일'만 입력하고 발송 차수를 따로 만들지 않은 단일 발송 발주 —
  //  그 발송예정일로 차수 하나를 만들어 재고 차감·발송 관리가 동작하게 한다(가장 흔한 사용 흐름).
  //  차수를 이미 하나라도 만든 경우(분할발송)엔 손대지 않는다.
  if (headerShipDate && !(schedules || []).some((s) => s.ship_date || (s.items || []).some((it) => Number(it.qty) > 0))) {
    schedules = [{ ship_date: headerShipDate, status: headerStatus || "발송대기", tracking_no: "", box_count: 1, stock_out: true, items: [] }];
  }

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

  // 발주 라인별 주문 수량 — 재고 차감은 '발주 전량' 기준이라 항상 필요하다.
  const orderQtyById = new Map<string, number>();
  if (canDeduct) {
    const { data: oi } = await sb.from("order_items").select("id, qty").eq("order_id", orderId);
    for (const r of oi || []) orderQtyById.set(r.id as string, Number(r.qty) || 0);
  }

  // 차수에 상품 수량이 하나도 배정되지 않았으면(분할발송 미사용) 발주 전량을 첫 차수에 자동 배분한다.
  //  이 배분은 shipment_items(발송 관리·매출 리포트·재고 대사의 '팔린 수' 기준)를 위한 것이고,
  //  재고 차감량과는 별개다 — 차감은 아래에서 발주 전량으로 따로 계산한다.
  if (canDeduct) {
    const anyAssigned = (schedules || []).some((s) => (s.items || []).some((it) => Number(it.qty) > 0));
    if (!anyAssigned) {
      const target = (schedules || []).find((s) => s.ship_date && s.status !== "취소" && s.stock_out !== false);
      if (target) {
        target.items = orderItems
          .map((it, idx) => ({ order_item_index: idx, qty: orderQtyById.get(it.id) || 0 }))
          .filter((x) => x.qty > 0);
      }
    }
  }

  // ── 재고 차감은 '첫 발송일에 발주 전량' 1회 ──
  //  선결제 대량 발주를 나눠 받는 거래라, 첫 발송일 전까지 전 물량을 생산해 두고 그때 재고에서 뺀다.
  //  차수별로 나눠 찍지 않는 이유: 차수에 수량을 일부만 배정하면 나머지가 영영 차감되지 않았다.
  //  대상 = 실제로 저장되는 차수 중 취소가 아니고 재고차감이 켜진 것, 그중 발송예정일이 가장 이른 것.
  //  (발송예정일이 있는 차수가 없으면 첫 차수에 붙이고 날짜는 헤더 발송예정일 → 오늘 순으로 잡는다.)
  const willInsert = (s: ShipmentScheduleInput) =>
    !!s.ship_date || (s.items || []).some((it) => Number(it.qty) > 0 && orderItems[it.order_item_index]);
  let deductIdx = -1;
  if (canDeduct) {
    const eligible = (schedules || [])
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => willInsert(s) && s.status !== "취소" && s.stock_out !== false);
    const dated = eligible.filter(({ s }) => !!s.ship_date);
    deductIdx = dated.length
      ? dated.reduce((a, b) => ((a.s.ship_date as string) <= (b.s.ship_date as string) ? a : b)).i
      : (eligible[0]?.i ?? -1);
  }

  // 차감할 품목·수량 — 발주 전량에서 '취소 차수에 배정된 수량'만 뺀다(매출 리포트와 같은 규칙).
  //  번들 라인은 구성품으로 전개(번들은 자체 재고가 없음).
  const deductPerProduct = new Map<string, number>();
  if (canDeduct && deductIdx >= 0) {
    const effQty = new Map(orderQtyById);
    for (const s of schedules || []) {
      if (s.status !== "취소") continue;
      for (const it of s.items || []) {
        const line = orderItems[it.order_item_index];
        if (!line) continue;
        effQty.set(line.id, Math.max(0, (effQty.get(line.id) || 0) - (Number(it.qty) || 0)));
      }
    }
    for (const line of orderItems) {
      const q = effQty.get(line.id) || 0;
      if (line.product_id && q > 0) expandBundleQty(bundles, line.product_id, q, deductPerProduct);
    }
  }

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

  for (let si = 0; si < (schedules || []).length; si++) {
    const sch = (schedules as ShipmentScheduleInput[])[si];
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
    }

    // 재고 차감(선점) — 발주 전량을 이 차수(가장 이른 발송일) 하나에만 기록한다.
    //  shipment_id 로 묶여 있어 재저장·발주 삭제 시 cascade 로 함께 지워지며 재고가 원복된다.
    //  '도매' 채널에서 차감(036). 컬럼 미적용 환경이면 channel 을 빼고 재시도.
    if (canDeduct && si === deductIdx && deductPerProduct.size > 0) {
      const txns: Record<string, unknown>[] = [...deductPerProduct.entries()].map(([product_id, qty]) => ({
        product_id,
        type: "출고",
        channel: "도매",
        qty: signedQty("출고", qty),
        unit_amount: null,
        txn_date: sch.ship_date || headerShipDate || today,
        partner,
        memo: "B2B 발송 선점(발주 전량)",
        shipment_id: shipRow.id,
        created_by: "B2B 자동출고",
      }));
      let txr = await sb.from("inventory_txns").insert(txns);
      if (txr.error && /channel/i.test(txr.error.message)) {
        for (const t of txns) delete t.channel;
        txr = await sb.from("inventory_txns").insert(txns);
      }
      if (txr.error) throw txr.error;
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
