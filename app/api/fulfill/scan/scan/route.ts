import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { currentActor } from "@/app/lib/b2b-activity";
import { computeTally, normInvoice } from "@/app/lib/fulfill-scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { invoice_no } — 송장 스캔(하이픈 무관 정규화·중복 무시) 후 최신 집계 반환.
//  속도 최적화: 미등록이면 재계산 없이 즉시 반환, 이벤트 존재확인은 upsert+select 한 번으로 합침,
//  집계는 '스캔된 송장'만 대상(computeTally). 대상 건수(totalInvoices)는 콜드 경로(/state)에서만 갱신.
export async function POST(req: NextRequest) {
  try {
    const { invoice_no } = (await req.json()) as { invoice_no?: string };
    const inv = normInvoice(invoice_no);
    if (!inv) return NextResponse.json({ ok: false, error: "송장번호가 비었습니다." }, { status: 400 });

    const sb = supabaseAdmin();

    // 풀에 존재하는 송장인지 — 없으면 상태 변화가 없으니 재계산 없이 즉시 반환(빠름).
    const { count: known } = await sb
      .from("fulfill_scan_items")
      .select("invoice_no", { count: "exact", head: true })
      .eq("invoice_no", inv);
    if (!known) return NextResponse.json({ ok: true, known: false, alreadyScanned: false });

    // 이벤트 삽입 + 중복여부를 한 번에: ignoreDuplicates 라 충돌 시 빈 배열 반환 → 이미 스캔.
    const actor = await currentActor();
    const { data: ins } = await sb
      .from("fulfill_scan_events")
      .upsert({ invoice_no: inv, scanned_by: actor }, { onConflict: "invoice_no", ignoreDuplicates: true })
      .select("invoice_no");
    const alreadyScanned = !ins || ins.length === 0;

    const tally = await computeTally(sb);
    return NextResponse.json({ ok: true, known: true, alreadyScanned, ...tally });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "스캔 실패") }, { status: 500 });
  }
}
