import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { reconcileB2BSales, syncOrderSales } from "@/app/lib/b2b-sales-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/b2b/reports/ledger?from=&to= — 발주 기준 기대 매출과 매출 원장(sales_orders 도매)을 발주 단위로 대조.
//  어긋난 발주만 돌려준다. 고치지 않는다(S12) — 사람이 보고 '다시 맞추기'를 누른다.
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const from = sp.get("from") || "";
    const to = sp.get("to") || "";
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
      return NextResponse.json({ ok: false, error: "from / to 는 YYYY-MM-DD 형식이어야 합니다" }, { status: 400 });
    }
    const r = await reconcileB2BSales(from, to);
    return NextResponse.json({ ok: true, ...r });
  } catch (err) {
    console.error("[b2b/reports/ledger GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "원장 대조 실패") }, { status: 500 });
  }
}

// POST { order_id } — 그 발주의 매출 원장을 현재 발주 상태로 다시 맞춘다(결정적 재빌드).
//  발송완료·취소 발주는 같은 주문번호의 백필 행도 지우고 발송일·부가세 포함 기준으로 다시 넣는다 — 귀속 월·금액이 바뀔 수 있다.
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { order_id?: string };
    const orderId = String(body.order_id || "");
    if (!orderId) return NextResponse.json({ ok: false, error: "order_id 가 필요합니다." }, { status: 400 });
    const r = await syncOrderSales(orderId);
    return NextResponse.json({ ok: true, rows: r.rows });
  } catch (err) {
    console.error("[b2b/reports/ledger POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "다시 맞추기 실패") }, { status: 500 });
  }
}
