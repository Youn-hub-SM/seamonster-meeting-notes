import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { currentActor } from "@/app/lib/b2b-activity";
import { computeTally, normInvoice } from "@/app/lib/fulfill-scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { invoice_no } — 송장 스캔(하이픈 무관 정규화·중복 무시) 후 최신 집계 반환.
//  이전 라운드(초기화로 마감, 30일 보관 — 125)에서 찍은 송장이면 prevRound 로 알리고 집계에 넣지 않는다(이중 출고 방지).
//  include_prev=true(알고 다시 찍는 경우 — 경고 줄의 [이번 라운드에 넣기]·F8, '이전 라운드 송장도 넣기' 스위치)면
//  그 송장을 이번 라운드로 옮겨 집계에 넣고 moved 로 알린다.
//  속도 최적화: 미등록이면 재계산 없이 즉시 반환, 이벤트 존재확인은 upsert+select 한 번으로 합침,
//  집계는 '스캔된 송장'만 대상(computeTally). 대상 건수(totalInvoices)는 콜드 경로(/state)에서만 갱신.
export async function POST(req: NextRequest) {
  try {
    const { invoice_no, include_prev } = (await req.json()) as { invoice_no?: string; include_prev?: boolean };
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
    const { data: ins, error: ie } = await sb
      .from("fulfill_scan_events")
      .upsert({ invoice_no: inv, scanned_by: actor }, { onConflict: "invoice_no", ignoreDuplicates: true })
      .select("invoice_no");
    if (ie) throw ie; // 실패를 '이미 스캔'으로 오인하면 첫 스캔이 조용히 빠진다 — 오류로 알려 다시 찍게
    const alreadyScanned = !ins || ins.length === 0;
    // 이미 있던 행 — 이번 라운드인지, 마감된 이전 라운드인지(125 미적용이면 칸이 없어 이번 라운드로 본다)
    let prevRound: { scanned_at: string; scanned_by: string | null } | null = null;
    let moved = false;
    if (alreadyScanned) {
      const { data: row, error: re } = await sb.from("fulfill_scan_events").select("scanned_at, scanned_by, cleared_at").eq("invoice_no", inv).maybeSingle();
      const r = row as { scanned_at: string; scanned_by: string | null; cleared_at: string | null } | null;
      if (!re && r?.cleared_at) {
        prevRound = { scanned_at: r.scanned_at, scanned_by: r.scanned_by };
        if (include_prev) {
          // 알고 다시 찍음 — 이번 라운드로(스캔 시각·담당은 지금 것으로). 마감된 행만 바꿔 동시 요청에도 한 번만.
          const { data: mv, error: me } = await sb.from("fulfill_scan_events")
            .update({ cleared_at: null, scanned_at: new Date().toISOString(), scanned_by: actor })
            .eq("invoice_no", inv).not("cleared_at", "is", null).select("invoice_no");
          if (me) throw me;
          moved = (mv ?? []).length > 0;
        }
      }
    }

    const tally = await computeTally(sb);
    return NextResponse.json({ ok: true, known: true, alreadyScanned, prevRound, moved, ...tally });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "스캔 실패") }, { status: 500 });
  }
}
