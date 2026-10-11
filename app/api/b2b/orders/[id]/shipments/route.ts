import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import {
  applyOrderShipments,
  isShippedSchedule,
  keptShipKeys,
  shippedKey,
  kstToday,
  missingColumn,
  salesSyncFields,
  ShipChangeError,
  type SavedOrderItem,
  type ShipSchedule,
} from "@/app/lib/b2b-shipments";
import type { ShipmentScheduleInput } from "@/app/lib/b2b-orders";
import { logShipmentScheduled } from "@/app/lib/b2b-activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// 발송 일정(차수) 전용 저장 — 발주 목록의 '발송일 등록' 창이 쓴다.
//  발주 등록 폼에서 발송 일정 섹션을 뺐으므로, 차수(날짜·박스 수·수량)는 여기 한 곳에서만 만든다.
//  GET  → 현재 차수(id 포함) + 배송정보 + 발주 라인(수량 배정용)
//  POST → { schedules } 통째 교체. 재고 차감(도매 — 대량 발주면 '도매 대량')·헤더 발송일/상태/박스 수·매출 동기화까지 applyOrderShipments 가 처리.
//   이 창은 날짜·박스 수·수량만 고친다 — 상태·송장·발송 시각은 차수 id 로 DB 값을 그대로 쓴다(열어 둔 사이 목록에서 한 발송완료를 덮지 않게).

type ShipRow = {
  id: string; seq: number; ship_date: string | null; status: string; tracking_no: string | null;
  box_count: number | null; stock_out?: boolean | null; shipped_at?: string | null;
  recipient_name: string | null; recipient_phone: string | null; address: string | null;
  delivery_memo: string | null; courier: string | null;
  shipment_items?: { order_item_id: string; qty: number }[];
};

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const sb = supabaseAdmin();
    const sel = (withStockOut: boolean) =>
      sb.from("shipments")
        .select(`id, seq, ship_date, status, tracking_no, box_count, ${withStockOut ? "stock_out, " : ""}shipped_at, recipient_name, recipient_phone, address, delivery_memo, courier, shipment_items(order_item_id, qty)`)
        .eq("order_id", id)
        .order("seq", { ascending: true });
    const [oi, ord, sh0, keptKeys] = await Promise.all([
      // 라인 순번 = 저장 때 다시 읽는 순서(b2b-shipments loadSavedItems)와 같아야 수량이 제 라인에 붙는다
      sb.from("order_items").select("id, product_name, spec, qty, sort_order").eq("order_id", id).order("sort_order", { ascending: true }).order("id", { ascending: true }),
      sb.from("orders").select("status").eq("id", id).maybeSingle(),
      sel(true),
      keptShipKeys(sb, id),
    ]);
    if (oi.error) throw oi.error;
    if (ord.error) throw ord.error;
    // stock_out 컬럼(035) 미적용이면 그 컬럼만 빼고 재조회 — 그 밖의 오류는 던진다
    let sh = sh0;
    if (sh.error && missingColumn(sh.error, "stock_out")) sh = await sel(false);
    if (sh.error) throw sh.error;
    const ships = (sh.data ?? []) as unknown as ShipRow[];
    const items = (oi.data ?? []).map((r) => ({ id: r.id as string, product_name: r.product_name as string, spec: (r.spec as string) ?? null, qty: Number(r.qty) || 0 }));
    const idxOf = new Map(items.map((it, i) => [it.id, i]));

    // 날짜·수량이 모두 없는 '배송정보 전용' 행은 차수로 보여주지 않는다(폼과 같은 규칙).
    const schedules = ships
      .filter((s) => s.ship_date || (s.shipment_items || []).some((x) => Number(x.qty) > 0))
      .map((s) => ({
        id: s.id, // 저장 때 이 id 로 상태·송장·발송 시각을 DB 에서 가져온다
        ship_date: s.ship_date || "",
        status: s.status,
        tracking_no: s.tracking_no || "",
        box_count: Math.max(1, Number(s.box_count) || 1),
        stock_out: s.stock_out !== false,
        shipped_at: s.shipped_at ?? null,
        // 발송 뒤 '안 돌아옴'으로 취소해 출고 유지 행이 남은 차수 — 창이 발송일·수량을 잠근다(저장도 막는다)
        kept_out: s.status === "취소" && keptKeys.has(shippedKey(s.shipped_at) ?? NaN),
        items: (s.shipment_items || [])
          .map((x) => ({ order_item_index: idxOf.get(x.order_item_id) ?? -1, qty: Number(x.qty) || 0 }))
          .filter((x) => x.order_item_index >= 0 && x.qty > 0),
      }));
    const r0 = ships[0];
    const recipient = r0
      ? { recipient_name: r0.recipient_name || "", recipient_phone: r0.recipient_phone || "", address: r0.address || "", delivery_memo: r0.delivery_memo || "", courier: r0.courier || "" }
      : null;

    return NextResponse.json({ ok: true, items, schedules, recipient, order_status: (ord.data as { status?: string } | null)?.status ?? null });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "발송 일정 조회 실패") }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as { schedules?: (ShipmentScheduleInput & { id?: string })[] };
    const incoming = Array.isArray(body.schedules) ? body.schedules : [];
    // 빈 목록 = 일정 전체 삭제(허용) — 화면이 의도를 확인하고 보낸다.
    //  재저장이 기존 차수를 지우고(cascade 로 선점 재고 원복) 배송정보 행만 보존한다.
    const clearingAll = !incoming.some((s) => s.ship_date);
    const sb = supabaseAdmin();
    const today = kstToday();

    const { data: ord, error: ordErr } = await sb.from("orders").select("status").eq("id", id).maybeSingle();
    if (ordErr) throw ordErr;
    if (!ord) return NextResponse.json({ ok: false, error: "발주를 찾을 수 없습니다." }, { status: 404 });
    const orderStatus = (ord as { status: string }).status;
    // 취소된 발주의 차수를 새로 잡으면 발주는 '취소'인데 재고만 빠진다 — 상태를 먼저 되돌린다. 전부 지우는 정리는 허용(취소 유지).
    if (orderStatus === "취소" && !clearingAll) {
      return NextResponse.json({ ok: false, error: "취소된 발주입니다 — 발송 상태를 먼저 되돌린 뒤 발송 일정을 고치세요." }, { status: 400 });
    }

    // 발주 라인 — 창의 라인 순번(order_item_index)과 같은 순서로 읽는다(GET 과 같은 정렬). 수량은 배분 초과 검사용.
    const { data: lineRows, error: lineErr } = await sb
      .from("order_items")
      .select("id, product_id, product_name, spec, qty, sort_order")
      .eq("order_id", id)
      .order("sort_order", { ascending: true })
      .order("id", { ascending: true });
    if (lineErr) throw lineErr;
    const lines = (lineRows ?? []) as { id: string; product_id: string | null; product_name: string; spec: string | null; qty: number }[];
    const savedItems: SavedOrderItem[] = lines.map((l) => ({ id: l.id, product_id: l.product_id ?? null, product_name: l.product_name, spec: l.spec ?? null }));

    // 출고 유지 행이 남은 차수(발송 시각 키) — 그 차수의 발송일·배분은 고치지 않는다. 읽지 못하면 저장하지 않는다(S4).
    const keptKeys = await keptShipKeys(sb, id);

    let beforeDates: string[] = [];
    let prevShipCount = 0;
    let prevAllCancelled = false;
    let kept: ShipSchedule[] = [];
    const datesOf = (rows: { ship_date?: string | null; status?: string | null }[]) =>
      rows.filter((r) => r.ship_date && r.status !== "취소").map((r) => r.ship_date as string).sort();

    const r = await applyOrderShipments(id, {
      savedItems,
      mutate: (schedules, ships) => {
        // 저장 전 발송예정일 스냅샷(알림을 '실제로 바뀐 경우'에만 보내기 위해)·헤더 상태 보정 근거
        beforeDates = datesOf(schedules);
        prevShipCount = ships.length;
        prevAllCancelled = ships.length > 0 && ships.every((s) => s.status === "취소");
        const byId = new Map(schedules.filter((s) => s.id).map((s) => [s.id as string, s]));
        // 열어 둔 사이 다른 저장이 차수를 새로 만들었으면(id 가 바뀜) 덮지 않는다
        if (incoming.some((s) => s.id && !byId.has(s.id))) {
          throw new ShipChangeError("다른 곳에서 발송 일정이 바뀌었습니다 — 창을 닫고 다시 여세요.", 409);
        }
        const dated = incoming.filter((s) => s.ship_date);
        // 발송된 차수(발송완료·발송 시각 보유)는 지울 수 없다(D3) — 지우면 그 몫이 'N개 남음'으로 돌아가거나 선점이 원복된다
        const keptIds = new Set(dated.map((s) => s.id).filter(Boolean) as string[]);
        const lost = schedules.filter((s) => s.id && isShippedSchedule(s) && (s.ship_date || (s.items || []).length) && !keptIds.has(s.id));
        if (lost.length) throw new ShipChangeError("이미 발송된 차수는 지울 수 없습니다 — 발주 목록에서 그 차수를 '취소'로 바꾸세요.", 400);
        // 상태·송장·발송 시각·재고차감 설정은 DB 값 — 이 창은 날짜·박스 수·수량만 고친다
        const itemsOf = (s: ShipmentScheduleInput) => (s.items || [])
          .map((it) => ({ order_item_index: Number(it.order_item_index), qty: Number(it.qty) || 0 }))
          .filter((it) => it.qty > 0);
        const sameItems = (a: { order_item_index: number; qty: number }[], b: { order_item_index: number; qty: number }[]) => {
          const m = new Map<number, number>();
          for (const it of a) m.set(it.order_item_index, (m.get(it.order_item_index) || 0) + it.qty);
          for (const it of b) m.set(it.order_item_index, (m.get(it.order_item_index) || 0) - it.qty);
          return [...m.values()].every((d) => Math.abs(d) < 1e-9);
        };
        const next: ShipSchedule[] = dated.map((s) => {
          const db = s.id ? byId.get(s.id) : undefined;
          // 발송 뒤 '안 돌아옴'으로 취소한 차수 — 출고 유지 행이 취소 때의 배분·발송일로 한 번 만들어졌다.
          //  배분을 고치면 선점(발주 − 취소 배분)과 출고 유지가 어긋나 장부에서 두 번 빠지므로 DB 값 그대로만 받는다.
          //  (출고 유지 행이 없는 옛 취소 차수는 발송 시각이 있어도 예전처럼 고칠 수 있다)
          const keptCancel = !!db && db.status === "취소" && keptKeys.has(shippedKey(db.shipped_at) ?? NaN);
          if (keptCancel && (s.ship_date !== db.ship_date || !sameItems(itemsOf(s), itemsOf(db)))) {
            throw new ShipChangeError("발송 뒤 취소한 차수의 발송일·수량은 바꿀 수 없습니다 — 목록에서 그 차수를 되돌린 뒤 고치세요.", 400);
          }
          return {
            id: s.id,
            ship_date: keptCancel ? db.ship_date : s.ship_date,
            box_count: Math.max(1, Math.floor(Number(s.box_count) || 1)),
            items: keptCancel ? itemsOf(db) : itemsOf(s),
            status: db ? db.status : (s.status === "취소" ? "취소" : "발송대기"), // 새 줄은 발송대기(옛 화면이 실어 보낸 취소는 유지)
            tracking_no: db ? db.tracking_no : "",
            shipped_at: db ? db.shipped_at ?? null : null,
            stock_out: db ? db.stock_out : true,
            cancelled_with_order: db ? db.cancelled_with_order : false,
          };
        });
        // 발송완료 차수의 발송일은 실제로 나간 날 — 미래로 잡을 수 없다(D2)
        if (next.some((s) => s.status === "발송완료" && s.ship_date > today)) {
          throw new ShipChangeError("발송완료된 차수의 발송일은 오늘보다 뒤일 수 없습니다.", 400);
        }
        // 배분 합이 발주 수량보다 많으면 막는다 — 취소 차수 배분은 '주문에서 빠진 양'이라, 남긴 채 새 차수에 같은 수량을 넣으면
        //  발주는 되살아나는데 재고 차감·매출·청구가 0 이 된다(점검 확정). 취소 차수 몫을 다시 보내려면 그 차수를 지운다.
        const qtyOf = new Map<number, number>();
        for (const s of next) for (const it of s.items) qtyOf.set(it.order_item_index, (qtyOf.get(it.order_item_index) || 0) + Number(it.qty));
        const over = [...qtyOf.entries()].filter(([idx, q]) => !lines[idx] || q - (Number(lines[idx].qty) || 0) > 1e-9);
        if (over.length) {
          const label = (idx: number) => lines[idx] ? `${lines[idx].product_name}${lines[idx].spec ? ` ${lines[idx].spec}` : ""}` : `${idx + 1}번째 품목`;
          throw new ShipChangeError(
            `배분 수량이 발주 수량보다 많습니다 — ${over.map(([idx, q]) => `${label(idx)}: 발주 ${Number(lines[idx]?.qty) || 0} / 배분 ${Math.round(q * 1000) / 1000}`).join(", ")}. 취소 차수 몫을 다시 보내려면 그 차수를 지우세요.`,
            400
          );
        }
        kept = next;
        schedules.splice(0, schedules.length, ...next);
      },
      headerShipDate: null,
      noDateShipDate: null, // 날짜 있는 비취소 차수가 없으면 발송일도 비운다
      // 헤더 상태(복수 발송은 차수에서 도출되므로 여기는 1개 이하만):
      //  - 전부 지웠으면 미발송으로 되돌린다 — 단 취소 발주는 취소 유지(정리하느라 지운 것으로 되살아나면 안 된다)
      //  - 복수 발송(2개 이상)이 이 저장으로 1개가 됐으면 그 차수 상태로 — 차수 1개는 도출을 안 하므로,
      //    취소 차수를 지우고 남은 1개가 발송대기인데 발주가 발송완료(매출 인식)로 남으면 안 된다.
      //    이전 차수가 전부 취소였으면(= 발주 취소) 취소 그대로. 원래부터 단일 발송이던 발주는 발주 단위로 관리(그대로).
      status: () => {
        if (clearingAll) return orderStatus === "취소" ? undefined : "발송대기";
        if (prevShipCount >= 2 && kept.length === 1) {
          const st = kept[0].status;
          if (st === "발송완료") return "발송완료";
          if (st === "취소" && prevAllCancelled) return undefined;
          return "발송대기";
        }
        return undefined;
      },
    });

    // 알림 — 발송예정일이 실제로 달라졌을 때만. 수량 배분만 고치고 저장하는 경우가 잦아
    //  날짜가 그대로면 조용히 넘긴다(설정: 관리자 › 알림 › '발송일정 등록').
    //  재고·헤더·매출을 다 맞춘 뒤(applyOrderShipments 안에서 끝난다)에 보낸다.
    const afterDates = datesOf(kept);
    if (beforeDates.join("|") !== afterDates.join("|")) {
      await logShipmentScheduled(id, beforeDates, afterDates);
    }

    return NextResponse.json({ ok: true, ship_date: r.earliestShipDate, box_count: r.totalBoxes, channel_notice: r.channelNotice, ...salesSyncFields(r) });
  } catch (err) {
    if (err instanceof ShipChangeError) {
      return NextResponse.json({ ok: false, error: err.message, ...(err.extra || {}) }, { status: err.status });
    }
    console.error("[b2b/orders/shipments]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "발송 일정 저장 실패") }, { status: 500 });
  }
}
