import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { computePoolState, clearScanRound, undoScanClear, lastScanClear } from "@/app/lib/fulfill-scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST — 스캔 초기화(업로드 데이터는 유지). 기록은 지우지 않고 라운드 마감(30일 보관 — 125, 미적용이면 삭제).
//  POST { undo: true, at } — 직전 초기화 되돌리기(화면에서 확인한 at 묶음을 이번 라운드로).
export async function POST(req: NextRequest) {
  try {
    const sb = supabaseAdmin();
    const b = (await req.json().catch(() => ({}))) as { undo?: boolean; at?: string };
    let restored: number | undefined;
    if (b.undo) restored = await undoScanClear(sb, b.at);
    else await clearScanRound(sb);
    const [state, lastReset] = await Promise.all([computePoolState(sb), lastScanClear(sb)]);
    return NextResponse.json({ ok: true, ...state, lastReset, ...(restored !== undefined ? { restored } : {}) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "초기화 실패") }, { status: 500 });
  }
}
