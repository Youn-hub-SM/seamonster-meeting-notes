import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getNoticePrompt, setNoticePrompt, DEFAULT_NOTICE_PROMPT } from "@/app/lib/notice";
import { adminOnly } from "@/app/lib/admin-req";

export const dynamic = "force-dynamic";

// 권한: 조회는 로그인 전원, 저장은 관리자만(2026-10-22 — 공지 작성기 화면이 사라지고 관리자 › 설정 › AI 에서만 편집).

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
  const deny = await adminOnly(req); if (deny) return deny;
  try {
    const { prompt } = (await req.json()) as { prompt?: string };
    await setNoticePrompt(typeof prompt === "string" ? prompt : "");
    const current = await getNoticePrompt();
    return NextResponse.json({ ok: true, prompt: current, isDefault: current === DEFAULT_NOTICE_PROMPT });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}
