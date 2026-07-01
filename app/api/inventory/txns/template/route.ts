import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { extractErrorMsg } from "@/app/lib/supabase";
import { TXN_XLSX_HEADERS, TXN_XLSX_EXAMPLE, OUT_TXN_XLSX_HEADERS, OUT_TXN_XLSX_EXAMPLE } from "@/app/lib/inventory-xlsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/inventory/txns/template[?type=출고] — 엑셀 일괄 입력 양식(헤더 + 예시 2행).
//  입고(기본): SKU·수량·단가. 출고: 수량·(무시)·SKU (외부 출고 파일 그대로 업로드용).
export async function GET(req: NextRequest) {
  try {
    const isOut = req.nextUrl.searchParams.get("type") === "출고";
    const headers = isOut ? OUT_TXN_XLSX_HEADERS : TXN_XLSX_HEADERS;
    const example = isOut ? OUT_TXN_XLSX_EXAMPLE : TXN_XLSX_EXAMPLE;

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(isOut ? "출고(판매)" : "입고(구매)");
    ws.addRow([...headers]);
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF3F8" } };
    for (const ex of example) ws.addRow(ex);
    ws.columns.forEach((c) => { c.width = 16; });

    const buf = await wb.xlsx.writeBuffer();
    return new NextResponse(buf as ArrayBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="inventory-${isOut ? "out" : "in"}-template.xlsx"`,
      },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "양식 생성 실패") }, { status: 500 });
  }
}
