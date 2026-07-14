import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { loadRequests } from "@/app/lib/wholesale-production-db";
import { logProductionRequestStatusChanged } from "@/app/lib/b2b-activity";

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
    const qty = Math.round(Number(b.qty) || 0);
    if (!item_id) return NextResponse.json({ ok: false, error: "품목을 선택하세요." }, { status: 400 });
    if (qty === 0) return NextResponse.json({ ok: false, error: "입고 수량을 입력하세요.(초과·수정은 음수도 가능)" }, { status: 400 });

    const sb = supabaseAdmin();
    // 라인이 이 요청서 소속인지 확인 + product_id 확보
    const { data: item, error: ie } = await sb
      .from("production_request_items").select("id, request_id, product_id").eq("id", item_id).single();
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

    // 3) 상태: 요청 → 진행중 (첫 입고 = 생산 시작 알림 + 변경기록)
    if ((head as { status?: string } | null)?.status === "요청") {
      await sb.from("production_requests").update({ status: "진행중", updated_at: new Date().toISOString() }).eq("id", requestId);
      await logProductionRequestStatusChanged(reqNo, "요청", "진행중", who);
    } else {
      await sb.from("production_requests").update({ updated_at: new Date().toISOString() }).eq("id", requestId);
    }

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
    const { data: rc, error: fe } = await sb.from("production_receipts").select("id, request_id").eq("id", rid).single();
    if (fe || !rc) return NextResponse.json({ ok: false, error: "입고 기록을 찾을 수 없습니다." }, { status: 404 });
    if ((rc as { request_id: string }).request_id !== requestId)
      return NextResponse.json({ ok: false, error: "요청서와 입고가 일치하지 않습니다." }, { status: 400 });

    // 원자적 취소: receipt + 연결 도매 입고 원장을 한 트랜잭션에서 삭제(재고 원복).
    const { error: ce } = await sb.rpc("cancel_production_receipt", { p_receipt_id: rid });
    if (ce) throw ce;

    const [row] = await loadRequests(sb, { id: requestId });
    return NextResponse.json({ ok: true, request: row });
  } catch (err) {
    console.error("[production/requests receive DELETE]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "입고 취소 실패") }, { status: 500 });
  }
}
