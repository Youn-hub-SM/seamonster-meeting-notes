import { NextResponse } from "next/server";
import { isNaverAdConfigured, pingNaverAd } from "@/app/lib/naver-ad";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — 자격 설정 여부 + (설정 시) 라이브 연결 확인
export async function GET() {
  const configured = isNaverAdConfigured();
  if (!configured) return NextResponse.json({ ok: true, configured: false });
  try {
    const p = await pingNaverAd();
    return NextResponse.json({ ok: true, configured: true, connected: true, campaigns: p.campaigns });
  } catch (err) {
    return NextResponse.json({ ok: true, configured: true, connected: false, error: err instanceof Error ? err.message : "연결 실패" });
  }
}
