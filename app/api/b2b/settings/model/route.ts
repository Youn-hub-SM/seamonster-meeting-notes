import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import { getAiModelKey, setAiModelKey, getCsModelKey, setCsModelKey } from "@/app/lib/ai-model";
import { MODELS, MODEL_OPTIONS, ModelKey } from "@/app/lib/config";

export const dynamic = "force-dynamic";

// GET /api/b2b/settings/model — 전체 모델 + CS 전용 모델 + 선택지
export async function GET() {
  try {
    const [global, cs] = await Promise.all([getAiModelKey(), getCsModelKey()]);
    return NextResponse.json({ ok: true, global, cs, options: MODEL_OPTIONS });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// PUT /api/b2b/settings/model — { scope?: "global"|"cs", key }
//  - global: key 는 모델 키
//  - cs: key 는 모델 키 또는 "inherit"(전체 설정 따름)
export async function PUT(req: NextRequest) {
  try {
    const { scope = "global", key } = (await req.json()) as { scope?: "global" | "cs"; key?: string };

    if (scope === "cs") {
      if (key !== "inherit" && !(key && key in MODELS)) {
        return NextResponse.json({ ok: false, error: "유효하지 않은 모델입니다." }, { status: 400 });
      }
      await setCsModelKey(key === "inherit" ? "inherit" : (key as ModelKey));
      return NextResponse.json({ ok: true, scope, key });
    }

    // global
    if (!key || !(key in MODELS)) {
      return NextResponse.json({ ok: false, error: "유효하지 않은 모델입니다." }, { status: 400 });
    }
    await setAiModelKey(key as ModelKey);
    return NextResponse.json({ ok: true, scope: "global", key });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}
