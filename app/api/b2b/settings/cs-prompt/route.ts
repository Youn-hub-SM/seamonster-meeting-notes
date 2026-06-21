import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getCsPrompt, setCsPrompt, DEFAULT_CS_PROMPT } from "@/app/lib/cs";

export const dynamic = "force-dynamic";

// GET /api/b2b/settings/cs-prompt — 현재 코치 지침 + 기본값
export async function GET() {
  try {
    const prompt = await getCsPrompt();
    return NextResponse.json({
      ok: true,
      prompt,
      default: DEFAULT_CS_PROMPT,
      isDefault: prompt === DEFAULT_CS_PROMPT,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// PUT /api/b2b/settings/cs-prompt — { prompt }  (빈 값이면 기본값으로 복원)
export async function PUT(req: NextRequest) {
  try {
    const { prompt } = (await req.json()) as { prompt?: string };
    await setCsPrompt(typeof prompt === "string" ? prompt : "");
    const current = await getCsPrompt();
    return NextResponse.json({ ok: true, prompt: current, isDefault: current === DEFAULT_CS_PROMPT });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}
