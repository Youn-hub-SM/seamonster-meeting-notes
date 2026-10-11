import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { chunks, maybeInterrupted, missingColumn, missingTable } from "@/app/lib/fulfill-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// CN 파일을 받았지만 ④ 상품 출고를 안 한 배치(135) — 실물은 나갔는데 재고·처리완료 표시가 없는 상태를 드러낸다(S12).
//  GET  → 최근 14일, [발송 안 함] 처리 안 한 것. 135 미적용이면 빈 목록(applied:false).
//  POST { sig, action: "downloaded" | "discard" } — CN 다운로드 기록 / 발송 안 함(목록에서 뺌).
const SIG_RE = /^[0-9a-f]{16}$/i;
const COLS_RE = /downloaded_at|discarded_at|file_name|order_count|total_qty/i;

export async function GET() {
  try {
    const sb = supabaseAdmin();
    const since = new Date(Date.now() - 14 * 86400e3).toISOString();
    const { data, error } = await sb.from("fulfill_pending_keys").select("sig, file_name, order_count, total_qty, downloaded_at")
      .not("downloaded_at", "is", null).is("discarded_at", null).gte("downloaded_at", since)
      .order("downloaded_at", { ascending: false }).range(0, 199);
    if (error) {
      if (missingColumn(error, COLS_RE) || missingTable(error)) return NextResponse.json({ ok: true, batches: [], applied: false });
      throw error;
    }
    const rows = (data ?? []) as { sig: string; file_name: string | null; order_count: number | null; total_qty: number | null; downloaded_at: string }[];
    // 출고 완료됐는데 대기 키 삭제만 실패해 남은 행은 뺀다. 출고 이력이 있어도 재고 행이 하나도 없으면(2분 지난 중단된 출고)
    //  남긴다 — 이력만 보고 빼면 중간에 끊긴 출고가 이 목록에서도 사라져 재고가 안 빠진 걸 아무도 모른다(S12).
    const done = new Set<string>();
    const interrupted = new Set<string>();
    for (const part of chunks(rows.map((r) => r.sig), 150)) {
      const { data: d, error: de } = await sb.from("fulfill_dispatch").select("sig, group_id, sku_count, created_at").in("sig", part);
      if (de) throw de;
      for (const r of (d ?? []) as { sig: string; group_id: string | null; sku_count: number | null; created_at: string }[]) {
        if (done.has(r.sig)) continue;
        if (maybeInterrupted(r)) {
          const { count, error: ce } = await sb.from("inventory_txns").select("id", { count: "exact", head: true }).eq("group_id", r.group_id!);
          if (ce) throw ce;
          if ((count ?? 0) === 0) { interrupted.add(r.sig); continue; }
        }
        done.add(r.sig);
      }
    }
    const batches = rows.filter((r) => !done.has(r.sig)).map((r) => ({ ...r, interrupted: interrupted.has(r.sig) }));
    return NextResponse.json({ ok: true, applied: true, batches });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "조회 실패") }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as { sig?: string; action?: string };
    const sig = String(b.sig || "").toLowerCase();
    if (!SIG_RE.test(sig)) return NextResponse.json({ ok: false, error: "배치 서명이 올바르지 않습니다." }, { status: 400 });
    const sb = supabaseAdmin();
    if (b.action === "downloaded") {
      const { error } = await sb.from("fulfill_pending_keys").update({ downloaded_at: new Date().toISOString(), discarded_at: null }).eq("sig", sig);
      if (error && !missingColumn(error, COLS_RE) && !missingTable(error)) throw error;
      return NextResponse.json({ ok: true });
    }
    if (b.action === "discard") {
      const { data, error } = await sb.from("fulfill_pending_keys").update({ discarded_at: new Date().toISOString() }).eq("sig", sig).is("discarded_at", null).select("sig");
      if (error) throw error;
      if (!data?.length) return NextResponse.json({ ok: false, error: "이미 정리된 배치입니다 — 새로고침하세요." }, { status: 404 });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ ok: false, error: "알 수 없는 동작입니다." }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "저장 실패") }, { status: 500 });
  }
}
