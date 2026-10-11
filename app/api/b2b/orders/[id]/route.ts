import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import {
  OrderInput,
  ORDER_STATUSES,
  normalizeOrderItem,
  validateOrder,
} from "@/app/lib/b2b-orders";
import {
  applyOrderShipments,
  snapshotOrderShipments,
  restoreOrderShipments,
  isShippedSchedule,
  shippedKey,
  kstToday,
  missingColumn,
  ShipChangeError,
  isShipConflict,
  salesSyncFields,
  B2B_CANCEL_KEPT_SOURCE,
  planLineAllocCut,
  allocShipsFromSnapshot,
  allocShipsFromSchedules,
  applyAllocCuts,
  allocCutError,
  shippedQtyText,
  sameShipRows,
  SHIP_CONFLICT_MSG,
  type AllocLine,
  type SavedOrderItem,
  type ShipSchedule,
  type ShipSnapshot,
  type SaveShipmentsOpts,
} from "@/app/lib/b2b-shipments";
import {
  logOrderStatusChanged,
  logOrderProductionStatusChanged,
  logOrderPaymentStatusChanged,
  logOrderTaxInvoiceChanged,
  logOrderDeleted,
} from "@/app/lib/b2b-activity";
import { syncOrderSalesSafe, deleteOrderSales } from "@/app/lib/b2b-sales-sync";

export const runtime = "nodejs"; // sales-sync 가 crypto(sales-normalize) 사용
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const errorResponse = (err: unknown, fallback: string, tag: string) => {
  if (err instanceof ShipChangeError) {
    return NextResponse.json({ ok: false, error: err.message, ...(err.extra || {}) }, { status: err.status });
  }
  console.error(tag, err);
  return NextResponse.json({ ok: false, error: extractErrorMsg(err, fallback) }, { status: 500 });
};
// 상품을 고르지 않고 이름만 친 라인 — 재고가 빠지지 않는다(S9: 조용히 저장하지 않고 확인을 받는다)
const unlinkedNames = (items: { product_id?: string | null; product_name?: string }[]) =>
  (items || []).filter((it) => !it.product_id && String(it.product_name || "").trim()).map((it) => String(it.product_name).trim());
const isRealSchedule = (s: ShipSchedule) => !!s.ship_date || (s.items || []).some((it) => Number(it.qty) > 0);

// ─────────────────────────────────────────────
// GET /api/b2b/orders/[id] — 라인아이템 + 업체 풀 디테일
// ─────────────────────────────────────────────
export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const sb = supabaseAdmin();

    const { data: order, error: orderErr } = await sb
      .from("orders")
      .select("*, company:company_id(*)")
      .eq("id", id)
      .single();
    if (orderErr) throw orderErr;
    if (!order) return NextResponse.json({ ok: false, error: "발주를 찾을 수 없습니다." }, { status: 404 });

    const [{ data: items, error: itemsErr }, { data: shipments, error: shipErr }] = await Promise.all([
      sb.from("order_items").select("*").eq("order_id", id).order("sort_order", { ascending: true }).order("id", { ascending: true }),
      sb
        .from("shipments")
        .select("*, items:shipment_items(*)")
        .eq("order_id", id)
        .order("seq", { ascending: true }),
    ]);
    if (itemsErr) throw itemsErr;
    if (shipErr) throw shipErr;

    return NextResponse.json({
      ok: true,
      order: { ...order, items: items ?? [], shipments: shipments ?? [] },
    });
  } catch (err) {
    console.error("[b2b/orders GET single]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "조회 실패") },
      { status: 500 }
    );
  }
}

// ─────────────────────────────────────────────
// PUT /api/b2b/orders/[id] — 헤더 갱신 + 라인아이템 교체(라인 id 유지)
//  상태·발송일·송장·차수는 이 화면에서 고치지 않는다(목록의 상태칸·발송일 창이 맡는다) —
//  폼이 열 때 읽은 값으로 덮으면 그 사이 목록에서 한 발송완료·발송일 변경이 되돌아갔다(점검 확정).
//  차수는 DB 에서 재구성해 다시 저장한다(수량이 바뀌면 선점·매출이 따라온다).
// ─────────────────────────────────────────────
export async function PUT(req: NextRequest, { params }: Ctx) {
  // 뒷단계가 실패하면 catch 에서 헤더·대량 표식·라인·차수를 되돌린다(DB 트랜잭션이 없어 보상으로 원자성을 흉내낸다, S3).
  let rollbackHeader: (() => Promise<void>) | null = null;
  let rollbackBulk: (() => Promise<void>) | null = null;
  let rollbackLines: (() => Promise<void>) | null = null;
  let earlySnap: ShipSnapshot | null = null;
  let orderIdForRollback = "";
  let shipmentsSaved = false;
  try {
    const { id } = await params;
    orderIdForRollback = id;
    // allow_shipped_qty = 단일 발송 발주의 발송된 수량을 새 수량으로 다시 기록하는 것, 또는 미연동 줄에 상품을 연결해
    //  발송된 수량을 그 상품 재고에서 빼는 것을 화면에서 확인함
    const body = (await req.json()) as OrderInput & { updated_at?: string | null; allow_unlinked?: boolean; allow_shipped_qty?: boolean };
    const sb = supabaseAdmin();
    const validationError = validateOrder(body, { skipTracking: true }); // 상태를 안 쓰므로 송장 검사도 안 한다
    if (validationError) {
      return NextResponse.json({ ok: false, error: validationError }, { status: 400 });
    }
    const unlinked = unlinkedNames(body.items);
    if (unlinked.length && !body.allow_unlinked) {
      return NextResponse.json(
        { ok: false, unlinked, error: `재고 미연동 품목이 있습니다: ${unlinked.join(", ")} — 상품을 고르거나 그대로 저장을 확인하세요.` },
        { status: 400 }
      );
    }

    // 0) 변경 전 헤더 — 다른 곳에서 바뀌었는지 검사·활동 로그·실패 시 되돌림
    const { data: prevOrder, error: prevErr } = await sb.from("orders").select("*").eq("id", id).maybeSingle();
    if (prevErr) throw prevErr;
    if (!prevOrder) return NextResponse.json({ ok: false, error: "발주를 찾을 수 없습니다." }, { status: 404 });
    const prev = prevOrder as Record<string, unknown>;
    // 폼을 연 뒤 목록·입금 화면 등에서 이 발주가 바뀌었으면 덮지 않는다(차수 변경도 발주 updated_at 을 갱신한다)
    if (body.updated_at && String(body.updated_at) !== String(prev.updated_at ?? "")) {
      return NextResponse.json(
        { ok: false, stale: true, error: "다른 곳에서 이 발주가 바뀌었습니다 — 새로고침한 뒤 다시 고쳐 저장하세요." },
        { status: 409 }
      );
    }

    // 1) 발송 스냅샷(라인을 바꾸기 전) — 뒤에서 실패하면 원래 차수·배분·선점으로 되돌린다. 읽지 못하면 아무것도 바꾸기 전에 중단.
    earlySnap = await snapshotOrderShipments(sb, id);
    const { data: existingItems, error: snapErr } = await sb.from("order_items").select("*").eq("order_id", id);
    if (snapErr) throw snapErr;

    // 1-b) 취소된 발주인데 취소 안 된 실제 차수(발송일 또는 배정 수량 있음)가 남아 있으면 저장하지 않는다(옛 데이터·경합).
    //  그대로 재저장하면 복수 발송은 차수에서 '발송대기'로 도출돼 취소 발주가 되살아나고, 단일 발송은 헤더는 '취소'인 채
    //  선점만 다시 기록된다(취소 발주가 재고를 계속 차감). 차수 상태를 먼저 맞추게 한다 — 아무것도 쓰기 전이다(guard).
    if (prev.status === "취소") {
      const qtyByShip = new Map<string, number>();
      for (const it of earlySnap.items) {
        const sid = String(it.shipment_id);
        qtyByShip.set(sid, (qtyByShip.get(sid) || 0) + (Number(it.qty) || 0));
      }
      const live = earlySnap.ships.filter((s) =>
        s.status !== "취소" && (!!s.ship_date || (qtyByShip.get(String(s.id)) || 0) > 0));
      if (live.length) {
        const multi = earlySnap.ships.length >= 2; // 목록이 복수 발송으로 보는 기준(isParentOrder)과 같다
        return NextResponse.json(
          {
            ok: false,
            cancelled_live: true,
            error: multi
              ? `취소된 발주에 취소되지 않은 차수가 ${live.length}개 있습니다 — 발주 목록에서 차수를 펼쳐 '취소'로 바꾼 뒤 새로고침해 다시 저장하세요.`
              : "취소된 발주에 취소되지 않은 차수가 있습니다 — 발주 목록에서 상태를 '발송대기'로 되돌렸다가 다시 '취소'한 뒤 새로고침해 저장하세요.",
          },
          { status: 409 }
        );
      }
    }

    // 1-c) 라인 수량 ↔ 차수 배분(취소 차수 포함) — 배분보다 줄이면 선점(발주 − 취소 배분)·매출·청구가 실제로 나간 것보다
    //  적게 잡힌다(최종 점검 확정). 발송·취소된 몫보다 줄이거나, 안 나간 차수 여럿에 걸쳐 있거나, 발송된 라인을 지우면
    //  아무것도 쓰기 전에 막는다(guard). 안 나간 차수 하나에만 배분이 있으면 그 차수 배분을 함께 줄이고(4 의 mutate),
    //  단일 발송 전량이면 발송된 차수라도 배분이 새 수량을 따른다(화면 확인 allow_shipped_qty 필요 — 재고·매출이 바뀐다).
    //  저장된 수량부터 배분보다 작은 옛 데이터는 수량을 그대로 두면 막지 않는다(다른 칸 수정은 저장된다).
    //  줄 id 를 그대로 둔 채 연결 상품만 바꾼 줄도 지운 라인과 같이 본다 — 3) 이 같은 id 를 update 하면 재저장이 옛 상품 선점을
    //  지우고 새 상품을 발송일로 뺀다. 발송된·안 돌아옴 배분이 있으면 막고, 미연동 줄에 처음 연결하는 것만 확인을 받는다.
    //  발송일 창의 배분 초과 오류(shipments POST)와 같은 계산 규칙(배분 합 ≤ 발주 수량).
    const existing = (existingItems ?? []) as Record<string, unknown>[];
    const existingIds = new Set(existing.map((r) => String(r.id)));
    const prevQtyOf = new Map(existing.map((r) => [String(r.id), Number(r.qty) || 0]));
    const prevProductOf = new Map(existing.map((r) => [String(r.id), (r.product_id as string | null) || null]));
    const lineLabel = (name: unknown, spec: unknown) => `${String(name || "").trim() || "품목"}${spec ? ` ${String(spec)}` : ""}`;
    const prevLabelOf = new Map(existing.map((r) => [String(r.id), lineLabel(r.product_name, r.spec)]));
    const keptLines: AllocLine[] = [];
    const snap0 = earlySnap;
    {
      const seen = new Set<string>();
      for (const it of body.items) {
        if (!it.id || !existingIds.has(it.id) || seen.has(it.id)) continue; // 3) 과 같은 규칙 — 같은 id 의 두 번째 줄은 새 줄
        seen.add(it.id);
        const clean = normalizeOrderItem(it);
        keptLines.push({
          id: it.id, qty: clean.qty, prev: prevQtyOf.get(it.id) ?? null, label: lineLabel(clean.product_name, clean.spec),
          product: clean.product_id, prevProduct: prevProductOf.get(it.id) ?? null, prevLabel: prevLabelOf.get(it.id),
        });
      }
      const removedLines: AllocLine[] = existing
        .filter((r) => !seen.has(String(r.id)))
        .map((r) => ({ id: String(r.id), qty: 0, label: lineLabel(r.product_name, r.spec) }));
      const plan0 = planLineAllocCut(keptLines, removedLines, allocShipsFromSnapshot(snap0));
      if (plan0.errors.length) {
        return NextResponse.json({ ok: false, alloc_short: true, error: allocCutError(plan0.errors) }, { status: 400 });
      }
      const shippedMoves = plan0.cuts.filter((c) => c.shipped);
      if ((shippedMoves.length || plan0.relinks.length) && !body.allow_shipped_qty) {
        return NextResponse.json(
          { ok: false, shipped_qty: true, error: `확인이 필요합니다 — ${shippedQtyText(shippedMoves, plan0.relinks)}. 새로고침한 뒤 다시 저장하세요.` },
          { status: 400 }
        );
      }
    }

    // 2) 헤더 update — 이 화면이 실제로 고치는 칸만
    const headerFields = (withDiscount: boolean): Record<string, unknown> => ({
      company_id: body.company_id,
      order_date: body.order_date,
      production_date: body.production_date || null,
      production_status: body.production_status,
      payment_status: body.payment_status,
      tax_invoice_status: body.tax_invoice_status,
      notes: body.notes?.trim() || null,
      ...(withDiscount
        ? {
            discount_amount: Math.round(Number(body.discount_amount) || 0), // 양수 = 할인, 음수 = 추가금
            discount_reason: body.discount_reason?.trim() || null,
          }
        : {}),
    });
    let withDiscount = true;
    let { error: orderErr } = await sb.from("orders").update(headerFields(true)).eq("id", id);
    // 095 미적용 환경 폴백 — 할인 컬럼 없이 재시도
    if (orderErr && /discount/i.test(orderErr.message || "")) {
      withDiscount = false;
      orderErr = (await sb.from("orders").update(headerFields(false)).eq("id", id)).error;
    }
    if (orderErr) throw orderErr;
    rollbackHeader = async () => {
      const keys = Object.keys(headerFields(withDiscount));
      const back = Object.fromEntries(keys.map((k) => [k, prev[k] ?? null]));
      const r = await sb.from("orders").update(back).eq("id", id);
      if (r.error) throw r.error;
    };

    // 2-b) 대량 발주 표식(115) — 체크 해제도 반영해야 하므로 항상 쓴다.
    //  재저장(4)이 DB 에서 이 값을 다시 읽어 차감 칸('도매' vs '도매 대량')을 정하므로 반드시 그 전에 쓴다.
    //  이미 나간 출고는 옛 칸을 유지한다(saveOrderShipments effChannel). 115 미적용이면 건너뛴다(전건 도매).
    const prevBulk = "is_bulk" in prev ? prev.is_bulk === true : null;
    const bulkRes = await sb.from("orders").update({ is_bulk: !!body.is_bulk }).eq("id", id);
    if (bulkRes.error && !missingColumn(bulkRes.error, "is_bulk")) throw bulkRes.error;
    rollbackBulk = async () => {
      if (prevBulk === null || prevBulk === !!body.is_bulk) return;
      const r = await sb.from("orders").update({ is_bulk: prevBulk }).eq("id", id);
      if (r.error) throw r.error;
    };

    // 3) 라인 — id 로 맞춰 남은 줄은 고치고, 새 줄은 넣고, 빠진 줄은 지운다.
    //  통째로 지우고 다시 넣으면 라인 id 가 바뀌어 차수 배분(shipment_items.order_item_id)이 끊기고,
    //  부분 취소 차수의 감액·'N개 남음'이 사라졌다(점검 확정). line_total 은 generated column 이라 쓰지 않는다.
    const keptIds = new Set<string>();
    const insertedIds: string[] = [];
    // 지운 라인의 차수 배분 행 — 라인을 지우면 연결이 끊긴다(on delete set null). 되돌릴 때 다시 잇는다
    let removedLinks: { id: string; order_item_id: string }[] = [];
    rollbackLines = async () => {
      const errs: string[] = [];
      if (insertedIds.length) {
        const r = await sb.from("order_items").delete().in("id", insertedIds);
        if (r.error) errs.push(`새 줄 정리: ${r.error.message}`);
      }
      const rows = existing.map((r) => {
        const { line_total: _lt, ...rest } = r;
        return rest;
      });
      if (rows.length) {
        const r = await sb.from("order_items").upsert(rows, { onConflict: "id" });
        if (r.error) errs.push(`라인: ${r.error.message}`);
      }
      // 차수를 스냅샷으로 되돌리지 않는 경합(409)에서도 지운 라인의 배분이 끊긴 채 남지 않게 — 그 행이 아직 있으면 다시 잇는다
      for (const rid of new Set(removedLinks.map((x) => x.order_item_id))) {
        const ids = removedLinks.filter((x) => x.order_item_id === rid).map((x) => x.id);
        const r = await sb.from("shipment_items").update({ order_item_id: rid }).in("id", ids).is("order_item_id", null);
        if (r.error) errs.push(`차수 배분 연결: ${r.error.message}`);
      }
      if (errs.length) throw new Error(errs.join(" / "));
    };
    const finalLines: SavedOrderItem[] = [];
    for (let idx = 0; idx < body.items.length; idx++) {
      const it = body.items[idx];
      const clean = normalizeOrderItem(it);
      const row = {
        product_id: clean.product_id,
        product_name: clean.product_name,
        option_label: clean.option_label,
        spec: clean.spec,
        qty: clean.qty,
        unit_price: clean.unit_price,
        cost_at_order: clean.cost_at_order,
        tax_type: clean.tax_type,
        sort_order: idx, // 화면 순서 = 차수 배분의 라인 순번
      };
      const lineId = it.id && existingIds.has(it.id) && !keptIds.has(it.id) ? it.id : null;
      if (lineId) {
        const { error } = await sb.from("order_items").update(row).eq("id", lineId).eq("order_id", id);
        if (error) throw error;
        keptIds.add(lineId);
        finalLines.push({ id: lineId, product_id: clean.product_id, product_name: clean.product_name, spec: clean.spec });
      } else {
        const { data, error } = await sb.from("order_items").insert({ order_id: id, ...row }).select("id").single();
        if (error) throw error;
        insertedIds.push(String(data.id));
        finalLines.push({ id: String(data.id), product_id: clean.product_id, product_name: clean.product_name, spec: clean.spec });
      }
    }
    const removed = existing.map((r) => String(r.id)).filter((rid) => !keptIds.has(rid));
    if (removed.length) {
      // 끊길 배분 행을 먼저 읽는다 — 읽지 못하면 지우지 않는다(S4)
      const links = await sb.from("shipment_items").select("id, order_item_id").in("order_item_id", removed);
      if (links.error) throw links.error;
      removedLinks = ((links.data ?? []) as { id: string; order_item_id: string | null }[])
        .filter((x) => !!x.order_item_id)
        .map((x) => ({ id: String(x.id), order_item_id: String(x.order_item_id) }));
      const { error } = await sb.from("order_items").delete().in("id", removed);
      if (error) throw error;
    }

    // 4) 차수 재저장 — DB 차수를 그대로 재구성(상태·송장·날짜·배분 유지). 수량이 바뀌면 선점이, 발송완료면 매출이 따라온다.
    //  헤더 상태는 그대로 — 복수 발송만 차수에서 도출. 발송일 = 가장 이른 비취소 차수일.
    //  수량을 고친 라인은 다시 읽은 차수로 1-c 검사를 한 번 더 하고, 차수 배분을 새 수량에 맞춘다
    //  (안 나간 차수 하나 감축은 재고·매출 그대로, 단일 발송 전량은 선점·매출이 새 수량을 따른다).
    //  1-c 는 통과했는데 여기서 걸리면 그 사이 다른 곳에서 차수가 바뀐 것이다 — 처음 스냅샷으로 되돌리면 그 변경을 덮으므로
    //  경합(409)으로 멈춘다(차수는 되돌리지 않는다). 차수가 그대로인데 걸리면 이 요청의 문제라 400 + 스냅샷 복원(안전).
    let cutNotice: string | null = null;
    const resave = () => applyOrderShipments(id, {
      savedItems: finalLines,
      recipient: body.recipient,
      boxCount: Math.max(1, Math.floor(Number(prev.box_count) || 1)),
      headerShipDate: (prev.ship_date as string | null) ?? null,
      headerStatus: (prev.status as ShipSchedule["status"]) ?? null,
      mutate: (schedules, ships) => {
        //  상품 바꿈도 같은 계획이 다시 본다(keptLines 의 product·prevProduct) — 그 사이 차수가 발송됐으면 여기서 걸린다.
        const plan = planLineAllocCut(keptLines, [], allocShipsFromSchedules(schedules, ships, finalLines));
        const moves = plan.cuts.filter((c) => c.shipped);
        const unconfirmed = (moves.length > 0 || plan.relinks.length > 0) && !body.allow_shipped_qty;
        if (plan.errors.length || unconfirmed) {
          if (!sameShipRows(ships, snap0.ships)) throw new ShipChangeError(SHIP_CONFLICT_MSG, 409, { conflict: true });
          if (plan.errors.length) throw new ShipChangeError(allocCutError(plan.errors), 400, { alloc_short: true });
          throw new ShipChangeError(`확인이 필요합니다 — ${shippedQtyText(moves, plan.relinks)}. 새로고침한 뒤 다시 저장하세요.`, 400, { shipped_qty: true });
        }
        applyAllocCuts(schedules, finalLines, plan.cuts);
        // 복수 발송이면 어느 차수가 바뀌었는지 알린다(단일 발송은 발주 수량 = 그 차수 수량이라 알릴 것이 없고,
        //  발송된 수량을 다시 기록한 것은 저장 전에 화면이 확인을 받았다)
        const pendingCuts = plan.cuts.filter((c) => !c.shipped);
        cutNotice = plan.multi && pendingCuts.length
          ? `안 나간 차수의 보낼 수량을 함께 고쳤습니다 — ${pendingCuts.map((c) => `${c.seq ? `${c.seq}차 ` : ""}${c.label} ${c.from} → ${c.to}`).join(", ")}`
          : null;
      },
    });
    let res: Awaited<ReturnType<typeof applyOrderShipments>>;
    try {
      res = await resave();
    } catch (e) {
      // 그 사이 목록에서 차수 상태를 바꿨다(쓰기 전에 멈춤) — 이 화면은 상태를 안 고치고 DB 차수를 그대로 다시 저장하므로
      //  한 번 더 읽어 그 변경 위에 다시 맞춘다. 또 겹치면 아래 catch 가 409 로 알린다.
      if (!isShipConflict(e)) throw e;
      res = await resave();
    }
    shipmentsSaved = true;
    if (res.channelKept) console.warn(`[b2b/orders PUT] ${id} 이미 출고된 선점이라 차감 칸 '${res.channelKept}' 유지(is_bulk 와 다름)`);

    // 활동 로그 — 입금상태/세금계산서/생산 변경 시(발송 상태는 이 화면에서 바뀌지 않는다, 복수 발송 도출만)
    //  재고·헤더·매출을 다 맞춘 뒤(applyOrderShipments 안에서 끝난다)에 보낸다 — 알림이 늦어도 장부는 이미 맞다.
    if (res.headerStatus && prev.status && res.headerStatus !== prev.status) {
      await logOrderStatusChanged(id, String(prev.status), res.headerStatus);
    }
    if (prev.production_status && prev.production_status !== body.production_status) {
      await logOrderProductionStatusChanged(id, String(prev.production_status), body.production_status);
    }
    if (prev.payment_status && prev.payment_status !== body.payment_status) {
      await logOrderPaymentStatusChanged(id, String(prev.payment_status), body.payment_status);
    }
    if (prev.tax_invoice_status && prev.tax_invoice_status !== body.tax_invoice_status) {
      await logOrderTaxInvoiceChanged(id, String(prev.tax_invoice_status), body.tax_invoice_status);
    }

    return NextResponse.json({
      ok: true, order: res.order, channel_kept: res.channelKept,
      channel_notice: [cutNotice, res.channelNotice].filter(Boolean).join("\n") || null,
      ...salesSyncFields(res),
    });
  } catch (err) {
    // 차수 재저장 전에 실패했으면 헤더·대량 표식·라인·차수를 되돌린다(차수 저장 뒤의 실패는 되돌리면 원장과 어긋난다).
    //  경합(isShipConflict)이면 차수는 되돌리지 않는다 — 이 요청은 차수를 쓰기 전에 멈췄고, 지금 차수는 다른 요청의 결과다
    //  (처음 스냅샷으로 덮으면 그 요청의 발송완료·취소가 오류 없이 사라진다). 다시 열어 저장하면 선점이 라인에 맞춰진다.
    //  되돌리기는 단계마다 따로 시도하고, 하나라도 실패하면 오류 종류와 상관없이 화면에 알린다(조용히 넘기지 않는다).
    let restoreFailed = false;
    if (!shipmentsSaved) {
      const sb = supabaseAdmin();
      const step = async (label: string, fn: () => Promise<void>) => {
        try {
          await fn();
        } catch (e) {
          restoreFailed = true;
          console.error(`[b2b/orders PUT] 되돌리기 실패(${label})`, e);
        }
      };
      if (rollbackLines) await step("라인", rollbackLines);
      const snap = earlySnap;
      if (snap && rollbackLines && !isShipConflict(err)) {
        await step("차수", async () => {
          if (!(await restoreOrderShipments(sb, orderIdForRollback, snap))) throw new Error("차수 복원 실패");
        });
      }
      if (rollbackBulk) await step("대량 표식", rollbackBulk);
      if (rollbackHeader) await step("헤더", rollbackHeader);
    }
    if (restoreFailed) {
      console.error("[b2b/orders PUT]", err);
      const base = err instanceof ShipChangeError ? err.message : extractErrorMsg(err, "수정 실패");
      return NextResponse.json(
        { ok: false, error: `${base} — 원래 상태로 되돌리는 것도 실패했습니다. 발주를 다시 열어 품목·발송 일정을 확인하세요.` },
        { status: 500 }
      );
    }
    return errorResponse(err, "수정 실패", "[b2b/orders PUT]");
  }
}

// ─────────────────────────────────────────────
// DELETE /api/b2b/orders/[id]
//  발송된 발주(발송완료 또는 발송 시각이 남은 차수)는 지우지 않는다(대표 결정 D3) — 지우면 cascade 로
//  선점 출고가 사라져 실제로 나간 물건이 장부에 되살아난다. 취소로 바꾸면 반품 여부를 묻고 재고를 맞춘다.
// ─────────────────────────────────────────────
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const sb = supabaseAdmin();

    // 삭제 전 스냅샷 (이력 기록용 — 삭제되면 못 읽음)
    const { data: snap, error: snapErr } = await sb
      .from("orders")
      .select("order_no, total, status, company:company_id(name)")
      .eq("id", id)
      .maybeSingle();
    if (snapErr) throw snapErr;
    if (!snap) return NextResponse.json({ ok: false, error: "발주를 찾을 수 없습니다." }, { status: 404 });

    const { data: ships, error: shErr } = await sb.from("shipments").select("status, shipped_at").eq("order_id", id);
    if (shErr) throw shErr;
    const shipped = (snap as { status?: string }).status === "발송완료" ||
      ((ships ?? []) as { status: string; shipped_at: string | null }[]).some(isShippedSchedule);
    // '출고 유지'(발송 후 취소·미반품) 행이 남은 발주도 — 지우면 그 행이 주인 없이 남는다
    let hasKept = false;
    {
      const k = await sb.from("inventory_txns").select("id").eq("source", B2B_CANCEL_KEPT_SOURCE).eq("source_ref", id).limit(1);
      if (k.error && !missingColumn(k.error, "source")) throw k.error;
      hasKept = !k.error && (k.data ?? []).length > 0;
    }
    if (shipped || hasKept) {
      return NextResponse.json(
        { ok: false, error: "발송된 발주는 삭제할 수 없습니다 — 목록에서 상태를 '취소'로 바꾸세요. 발송완료로 잘못 바꾼 것이면 먼저 '발송대기'로 되돌린 뒤 삭제하세요." },
        { status: 400 }
      );
    }

    // 매출원장에서 이 발주분(b2b-<id> + 같은 주문번호의 도매 백필 행)을 먼저 제거 → 삭제된 발주 매출이 집계에 영구히 남지 않게.
    //  (orders→sales_orders 는 FK 가 아니라 upload_batch 태그로만 연결되어 cascade 가 안 걸린다)
    //  실패하면 던진다 — 발주를 지우지 않는다(연결이 끊긴 매출 행은 어떤 동기화로도 다시 지워지지 않는다, 점검 확정).
    await deleteOrderSales(id, (snap as { order_no?: string }).order_no || "");

    // order_items, shipments 는 ON DELETE CASCADE 로 같이 삭제됨
    const { error } = await sb.from("orders").delete().eq("id", id);
    if (error) throw error;

    const s = snap as { order_no: string; total: number; company: { name?: string } | { name?: string }[] | null };
    const company = Array.isArray(s.company) ? s.company[0] : s.company;
    await logOrderDeleted(s.order_no, company?.name ?? "(미지정)", Number(s.total) || 0);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[b2b/orders DELETE]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "삭제 실패") },
      { status: 500 }
    );
  }
}

// ─────────────────────────────────────────────
// PATCH /api/b2b/orders/[id] — 상태만 빠르게 변경 (인라인용)
//  body.status 변경(발송완료·되돌림·취소·복구)과 발송일 단독 변경은 모두 applyOrderShipments 로
//  차수·재고(선점·출고 유지)·헤더·매출을 같은 규칙으로 다시 맞춘다(S7).
//  발송완료: body.shipped_date = 실제 발송일(기본 오늘, 미래 불가) — 저장된 발송일과 다르면 선점일·매출 인식일이 그 날로 옮겨진다(D2).
//  발송된 발주 취소: body.returned(true=반품으로 돌아옴 → 재고 복구, false=안 돌아옴 → 출고 유지) 필수(D3).
// ─────────────────────────────────────────────
export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const body = (await req.json()) as Partial<{
      status: string;
      production_status: string;
      payment_status: string;
      tax_invoice_status: string;
      production_date: string | null;
      ship_date: string | null;
      tracking_no: string | null;
      shipped_date: string | null;
      returned: boolean;
    }>;

    const sb = supabaseAdmin();
    // 변경 전 상태 — 읽지 못하면 멈춘다(빈 값으로 보면 취소 재계산·복수 발송 검사를 건너뛴다, S4)
    const { data: prevRow, error: prevErr } = await sb
      .from("orders")
      .select("status, production_status, payment_status, tax_invoice_status, tracking_no, ship_date, box_count, created_at")
      .eq("id", id)
      .maybeSingle();
    if (prevErr) throw prevErr;
    if (!prevRow) return NextResponse.json({ ok: false, error: "발주를 찾을 수 없습니다." }, { status: 404 });
    const prev = prevRow as {
      status: string; production_status: string; payment_status: string; tax_invoice_status: string;
      tracking_no: string | null; ship_date: string | null; box_count: number | null;
    };

    if (body.status !== undefined && !(ORDER_STATUSES as readonly string[]).includes(body.status)) {
      return NextResponse.json({ ok: false, error: "알 수 없는 발송 상태입니다." }, { status: 400 });
    }

    // 상태 외 칸 — 상태 변경과 같은 update 로 쓴다
    const patch: Record<string, unknown> = {};
    if (body.production_status !== undefined) patch.production_status = body.production_status;
    if (body.payment_status !== undefined) patch.payment_status = body.payment_status;
    if (body.tax_invoice_status !== undefined) patch.tax_invoice_status = body.tax_invoice_status;
    if (body.production_date !== undefined) patch.production_date = body.production_date || null;
    if (body.tracking_no !== undefined) patch.tracking_no = (body.tracking_no || "").trim() || null;
    const statusChange = body.status !== undefined && body.status !== prev.status;
    const shipDateOnly = body.ship_date !== undefined && !!body.ship_date && body.status === undefined;
    if (body.ship_date !== undefined && !body.ship_date && body.status === undefined) patch.ship_date = null;
    if (Object.keys(patch).length === 0 && body.status === undefined && !shipDateOnly) {
      return NextResponse.json({ ok: false, error: "변경할 필드가 없습니다." }, { status: 400 });
    }

    // 복수 발송(차수 2개 이상)은 차수별로 상태를 바꾼다 — 발주 단위 발송완료는 남은 차수까지 전부 발송완료로,
    //  발송대기 되돌림은 이미 나간 차수까지 전부 미발송으로 덮는다(첫 차수 발송 = 발주 발송완료가 된 뒤로 흔해짐).
    //  목록은 복수 발송에 발주 상태 선택을 숨기지만 일괄 변경·직접 호출은 여기서 막는다. 취소·복구(prev=취소)는 발주 단위로 된다.
    //  같은 상태로 다시 보내는 요청도 막는다(목록이 오래된 화면에서 생길 수 있다).
    let multiShip = false;
    if (body.status !== undefined || shipDateOnly) {
      const { data: shipRows, error: shipCntErr } = await sb.from("shipments").select("id").eq("order_id", id);
      if (shipCntErr) throw shipCntErr;
      multiShip = (shipRows ?? []).length >= 2;
    }
    if ((body.status === "발송완료" || body.status === "발송대기") && prev.status !== "취소" && multiShip) {
      return NextResponse.json(
        { ok: false, error: "복수 발송 발주는 차수별로 상태를 바꿉니다 — 발주 목록에서 차수를 펼쳐 변경하세요." },
        { status: 400 }
      );
    }
    // 바뀌는 것이 없는 요청(이미 그 상태 — 일괄 변경에 섞인 발주, 응답이 끊긴 뒤 다시 누름) = 성공.
    //  빈 update 는 0행이 돌아와 .single() 이 실패한다(PGRST116).
    if (!statusChange && !shipDateOnly && Object.keys(patch).length === 0) {
      const { data: cur, error: curErr } = await sb.from("orders").select("*").eq("id", id).maybeSingle();
      if (curErr) throw curErr;
      return NextResponse.json({ ok: true, order: cur, channel_notice: null });
    }

    const today = kstToday();
    // 발송완료로 바꾸려면 송장번호(이번 요청 또는 기존 값)와 실제 발송일
    let shippedDate = today;
    const explicitShipDate = !!body.shipped_date; // 화면이 고른 날짜(없으면 일괄 변경 등 — 되살리는 차수는 저장된 발송일을 쓴다)
    if (statusChange && body.status === "발송완료") {
      const trackingNo = (body.tracking_no ?? prev.tracking_no ?? "").toString().trim();
      if (!trackingNo) {
        return NextResponse.json({ ok: false, error: "발송완료로 변경하려면 송장번호가 필요합니다." }, { status: 400 });
      }
      shippedDate = String(body.shipped_date || today);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(shippedDate)) {
        return NextResponse.json({ ok: false, error: "실제 발송일 형식이 올바르지 않습니다." }, { status: 400 });
      }
      if (shippedDate > today) {
        return NextResponse.json({ ok: false, error: "실제 발송일은 오늘보다 뒤일 수 없습니다." }, { status: 400 });
      }
    }

    const notices: string[] = [];
    let order: Record<string, unknown> | null = null;
    let effStatus = prev.status;
    // 매출 반영 결과(실패면 화면이 경고 배너) — 상태·발송일 경로는 applyOrderShipments 가, 발송일 비우기는 아래에서 동기화한다
    let salesSync: ReturnType<typeof salesSyncFields> = { sales_sync_failed: false };

    if (statusChange) {
      const to = body.status as string;
      const from = prev.status;
      const orderTracking = ((patch.tracking_no as string | null | undefined) ?? prev.tracking_no ?? null) || null;
      const headerBoxes = Math.max(1, Math.floor(Number(prev.box_count) || 1));
      // 단일 발송을 발송완료로 — 날짜 있는 차수가 없으면(배송정보 전용 행뿐) 그 행에, 행도 없으면 새로 만든다.
      //  실제 발송일로 날짜를 맞춘다 — 선점일(첫 발송일 전량)과 매출 인식일이 함께 그 날로 간다(D2).
      const markShipped = (schedules: ShipSchedule[]) => {
        let target = schedules.find((s) => s.status !== "취소" && isRealSchedule(s))
          ?? schedules.find((s) => s.status !== "취소" && !isRealSchedule(s));
        if (!target) {
          target = { ship_date: "", status: "발송대기", tracking_no: "", box_count: headerBoxes, stock_out: true, items: [] };
          schedules.push(target);
        }
        // 구 자동차수는 box_count=1 하드코딩이었다 — 헤더 박스 수가 더 크면 헤더값을 승격(발송요청 양식에서 확정한 박스 수 보존)
        if (Math.max(1, Math.floor(Number(target.box_count) || 1)) === 1 && headerBoxes > 1) target.box_count = headerBoxes;
        // 발송된 적 있는 차수(발송 뒤 취소·안 돌아옴을 되살림)는 저장된 발송일이 실제 발송일이다 — 날짜를 안 보냈으면 그대로 둔다.
        //  보낸 날짜가 다르면 그 날로 옮기되(D2 — 명시한 날짜 우선) 알린다: 선점일·매출 인식일이 함께 옮겨진다.
        const orig = target.shipped_at && target.ship_date ? target.ship_date : null;
        const date = !explicitShipDate && orig && orig <= today ? orig : shippedDate;
        if (orig && orig !== date) notices.push(`발송일을 ${orig} → ${date}로 옮겼습니다 — 재고 차감일·매출 인식일이 함께 바뀝니다.`);
        target.ship_date = date;
        target.status = "발송완료";
        if (orderTracking) target.tracking_no = orderTracking;
        target.shipped_at = target.shipped_at ?? new Date().toISOString();
      };

      let change: Parameters<typeof applyOrderShipments>[1];
      if (to === "취소") {
        // 발주 취소 — 차수를 함께 취소하고 재고를 재계산한다(상태만 바꾸면 선점 출고가 남아 현재고가 영구 왜곡).
        //  발송된 차수가 있으면 반품 여부를 묻는다: 돌아옴 → 재고 복구(발송 시각을 지워 '안 나간 차수'와 같게),
        //  안 돌아옴 → 그 차수로 나간 수량을 출고 유지 행으로 남긴다(발송 시각 보존 = 유지 키).
        const singleShipped = from === "발송완료" && !multiShip;
        change = {
          mutate: (schedules) => {
            const cancelled: number[] = [];
            const shippedIdx: number[] = [];
            schedules.forEach((s, i) => {
              if (s.status === "취소") return; // 먼저 따로 취소한 차수는 그대로(발주 복구 때도 취소 유지)
              if (!isRealSchedule(s)) return;  // 배송정보 전용 행은 차수가 아니다(저장 때 그대로 다시 만들어진다)
              cancelled.push(i);
              if (isShippedSchedule(s) || (singleShipped && isRealSchedule(s))) shippedIdx.push(i);
            });
            if ((shippedIdx.length || from === "발송완료") && typeof body.returned !== "boolean") {
              throw new ShipChangeError("발송된 발주입니다 — 반품으로 실제 돌아왔는지 골라 주세요.", 409, { need_return: true });
            }
            for (const i of cancelled) {
              schedules[i].status = "취소";
              schedules[i].cancelled_with_order = true;
            }
            shippedIdx.forEach((i, n) => {
              const s = schedules[i];
              // 발송 시각 = 출고 유지 키 — 시각이 없던 옛 차수에 새로 찍을 때 차수마다 다른 값이 되게(ms 차이)
              s.shipped_at = body.returned ? null : (s.shipped_at ?? new Date(Date.now() + n).toISOString());
            });
            const opts: SaveShipmentsOpts = { cancelled, keep: body.returned === false ? shippedIdx : [] };
            return opts;
          },
          // 취소에는 헤더 발송일을 넘기지 않는다 — 자동차수 생성 분기가 '발송대기+전량 선점' 차수를
          //  만들어 취소 발주가 재고를 전량 차감하는 역방향 사고를 막는다(검증 확정 보정)
          headerShipDate: null,
          status: "취소",
          statusFromSingle: true,
        };
      } else if (from === "취소") {
        // 취소 복구 — 발주 취소로 같이 취소된 차수만 되살린다(134 표식, 없으면 옛 동작대로 전부).
        //  발송 시각이 남은 차수(이미 나갔고 안 돌아옴)는 발송완료로, 출고 유지 행은 지우고 일반 선점으로 돌아간다.
        //  나머지는 발송대기 — 단일 발송을 발송완료로 복구하면 실제 발송일로 발송완료.
        change = {
          mutate: (schedules) => {
            const cancelledIdx = schedules.map((s, i) => ({ s, i })).filter((x) => x.s.status === "취소");
            const flagged = cancelledIdx.filter((x) => x.s.cancelled_with_order);
            const revive = flagged.length ? flagged : cancelledIdx;
            const releaseKeys: number[] = [];
            for (const { s } of revive) {
              const k = shippedKey(s.shipped_at);
              if (k !== null) releaseKeys.push(k);
              s.cancelled_with_order = false;
              s.status = s.shipped_at ? "발송완료" : "발송대기";
            }
            if (to === "발송완료" && !multiShip) markShipped(schedules);
            return { releaseKeys };
          },
          headerShipDate: to === "발송완료" && !multiShip ? shippedDate : prev.ship_date ?? null,
          headerStatus: to === "발송완료" && !multiShip ? "발송완료" : null,
          status: to,
          statusFromSingle: true, // 되살린 차수가 이미 발송완료면 발주도 발송완료(요청 상태로 두면 나간 물건의 매출이 빠진다)
        };
      } else if (to === "발송완료") {
        change = {
          mutate: (schedules) => { markShipped(schedules); },
          headerShipDate: shippedDate,
          headerStatus: "발송완료",
          status: "발송완료",
          statusFromSingle: true,
        };
      } else {
        // 발송완료 → 발송대기 되돌림 — 차수도 함께(차수가 발송완료로 남으면 이후 무관한 차수 PATCH 가 발주를 다시 발송완료로 올린다)
        change = {
          mutate: (schedules) => {
            for (const s of schedules) if (s.status === "발송완료") { s.status = "발송대기"; s.shipped_at = null; }
          },
          headerShipDate: null,
          status: "발송대기",
          statusFromSingle: true,
        };
      }
      const r = await applyOrderShipments(id, { ...change, extra: patch });
      order = r.order;
      effStatus = r.headerStatus ?? to;
      salesSync = salesSyncFields(r);
      if (r.channelNotice) notices.push(r.channelNotice);
      if (effStatus !== to) notices.push(`이미 발송된 차수가 있어 '${effStatus}'(으)로 되돌렸습니다.`);
      if (effStatus === "발송완료" && to === "발송완료") {
        const un = r.savedItems.filter((l) => !l.product_id).map((l) => l.product_name);
        if (un.length) notices.push(`재고 미연동 품목 ${un.length}줄은 재고에서 빠지지 않았습니다: ${un.join(", ")}`);
      }
    } else if (shipDateOnly) {
      // 발송일 단독 변경 — orders 컬럼만 바꾸면 재고가 안 빠지므로 차수 발송일을 바꿔 재저장한다(선점·매출일이 따라온다).
      //  복수발송은 차수별로 관리 — 발송일 창에서 고친다.
      const date = String(body.ship_date);
      if (multiShip) {
        return NextResponse.json({ ok: false, error: "복수 발송 발주는 발송일 칸('N차 · 수정')에서 차수별로 고치세요." }, { status: 400 });
      }
      if (prev.status === "발송완료" && date > today) {
        return NextResponse.json({ ok: false, error: "발송완료된 발주의 발송일은 오늘보다 뒤일 수 없습니다." }, { status: 400 });
      }
      const headerBoxes = Math.max(1, Math.floor(Number(prev.box_count) || 1));
      const r = await applyOrderShipments(id, {
        mutate: (schedules) => {
          const s0 = schedules[0];
          if (!s0) return;
          if (s0.status === "발송완료" && date > today) throw new ShipChangeError("발송완료된 차수의 발송일은 오늘보다 뒤일 수 없습니다.");
          s0.ship_date = date;
          if (Math.max(1, Math.floor(Number(s0.box_count) || 1)) === 1 && headerBoxes > 1) s0.box_count = headerBoxes;
        },
        headerShipDate: date,
        headerStatus: (prev.status as ShipSchedule["status"]) || "발송대기",
        noDateShipDate: date, // 전 차수가 취소면 earliest 가 null — 입력한 날짜를 버리지 않는다(검증 확정 보정)
        extra: patch,
      });
      order = r.order;
      salesSync = salesSyncFields(r);
      if (r.channelNotice) notices.push(r.channelNotice);
    } else {
      const { data, error } = await sb.from("orders").update(patch).eq("id", id).select().single();
      if (error) throw error;
      order = data as Record<string, unknown>;
      // 발송일 비우기 — 매출 인식일이 바뀐다
      if (patch.ship_date !== undefined && (prev.ship_date ?? null) !== null) {
        salesSync = salesSyncFields(await syncOrderSalesSafe(id));
      }
    }

    // 활동 로그 — 재고·헤더·매출을 다 맞춘 뒤에 보낸다(알림이 늦거나 실패해도 장부는 이미 맞다)
    if (effStatus && prev.status && prev.status !== effStatus) {
      await logOrderStatusChanged(id, prev.status, effStatus);
    }
    if (body.production_status && prev.production_status && prev.production_status !== body.production_status) {
      await logOrderProductionStatusChanged(id, prev.production_status, body.production_status);
    }
    if (body.payment_status && prev.payment_status && prev.payment_status !== body.payment_status) {
      await logOrderPaymentStatusChanged(id, prev.payment_status, body.payment_status);
    }
    if (body.tax_invoice_status && prev.tax_invoice_status && prev.tax_invoice_status !== body.tax_invoice_status) {
      await logOrderTaxInvoiceChanged(id, prev.tax_invoice_status, body.tax_invoice_status);
    }

    return NextResponse.json({ ok: true, order, channel_notice: notices.join("\n") || null, ...salesSync });
  } catch (err) {
    return errorResponse(err, "수정 실패", "[b2b/orders PATCH]");
  }
}
