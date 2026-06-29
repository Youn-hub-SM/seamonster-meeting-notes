import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { extractErrorMsg } from "@/app/lib/supabase";
import { TXN_XLSX_HEADERS, TXN_XLSX_EXAMPLE } from "@/app/lib/inventory-xlsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/inventory/txns/template — 구매·판매 엑셀 일괄 입력 양식(헤더 + 예시 2행).
export async function GET() {
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("입출고");
    ws.addRow([...TXN_XLSX_HEADERS]);
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF3F8" } };
    for (const ex of TXN_XLSX_EXAMPLE) ws.addRow(ex);
    ws.columns.forEach((c) => { c.width = 16; });

    const buf = await wb.xlsx.writeBuffer();
    return new NextResponse(buf as ArrayBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="inventory-io-template.xlsx"`,
      },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "양식 생성 실패") }, { status: 500 });
  }
}
