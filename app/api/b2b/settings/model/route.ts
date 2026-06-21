import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getAiModelKey, setAiModelKey } from "@/app/lib/ai-model";
import { MODELS, MODEL_OPTIONS, ModelKey } from "@/app/lib/config";

export const dynamic = "force-dynamic";

// GET /api/b2b/settings/model — 현재 모델 키 + 선택지
export async function GET() {
  try {
    const current = await getAiModelKey();
    return NextResponse.json({ ok: true, current, options: MODEL_OPTIONS });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// PUT /api/b2b/settings/model — { key } 로 모델 변경
export async function PUT(req: NextRequest) {
  try {
    const { key } = (await req.json()) as { key?: string };
    if (!key || !(key in MODELS)) {
      return NextResponse.json({ ok: false, error: "유효하지 않은 모델입니다." }, { status: 400 });
    }
    await setAiModelKey(key as ModelKey);
    return NextResponse.json({ ok: true, current: key });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}
