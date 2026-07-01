import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { extractErrorMsg } from "@/app/lib/supabase";
import { ADJUST_XLSX_HEADERS, ADJUST_XLSX_EXAMPLE } from "@/app/lib/inventory-xlsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/inventory/adjust/template — 재고 조정(실사) 대량 업로드 양식.
export async function GET() {
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("재고 조정");
    ws.addRow([...ADJUST_XLSX_HEADERS]);
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF3F8" } };
    for (const ex of ADJUST_XLSX_EXAMPLE) { const r = ws.addRow(ex); r.font = { italic: true, color: { argb: "FF8A94A6" } }; }
    ws.columns.forEach((c, i) => { c.width = i === 0 ? 18 : i === 2 ? 24 : 12; });
    ws.addRow([]);
    ws.addRow(["", "", "※ '실사수량'은 실제 센 현재 수량(목표). 현재고가 이 값이 되도록 조정합니다. 예시 행은 지우고 입력하세요."]).font = { color: { argb: "FF8A94A6" } };

    const buf = await wb.xlsx.writeBuffer();
    const fname = encodeURIComponent("씨몬스터_재고조정_양식.xlsx");
    return new NextResponse(buf as ArrayBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename*=UTF-8''${fname}`,
      },
    });
  } catch (err) {
    console.error("[inventory/adjust/template]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "양식 생성 실패") }, { status: 500 });
  }
}
