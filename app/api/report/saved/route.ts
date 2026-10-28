import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getSavedReports, addSavedReport, deleteSavedReport } from "@/app/lib/report-saved";
import { assertSelectOnly } from "@/app/lib/report-ai";
import { verifySession, resolveUserName } from "@/app/lib/b2b-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET → 저장 리포트 목록
export async function GET() {
  try {
    return NextResponse.json({ ok: true, reports: await getSavedReports() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "목록 조회 실패") }, { status: 500 });
  }
}

// POST { name, question, sql, chart, looker } → 저장
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as { name?: string; question?: string; sql?: string; chart?: unknown; looker?: unknown };
    const name = (b.name || "").trim();
    const sql = (b.sql || "").trim();
    if (!name) return NextResponse.json({ ok: false, error: "리포트 이름을 입력하세요." }, { status: 400 });
    if (!sql) return NextResponse.json({ ok: false, error: "SQL 이 비어 있습니다." }, { status: 400 });
    // {{변수}} 자리를 임시치환한 뒤 단일 SELECT 인지 검증(구조 안전성)
    const probe = sql.replace(/\{\{\s*[^}]+\s*\}\}/g, "1");
    try { assertSelectOnly(probe); } catch (e) { return NextResponse.json({ ok: false, error: extractErrorMsg(e, "SELECT 쿼리만 저장할 수 있습니다.") }, { status: 400 }); }
    const token = req.cookies.get("b2b_auth")?.value;
    const createdBy = (await verifySession(token)) || resolveUserName(token);
    const rec = await addSavedReport({
      name, question: (b.question || "").trim(), sql,
      chart: (b.chart as never) ?? { type: "none" },
      looker: (b.looker as never) ?? { mode: "na" },
      createdBy,
    });
    return NextResponse.json({ ok: true, report: rec });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "저장 실패") }, { status: 500 });
  }
}

// DELETE ?id= → 삭제
export async function DELETE(req: NextRequest) {
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ ok: false, error: "id 필요" }, { status: 400 });
    await deleteSavedReport(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "삭제 실패") }, { status: 500 });
  }
}
