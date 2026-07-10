import { NextResponse } from "next/server";
import { isMetaAdConfigured, metaDiagnostics } from "@/app/lib/meta-ad";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 임시 진단용: 토큰 타입·만료·스코프·접근계정. 확인 후 삭제.
export async function GET() {
  if (!isMetaAdConfigured()) return NextResponse.json({ ok: false, configured: false });
  try {
    return NextResponse.json({ ok: true, ...(await metaDiagnostics()) });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "진단 실패" }, { status: 500 });
  }
}
