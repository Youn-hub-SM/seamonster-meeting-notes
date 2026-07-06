import { NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import ExcelJS from "exceljs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — 업로드 양식(송장번호·단품코드·주문수량) 다운로드
export async function GET() {
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("송장데이터");
    ws.addRow(["송장번호", "단품코드", "주문수량"]);
    ws.addRow(["123456789012", "DG-100-K-100", 2]);
    ws.addRow(["123456789012", "AG-100-K-100", 1]);
    ws.addRow(["987654321098", "SET-DG-100", 1]);
    ws.getColumn(1).width = 20; ws.getColumn(2).width = 22; ws.getColumn(3).width = 10;
    const buf = await wb.xlsx.writeBuffer();
    return new NextResponse(Buffer.from(buf), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${encodeURIComponent("송장스캔_양식.xlsx")}"`,
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "양식 생성 실패") }, { status: 500 });
  }
}
