import { NextRequest, NextResponse } from "next/server";
import { setEntityStatus } from "@/app/lib/meta-ad";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { id, status: "ACTIVE"|"PAUSED" } — 광고/광고세트/캠페인 켜기·끄기.
export async function POST(req: NextRequest) {
  try {
    const { id, status } = (await req.json()) as { id?: string; status?: string };
    if (!id) return NextResponse.json({ ok: false, error: "id 가 필요합니다." }, { status: 400 });
    if (status !== "ACTIVE" && status !== "PAUSED") return NextResponse.json({ ok: false, error: "status 는 ACTIVE/PAUSED 여야 합니다." }, { status: 400 });
    await setEntityStatus(id, status);
    return NextResponse.json({ ok: true, id, status });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "상태 변경 실패" }, { status: 500 });
  }
}
