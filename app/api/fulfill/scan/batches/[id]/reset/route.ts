import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { computeBatchState } from "@/app/lib/fulfill-scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// POST — 이 배치의 스캔 내역 전체 초기화(라인 데이터는 유지)
export async function POST(_req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const sb = supabaseAdmin();
    const { error } = await sb.from("fulfill_scan_events").delete().eq("batch_id", id);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    const state = await computeBatchState(sb, id);
    return NextResponse.json({ ok: true, ...state });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "초기화 실패") }, { status: 500 });
  }
}
