import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { loadRequests } from "@/app/lib/wholesale-production-db";
import { PR_STATUSES, type PrStatus } from "@/app/lib/wholesale-production";
import { logProductionRequestStatusChanged } from "@/app/lib/b2b-activity";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET — 요청서 단건(품목·입고 이력 포함)
export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const [row] = await loadRequests(supabaseAdmin(), { id });
    if (!row) return NextResponse.json({ ok: false, error: "요청서를 찾을 수 없습니다." }, { status: 404 });
    return NextResponse.json({ ok: true, request: row });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// PATCH { status?, title?, requested_by?, request_date?, memo? } — 헤더 수정(상태 변경 포함)
export async function PATCH(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const b = (await req.json()) as Record<string, unknown>;
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (b.status !== undefined) {
      const s = String(b.status) as PrStatus;
      if (!PR_STATUSES.includes(s)) return NextResponse.json({ ok: false, error: "상태값이 올바르지 않습니다." }, { status: 400 });
      patch.status = s;
    }
    if (b.title !== undefined) patch.title = String(b.title || "").trim() || null;
    if (b.requested_by !== undefined) patch.requested_by = String(b.requested_by || "").trim() || null;
    if (b.assignee !== undefined) patch.assignee = String(b.assignee || "").trim() || null;
    if (b.memo !== undefined) patch.memo = String(b.memo || "").trim() || null;
    if (b.request_date !== undefined && DATE_RE.test(String(b.request_date))) patch.request_date = String(b.request_date);

    const sb = supabaseAdmin();
    // 상태 변경이면 이전 상태·요청번호 확보(변경기록 + 알림용)
    let prevStatus: string | null = null, reqNo = "";
    if (patch.status !== undefined) {
      const { data: cur } = await sb.from("production_requests").select("status, req_no").eq("id", id).single();
      prevStatus = (cur as { status?: string } | null)?.status ?? null;
      reqNo = (cur as { req_no?: string } | null)?.req_no ?? "";
    }
    const { error } = await sb.from("production_requests").update(patch).eq("id", id);
    if (error) throw error;
    // 상태 변경 → 변경기록(+진행중/완료면 Flow 알림)
    if (patch.status !== undefined && prevStatus && prevStatus !== patch.status)
      await logProductionRequestStatusChanged(reqNo, prevStatus, String(patch.status));
    const [row] = await loadRequests(sb, { id });
    return NextResponse.json({ ok: true, request: row });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "수정 실패") }, { status: 500 });
  }
}

// DELETE — 요청서 삭제. 입고 기록이 있으면 거부(재고 정합성 보호) → '취소'로 기록 보존.
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const sb = supabaseAdmin();
    const { count, error: ce } = await sb.from("production_receipts").select("id", { count: "exact", head: true }).eq("request_id", id);
    if (ce) throw ce;
    if ((count ?? 0) > 0) return NextResponse.json({ ok: false, error: "입고 기록이 있어 삭제할 수 없습니다. 입고를 먼저 취소하거나 요청서를 '취소' 처리하세요." }, { status: 400 });
    const { error } = await sb.from("production_requests").delete().eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "삭제 실패") }, { status: 500 });
  }
}
