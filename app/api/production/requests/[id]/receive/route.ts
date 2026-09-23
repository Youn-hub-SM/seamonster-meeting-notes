import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { loadRequests, formatRequestDetail } from "@/app/lib/wholesale-production-db";
import { logProductionReceipt, logProductionReceiptCancelled } from "@/app/lib/b2b-activity";
import { getRequestFullness, recheckRequestCompletion } from "@/app/lib/production-allocate";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function actor(req: NextRequest): Promise<string | null> {
  const token = req.cookies.get("b2b_auth")?.value;
  return (await verifySession(token)) || resolveUserName(token);
}

// 도매 입고 원장 1건 생성(선택 컬럼 channel/status 미적용 환경이면 빼고 재시도).
async function insertWholesaleReceiptTxn(sb: ReturnType<typeof supabaseAdmin>, row: Record<string, unknown>): Promise<string> {
  const attempt = { ...row };
  let res = await sb.from("inventory_txns").insert(attempt).select("id").single();
  for (let guard = 0; res.error && guard < 2; guard++) {
    const miss = (["channel", "status"] as const).find((c) => c in attempt && new RegExp(c, "i").test(res.error!.message));
    if (!miss) break;
    delete attempt[miss];
    res = await sb.from("inventory_txns").insert(attempt).select("id").single();
  }
  if (res.error) throw res.error;
  return (res.data as { id: string }).id;
}

// POST { item_id, qty, receipt_date?, memo? } — 입고 처리(부분/초과/수정). 도매 입고 원장 생성 + 증거 기록.
export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    const { id: requestId } = await params;
    const b = (await req.json()) as Record<string, unknown>;
    const item_id = String(b.item_id || "");
    const qty = Math.round((Number(b.qty) || 0) * 100) / 100;
    if (!item_id) return NextResponse.json({ ok: false, error: "품목을 선택하세요." }, { status: 400 });
    if (qty === 0) return NextResponse.json({ ok: false, error: "입고 수량을 입력하세요.(초과·수정은 음수도 가능)" }, { status: 400 });

    const sb = supabaseAdmin();
    // 라인이 이 요청서 소속인지 확인 + product_id 확보
    const { data: item, error: ie } = await sb
      .from("production_request_items").select("id, request_id, product_id, products(name)").eq("id", item_id).single();
    if (ie || !item) return NextResponse.json({ ok: false, error: "요청 품목을 찾을 수 없습니다." }, { status: 404 });
    if ((item as { request_id: string }).request_id !== requestId)
      return NextResponse.json({ ok: false, error: "요청서와 품목이 일치하지 않습니다." }, { status: 400 });

    const { data: head } = await sb.from("production_requests").select("req_no, status").eq("id", requestId).single();
    if (!head) return NextResponse.json({ ok: false, error: "요청서를 찾을 수 없습니다." }, { status: 404 });
    const headStatus = (head as { status?: string }).status;
    if (headStatus === "완료" || headStatus === "취소")
      return NextResponse.json({ ok: false, error: `‘${headStatus}’ 상태 요청서에는 입고할 수 없습니다. 먼저 ‘다시 열기’ 하세요.` }, { status: 409 });
    const reqNo = (head as { req_no?: string }).req_no || "";
    const who = await actor(req);
    const receipt_date = DATE_RE.test(String(b.receipt_date || "")) ? String(b.receipt_date) : undefined;
    const userMemo = String(b.memo || "").trim();

    // 1) 도매 입고 원장(증거 대상 재고 반영)
    const txnRow: Record<string, unknown> = {
      product_id: (item as { product_id: string }).product_id,
      type: "입고", channel: "도매", status: "완료", qty,
      memo: `생산요청 ${reqNo}${userMemo ? ` · ${userMemo}` : ""}`.trim(),
      created_by: who,
    };
    if (receipt_date) txnRow.txn_date = receipt_date;
    const invTxnId = await insertWholesaleReceiptTxn(sb, txnRow);

    // 2) 입고 기록(증거) — 원장과 링크
    const receiptRow: Record<string, unknown> = {
      request_id: requestId, item_id, qty, memo: userMemo || null, received_by: who, inv_txn_id: invTxnId,
    };
    if (receipt_date) receiptRow.receipt_date = receipt_date;
    const { error: re } = await sb.from("production_receipts").insert(receiptRow);
    if (re) { await sb.from("inventory_txns").delete().eq("id", invTxnId); throw re; }

    // 입고 알림(품목·수량 + 게시물 본문에 요청서 전체 이행 현황 — 설정 체크리스트 prod_receipt 로 제어)
    const prodRel = (item as { products?: { name?: string } | { name?: string }[] | null }).products;
    const itemName = (Array.isArray(prodRel) ? prodRel[0]?.name : prodRel?.name) || "품목";
    let detailNow: string | undefined;
    try { const [dr] = await loadRequests(sb, { id: requestId }); if (dr) detailNow = formatRequestDetail(dr); } catch { /* 상세 없이 발송 */ }
    await logProductionReceipt(reqNo, itemName, qty, who, detailNow);

    // 3) 상태 전환은 recheckRequestCompletion 한 곳에서 — 요청→진행중(부분) 또는 →완료(전 품목 100%↑). 전환·알림 중복 방지.
    await sb.from("production_requests").update({ updated_at: new Date().toISOString() }).eq("id", requestId);
    try { await recheckRequestCompletion(sb, [requestId], "입고 처리"); } catch { /* 자동 마감 실패는 입고를 막지 않는다 */ }

    const [row] = await loadRequests(sb, { id: requestId });
    return NextResponse.json({ ok: true, request: row });
  } catch (err) {
    console.error("[production/requests receive POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "입고 처리 실패") }, { status: 500 });
  }
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
      return NextResponse.json({ ok: false, error: "입고 화면에서 기록한 입고입니다 — 입고 및 출고(또는 재고 옮기기)에서 그 기록을 취소하면 연결도 함께 원복됩니다." }, { status: 409 });

    // 원자적 취소: receipt + 연결 도매 입고 원장을 한 트랜잭션에서 삭제(재고 원복).
    //  취소 전 100% 완료였던 요청서만 재개 대상(수동 마감 보존).
    const fullBefore = await getRequestFullness(sb, requestId);
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
