import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { computePoolState, lastScanClear, scanStateVersion } from "@/app/lib/fulfill-scan";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET ?v=<버전> — 풀 현재 집계 + 최근 스캔.
//  2026-11-03: 이 경로가 Vercel Active CPU 1위(하루 660회·회당 2.5초)였다 — 스캔 화면이 30초마다 전량 집계를 시켰기 때문.
//  이제 버전(작은 조회 5개)을 먼저 비교해 화면이 가진 것과 같으면 집계 없이 { unchanged: true } 만 돌려주고,
//  바뀌었을 때만 집계한다. 같은 버전은 인스턴스 메모리에 한 벌 캐시해 여러 화면이 동시에 열려 있어도 한 번만 계산한다.
type Payload = Record<string, unknown>;
let cache: { version: string; payload: Payload } | null = null;

export async function GET(req: NextRequest) {
  try {
    const sb = supabaseAdmin();
    const want = req.nextUrl.searchParams.get("v") || "";
    const version = await scanStateVersion(sb);
    const cacheable = !version.includes("err");
    if (want && cacheable && want === version) return NextResponse.json({ ok: true, unchanged: true, version });
    if (cacheable && cache && cache.version === version) return NextResponse.json({ ok: true, version, ...cache.payload });

    const [state, lastReset] = await Promise.all([computePoolState(sb), lastScanClear(sb)]);
    // 최근 스캔 = 이번 라운드만(125 미적용이면 칸이 없어 전부)
    const q = () => sb.from("fulfill_scan_events").select("invoice_no, scanned_at, scanned_by").order("scanned_at", { ascending: false }).limit(50);
    let rec = await q().is("cleared_at", null);
    if (rec.error && /cleared_at/i.test(rec.error.message)) rec = await q();
    const payload: Payload = { ...state, recent: rec.data ?? [], lastReset };
    if (cacheable) cache = { version, payload };
    return NextResponse.json({ ok: true, version, ...payload });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "조회 실패") + " (057 적용 확인)" }, { status: 500 });
  }
}
