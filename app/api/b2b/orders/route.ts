import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import {
  OrderInput,
  OrderListItem,
  computeRemaining,
  normalizeOrderItem,
  validateOrder,
} from "@/app/lib/b2b-orders";
import {
  applyOrderShipments,
  missingColumn,
  salesSyncFields,
  ShipChangeError,
  type SavedOrderItem,
  type ShipSchedule,
} from "@/app/lib/b2b-shipments";
import { logOrderCreated } from "@/app/lib/b2b-activity";

export const runtime = "nodejs"; // sales-sync 가 crypto(sales-normalize) 사용
export const dynamic = "force-dynamic";

// ─────────────────────────────────────────────
// GET /api/b2b/orders
//  query: ?status=...&company_id=...&date_from=YYYY-MM-DD&date_to=YYYY-MM-DD&date_field=ship_date|production_date|order_date
// ─────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const status = url.searchParams.get("status");
    const companyId = url.searchParams.get("company_id");
    const dateFrom = url.searchParams.get("date_from");
    const dateTo = url.searchParams.get("date_to");
    const dateField = url.searchParams.get("date_field") || "order_date";

    const sb = supabaseAdmin();
    let q = sb
      .from("orders")
      .select(
        "*, companies:company_id(name), order_items(id, product_id, product_name, spec, qty, sort_order), " +
          "shipments(id, seq, ship_date, status, shipped_at, recipient_name, recipient_phone, tracking_no, box_count, shipment_items(order_item_id, product_name, spec, qty))"
      )
      .order("order_date", { ascending: false })
      .order("created_at", { ascending: false });

    if (status && status !== "전체") q = q.eq("status", status);
    if (companyId) q = q.eq("company_id", companyId);
    if (dateFrom && ["order_date", "production_date", "ship_date"].includes(dateField)) {
      q = q.gte(dateField, dateFrom);
    }
    if (dateTo && ["order_date", "production_date", "ship_date"].includes(dateField)) {
      q = q.lte(dateField, dateTo);
    }

    const { data, error } = await q;
    if (error) throw error;

    // 평탄화: companies.name → company_name, order_items[] → items(정렬) + item_count, shipments[] 정렬
    type ItemRow = { id: string; product_id: string | null; product_name: string; spec: string | null; qty: number; sort_order: number };
    type ShipItemRow = { order_item_id: string | null; product_name: string; spec: string | null; qty: number };
    type ShipRow = { id: string; seq: number; ship_date: string | null; status: string; shipped_at?: string | null; recipient_name?: string | null; recipient_phone?: string | null; tracking_no: string | null; box_count?: number; shipment_items?: ShipItemRow[] };
    type Row = Record<string, unknown> & {
      companies?: { name?: string } | null;
      order_items?: ItemRow[];
      shipments?: ShipRow[];
    };
    const orders: OrderListItem[] = ((data as unknown as Row[] | null) ?? []).map((r) => {
      const { companies, order_items, shipments, ...rest } = r;
      const items = Array.isArray(order_items)
        ? [...order_items]
            .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
            .map((it) => ({ id: it.id, product_name: it.product_name, spec: it.spec, qty: Number(it.qty) || 0 }))
        : [];
      const ships = Array.isArray(shipments)
        ? [...shipments]
            .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
            .map((s) => ({
              id: s.id,
              seq: s.seq,
              ship_date: s.ship_date,
              status: s.status as OrderListItem["shipments"][number]["status"],
              shipped_at: s.shipped_at ?? null, // 발송 시각 — 발송 뒤 취소한 차수를 되살릴 때 원래 발송일을 기본값으로 쓴다
              recipient_name: s.recipient_name ?? "",
              recipient_phone: s.recipient_phone ?? "",
              tracking_no: s.tracking_no ?? null,
              box_count: Math.max(1, Number(s.box_count) || 1),
              items: (s.shipment_items ?? []).map((si) => ({ order_item_id: si.order_item_id, product_name: si.product_name, spec: si.spec, qty: Number(si.qty) || 0 })),
            }))
        : [];
      // 발송일 미정 잔여(라인별·합) — 취소 발주는 보낼 것이 없으므로 0
      const cancelled = (rest as { status?: string }).status === "취소";
      const rem = cancelled ? items.map(() => 0) : computeRemaining(items, ships);
      const itemsWithRem = items.map((it, i) => ({ ...it, remaining: rem[i] }));
      // 상품을 고르지 않고 이름만 친 라인 수 — 재고가 빠지지 않으므로 목록이 '재고 미연동 N줄'로 알린다(S9)
      const unlinked_count = (order_items ?? []).filter((it) => !it.product_id && String(it.product_name || "").trim()).length;
      return {
        ...(rest as unknown as OrderListItem),
        company_name: companies?.name ?? "(미지정)",
        item_count: items.length,
        items: itemsWithRem,
        shipments: ships,
        remaining_total: rem.reduce((a, b) => a + b, 0),
        unlinked_count,
      };
    });

    return NextResponse.json({ ok: true, orders });
  } catch (err) {
    console.error("[b2b/orders GET]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "조회 실패") },
      { status: 500 }
    );
  }
}

// ─────────────────────────────────────────────
// POST /api/b2b/orders — 헤더 + 라인아이템 한 번에
//  새 발주는 항상 '발송대기'로 만든다 — 발송완료는 목록에서 실제 발송일·송장과 함께(D2).
//  body.client_request_id: 등록 화면을 열 때 만든 요청 키(134) — 같은 키로 다시 오면 처음 만든 발주를 돌려준다(S2).
//  body.allow_unlinked: 상품 미연결(직접입력) 라인을 그대로 저장한다는 확인(S9).
// ─────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as OrderInput & { client_request_id?: string | null; allow_unlinked?: boolean };
    const validationError = validateOrder({ ...body, status: "발송대기" });
    if (validationError) {
      return NextResponse.json({ ok: false, error: validationError }, { status: 400 });
    }
    const unlinked = (body.items || [])
      .filter((it) => !it.product_id && String(it.product_name || "").trim())
      .map((it) => String(it.product_name).trim());
    if (unlinked.length && !body.allow_unlinked) {
      return NextResponse.json(
        { ok: false, unlinked, error: `재고 미연동 품목이 있습니다: ${unlinked.join(", ")} — 상품을 고르거나 그대로 저장을 확인하세요.` },
        { status: 400 }
      );
    }

    const sb = supabaseAdmin();
    const reqKey = typeof body.client_request_id === "string" && /^[A-Za-z0-9-]{8,64}$/.test(body.client_request_id)
      ? body.client_request_id
      : null;
    const findByKey = async (): Promise<Record<string, unknown> | null> => {
      if (!reqKey) return null;
      const ex = await sb.from("orders").select("*").eq("client_request_id", reqKey).maybeSingle();
      if (ex.error) {
        if (missingColumn(ex.error, "client_request_id")) return null; // 134 미적용 — 키 없이 진행(종전 동작)
        throw ex.error;
      }
      return (ex.data as Record<string, unknown> | null) ?? null;
    };
    // 같은 키로 이미 만든 발주 — 응답이 끊겨 다시 누른 경우. 새로 만들지 않고 그대로 돌려준다.
    {
      const dup = await findByKey();
      if (dup) return NextResponse.json({ ok: true, order: dup, duplicate: true });
    }

    // 1) 헤더 insert (order_no 는 트리거가 자동 발번)
    const payload: Record<string, unknown> = {
      company_id: body.company_id,
      order_date: body.order_date,
      production_date: body.production_date || null,
      ship_date: body.ship_date || null,
      status: "발송대기",
      production_status: body.production_status,
      payment_status: body.payment_status,
      tax_invoice_status: body.tax_invoice_status,
      notes: body.notes?.trim() || null,
      discount_amount: Math.round(Number(body.discount_amount) || 0), // 양수 = 할인, 음수 = 추가금
      discount_reason: body.discount_reason?.trim() || null,
      box_count: Math.max(1, Math.floor(Number(body.box_count) || 1)),
      tracking_no: null,
      ...(reqKey ? { client_request_id: reqKey } : {}),
    };
    let orderRow: { id: string } | null = null;
    for (let attempt = 0; !orderRow; attempt++) {
      const r = await sb.from("orders").insert(payload).select().single();
      if (!r.error) { orderRow = r.data as { id: string }; break; }
      const e = r.error;
      if (attempt >= 3) throw e;
      // 134 미적용 — 요청 키 없이 다시
      if ("client_request_id" in payload && missingColumn(e, "client_request_id")) { delete payload.client_request_id; continue; }
      // 095 미적용 환경 폴백 — 할인 컬럼 없이 재시도(할인 없이 저장됨)
      if ("discount_amount" in payload && /discount/i.test(e.message || "")) { delete payload.discount_amount; delete payload.discount_reason; continue; }
      if (e.code === "23505") {
        // 같은 요청 키가 동시에 들어왔다 — 먼저 만든 발주를 돌려준다
        if (reqKey && /client_request/i.test(e.message || "")) {
          const dup = await findByKey();
          if (dup) return NextResponse.json({ ok: true, order: dup, duplicate: true });
        }
        // 발주번호 발번 충돌 (동시 등록 등) — 재시도 안내
        return NextResponse.json(
          { ok: false, error: "발주번호 발번이 겹쳤습니다. 저장을 한 번 더 눌러주세요." },
          { status: 409 }
        );
      }
      throw e;
    }
    const orderId = orderRow.id;

    // 1-b) 대량 발주 표식(115) — 발송 선점을 '도매 대량' 칸에서 빼는 스위치.
    //  3) 의 재저장이 DB 에서 이 값을 읽으므로 반드시 그 전에 쓴다. 신규는 기본 false 라
    //  체크한 경우에만 쓴다. is_bulk 컬럼 미적용(115 전) 환경이면 에러에 컬럼명이 보인다 — 그때만 넘어간다(전건 도매).
    if (body.is_bulk) {
      const bulkRes = await sb.from("orders").update({ is_bulk: true }).eq("id", orderId);
      if (bulkRes.error && !missingColumn(bulkRes.error, "is_bulk")) {
        await sb.from("orders").delete().eq("id", orderId); // 보상: 헤더 롤백(라인아이템 실패와 같은 규칙)
        throw bulkRes.error;
      }
    }

    // 2) 라인아이템 insert
    const itemsToInsert = body.items.map((it, idx) => {
      const clean = normalizeOrderItem(it);
      return {
        order_id: orderId,
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
    });

    const { data: insertedItems, error: itemsErr } = await sb
      .from("order_items")
      .insert(itemsToInsert)
      .select("id, product_id, product_name, spec, sort_order");
    if (itemsErr) {
      // 보상: 헤더 롤백
      await sb.from("orders").delete().eq("id", orderId);
      throw itemsErr;
    }

    // 폼 인덱스(sort_order) 순으로 정렬해 매핑 안정화
    const savedItems: SavedOrderItem[] = (insertedItems ?? [])
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((r) => ({ id: r.id, product_id: r.product_id ?? null, product_name: r.product_name, spec: r.spec }));

    // 3) 발송 일정 + 헤더(발송일·박스 수)·매출 — 공용 재저장 경로. 새 발주의 차수는 모두 발송대기(송장 없음).
    //  등록 폼은 차수를 보내지 않는다(발송일은 목록의 '+ 발송일' 창에서) — 보내면 그 날짜로 선점한다.
    const incoming: ShipSchedule[] = (body.shipments ?? []).map((s) => ({
      ...s,
      status: s.status === "취소" ? "취소" : "발송대기",
      tracking_no: "",
      shipped_at: null,
    }));
    let created: Awaited<ReturnType<typeof applyOrderShipments>>;
    try {
      created = await applyOrderShipments(orderId, {
        savedItems,
        recipient: body.recipient,
        boxCount: Math.max(1, Math.floor(Number(body.box_count) || 1)),
        headerShipDate: body.ship_date || null,
        headerStatus: "발송대기",
        mutate: (schedules) => { schedules.splice(0, schedules.length, ...incoming); },
        noDateShipDate: body.ship_date || null,
      });
    } catch (shipErr) {
      await sb.from("orders").delete().eq("id", orderId);
      throw shipErr;
    }

    // 활동 로그 기록 (fire-and-forget, 실패해도 응답엔 영향 없음) — 재고·헤더·매출을 다 맞춘 뒤에 보낸다
    await logOrderCreated(orderId);

    // 새 발주는 항상 발송대기라 매출 행이 없다 — 동기화가 실패해도 원장에 남을 것이 없지만 결과는 그대로 싣는다
    return NextResponse.json({ ok: true, order: created.order, ...salesSyncFields(created) });
  } catch (err) {
    if (err instanceof ShipChangeError) {
      return NextResponse.json({ ok: false, error: err.message, ...(err.extra || {}) }, { status: err.status });
    }
    console.error("[b2b/orders POST]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "등록 실패") },
      { status: 500 }
    );
  }
}
