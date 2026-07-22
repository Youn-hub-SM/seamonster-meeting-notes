import { NextResponse } from "next/server";
import { computeDailyStats } from "@/app/lib/sales-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// 대시보드 헤드라인 지표 — 데이터 최신일 기준(검증된 computeDailyStats 재사용).
export async function GET() {
  try {
    const s = await computeDailyStats();
    const channels = s.channels
      .map((ch) => ({ name: ch, month: s.channel_summary[ch].month, prev_month: s.channel_summary[ch].prev_month }))
      .sort((a, b) => b.month - a.month);
    return NextResponse.json({
      ok: true, base_date: s.date_str, is_sunday: s.is_sunday,
      window_sales: s.window_sales, window_start: s.window_start, window_end: s.window_end,
      this_month_sales: s.this_month_sales, prev_month_sales: s.prev_month_sales, month_rr_pct: s.month_rr_pct,
      this_year_sales: s.this_year_sales, last_year_sales: s.last_year_sales, year_rr_pct: s.year_rr_pct,
      order_count: s.order_count, aov: s.aov, new_cust: s.new_cust, repeat_cust: s.repeat_cust, unclassified_orders: s.unclassified_orders,
      channels, top10: s.top10.slice(0, 5),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
