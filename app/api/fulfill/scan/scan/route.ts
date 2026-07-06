import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { currentActor } from "@/app/lib/b2b-activity";
import { computePoolState, normInvoice } from "@/app/lib/fulfill-scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { invoice_no } — 송장 스캔(하이픈 무관 정규화·중복 무시) 후 최신 집계 반환
export async function POST(req: NextRequest) {
  try {
    const { invoice_no } = (await req.json()) as { invoice_no?: string };
    const inv = normInvoice(invoice_no);
    if (!inv) return NextResponse.json({ ok: false, error: "송장번호가 비었습니다." }, { status: 400 });

    const sb = supabaseAdmin();

    // 풀에 존재하는 송장인지
    const { count: known } = await sb
      .from("fulfill_scan_items")
      .select("invoice_no", { count: "exact", head: true })
      .eq("invoice_no", inv);
    if (!known) {
      const state = await computePoolState(sb);
      return NextResponse.json({ ok: true, known: false, alreadyScanned: false, ...state });
    }

    // 이미 스캔됐는지
    const { data: existed } = await sb.from("fulfill_scan_events").select("invoice_no").eq("invoice_no", inv).maybeSingle();
    const alreadyScanned = !!existed;
    if (!alreadyScanned) {
      const actor = await currentActor();
      await sb.from("fulfill_scan_events").upsert(
        { invoice_no: inv, scanned_by: actor, scanned_at: new Date().toISOString() },
        { onConflict: "invoice_no", ignoreDuplicates: true },
      );
    }

    const state = await computePoolState(sb);
    return NextResponse.json({ ok: true, known: true, alreadyScanned, ...state });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "스캔 실패") }, { status: 500 });
  }
}
