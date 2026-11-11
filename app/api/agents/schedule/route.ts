import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { agentOf } from "@/app/lib/agents/registry";
import { getSchedule, setSchedule, normalizeSchedule, getLastTick } from "@/app/lib/agents/schedule";

export const dynamic = "force-dynamic";

// GET ?agent= — 예약 설정 + 예약 신호가 마지막으로 온 시각(migration 165 의 pg_cron 틱)
export async function GET(req: NextRequest) {
  try {
    const agent = req.nextUrl.searchParams.get("agent") || "";
    if (!agentOf(agent)) return NextResponse.json({ ok: false, error: "없는 에이전트입니다." }, { status: 400 });
    const [schedule, lastTick] = await Promise.all([getSchedule(agent), getLastTick()]);
    return NextResponse.json({ ok: true, schedule, lastTick: lastTick || null });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "예약을 불러오지 못했습니다") }, { status: 500 });
  }
}

// PUT { agent, on, weekday, hour } — 예약 저장(요일 0=일 … 6=토, 시각 0~23, 한국 시간)
export async function PUT(req: NextRequest) {
  try {
    const b = (await req.json()) as { agent?: string; on?: boolean; weekday?: number; hour?: number };
    const agent = String(b.agent || "");
    if (!agentOf(agent)) return NextResponse.json({ ok: false, error: "없는 에이전트입니다." }, { status: 400 });
    const schedule = normalizeSchedule(b);
    await setSchedule(agent, schedule);
    return NextResponse.json({ ok: true, schedule });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "예약을 저장하지 못했습니다") }, { status: 500 });
  }
}
