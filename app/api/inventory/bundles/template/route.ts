import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { extractErrorMsg } from "@/app/lib/supabase";
import { BUNDLE_XLSX_HEADERS, BUNDLE_XLSX_EXAMPLE } from "@/app/lib/bundle-xlsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/inventory/bundles/template — 묶음 상품 일괄 등록 양식(묶음SKU·묶음명·구성품SKU·수량).
export async function GET() {
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("묶음상품");
    ws.addRow([...BUNDLE_XLSX_HEADERS]);
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF3F8" } };
    for (const ex of BUNDLE_XLSX_EXAMPLE) ws.addRow(ex);
    ws.columns.forEach((c) => { c.width = 18; });
    ws.addRow([]);
    ws.addRow(["※ 한 세트에 구성품이 여러 개면 '묶음SKU'를 같게 여러 줄 입력하세요."]);
    ws.addRow(["※ 묶음SKU 가 상품에 없으면 최소 정보로 자동 생성됩니다(원가·가격 불필요). 구성품 SKU 는 이미 등록된 상품이어야 합니다."]);

    const buf = await wb.xlsx.writeBuffer();
    return new NextResponse(buf as ArrayBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="bundle-template.xlsx"`,
      },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "양식 생성 실패") }, { status: 500 });
  }
}
