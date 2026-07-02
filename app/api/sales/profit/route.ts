import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/app/lib/supabase";
import { computeProfitRow, computeProfitTotals, type ProfitInput } from "@/app/lib/sales-profit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET ?from=&to= — 채널별 매출·이익 집계 + 미매칭 관리코드.
export async function GET(req: NextRequest) {
  try {
    const sb = supabaseAdmin();
    const p = new URL(req.url).searchParams;
    let from = p.get("from") || "", to = p.get("to") || "";
    if (!from || !to) {
      const { data: b } = await sb.rpc("sales_date_bounds");
      const max = Array.isArray(b) && b[0]?.max_date ? String(b[0].max_date) : null;
      if (!max) return NextResponse.json({ ok: false, error: "매출 데이터가 없습니다." }, { status: 400 });
      to = to || max;
      from = from || `${max.slice(0, 7)}-01`; // 그 달 1일
    }

    const [{ data: sumRows, error: e1 }, { data: unm, error: e2 }, costCntRes] = await Promise.all([
      sb.rpc("sales_profit_summary", { p_from: from, p_to: to }),
      sb.rpc("sales_profit_unmatched", { p_from: from, p_to: to }),
      sb.from("sales_sku_cost").select("sku_code", { count: "exact", head: true }),
    ]);
    if (e1) return NextResponse.json({ ok: false, error: `집계 오류: ${e1.message}. 043 적용 여부 확인.` }, { status: 500 });
    if (e2) return NextResponse.json({ ok: false, error: `미매칭 조회 오류: ${e2.message}` }, { status: 500 });
    const cost_count = costCntRes.error ? null : (costCntRes.count ?? 0);

    const rows = ((sumRows as ProfitInput[]) || []).map((r) => computeProfitRow({
      channel: String(r.channel), orders: Number(r.orders) || 0,
      pay_amount: Number(r.pay_amount) || 0, product_cost: Number(r.product_cost) || 0, cooling: Number(r.cooling) || 0,
    }));
    const totals = computeProfitTotals(rows);
    const unmatched = ((unm as { sku_code: string; line_count: number; qty_sum: number; amount_sum: number; channels: string }[]) || [])
      .map((u) => ({ sku_code: u.sku_code, line_count: Number(u.line_count), qty_sum: Number(u.qty_sum), amount_sum: Number(u.amount_sum), channels: u.channels }));

    return NextResponse.json({
      ok: true, from, to, rows, totals, unmatched,
      cost_count,
      unmatched_amount: unmatched.reduce((a, u) => a + u.amount_sum, 0),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
