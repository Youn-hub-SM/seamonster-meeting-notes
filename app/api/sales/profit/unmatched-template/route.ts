import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/app/lib/supabase";
import ExcelJS from "exceljs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// GET ?from=&to= — 미매칭 관리코드를 '원가·중량 채워넣기' 양식(xlsx)으로 추출.
//  헤더가 cost-upload 와 동일(관리코드/상품명/중량/상품원가_단가) → 채워서 그대로 업로드하면 매칭됨.
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
    const { data: unm, error } = await sb.rpc("sales_profit_unmatched", { p_from: from, p_to: to });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("미매칭_원가입력");
    ws.columns = [
      { header: "관리코드", key: "sku_code", width: 22 },
      { header: "상품명", key: "product_name", width: 22 },
      { header: "중량", key: "weight", width: 10 },
      { header: "상품원가_단가", key: "cost", width: 14 },
      { header: "참고_수량합", key: "qty_sum", width: 12 },
      { header: "참고_결제금액합", key: "amount_sum", width: 16 },
      { header: "판매처", key: "channels", width: 24 },
    ];
    ws.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0D3B52" } };
    for (const u of (unm as { sku_code: string; qty_sum: number; amount_sum: number; channels: string }[]) || []) {
      ws.addRow({ sku_code: u.sku_code, product_name: "", weight: "", cost: "", qty_sum: Number(u.qty_sum), amount_sum: Number(u.amount_sum), channels: u.channels });
    }
    ws.getColumn("amount_sum").numFmt = "#,##0";
    ws.views = [{ state: "frozen", ySplit: 1 }];
    // 중량·상품원가 칸 강조(입력 필요)
    ["C", "D"].forEach((c) => { ws.getColumn(c).eachCell((cell, r) => { if (r > 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF3CD" } }; }); });

    const buf = await wb.xlsx.writeBuffer();
    return new NextResponse(buf as ArrayBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="unmatched_cost_${from}_${to}.xlsx"`,
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
