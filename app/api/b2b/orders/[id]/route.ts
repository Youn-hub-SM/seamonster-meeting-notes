import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import {
  OrderInput,
  normalizeOrderItem,
  validateOrder,
} from "@/app/lib/b2b-orders";
import { saveOrderShipments, SavedOrderItem } from "@/app/lib/b2b-shipments";
import {
  logOrderStatusChanged,
  logOrderPaymentStatusChanged,
  logOrderTaxInvoiceChanged,
} from "@/app/lib/b2b-activity";

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

    // 0) 변경 전 상태 캡처 (활동 로그용)
    const { data: prevOrder } = await sb
      .from("orders")
      .select("status, payment_status, tax_invoice_status")
      .eq("id", id)
      .single();
    const prevStatus = prevOrder?.status as string | undefined;
    const prevPayment = prevOrder?.payment_status as string | undefined;
    const prevTaxInvoice = prevOrder?.tax_invoice_status as string | undefined;

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
        box_count: Math.max(1, Math.floor(Number(body.box_count) || 1)),
        tracking_no: body.tracking_no?.trim() || null,
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
    const { data: insertedItems, error: insErr } = await sb
      .from("order_items")
      .insert(itemsToInsert)
      .select("id, product_name, spec, sort_order");
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

    const savedItems: SavedOrderItem[] = (insertedItems ?? [])
      .slice()
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .map((r) => ({ id: r.id, product_name: r.product_name, spec: r.spec }));

    // 4) 발송 일정(분할 발송) 전체 교체 + 발송별 상품/수량
    const { earliestShipDate } = await saveOrderShipments(id, body.recipient, body.shipments, savedItems);
    const headerShipDate = body.ship_date || earliestShipDate;
    await sb.from("orders").update({ ship_date: headerShipDate || null }).eq("id", id);

    // 5) 갱신된 헤더(트리거가 합계 재계산함) 재조회
    const { data: refreshed, error: refErr } = await sb
      .from("orders")
      .select("*")
      .eq("id", id)
      .single();
    if (refErr) throw refErr;

    // 활동 로그 — 상태/입금상태/세금계산서 변경 시
    if (prevStatus && prevStatus !== body.status) {
      await logOrderStatusChanged(id, prevStatus, body.status);
    }
    if (prevPayment && prevPayment !== body.payment_status) {
      await logOrderPaymentStatusChanged(id, prevPayment, body.payment_status);
    }
    if (prevTaxInvoice && prevTaxInvoice !== body.tax_invoice_status) {
      await logOrderTaxInvoiceChanged(id, prevTaxInvoice, body.tax_invoice_status);
    }

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
      tracking_no: string | null;
    }>;

    const sb = supabaseAdmin();
    // 변경 전 상태 캡처 (활동 로그용 + 송장번호 확인)
    const { data: prev } = await sb
      .from("orders")
      .select("status, payment_status, tax_invoice_status, tracking_no")
      .eq("id", id)
      .single();

    const patch: Record<string, unknown> = {};
    if (body.status !== undefined) patch.status = body.status;
    if (body.payment_status !== undefined) patch.payment_status = body.payment_status;
    if (body.tax_invoice_status !== undefined) patch.tax_invoice_status = body.tax_invoice_status;
    if (body.production_date !== undefined) patch.production_date = body.production_date || null;
    if (body.ship_date !== undefined) patch.ship_date = body.ship_date || null;
    if (body.tracking_no !== undefined) patch.tracking_no = (body.tracking_no || "").trim() || null;
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ ok: false, error: "변경할 필드가 없습니다." }, { status: 400 });
    }

    // 발송완료로 바꾸려면 송장번호 필수 (이번 요청 또는 기존 값)
    if (body.status === "발송완료") {
      const trackingNo = (body.tracking_no ?? prev?.tracking_no ?? "").toString().trim();
      if (!trackingNo) {
        return NextResponse.json(
          { ok: false, error: "발송완료로 변경하려면 송장번호가 필요합니다." },
          { status: 400 }
        );
      }
    }

    const { data, error } = await sb.from("orders").update(patch).eq("id", id).select().single();
    if (error) throw error;

    // 발주를 발송완료로 바꾸면 미발송 발송 일정도 발송완료로 동기화
    // (캘린더·주간뷰가 일정 상태를 표시하므로 어긋나면 영구 '발송대기'로 보임)
    if (body.status === "발송완료") {
      await sb
        .from("shipments")
        .update({ status: "발송완료", shipped_at: new Date().toISOString() })
        .eq("order_id", id)
        .in("status", ["발송대기", "발송중"]);
    }

    // 활동 로그
    if (body.status && prev?.status && prev.status !== body.status) {
      await logOrderStatusChanged(id, prev.status, body.status);
    }
    if (body.payment_status && prev?.payment_status && prev.payment_status !== body.payment_status) {
      await logOrderPaymentStatusChanged(id, prev.payment_status, body.payment_status);
    }
    if (body.tax_invoice_status && prev?.tax_invoice_status && prev.tax_invoice_status !== body.tax_invoice_status) {
      await logOrderTaxInvoiceChanged(id, prev.tax_invoice_status, body.tax_invoice_status);
    }

    return NextResponse.json({ ok: true, order: data });
  } catch (err) {
    console.error("[b2b/orders PATCH]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "수정 실패") },
      { status: 500 }
    );
  }
}
