import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { computeBatchState } from "@/app/lib/fulfill-scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// GET — 배치 정보 + 현재 집계 + 최근 스캔 목록
export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const sb = supabaseAdmin();
    const { data: batch, error } = await sb
      .from("fulfill_scan_batches")
      .select("id, title, created_by, created_at, closed, invoice_count, item_count, note")
      .eq("id", id)
      .maybeSingle();
    if (error) return NextResponse.json({ ok: false, error: `${error.message} (057 적용 확인)` }, { status: 500 });
    if (!batch) return NextResponse.json({ ok: false, error: "배치를 찾을 수 없습니다." }, { status: 404 });

    const state = await computeBatchState(sb, id);
    const { data: recent } = await sb
      .from("fulfill_scan_events")
      .select("invoice_no, scanned_at, scanned_by")
      .eq("batch_id", id)
      .order("scanned_at", { ascending: false })
      .limit(50);

    return NextResponse.json({ ok: true, batch, ...state, recent: recent ?? [] });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "조회 실패") }, { status: 500 });
  }
}

// DELETE — 배치 삭제(라인·이벤트 cascade)
export async function DELETE(_req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const sb = supabaseAdmin();
    const { error } = await sb.from("fulfill_scan_batches").delete().eq("id", id);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "삭제 실패") }, { status: 500 });
  }
}
