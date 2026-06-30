import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { computeQuote, type QuoteTxn } from "@/app/lib/inventory-quote";
import { fetchQuoteTxns, validMonth } from "./fetch";

export const dynamic = "force-dynamic";

// GET /api/inventory/quote?month=YYYY-MM&rent=&etc= — 월간 매입 결산(면세/과세/임대료 요약 + SKU별 집계).
export async function GET(req: NextRequest) {
  try {
    const month = validMonth(req.nextUrl.searchParams.get("month"));
    if (!month) return NextResponse.json({ ok: false, error: "month(YYYY-MM)이 필요합니다." }, { status: 400 });
    const rent = Number(req.nextUrl.searchParams.get("rent")) || 0;
    const exemptEtc = Number(req.nextUrl.searchParams.get("etc")) || 0;
    const taxableEtc = Number(req.nextUrl.searchParams.get("tax_etc")) || 0;

    const txns: QuoteTxn[] = await fetchQuoteTxns(month);
    // status 컬럼이 있으면 '완료'만(대기 매입은 결산 제외). 없으면 전체.
    const hasStatus = txns.some((t) => t.status != null);
    const used = hasStatus ? txns.filter((t) => t.status === "완료") : txns;
    const result = computeQuote(month, used, { rent, exemptEtc, taxableEtc });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[inventory/quote GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "결산 조회 실패") }, { status: 500 });
  }
}
