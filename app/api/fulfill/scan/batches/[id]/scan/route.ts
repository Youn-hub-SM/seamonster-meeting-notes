import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { currentActor } from "@/app/lib/b2b-activity";
import { computeBatchState } from "@/app/lib/fulfill-scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

// POST { invoice_no } — 송장 스캔 기록(중복 무시) 후 최신 집계 반환
export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    const { id } = await params;
    const { invoice_no } = (await req.json()) as { invoice_no?: string };
    const inv = String(invoice_no || "").trim();
    if (!inv) return NextResponse.json({ ok: false, error: "송장번호가 비었습니다." }, { status: 400 });

    const sb = supabaseAdmin();

    // 이 배치에 존재하는 송장인지
    const { count: known } = await sb
      .from("fulfill_scan_items")
      .select("invoice_no", { count: "exact", head: true })
      .eq("batch_id", id)
      .eq("invoice_no", inv);
    if (!known) {
      const state = await computeBatchState(sb, id);
      return NextResponse.json({ ok: true, known: false, alreadyScanned: false, ...state });
    }

    // 이미 스캔됐는지
    const { data: existed } = await sb
      .from("fulfill_scan_events")
      .select("invoice_no")
      .eq("batch_id", id)
      .eq("invoice_no", inv)
      .maybeSingle();
    const alreadyScanned = !!existed;
    if (!alreadyScanned) {
      const actor = await currentActor();
      await sb.from("fulfill_scan_events").upsert(
        { batch_id: id, invoice_no: inv, scanned_by: actor, scanned_at: new Date().toISOString() },
        { onConflict: "batch_id,invoice_no", ignoreDuplicates: true },
      );
    }

    const state = await computeBatchState(sb, id);
    return NextResponse.json({ ok: true, known: true, alreadyScanned, ...state });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "스캔 실패") }, { status: 500 });
  }
}
