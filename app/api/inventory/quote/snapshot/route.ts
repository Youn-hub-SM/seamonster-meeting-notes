import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { computeQuote } from "@/app/lib/inventory-quote";
import { fetchQuoteTxns, fetchQuoteReturns, validMonth } from "../fetch";

export const dynamic = "force-dynamic";

// migration 101 미적용 판별 — 테이블이 없으면 확정 기능만 숨기고 결산 자체는 그대로 돈다
const MISSING = /quote_snapshots/i;

// GET ?month=YYYY-MM — 그 달의 확정본(없으면 null)
export async function GET(req: NextRequest) {
  try {
    const month = validMonth(req.nextUrl.searchParams.get("month"));
    if (!month) return NextResponse.json({ ok: false, error: "month(YYYY-MM)이 필요합니다." }, { status: 400 });
    const sb = supabaseAdmin();
    const { data, error } = await sb.from("quote_snapshots")
      .select("month, confirmed_at, confirmed_by, summary, items, params, note")
      .eq("month", month).maybeSingle();
    if (error) {
      if (MISSING.test(error.message)) return NextResponse.json({ ok: true, snapshot: null, unavailable: true });
      throw error;
    }
    return NextResponse.json({ ok: true, snapshot: data ?? null });
  } catch (err) {
    console.error("[quote/snapshot GET]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "확정본 조회 실패") }, { status: 500 });
  }
}

// POST { month, rent, etc, tax_etc } — 서버가 지금 원장으로 재계산한 결과를 확정본으로 저장.
//  클라이언트가 보낸 숫자를 믿지 않고 서버 계산을 박제한다. 재확정 = 같은 달 덮어쓰기(upsert).
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as Record<string, unknown>;
    const month = validMonth(String(b.month || ""));
    if (!month) return NextResponse.json({ ok: false, error: "month(YYYY-MM)이 필요합니다." }, { status: 400 });
    const rent = Number(b.rent) || 0;
    const exemptEtc = Number(b.etc) || 0;
    const taxableEtc = Number(b.tax_etc) || 0;

    const [txns, returns] = await Promise.all([fetchQuoteTxns(month), fetchQuoteReturns(month)]);
    // 결산 GET 과 같은 이중 안전장치 — status 컬럼이 있으면 '완료'만
    const hasStatus = txns.some((t) => t.status != null);
    const used = hasStatus ? txns.filter((t) => t.status === "완료") : txns;
    const result = computeQuote(month, used, { rent, exemptEtc, taxableEtc, returns });

    const token = req.cookies.get("b2b_auth")?.value;
    const confirmed_by = (await verifySession(token)) || resolveUserName(token);
    const row = {
      month,
      confirmed_at: new Date().toISOString(),
      confirmed_by,
      summary: result.summary,
      items: result.items,
      params: { rent, etc: exemptEtc, tax_etc: taxableEtc },
    };
    const sb = supabaseAdmin();
    const { error } = await sb.from("quote_snapshots").upsert(row, { onConflict: "month" });
    if (error) {
      if (MISSING.test(error.message))
        return NextResponse.json({ ok: false, error: "결산 확정 저장에는 supabase/migrations/101_quote_snapshots.sql 적용이 필요합니다." }, { status: 400 });
      throw error;
    }
    return NextResponse.json({ ok: true, snapshot: row });
  } catch (err) {
    console.error("[quote/snapshot POST]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "결산 확정 실패") }, { status: 500 });
  }
}

// DELETE ?month=YYYY-MM — 확정 해제
export async function DELETE(req: NextRequest) {
  try {
    const month = validMonth(req.nextUrl.searchParams.get("month"));
    if (!month) return NextResponse.json({ ok: false, error: "month(YYYY-MM)이 필요합니다." }, { status: 400 });
    const sb = supabaseAdmin();
    const { error } = await sb.from("quote_snapshots").delete().eq("month", month);
    if (error && !MISSING.test(error.message)) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[quote/snapshot DELETE]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "확정 해제 실패") }, { status: 500 });
  }
}
