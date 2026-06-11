import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { deriveParentStatus } from "@/app/lib/b2b-shipments";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// PATCH /api/b2b/shipments/[id] — 발송 차수(하위) 상태/송장번호 변경
//   body: { status?, tracking_no? }
//   발송완료로 바꾸려면 송장번호 필수. 변경 후 상위발주 상태를 하위 차수들로부터 재도출.
export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const body = (await req.json()) as { status?: string; tracking_no?: string };

    const sb = supabaseAdmin();
    const { data: ship, error: getErr } = await sb
      .from("shipments")
      .select("id, order_id, status, tracking_no")
      .eq("id", id)
      .single();
    if (getErr || !ship) {
      return NextResponse.json({ ok: false, error: "발송 일정을 찾을 수 없습니다." }, { status: 404 });
    }

    const newStatus = body.status ?? ship.status;
    const trackingNo =
      body.tracking_no !== undefined
        ? (body.tracking_no || "").trim()
        : (ship.tracking_no ?? "").toString().trim();

    if (newStatus === "발송완료" && !trackingNo) {
      return NextResponse.json(
        { ok: false, error: "발송완료로 변경하려면 송장번호가 필요합니다." },
        { status: 400 }
      );
    }

    const patch: Record<string, unknown> = {};
    if (body.status !== undefined) patch.status = body.status;
    if (body.tracking_no !== undefined) patch.tracking_no = (body.tracking_no || "").trim() || null;
    patch.shipped_at = newStatus === "발송완료" ? new Date().toISOString() : null;

    const { error: upErr } = await sb.from("shipments").update(patch).eq("id", id);
    if (upErr) throw upErr;

    // 상위발주 상태 재도출 (복수 발송이면)
    const { data: ships } = await sb.from("shipments").select("status").eq("order_id", ship.order_id);
    const derived = deriveParentStatus((ships ?? []).map((s) => s.status as string));
    if (derived) {
      await sb.from("orders").update({ status: derived }).eq("id", ship.order_id);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[b2b/shipments PATCH]", err);
    return NextResponse.json(
      { ok: false, error: extractErrorMsg(err, "변경 실패") },
      { status: 500 }
    );
  }
}
