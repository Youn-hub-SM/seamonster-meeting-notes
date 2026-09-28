import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { loadRequests, formatRequestDetail } from "@/app/lib/wholesale-production-db";
import { logProductionReceiptCancelled } from "@/app/lib/b2b-activity";
import { getRequestFullness, recheckRequestCompletion } from "@/app/lib/production-allocate";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

async function actor(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get("b2b_auth")?.value;
  return (await verifySession(token)) || resolveUserName(token);
}

// POST — 요청서 화면 직접 입고는 폐지(2026-09-23 지정 매칭). 용도와 무관하게 '도매' 칸에 입고 원장을 만들어
//  규칙 1(입고는 소매로만)과 /api/inventory/txn 의 채널 차단을 우회하던 경로. UI 호출부는 없고, 구화면 캐시·직접 호출만 410 으로 안내.
//  DELETE 는 그대로 — 예전 직접 입고 이력의 취소는 계속 되어야 한다.
export async function POST() {
  return NextResponse.json({ ok: false, error: "요청서 화면 직접 입고는 폐지되었습니다 — 입고 및 출고(또는 재고 목록 입출조정)에서 입고하고 요청서를 지정하세요." }, { status: 410 });
}

// DELETE ?rid= — 입고 취소(입고 기록 + 연결된 도매 입고 원장 삭제 = 재고 원복)
export async function DELETE(req: NextRequest, { params }: Ctx) {
  try {
    const { id: requestId } = await params;
    const rid = req.nextUrl.searchParams.get("rid");
    if (!rid) return NextResponse.json({ ok: false, error: "입고 id 가 필요합니다." }, { status: 400 });
    const sb = supabaseAdmin();
    const { data: rc, error: fe } = await sb.from("production_receipts").select("id, request_id, qty, memo, production_request_items(products(name))").eq("id", rid).single();
    if (fe || !rc) return NextResponse.json({ ok: false, error: "입고 기록을 찾을 수 없습니다." }, { status: 404 });
    if ((rc as { request_id: string }).request_id !== requestId)
      return NextResponse.json({ ok: false, error: "요청서와 입고가 일치하지 않습니다." }, { status: 400 });
    // 링크형 입고(이전 연동·기간 자동 매칭)의 원장은 다른 화면 소유 — 여기서 취소하면
    //  실제 재고 원장까지 지워진다(cancel_production_receipt 가 원장을 삭제). UI 는 버튼을 숨기지만
    //  구화면 캐시·직접 호출 대비 서버에서도 거절한다.
    if (/기간 자동 매칭|이전 연동|이전 배정|입고 연결|입고\/출고 연동/.test(String((rc as { memo?: string | null }).memo || "")))
      return NextResponse.json({ ok: false, error: "입고 화면에서 기록한 입고입니다 — 입고 및 출고(또는 재고 이동)에서 그 기록을 취소하면 연결도 함께 원복됩니다." }, { status: 409 });

    // 원자적 취소: receipt + 연결 도매 입고 원장을 한 트랜잭션에서 삭제(재고 원복).
    //  취소 전 100% 완료였던 요청서만 재개 대상(수동 마감 보존).
    const fullBefore = await getRequestFullness(sb, requestId);
    if (!fullBefore) return NextResponse.json({ ok: false, error: "취소 준비 조회에 실패했습니다 — 다시 시도하세요." }, { status: 500 });
    const { error: ce } = await sb.rpc("cancel_production_receipt", { p_receipt_id: rid });
    if (ce) throw ce;
    if (fullBefore?.full && fullBefore.status === "완료") { try { await recheckRequestCompletion(sb, [requestId], "입고 취소", "reopen"); } catch { /* 재개 실패는 취소를 막지 않는다 */ } }

    // 입고 취소 알림(설정 체크리스트 prod_receipt_cancel 로 제어)
    try {
      const { data: head } = await sb.from("production_requests").select("req_no").eq("id", requestId).maybeSingle();
      type RcRel = { qty?: number; production_request_items?: { products?: { name?: string } | { name?: string }[] | null } | { products?: { name?: string } | { name?: string }[] | null }[] | null };
      const rel = (rc as RcRel).production_request_items;
      const item0 = Array.isArray(rel) ? rel[0] : rel;
      const pr = item0?.products;
      const itemName = (Array.isArray(pr) ? pr[0]?.name : pr?.name) || "품목";
      let detailNow: string | undefined; // 취소 후 이행 현황을 게시물 본문에
      try { const [dr] = await loadRequests(sb, { id: requestId }); if (dr) detailNow = formatRequestDetail(dr); } catch { /* 상세 없이 발송 */ }
      await logProductionReceiptCancelled((head as { req_no?: string } | null)?.req_no || "", itemName, Number((rc as RcRel).qty) || 0, await actor(req), detailNow);
    } catch { /* 알림 실패 무시 */ }

    const [row] = await loadRequests(sb, { id: requestId });
    return NextResponse.json({ ok: true, request: row });
  } catch (err) {
    console.error("[production/requests receive DELETE]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "입고 취소 실패") }, { status: 500 });
  }
}
