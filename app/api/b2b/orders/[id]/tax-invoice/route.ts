import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { currentActor } from "@/app/lib/b2b-activity";
import { getInvoiceContext, issueOrderInvoices, refreshOrderInvoices, markInvoiceFailed, loadInvoices, IssueRefused, type IssueInput } from "@/app/lib/tax-invoice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Ctx = { params: Promise<{ id: string }> };

// GET — 세금계산서 발행 미리보기(문서 초안·공급자·공급받는자·발행 기록·볼타 준비 상태)
export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const ctx = await getInvoiceContext(supabaseAdmin(), id);
    if (!ctx) return NextResponse.json({ ok: false, error: "발주를 찾을 수 없습니다." }, { status: 404 });
    return NextResponse.json({ ok: true, ...ctx });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "미리보기 실패") }, { status: 500 });
  }
}

// POST { action: "issue", ...IssueInput } — 발행(볼타 접수) · { action: "refresh" } — 결과 다시 확인
//  · { action: "mark_failed", rowId } — 처리 중에 멈춘 문서를 실패로(10분 뒤부터)
//  로그인한 사람 누구나(2026-10-08 대표 결정).
export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const b = (await req.json().catch(() => ({}))) as Partial<IssueInput> & { action?: string; rowId?: string };
    const sb = supabaseAdmin();
    const actor = await currentActor();
    if (b.action === "refresh") {
      await refreshOrderInvoices(sb, id, actor);
    } else if (b.action === "mark_failed") {
      if (!b.rowId) return NextResponse.json({ ok: false, error: "rowId 가 필요합니다." }, { status: 400 });
      await markInvoiceFailed(sb, id, String(b.rowId), actor);
    } else if (b.action === "issue") {
      if (!b.supplied || !b.writeDate || !b.purpose) return NextResponse.json({ ok: false, error: "발행 정보가 비었습니다." }, { status: 400 });
      const results = await issueOrderInvoices(sb, id, {
        writeDate: String(b.writeDate), purpose: b.purpose, supplied: b.supplied, saveCompany: !!b.saveCompany,
        description: String(b.description ?? ""), fingerprint: String(b.fingerprint ?? ""), lines: b.lines,
      }, actor);
      const { rows } = await loadInvoices(sb, id);
      return NextResponse.json({ ok: results.some((r) => r.ok), results, invoices: rows, error: results.filter((r) => !r.ok).map((r) => r.error).join(" ") || undefined });
    } else {
      return NextResponse.json({ ok: false, error: "action 이 필요합니다." }, { status: 400 });
    }
    const ctx = await getInvoiceContext(sb, id);
    return NextResponse.json({ ok: true, ...ctx });
  } catch (err) {
    if (err instanceof IssueRefused) return NextResponse.json({ ok: false, error: err.message }, { status: 400 });
    console.error("[b2b/orders/tax-invoice]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "발행 실패") }, { status: 500 });
  }
}
