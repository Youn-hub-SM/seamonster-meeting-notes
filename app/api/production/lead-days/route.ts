import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getLeadDays, setLeadDays, DEFAULT_LEAD_DAYS } from "@/app/lib/production-config";

export const dynamic = "force-dynamic";

// GET — 현재 생산 리드타임(일)
export async function GET() {
  try {
    const leadDays = await getLeadDays();
    return NextResponse.json({ ok: true, leadDays, default: DEFAULT_LEAD_DAYS });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// PUT { days } — 생산 리드타임 저장 (1~60일로 클램프)
export async function PUT(req: NextRequest) {
  try {
    const { days } = (await req.json()) as { days?: number };
    const leadDays = await setLeadDays(Number(days));
    return NextResponse.json({ ok: true, leadDays });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}
