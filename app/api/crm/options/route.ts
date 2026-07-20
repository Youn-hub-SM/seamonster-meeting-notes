import { NextRequest, NextResponse } from "next/server";
import { getCrmOptions, saveCrmOptions } from "@/app/lib/crm-options";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — 현재 선택지(미저장이면 기본값)
export async function GET() {
  try {
    return NextResponse.json({ ok: true, options: await getCrmOptions() });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "조회 실패" }, { status: 500 });
  }
}

// POST { options } — 저장(서버에서 정제: 공백 제거·중복 제거·개수 상한·빈 목록은 기본값 복귀)
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { options?: unknown };
    const saved = await saveCrmOptions(body.options);
    return NextResponse.json({ ok: true, options: saved });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "저장 실패" }, { status: 500 });
  }
}
