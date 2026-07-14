import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { assertSelectOnly } from "@/app/lib/report-ai";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST { sql, title? } — 리포트 SQL을 다시 실행(read-only)해 엑셀로 내보내기.
export async function POST(req: NextRequest) {
  try {
    const { sql, title } = (await req.json()) as { sql?: string; title?: string };
    if (!sql) return NextResponse.json({ ok: false, error: "sql 필요" }, { status: 400 });
    let safe: string;
    try { safe = assertSelectOnly(sql); } catch (e) { return NextResponse.json({ ok: false, error: extractErrorMsg(e, "SQL 검증 실패") }, { status: 400 }); }

    const sb = supabaseAdmin();
    const { data, error } = await sb.rpc("run_report", { q: safe });
    if (error) return NextResponse.json({ ok: false, error: `쿼리 실행 오류: ${error.message}` }, { status: 400 });

    const rows = Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
    const columns = rows.length ? Object.keys(rows[0]) : [];

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("리포트");
    if (columns.length) {
      ws.addRow(columns);
      ws.getRow(1).font = { bold: true };
      for (const r of rows) ws.addRow(columns.map((c) => (r[c] ?? "") as ExcelJS.CellValue));
      ws.columns.forEach((col) => { col.width = 18; });
    } else {
      ws.addRow(["결과 없음"]);
    }
    const buf = await wb.xlsx.writeBuffer();
    const fname = `report_${(title || "custom").replace(/[^\w가-힣-]+/g, "_").slice(0, 40)}.xlsx`;
    return new NextResponse(buf as ArrayBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`,
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "엑셀 내보내기 실패") }, { status: 500 });
  }
}
