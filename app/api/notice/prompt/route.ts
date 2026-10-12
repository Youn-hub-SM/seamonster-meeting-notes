import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getNoticePrompt, setNoticePrompt, DEFAULT_NOTICE_PROMPT } from "@/app/lib/notice";

export const dynamic = "force-dynamic";

// 권한: app/api/b2b/settings/cs-prompt/route.ts 와 같다 — 미들웨어 로그인 게이트만, 관리자 제한 없음(전원).

// GET /api/notice/prompt — 현재 톤 프롬프트 + 기본값
export async function GET() {
  try {
    const prompt = await getNoticePrompt();
    return NextResponse.json({
      ok: true,
      prompt,
      default: DEFAULT_NOTICE_PROMPT,
      isDefault: prompt === DEFAULT_NOTICE_PROMPT,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// PUT /api/notice/prompt — { prompt }  (빈 값이면 기본값으로 복원)
export async function PUT(req: NextRequest) {
  try {
    const { prompt } = (await req.json()) as { prompt?: string };
    await setNoticePrompt(typeof prompt === "string" ? prompt : "");
    const current = await getNoticePrompt();
    return NextResponse.json({ ok: true, prompt: current, isDefault: current === DEFAULT_NOTICE_PROMPT });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}
