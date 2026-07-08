import { NextRequest, NextResponse } from "next/server";
import { extractErrorMsg } from "@/app/lib/supabase";
import {
  getAiModelKey, setAiModelKey,
  getFeatureModelKey, setFeatureModelKey,
  AI_FEATURES, type AiFeature,
} from "@/app/lib/ai-model";
import { MODELS, MODEL_OPTIONS, ModelKey } from "@/app/lib/config";

export const dynamic = "force-dynamic";

const FEATURE_KEYS = AI_FEATURES.map((f) => f.key) as AiFeature[];
const isFeature = (s: string): s is AiFeature => (FEATURE_KEYS as string[]).includes(s);

// GET /api/b2b/settings/model — 공통 기본 모델 + 기능별 모델 + 선택지/메타
export async function GET() {
  try {
    const [global, ...featVals] = await Promise.all([
      getAiModelKey(),
      ...FEATURE_KEYS.map((f) => getFeatureModelKey(f)),
    ]);
    const features: Record<string, string> = {};
    FEATURE_KEYS.forEach((k, i) => { features[k] = featVals[i]; });
    return NextResponse.json({ ok: true, global, features, options: MODEL_OPTIONS, featureMeta: AI_FEATURES });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "조회 실패") }, { status: 500 });
  }
}

// PUT /api/b2b/settings/model — { scope, key }
//  - scope "global": key 는 모델 키
//  - scope 가 기능 키(meeting/cs/correct/voc/production): key 는 모델 키 또는 "inherit"(공통 따름)
export async function PUT(req: NextRequest) {
  try {
    const { scope = "global", key } = (await req.json()) as { scope?: string; key?: string };

    if (scope === "global") {
      if (!key || !(key in MODELS)) {
        return NextResponse.json({ ok: false, error: "유효하지 않은 모델입니다." }, { status: 400 });
      }
      await setAiModelKey(key as ModelKey);
      return NextResponse.json({ ok: true, scope: "global", key });
    }

    if (!isFeature(scope)) {
      return NextResponse.json({ ok: false, error: "알 수 없는 기능입니다." }, { status: 400 });
    }
    if (key !== "inherit" && !(key && key in MODELS)) {
      return NextResponse.json({ ok: false, error: "유효하지 않은 모델입니다." }, { status: 400 });
    }
    await setFeatureModelKey(scope, key === "inherit" ? "inherit" : (key as ModelKey));
    return NextResponse.json({ ok: true, scope, key });
  } catch (err) {
    return NextResponse.json({ ok: false, error: extractErrorMsg(err, "저장 실패") }, { status: 500 });
  }
}
