import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { validateReportSql } from "@/app/lib/report-ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// POST { sql } — AI 없이 주어진 SQL 을 그대로 실행(저장 리포트 재사용·변수 치환 후). run_report(안전) 경유.
export async function POST(req: NextRequest) {
  try {
    const { sql } = (await req.json()) as { sql?: string };
    if (!sql) return NextResponse.json({ ok: false, error: "sql 필요" }, { status: 400 });
    let safe: string;
    try { safe = validateReportSql(sql); } catch (e) { return NextResponse.json({ ok: false, error: extractErrorMsg(e, "SQL 검증 실패") }, { status: 400 }); }

    const sb = supabaseAdmin();
    const { data, error } = await sb.rpc("run_report", { q: safe });
    if (error) return NextResponse.json({ ok: false, error: `쿼리 실행 오류: ${error.message}` }, { status: 400 });

    const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
    const columns = rows.length ? Object.keys(rows[0]) : [];
    return NextResponse.json({ ok: true, columns, rows, rowCount: rows.length });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "실행 실패") }, { status: 500 });
  }
}
