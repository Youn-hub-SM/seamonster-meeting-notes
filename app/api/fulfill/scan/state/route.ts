import { NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { computePoolState } from "@/app/lib/fulfill-scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — 풀 현재 집계 + 최근 스캔
export async function GET() {
  try {
    const sb = supabaseAdmin();
    const state = await computePoolState(sb);
    const { data: recent } = await sb
      .from("fulfill_scan_events")
      .select("invoice_no, scanned_at, scanned_by")
      .order("scanned_at", { ascending: false })
      .limit(50);
    return NextResponse.json({ ok: true, ...state, recent: recent ?? [] });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "조회 실패") + " (057 적용 확인)" }, { status: 500 });
  }
}
