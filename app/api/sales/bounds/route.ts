import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/app/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 매출 데이터 범위(최소/최대 주문일 + 총 행수) — 대시보드·업로드 안내용.
//  max_date = 오늘(KST) 이하 최신일(133). 오늘 이후 날짜 행은 future_rows·future_max 로 따로 — 화면이 경고한다.
//  133 미적용이면 RPC 가 미래 포함 max 를 그대로 주므로, 오늘 이후면 future_max 로도 알린다(행 수는 모름 = null).
export async function GET() {
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb.rpc("sales_date_bounds");
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    const b = (Array.isArray(data) && data[0] ? data[0] : { min_date: null, max_date: null, total_rows: 0 }) as {
      min_date: string | null; max_date: string | null; total_rows: number; future_rows?: number | null; future_max?: string | null;
    };
    const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const has133 = "future_rows" in b;
    const legacyFuture = !has133 && b.max_date && String(b.max_date) > today ? String(b.max_date) : null;
    return NextResponse.json({
      ok: true, min_date: b.min_date, max_date: b.max_date, total_rows: Number(b.total_rows || 0),
      future_rows: has133 ? Number(b.future_rows || 0) : legacyFuture ? null : 0,
      future_max: has133 ? b.future_max ?? null : legacyFuture,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
