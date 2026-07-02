import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/app/lib/supabase";
import { computeProfitRow, computeProfitTotals, PROFIT_COLS, type ProfitInput, type ProfitRow } from "@/app/lib/sales-profit";
import ExcelJS from "exceljs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET ?from=&to= — 채널별 매출·이익 요약 + 미매칭을 xlsx로.
export async function GET(req: NextRequest) {
  try {
    const sb = supabaseAdmin();
    const p = new URL(req.url).searchParams;
    let from = p.get("from") || "", to = p.get("to") || "";
    if (!from || !to) {
      const { data: b } = await sb.rpc("sales_date_bounds");
      const max = Array.isArray(b) && b[0]?.max_date ? String(b[0].max_date) : null;
      if (!max) return NextResponse.json({ ok: false, error: "매출 데이터가 없습니다." }, { status: 400 });
      to = to || max; from = from || `${max.slice(0, 7)}-01`;
    }
    const [{ data: sumRows, error: e1 }, { data: unm }] = await Promise.all([
      sb.rpc("sales_profit_summary", { p_from: from, p_to: to }),
      sb.rpc("sales_profit_unmatched", { p_from: from, p_to: to }),
    ]);
    if (e1) return NextResponse.json({ ok: false, error: e1.message }, { status: 500 });

    const rows: ProfitRow[] = ((sumRows as ProfitInput[]) || []).map((r) => computeProfitRow({
      channel: String(r.channel), orders: Number(r.orders) || 0, pay_amount: Number(r.pay_amount) || 0,
      product_cost: Number(r.product_cost) || 0, cooling: Number(r.cooling) || 0,
    }));
    const totals = computeProfitTotals(rows);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("채널별요약");
    ws.columns = PROFIT_COLS.map((c) => ({ header: c.label, key: c.key as string, width: c.key === "channel" ? 12 : 14 }));
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0D3B52" } };
    for (const r of [...rows, totals]) ws.addRow(r);
    for (const c of PROFIT_COLS) if (c.money) ws.getColumn(c.key as string).numFmt = "#,##0";
    ws.getRow(ws.rowCount).font = { bold: true }; // 합계행

    const wu = wb.addWorksheet("미매칭_관리코드");
    wu.columns = [
      { header: "관리코드", key: "sku_code", width: 22 }, { header: "미매칭_라인수", key: "line_count", width: 12 },
      { header: "미매칭_수량합", key: "qty_sum", width: 12 }, { header: "미매칭_결제금액합", key: "amount_sum", width: 16 },
      { header: "판매처_예시", key: "channels", width: 24 },
    ];
    wu.getRow(1).font = { bold: true };
    for (const u of (unm as Record<string, unknown>[]) || []) wu.addRow(u);
    wu.getColumn("amount_sum").numFmt = "#,##0";

    const buf = await wb.xlsx.writeBuffer();
    return new NextResponse(buf as ArrayBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="channel_profit_${from}_${to}.xlsx"`,
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
