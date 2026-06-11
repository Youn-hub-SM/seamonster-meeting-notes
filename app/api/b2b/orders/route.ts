import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import {
  OrderInput,
  OrderListItem,
  normalizeOrderItem,
  validateOrder,
} from "@/app/lib/b2b-orders";
import { saveOrderShipments, SavedOrderItem } from "@/app/lib/b2b-shipments";
import { logOrderCreated } from "@/app/lib/b2b-activity";

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
        "*, companies:company_id(name), order_items(product_name, spec, qty, sort_order), " +
          "shipments(id, seq, ship_date, status, tracking_no, shipment_items(product_name, spec, qty))"
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
    type ItemRow = { product_name: string; spec: string | null; qty: number; sort_order: number };
    type ShipItemRow = { product_name: string; spec: string | null; qty: number };
    type ShipRow = { id: string; seq: number; ship_date: string | null; status: string; tracking_no: string | null; shipment_items?: ShipItemRow[] };
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
            .map((it) => ({ product_name: it.product_name, spec: it.spec, qty: Number(it.qty) || 0 }))
        : [];
      const ships = Array.isArray(shipments)
        ? [...shipments]
            .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
            .map((s) => ({
              id: s.id,
              seq: s.seq,
              ship_date: s.ship_date,
              status: s.status as OrderListItem["shipments"][number]["status"],
              tracking_no: s.tracking_no ?? null,
              items: (s.shipment_items ?? []).map((si) => ({ product_name: si.product_name, spec: si.spec, qty: Number(si.qty) || 0 })),
            }))
        : [];
      return {
        ...(rest as unknown as OrderListItem),
        company_name: companies?.name ?? "(미지정)",
        item_count: items.length,
        items,
        shipments: ships,
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
// ─────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as OrderInput;
    const validationError = validateOrder(body);
    if (validationError) {
      return NextResponse.json({ ok: false, error: validationError }, { status: 400 });
    }

    const sb = supabaseAdmin();

    // 1) 헤더 insert (order_no 는 트리거가 자동 발번)
    const { data: orderRow, error: orderErr } = await sb
      .from("orders")
      .insert({
        company_id: body.company_id,
        order_date: body.order_date,
        production_date: body.production_date || null,
        ship_date: body.ship_date || null,
        status: body.status,
        payment_status: body.payment_status,
        tax_invoice_status: body.tax_invoice_status,
        notes: body.notes?.trim() || null,
        box_count: Math.max(1, Math.floor(Number(body.box_count) || 1)),
        tracking_no: body.tracking_no?.trim() || null,
      })
      .select()
      .single();
    if (orderErr) {
      // 발주번호 발번 충돌 (동시 등록 등) — 재시도 안내
      if (orderErr.code === "23505") {
        return NextResponse.json(
          { ok: false, error: "발주번호 발번이 겹쳤습니다. 저장을 한 번 더 눌러주세요." },
          { status: 409 }
        );
      }
      throw orderErr;
    }

    // 2) 라인아이템 insert
    const itemsToInsert = body.items.map((it, idx) => {
      const clean = normalizeOrderItem(it);
      return {
        order_id: orderRow.id,
        product_id: clean.product_id,
        product_name: clean.product_name,
        option_label: clean.option_label,
        spec: clean.spec,
        qty: clean.qty,
        unit_price: clean.unit_price,
        cost_at_order: clean.cost_at_order,
        tax_type: clean.tax_type,
        sort_order: clean.sort_order || idx,
      };
    });

    const { data: insertedItems, error: itemsErr } = await sb
      .from("order_items")
      .insert(itemsToInsert)
      .select("id, product_name, spec, sort_order");
    if (itemsErr) {
      // 보상: 헤더 롤백
      await sb.from("orders").delete().eq("id", orderRow.id);
      throw itemsErr;
    }

    // 폼 인덱스(sort_order) 순으로 정렬해 매핑 안정화
    const savedItems: SavedOrderItem[] = (insertedItems ?? [])
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((r) => ({ id: r.id, product_name: r.product_name, spec: r.spec }));

    // 3) 발송 일정(분할 발송) + 발송별 상품/수량
    let earliestShipDate: string | null = null;
    let derivedStatus: string | null = null;
    try {
      const res = await saveOrderShipments(orderRow.id, body.recipient, body.shipments, savedItems);
      earliestShipDate = res.earliestShipDate;
      derivedStatus = res.derivedStatus;
    } catch (shipErr) {
      await sb.from("orders").delete().eq("id", orderRow.id);
      throw shipErr;
    }

    // 헤더 동기화: ship_date(가장 이른 일정) + 복수 발송이면 상태 자동 도출
    const headerShipDate = body.ship_date || earliestShipDate;
    const headerPatch: Record<string, unknown> = {};
    if (headerShipDate) headerPatch.ship_date = headerShipDate;
    if (derivedStatus) headerPatch.status = derivedStatus;
    if (Object.keys(headerPatch).length > 0) {
      await sb.from("orders").update(headerPatch).eq("id", orderRow.id);
    }

    // 4) 재조회해서 트리거가 계산한 합계 포함하여 반환
    const { data: refreshed, error: refErr } = await sb
      .from("orders")
      .select("*")
      .eq("id", orderRow.id)
      .single();
    if (refErr) throw refErr;

    // 활동 로그 기록 (fire-and-forget, 실패해도 응답엔 영향 없음)
    await logOrderCreated(orderRow.id);

    return NextResponse.json({ ok: true, order: refreshed });
  } catch (err) {
    console.error("[b2b/orders POST]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "등록 실패") },
      { status: 500 }
    );
  }
}
