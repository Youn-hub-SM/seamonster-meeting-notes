import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getMeetingPrompt, setMeetingPrompt, DEFAULT_MEETING_PROMPT } from "@/app/lib/claude";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/b2b/settings/meeting-prompt — 현재 회의록 정리 지침 + 기본값
export async function GET() {
  try {
    const prompt = await getMeetingPrompt();
    return NextResponse.json({
      ok: true,
      prompt,
      default: DEFAULT_MEETING_PROMPT,
      isDefault: prompt === DEFAULT_MEETING_PROMPT,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// PUT /api/b2b/settings/meeting-prompt — { prompt }  (빈 값이면 기본값으로 복원)
export async function PUT(req: NextRequest) {
  try {
    const { prompt } = (await req.json()) as { prompt?: string };
    await setMeetingPrompt(typeof prompt === "string" ? prompt : "");
    const current = await getMeetingPrompt();
    return NextResponse.json({ ok: true, prompt: current, isDefault: current === DEFAULT_MEETING_PROMPT });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}
