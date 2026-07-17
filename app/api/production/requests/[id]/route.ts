import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { loadRequests } from "@/app/lib/wholesale-production-db";
import { PR_STATUSES, type PrStatus } from "@/app/lib/wholesale-production";
import { logProductionRequestStatusChanged } from "@/app/lib/b2b-activity";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";

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

// PATCH { status?, title?, requested_by?, request_date?, due_date?, memo?, items? } — 헤더·품목 수정(상태 변경 포함)
//  items: [{ id?, product_id, requested_qty, memo? }] — 전체 교체 방식.
//  단, 입고 기록이 있는 품목은 뺄 수 없다(items FK cascade 가 입고 증거까지 지워 재고 정합이 깨짐).
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
    if (b.due_date !== undefined) {
      // 생산마감일은 필수(일정·보드가 마감일 기준) — 빈값·형식 오류는 거부, 해제 불가.
      if (!DATE_RE.test(String(b.due_date))) return NextResponse.json({ ok: false, error: "생산마감일을 입력하세요." }, { status: 400 });
      patch.due_date = String(b.due_date);
    }

    const sb = supabaseAdmin();

    // 품목 교체 준비 — 헤더 갱신 전에 검증까지 끝낸다(절반만 반영되는 것 방지).
    type ItemIn = { id?: string; product_id: string; requested_qty: number; memo?: string };
    let itemsIn: ItemIn[] | null = null;
    let toDelete: string[] = [];
    let curItemIds = new Set<string>();
    if (b.items !== undefined) {
      if (!Array.isArray(b.items)) return NextResponse.json({ ok: false, error: "items 형식이 올바르지 않습니다." }, { status: 400 });
      itemsIn = (b.items as ItemIn[])
        .map((it) => ({ id: it.id ? String(it.id) : undefined, product_id: String(it.product_id || ""), requested_qty: Math.round(Number(it.requested_qty) || 0), memo: String(it.memo || "").trim() || undefined }))
        .filter((it) => it.product_id && it.requested_qty > 0);
      if (itemsIn.length === 0) return NextResponse.json({ ok: false, error: "요청 수량이 있는 품목이 최소 1개 필요합니다." }, { status: 400 });

      const { data: curItems, error: ciErr } = await sb.from("production_request_items").select("id").eq("request_id", id);
      if (ciErr) throw ciErr;
      curItemIds = new Set((curItems ?? []).map((i) => i.id as string));
      const keepIds = new Set(itemsIn.filter((it) => it.id && curItemIds.has(it.id)).map((it) => it.id!));
      toDelete = [...curItemIds].filter((iid) => !keepIds.has(iid));
      if (toDelete.length > 0) {
        const { data: rc, error: rcErr } = await sb.from("production_receipts").select("item_id").in("item_id", toDelete).limit(1);
        if (rcErr) throw rcErr;
        if ((rc ?? []).length > 0) {
          return NextResponse.json({ ok: false, error: "입고 기록이 있는 품목은 뺄 수 없습니다. 해당 품목의 입고를 먼저 취소하세요." }, { status: 400 });
        }
      }
    }

    // 상태 변경이면 이전 상태·요청번호 확보(변경기록 + 알림용)
    let prevStatus: string | null = null, reqNo = "";
    if (patch.status !== undefined) {
      const { data: cur } = await sb.from("production_requests").select("status, req_no").eq("id", id).single();
      prevStatus = (cur as { status?: string } | null)?.status ?? null;
      reqNo = (cur as { req_no?: string } | null)?.req_no ?? "";
    }
    let { error } = await sb.from("production_requests").update(patch).eq("id", id);
    if (error && "due_date" in patch && /due_date/i.test(error.message)) {
      delete patch.due_date; // 071 미적용 환경 폴백
      ({ error } = await sb.from("production_requests").update(patch).eq("id", id));
    }
    if (error) throw error;

    // 품목 교체 실행 — 수정 → 추가 → 삭제 순(검증은 위에서 완료)
    if (itemsIn) {
      let sort = 0;
      for (const it of itemsIn) {
        if (it.id && curItemIds.has(it.id)) {
          const { error: ue } = await sb.from("production_request_items").update({ requested_qty: it.requested_qty, memo: it.memo ?? null, sort }).eq("id", it.id).eq("request_id", id);
          if (ue) throw ue;
        } else {
          const { error: ie } = await sb.from("production_request_items").insert({ request_id: id, product_id: it.product_id, requested_qty: it.requested_qty, memo: it.memo ?? null, sort });
          if (ie) throw ie;
        }
        sort++;
      }
      if (toDelete.length > 0) {
        const { error: de } = await sb.from("production_request_items").delete().in("id", toDelete);
        if (de) throw de;
      }
    }
    // 상태 변경 → 변경기록(+진행중/완료면 Flow 알림). 작업자(누가 바꿨는지)를 함께 전달.
    if (patch.status !== undefined && prevStatus && prevStatus !== patch.status) {
      const token = req.cookies.get("b2b_auth")?.value;
      const who = (await verifySession(token)) || resolveUserName(token);
      await logProductionRequestStatusChanged(reqNo, prevStatus, String(patch.status), who);
    }
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
