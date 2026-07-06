import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getMarginPrompt, setMarginPrompt, DEFAULT_MARGIN_PROMPT } from "@/app/lib/margin-calc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/sales/margin-calc/prompt — 현재 계산기 지침 + 기본값
export async function GET() {
  try {
    const prompt = await getMarginPrompt();
    return NextResponse.json({
      ok: true,
      prompt,
      default: DEFAULT_MARGIN_PROMPT,
      isDefault: prompt === DEFAULT_MARGIN_PROMPT,
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// PUT /api/sales/margin-calc/prompt — { prompt } (빈 값이면 기본값으로 복원)
export async function PUT(req: NextRequest) {
  try {
    const { prompt } = (await req.json()) as { prompt?: string };
    await setMarginPrompt(typeof prompt === "string" ? prompt : "");
    const current = await getMarginPrompt();
    return NextResponse.json({ ok: true, prompt: current, isDefault: current === DEFAULT_MARGIN_PROMPT });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}
