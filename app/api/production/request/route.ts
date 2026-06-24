import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getRequestRows, PERIOD_DAYS } from "@/app/lib/production-request";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET /api/production/request?days=1|7|14|30&date=YYYY-MM-DD&format=json|xlsx
function parseDays(p: string | null): number {
  const n = Number(p);
  return (PERIOD_DAYS as readonly number[]).includes(n) ? n : 7;
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const days = parseDays(url.searchParams.get("days"));
    const date = url.searchParams.get("date") || new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const format = url.searchParams.get("format") || "json";

    const data = await getRequestRows(days, date);

    if (format !== "xlsx") {
      return NextResponse.json({ ok: true, days, ...data });
    }

    // ── 엑셀 생성 ──
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("생산요청서");
    ws.columns = [
      { width: 34 }, { width: 12 }, { width: 12 }, { width: 14 },
    ];
    const title = ws.addRow(["생산 요청서"]);
    title.font = { bold: true, size: 15 };
    ws.mergeCells(title.number, 1, title.number, 4);
    const sub = ws.addRow([`${data.label}  (${data.from} ~ ${data.to})`]);
    sub.font = { color: { argb: "FF888888" }, size: 11 };
    ws.mergeCells(sub.number, 1, sub.number, 4);
    ws.addRow([]);
    const header = ws.addRow(["품목명", "규격", "생산량", "비고"]);
    header.font = { bold: true };
    header.eachCell((c) => { c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } }; c.border = { bottom: { style: "thin", color: { argb: "FFCCCCCC" } } }; });
    for (const r of data.rows) {
      const row = ws.addRow([r.name, r.spec || "", r.qty, r.manual ? "직접추가" : ""]);
      row.getCell(3).numFmt = "#,##0";
    }
    ws.addRow([]);
    const totalRow = ws.addRow(["합계", "", data.total, ""]);
    totalRow.font = { bold: true };
    totalRow.getCell(3).numFmt = "#,##0";

    const buf = await wb.xlsx.writeBuffer();
    const fname = `production-request-${days}d-${data.from}.xlsx`;
    return new NextResponse(buf as ArrayBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fname}"; filename*=UTF-8''${encodeURIComponent(`생산요청서_${data.from}.xlsx`)}`,
      },
    });
  } catch (err) {
    console.error("[production/request]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}
