import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { loadRequests } from "@/app/lib/wholesale-production-db";
import { logProductionRequestCreated } from "@/app/lib/b2b-activity";
import { addBusinessDays } from "@/app/lib/business-days";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function actor(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get("b2b_auth")?.value;
  return (await verifySession(token)) || resolveUserName(token);
}

// GET ?status= — 도매 재고 생산 요청 목록(+품목·입고집계)
export async function GET(req: NextRequest) {
  try {
    const status = req.nextUrl.searchParams.get("status") || undefined;
    const rows = await loadRequests(supabaseAdmin(), { status });
    return NextResponse.json({ ok: true, requests: rows });
  } catch (err) {
    console.error("[production/requests GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// POST { title?, requested_by?, request_date?, memo?, items:[{product_id, requested_qty, memo?}] } — 요청서 생성
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as Record<string, unknown>;
    const rawItems = Array.isArray(b.items) ? (b.items as Record<string, unknown>[]) : [];
    const items = rawItems
      .map((it) => ({ product_id: String(it.product_id || ""), requested_qty: Math.round(Number(it.requested_qty) || 0), memo: String(it.memo || "").trim() || null }))
      .filter((it) => it.product_id && it.requested_qty > 0);
    if (!items.length) return NextResponse.json({ ok: false, error: "요청 품목과 수량을 1개 이상 입력하세요." }, { status: 400 });

    const sb = supabaseAdmin();
    const who = await actor(req);

    // 묶음(세트) 품목은 자체 재고가 없어(구성품 기준 도출) 도매 입고 대상이 아님 → 거부.
    const pids = [...new Set(items.map((it) => it.product_id))];
    const { data: bundles, error: be } = await sb.from("product_bundles").select("parent_id").in("parent_id", pids);
    if (!be && (bundles ?? []).length)
      return NextResponse.json({ ok: false, error: "묶음(세트) 품목은 생산 요청에 담을 수 없습니다. 구성품(단품)으로 요청하세요." }, { status: 400 });

    // 요청번호(PR-000001)
    let req_no: string | null = null;
    try { const { data } = await sb.rpc("next_production_request_no"); if (data) req_no = String(data); } catch { /* 069 미적용 */ }

    const request_date = DATE_RE.test(String(b.request_date || "")) ? String(b.request_date) : undefined;
    // 생산마감일은 필수 — 안 오거나 형식이 틀리면 요청일+7영업일로 서버가 채운다(일정·보드가 마감일 기준이라 비면 안 됨).
    const due_date = DATE_RE.test(String(b.due_date || ""))
      ? String(b.due_date)
      : addBusinessDays(request_date || new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10), 7);
    const head: Record<string, unknown> = {
      req_no,
      title: String(b.title || "").trim() || null,
      requested_by: String(b.requested_by || "").trim() || who,
      status: "요청",
      memo: String(b.memo || "").trim() || null,
      created_by: who,
    };
    if (request_date) head.request_date = request_date;
    if (due_date) head.due_date = due_date; // 생산마감일(071). 미적용 환경이면 아래에서 컬럼만 빼고 재시도.

    let { data: reqRow, error: he } = await sb.from("production_requests").insert(head).select("id").single();
    if (he && /due_date/i.test(he.message)) { delete head.due_date; ({ data: reqRow, error: he } = await sb.from("production_requests").insert(head).select("id").single()); }
    if (he) throw he;
    const requestId = (reqRow as { id: string }).id;

    const itemRows = items.map((it, i) => ({ request_id: requestId, product_id: it.product_id, requested_qty: it.requested_qty, memo: it.memo, sort: i }));
    const { error: ie } = await sb.from("production_request_items").insert(itemRows);
    if (ie) { await sb.from("production_requests").delete().eq("id", requestId); throw ie; }

    const [full] = await loadRequests(sb, { id: requestId });
    // 작성 알림(변경기록 + Flow 봇)
    if (full) {
      const label = full.title || `품목 ${full.items.length}종 · ${full.total_requested.toLocaleString()}개`;
      await logProductionRequestCreated(full.req_no || "", label, who);
    }
    return NextResponse.json({ ok: true, request: full });
  } catch (err) {
    console.error("[production/requests POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "요청서 생성 실패") }, { status: 500 });
  }
}
