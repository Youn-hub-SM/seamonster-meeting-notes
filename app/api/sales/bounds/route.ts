import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/app/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 매출 데이터 범위(최소/최대 주문일 + 총 행수) — 대시보드·업로드 안내용.
export async function GET() {
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb.rpc("sales_date_bounds");
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    const b = Array.isArray(data) && data[0] ? data[0] : { min_date: null, max_date: null, total_rows: 0 };
    return NextResponse.json({ ok: true, min_date: b.min_date, max_date: b.max_date, total_rows: Number(b.total_rows || 0) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
