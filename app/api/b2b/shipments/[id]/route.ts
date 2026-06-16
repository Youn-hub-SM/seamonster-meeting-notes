import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { deriveParentStatus } from "@/app/lib/b2b-shipments";
import { logShipmentStatusChanged } from "@/app/lib/b2b-activity";

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
      .select("id, order_id, seq, status, tracking_no, box_count")
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

    // 박스 수만큼 송장번호 필요 (콤마 구분, 박스당 1개)
    if (newStatus === "발송완료") {
      const boxCount = Math.max(1, Number(ship.box_count) || 1);
      const parts = trackingNo.split(",").map((s: string) => s.trim()).filter(Boolean);
      if (parts.length === 0) {
        return NextResponse.json(
          { ok: false, error: "발송완료로 변경하려면 송장번호가 필요합니다." },
          { status: 400 }
        );
      }
      if (parts.length < boxCount) {
        return NextResponse.json(
          { ok: false, error: `${boxCount}박스 — 박스별 송장번호 ${boxCount}개가 필요합니다 (${parts.length}개 입력됨).` },
          { status: 400 }
        );
      }
    }

    const patch: Record<string, unknown> = {};
    if (body.status !== undefined) patch.status = body.status;
    if (body.tracking_no !== undefined) patch.tracking_no = (body.tracking_no || "").trim() || null;
    patch.shipped_at = newStatus === "발송완료" ? new Date().toISOString() : null;

    const { error: upErr } = await sb.from("shipments").update(patch).eq("id", id);
    if (upErr) throw upErr;

    // 차수 상태 변경 이력 기록 (히스토리)
    if (body.status !== undefined && newStatus !== ship.status) {
      await logShipmentStatusChanged(ship.order_id as string, Number(ship.seq) || 1, ship.status as string, newStatus);
    }

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
