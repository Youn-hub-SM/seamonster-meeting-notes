import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import {
  OrderInput,
  OrderListItem,
  normalizeOrderItem,
  normalizeShipment,
  validateOrder,
} from "@/app/lib/b2b-orders";

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
        "*, companies:company_id(name), order_items(id)"
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

    // 평탄화: companies.name → company_name, order_items[] → item_count
    type Row = Record<string, unknown> & {
      companies?: { name?: string } | null;
      order_items?: { id: string }[];
    };
    const orders: OrderListItem[] = (data as Row[] | null ?? []).map((r) => {
      const { companies, order_items, ...rest } = r;
      return {
        ...(rest as unknown as OrderListItem),
        company_name: companies?.name ?? "(미지정)",
        item_count: Array.isArray(order_items) ? order_items.length : 0,
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
      })
      .select()
      .single();
    if (orderErr) throw orderErr;

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

    const { error: itemsErr } = await sb.from("order_items").insert(itemsToInsert);
    if (itemsErr) {
      // 보상: 헤더 롤백
      await sb.from("orders").delete().eq("id", orderRow.id);
      throw itemsErr;
    }

    // 3) 송장 정보 — recipient_name 과 address 중 하나라도 채워져 있으면 row 생성
    if (body.shipment) {
      const ship = normalizeShipment(body.shipment);
      if (ship.recipient_name || ship.address) {
        const { error: shipErr } = await sb.from("shipments").insert({
          order_id: orderRow.id,
          recipient_name: ship.recipient_name || "(미지정)",
          recipient_phone: ship.recipient_phone || "",
          address: ship.address || "(주소 미입력)",
          delivery_memo: ship.delivery_memo,
          courier: ship.courier,
          tracking_no: ship.tracking_no,
        });
        if (shipErr) {
          await sb.from("orders").delete().eq("id", orderRow.id);
          throw shipErr;
        }
      }
    }

    // 4) 재조회해서 트리거가 계산한 합계 포함하여 반환
    const { data: refreshed, error: refErr } = await sb
      .from("orders")
      .select("*")
      .eq("id", orderRow.id)
      .single();
    if (refErr) throw refErr;

    return NextResponse.json({ ok: true, order: refreshed });
  } catch (err) {
    console.error("[b2b/orders POST]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "등록 실패") },
      { status: 500 }
    );
  }
}
