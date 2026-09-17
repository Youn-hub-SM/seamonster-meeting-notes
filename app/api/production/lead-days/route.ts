import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getLeadDays, setLeadDays, DEFAULT_LEAD_DAYS, getCycleDays, setCycleDays, DEFAULT_CYCLE_DAYS } from "@/app/lib/production-config";

export const dynamic = "force-dynamic";

// GET — 현재 생산 리드타임(일) + 발주 주기(일)
export async function GET() {
  try {
    const [leadDays, cycleDays] = await Promise.all([getLeadDays(), getCycleDays()]);
    return NextResponse.json({ ok: true, leadDays, cycleDays, default: DEFAULT_LEAD_DAYS, defaultCycle: DEFAULT_CYCLE_DAYS });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// PUT { days?, cycleDays? } — 생산 리드타임(1~60) · 발주 주기(0~30) 저장. 온 값만 바꾼다(구 화면은 days 만 보낸다).
export async function PUT(req: NextRequest) {
  try {
    const b = (await req.json()) as { days?: number; cycleDays?: number };
    const leadDays = b.days != null ? await setLeadDays(Number(b.days)) : await getLeadDays();
    const cycleDays = b.cycleDays != null ? await setCycleDays(Number(b.cycleDays)) : await getCycleDays();
    return NextResponse.json({ ok: true, leadDays, cycleDays });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}
