import { NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { computePoolState } from "@/app/lib/fulfill-scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST — 스캔 진행 전체 초기화(업로드 데이터는 유지)
export async function POST() {
  try {
    const sb = supabaseAdmin();
    const { error } = await sb.from("fulfill_scan_events").delete().neq("invoice_no", " ");
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    const state = await computePoolState(sb);
    return NextResponse.json({ ok: true, ...state });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "초기화 실패") }, { status: 500 });
  }
}
