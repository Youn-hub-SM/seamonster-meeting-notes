import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { extractErrorMsg } from "@/app/lib/supabase";
import { VOC_XLSX_HEADERS, VOC_XLSX_EXAMPLE, VOC_XLSX_GUIDE } from "@/app/lib/voc-xlsx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/voc/template — VOC 일괄 등록 엑셀 양식(헤더+예시 + 입력안내 시트).
export async function GET() {
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("VOC 등록");
    ws.addRow([...VOC_XLSX_HEADERS]);
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF3F8" } };
    const ex = ws.addRow(VOC_XLSX_EXAMPLE);
    ex.font = { italic: true, color: { argb: "FF8A94A6" } };
    ws.columns.forEach((c, i) => {
      const h = VOC_XLSX_HEADERS[i];
      c.width = h === "상세내용" || h === "원인" || h === "처리내용" || h === "개선필요사항" || h === "고객특이사항" ? 26 : h === "구매상품" || h === "구매처" ? 16 : 12;
    });
    ws.views = [{ state: "frozen", ySplit: 1 }];

    // 입력 안내 시트
    const gs = wb.addWorksheet("입력안내");
    gs.addRow(["항목", "설명"]).font = { bold: true };
    gs.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF3F8" } };
    for (const [k, v] of VOC_XLSX_GUIDE) gs.addRow([k, v]);
    gs.getColumn(1).width = 22; gs.getColumn(2).width = 60;
    gs.addRow([]);
    gs.addRow(["", "※ 예시 행(2행)은 지우고 입력하세요. 접수일·상세내용만 있으면 등록됩니다."]).font = { color: { argb: "FF8A94A6" } };

    const buf = await wb.xlsx.writeBuffer();
    const fname = encodeURIComponent("씨몬스터_VOC_등록양식.xlsx");
    return new NextResponse(buf as ArrayBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename*=UTF-8''${fname}`,
      },
    });
  } catch (err) {
    console.error("[voc/template]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "양식 생성 실패") }, { status: 500 });
  }
}
