import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { PaymentInput } from "@/app/lib/b2b-orders";

export const dynamic = "force-dynamic";

// ─────────────────────────────────────────────
// GET /api/b2b/payments?order_id=...
//   order_id 지정: 그 발주의 입금 내역만
//   미지정: 모든 입금 내역 (최근 100건)
// ─────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const orderId = url.searchParams.get("order_id");
    const sb = supabaseAdmin();
    let q = sb.from("payments").select("*").order("paid_at", { ascending: false }).order("created_at", { ascending: false });
    if (orderId) q = q.eq("order_id", orderId);
    else q = q.limit(100);
    const { data, error } = await q;
    if (error) throw error;
    return NextResponse.json({ ok: true, payments: data ?? [] });
  } catch (err) {
    console.error("[b2b/payments GET]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "조회 실패") },
      { status: 500 }
    );
  }
}

// ─────────────────────────────────────────────
// POST /api/b2b/payments
// ─────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as PaymentInput;
    if (!body.order_id) {
      return NextResponse.json({ ok: false, error: "order_id 필수" }, { status: 400 });
    }
    const amount = Number(body.amount) || 0;
    if (amount <= 0) {
      return NextResponse.json({ ok: false, error: "금액은 0보다 커야 합니다." }, { status: 400 });
    }
    if (!body.paid_at) {
      return NextResponse.json({ ok: false, error: "입금일 필수" }, { status: 400 });
    }
    const sb = supabaseAdmin();
    const clean = (v: string): string | null => {
      const t = (v ?? "").trim();
      return t === "" ? null : t;
    };
    const { data, error } = await sb
      .from("payments")
      .insert({
        order_id: body.order_id,
        amount,
        paid_at: body.paid_at,
        method: clean(body.method),
        reference: clean(body.reference),
        notes: clean(body.notes),
      })
      .select()
      .single();
    if (error) throw error;
    return NextResponse.json({ ok: true, payment: data });
  } catch (err) {
    console.error("[b2b/payments POST]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "등록 실패") },
      { status: 500 }
    );
  }
}

// ─────────────────────────────────────────────
// DELETE /api/b2b/payments?id=...
// ─────────────────────────────────────────────
export async function DELETE(req: NextRequest) {
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) {
      return NextResponse.json({ ok: false, error: "id 필수" }, { status: 400 });
    }
    const sb = supabaseAdmin();
    const { error } = await sb.from("payments").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[b2b/payments DELETE]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "삭제 실패") },
      { status: 500 }
    );
  }
}
