import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import {
  OrderInput,
  normalizeOrderItem,
  normalizeShipment,
  validateOrder,
} from "@/app/lib/b2b-orders";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

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
      sb.from("order_items").select("*").eq("order_id", id).order("sort_order", { ascending: true }),
      sb.from("shipments").select("*").eq("order_id", id).order("created_at", { ascending: true }),
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
// PUT /api/b2b/orders/[id] — 헤더 갱신 + 라인아이템 전체 교체
// ─────────────────────────────────────────────
export async function PUT(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const body = (await req.json()) as OrderInput;
    const validationError = validateOrder(body);
    if (validationError) {
      return NextResponse.json({ ok: false, error: validationError }, { status: 400 });
    }

    const sb = supabaseAdmin();

    // 1) 헤더 update
    const { error: orderErr } = await sb
      .from("orders")
      .update({
        company_id: body.company_id,
        order_date: body.order_date,
        production_date: body.production_date || null,
        ship_date: body.ship_date || null,
        status: body.status,
        payment_status: body.payment_status,
        tax_invoice_status: body.tax_invoice_status,
        notes: body.notes?.trim() || null,
      })
      .eq("id", id);
    if (orderErr) throw orderErr;

    // 2) 기존 라인아이템 스냅샷 (롤백용)
    const { data: existingItems, error: snapErr } = await sb
      .from("order_items")
      .select("*")
      .eq("order_id", id);
    if (snapErr) throw snapErr;

    // 3) 라인아이템 전체 교체 (delete-then-insert)
    //    line_total 은 generated column 이라 직접 insert 불가 — payload 에서 제외 필수.
    const { error: delErr } = await sb.from("order_items").delete().eq("order_id", id);
    if (delErr) throw delErr;

    const itemsToInsert = body.items.map((it, idx) => {
      const clean = normalizeOrderItem(it);
      return {
        order_id: id,
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
    const { error: insErr } = await sb.from("order_items").insert(itemsToInsert);
    if (insErr) {
      // 보상: 기존 라인아이템 복구 시도
      if (existingItems && existingItems.length > 0) {
        const restoreRows = existingItems.map((it) => {
          const { line_total: _ignored, created_at: _c, id: _i, ...rest } = it;
          return rest;
        });
        await sb.from("order_items").insert(restoreRows);
      }
      throw insErr;
    }

    // 4) 송장 정보 — 기존 전체 삭제 후 재삽입 (한 발주 = 한 송장 기본)
    if (body.shipment) {
      const ship = normalizeShipment(body.shipment);
      await sb.from("shipments").delete().eq("order_id", id);
      if (ship.recipient_name || ship.address) {
        const { error: shipErr } = await sb.from("shipments").insert({
          order_id: id,
          recipient_name: ship.recipient_name || "(미지정)",
          recipient_phone: ship.recipient_phone || "",
          address: ship.address || "(주소 미입력)",
          delivery_memo: ship.delivery_memo,
          courier: ship.courier,
          tracking_no: ship.tracking_no,
        });
        if (shipErr) throw shipErr;
      }
    }

    // 5) 갱신된 헤더(트리거가 합계 재계산함) 재조회
    const { data: refreshed, error: refErr } = await sb
      .from("orders")
      .select("*")
      .eq("id", id)
      .single();
    if (refErr) throw refErr;

    return NextResponse.json({ ok: true, order: refreshed });
  } catch (err) {
    console.error("[b2b/orders PUT]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "수정 실패") },
      { status: 500 }
    );
  }
}

// ─────────────────────────────────────────────
// DELETE /api/b2b/orders/[id]
// ─────────────────────────────────────────────
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const sb = supabaseAdmin();
    // order_items, shipments 는 ON DELETE CASCADE 로 같이 삭제됨
    const { error } = await sb.from("orders").delete().eq("id", id);
    if (error) throw error;
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
// ─────────────────────────────────────────────
export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const body = (await req.json()) as Partial<{
      status: string;
      payment_status: string;
      tax_invoice_status: string;
      production_date: string | null;
      ship_date: string | null;
    }>;

    const patch: Record<string, unknown> = {};
    if (body.status !== undefined) patch.status = body.status;
    if (body.payment_status !== undefined) patch.payment_status = body.payment_status;
    if (body.tax_invoice_status !== undefined) patch.tax_invoice_status = body.tax_invoice_status;
    if (body.production_date !== undefined) patch.production_date = body.production_date || null;
    if (body.ship_date !== undefined) patch.ship_date = body.ship_date || null;
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ ok: false, error: "변경할 필드가 없습니다." }, { status: 400 });
    }

    const sb = supabaseAdmin();
    const { data, error } = await sb.from("orders").update(patch).eq("id", id).select().single();
    if (error) throw error;
    return NextResponse.json({ ok: true, order: data });
  } catch (err) {
    console.error("[b2b/orders PATCH]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "수정 실패") },
      { status: 500 }
    );
  }
}
