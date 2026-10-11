import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";
import { computeQuote } from "@/app/lib/inventory-quote";
import { fetchQuoteTxns, fetchQuoteReturns, validMonth } from "../fetch";

export const dynamic = "force-dynamic";

// migration 101 미적용 판별 — 테이블이 없으면 확정 기능만 숨기고 결산 자체는 그대로 돈다
const MISSING = /quote_snapshots/i;

// GET ?month=YYYY-MM — 그 달의 확정본(없으면 null)
// GET ?list=1 — 확정본 목록(최신 월부터). 화면 아래 '확정된 결산' 표용 — 품목표(items)는 빼고 요약만.
export async function GET(req: NextRequest) {
  try {
    if (req.nextUrl.searchParams.get("list") === "1") {
      const { data, error } = await supabaseAdmin().from("quote_snapshots")
        .select("month, confirmed_at, confirmed_by, summary")
        .order("month", { ascending: false }).limit(240);
      if (error) {
        if (MISSING.test(error.message)) return NextResponse.json({ ok: true, snapshots: [], unavailable: true });
        throw error;
      }
      return NextResponse.json({ ok: true, snapshots: data ?? [] });
    }
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

// POST { month, rent, etc, tax_etc, confirm_drop? } — 서버가 지금 원장으로 재계산한 결과를 확정본으로 저장.
//  클라이언트가 보낸 숫자를 믿지 않고 서버 계산을 박제한다. 재확정 = 같은 달 덮어쓰기(upsert).
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as Record<string, unknown>;
    const month = validMonth(String(b.month || ""));
    if (!month) return NextResponse.json({ ok: false, error: "month(YYYY-MM)이 필요합니다." }, { status: 400 });
    const rent = Number(b.rent) || 0;
    const exemptEtc = Number(b.etc) || 0;
    const taxableEtc = Number(b.tax_etc) || 0;

    // 원장·반품 조회 오류는 여기서 던져 500 — '매입 0'으로 계산해 확정하지 않는다(fetch.ts S4)
    const [txns, returns] = await Promise.all([fetchQuoteTxns(month), fetchQuoteReturns(month)]);
    // 결산 GET 과 같은 이중 안전장치 — status 컬럼이 있으면 '완료'만
    const hasStatus = txns.some((t) => t.status != null);
    const used = hasStatus ? txns.filter((t) => t.status === "완료") : txns;
    const result = computeQuote(month, used, { rent, exemptEtc, taxableEtc, returns });

    const sb = supabaseAdmin();
    // 재확정 가드 — 기존 확정본보다 매입이 크게 줄었으면(절반 이하·0) 확인 없이 덮어쓰지 않는다.
    //  확정본은 이력 없이 덮어써지므로, 원장 일부가 빠진 순간의 재확정이 정상 확정본을 지우는 것을 막는다.
    //  기존 확정본 조회 오류도 멈춘다(101 미적용만 통과 — 그때는 아래 upsert 가 안내한다).
    if (b.confirm_drop !== true) {
      const { data: prev, error: pe } = await sb.from("quote_snapshots").select("summary").eq("month", month).maybeSingle();
      if (pe && !MISSING.test(pe.message)) throw pe;
      const ps = (prev as { summary?: { totalQty?: number; totalAmount?: number; itemCount?: number } } | null)?.summary;
      if (ps) {
        const pq = Number(ps.totalQty) || 0, pa = Number(ps.totalAmount) || 0;
        const nq = result.summary.totalQty, na = result.summary.totalAmount;
        const dropped = (pq > 0 && nq <= pq * 0.5) || (pa > 0 && na <= pa * 0.5) || ((Number(ps.itemCount) || 0) > 0 && result.summary.itemCount === 0);
        if (dropped)
          return NextResponse.json({
            ok: false, need_confirm: true,
            error: `기존 확정본보다 매입이 크게 줄었습니다(수량 ${pq.toLocaleString()} → ${nq.toLocaleString()}, 금액 ${Math.round(pa).toLocaleString()} → ${Math.round(na).toLocaleString()}원). 입고 및 출고 목록에서 그 달 입고가 그대로인지 먼저 확인하세요.`,
          }, { status: 409 });
      }
    }

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
