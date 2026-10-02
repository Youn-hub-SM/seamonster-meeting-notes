import { NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { computePoolState, lastScanClear } from "@/app/lib/fulfill-scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — 풀 현재 집계 + 최근 스캔
export async function GET() {
  try {
    const sb = supabaseAdmin();
    const [state, lastReset] = await Promise.all([computePoolState(sb), lastScanClear(sb)]);
    // 최근 스캔 = 이번 라운드만(125 미적용이면 칸이 없어 전부)
    const q = () => sb.from("fulfill_scan_events").select("invoice_no, scanned_at, scanned_by").order("scanned_at", { ascending: false }).limit(50);
    let rec = await q().is("cleared_at", null);
    if (rec.error && /cleared_at/i.test(rec.error.message)) rec = await q();
    return NextResponse.json({ ok: true, ...state, recent: rec.data ?? [], lastReset });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "조회 실패") + " (057 적용 확인)" }, { status: 500 });
  }
}
