import { NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { computePoolState } from "@/app/lib/fulfill-scan";
import ExcelJS from "exceljs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — 현재 집계(상품별 수량)를 xlsx 로 다운로드
export async function GET() {
  try {
    const sb = supabaseAdmin();
    const state = await computePoolState(sb);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("집계");
    ws.addRow([`스캔 집계 · 스캔 송장 ${state.scannedCount}건 · 총 ${state.totalUnits}개`]);
    ws.addRow([]);
    ws.addRow(["상품명", "SKU", "수량"]);
    for (const t of state.tally) ws.addRow([t.name, t.sku, t.qty]);
    ws.getColumn(1).width = 34; ws.getColumn(2).width = 22; ws.getColumn(3).width = 10;

    const buf = await wb.xlsx.writeBuffer();
    const d = new Date(Date.now() + 9 * 3600e3);
    const stamp = `${d.toISOString().slice(0, 10).replace(/-/g, "")}_${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}`;
    const fname = `스캔집계_${stamp}.xlsx`;
    return new NextResponse(Buffer.from(buf), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(fname)}"`,
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "내보내기 실패") }, { status: 500 });
  }
}
