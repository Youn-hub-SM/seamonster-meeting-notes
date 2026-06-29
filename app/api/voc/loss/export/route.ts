import { NextRequest, NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { VOC_FAULT_CLAIMABLE, VOC_FAULT_BURDEN } from "@/app/lib/voc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/voc/loss/export?from=&to= — 기간 손해 정산 내역을 엑셀로(귀책별 청구가능/자사부담 분리).
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const from = sp.get("from") || "";
    const to = sp.get("to") || "";
    let q = supabaseAdmin().from("voc").select("received_at, customer, product, category, comp_type, fault, loss_amount").order("received_at", { ascending: true });
    if (DATE_RE.test(from)) q = q.gte("received_at", from);
    if (DATE_RE.test(to)) q = q.lte("received_at", to);
    const { data, error } = await q;
    if (error) throw error;
    const rows = (data ?? []) as { received_at: string; customer: string | null; product: string | null; category: string; comp_type: string; fault: string; loss_amount: number }[];

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("손해정산");
    const headers = ["접수일", "고객", "제품", "클레임유형", "보상유형", "귀책", "손해금액", "제조사 청구가능", "자사 부담"];
    ws.addRow(headers);
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFF3F8" } };

    let total = 0, claim = 0, burden = 0;
    for (const r of rows) {
      const loss = Number(r.loss_amount) || 0;
      const c = VOC_FAULT_CLAIMABLE.has(r.fault) ? loss : 0;
      const b = VOC_FAULT_BURDEN.has(r.fault) ? loss : 0;
      total += loss; claim += c; burden += b;
      ws.addRow([r.received_at, r.customer || "", r.product || "", r.category, r.comp_type, r.fault, loss, c, b]);
    }
    const totalRow = ws.addRow(["합계", "", "", "", "", "", total, claim, burden]);
    totalRow.font = { bold: true };

    [12, 12, 18, 12, 12, 10, 14, 14, 14].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    [7, 8, 9].forEach((c) => { ws.getColumn(c).numFmt = "#,##0"; });

    const buf = await wb.xlsx.writeBuffer();
    const fname = `voc-loss_${from || "all"}_${to || "all"}.xlsx`;
    return new NextResponse(buf as ArrayBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fname}"`,
      },
    });
  } catch (err) {
    console.error("[voc/loss export]", err);
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "추출 실패") }, { status: 500 });
  }
}
