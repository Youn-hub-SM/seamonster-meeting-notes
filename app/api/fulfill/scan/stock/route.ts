import { NextResponse } from "next/server";
import { supabaseAdmin, extractErrorMsg } from "@/app/lib/supabase";
import { computeScanStock } from "@/app/lib/fulfill-scan-stock";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — 이번 라운드 집계 + 소매 재고가 모자란 품목(부족량). 읽기 전용.
//  스캔 화면이 [인쇄]를 누를 때 한 번 부른다 — 스캔마다 재고를 읽지 않아 스캔 속도는 그대로다.
//  checked=false 면 재고를 읽지 못한 것이다(부족 없음이 아니다) — 화면이 인쇄물 맨 위에 그렇게 찍는다.
export async function GET() {
  try {
    return NextResponse.json({ ok: true, ...(await computeScanStock(supabaseAdmin())) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(e, "조회 실패") }, { status: 500 });
  }
}
