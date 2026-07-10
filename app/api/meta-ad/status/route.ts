import { NextResponse } from "next/server";
import { isMetaAdConfigured, pingMetaAd } from "@/app/lib/meta-ad";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — 메타 광고 자격/연결 상태. 자격 없으면 configured:false.
export async function GET() {
  if (!isMetaAdConfigured()) return NextResponse.json({ ok: true, configured: false });
  try {
    const p = await pingMetaAd();
    return NextResponse.json({ ok: true, configured: true, connected: true, account: { name: p.name, status: p.accountStatus } });
  } catch (err) {
    return NextResponse.json({ ok: true, configured: true, connected: false, error: err instanceof Error ? err.message : "연결 실패" });
  }
}
