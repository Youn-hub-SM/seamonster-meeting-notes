import { supabaseAdmin } from "./supabase";
import { MODELS, DEFAULT_MODEL, ModelKey } from "./config";

// AI 모델 설정 — b2b_settings(key-value) 테이블에 저장. 코드 수정·재배포 없이
// /b2b/settings/ai 화면에서 기능별로 바꿀 수 있음. (사업자등록증 OCR 은 정확도 위해 sonnet 고정, 별개)
//
//  · ai_model            : 공통 기본 모델(전역). 기능별 설정이 'inherit' 이면 이걸 따름.
//  · ai_model_<feature>  : 기능별 모델. 'inherit'(공통 따름·기본) 또는 특정 모델 키.

const MODEL_SETTING_KEY = "ai_model";

async function readModelKey(settingKey: string): Promise<string | null> {
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb.from("b2b_settings").select("value").eq("key", settingKey).maybeSingle();
    if (error || !data) return null;
    const v = data.value as { key?: string } | string | null;
    const key = typeof v === "string" ? v : v?.key;
    return key ?? null;
  } catch {
    return null;
  }
}

async function writeModelKey(settingKey: string, key: string): Promise<void> {
  const sb = supabaseAdmin();
  const { error } = await sb
    .from("b2b_settings")
    .upsert({ key: settingKey, value: { key }, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw error;
}

// ── 공통 기본(전역) 모델 ──
export async function getAiModelKey(): Promise<ModelKey> {
  const key = await readModelKey(MODEL_SETTING_KEY);
  return key && key in MODELS ? (key as ModelKey) : DEFAULT_MODEL;
}
export async function setAiModelKey(key: ModelKey): Promise<void> {
  await writeModelKey(MODEL_SETTING_KEY, key);
}
// 실제 모델 ID 문자열 (anthropic.messages.create 의 model 인자). 공통 기본.
export async function getCurrentModel(): Promise<string> {
  const key = await getAiModelKey();
  return MODELS[key] ?? MODELS.sonnet;
}

// ── 기능별 모델 ──
export type AiFeature = "meeting" | "cs" | "correct" | "voc" | "production";
export const AI_FEATURES: { key: AiFeature; label: string; desc: string }[] = [
  { key: "meeting", label: "회의록 정리", desc: "회의 녹취 요약·정리" },
  { key: "cs", label: "CS 코치", desc: "CS 응대 코칭·답변 초안" },
  { key: "correct", label: "문장 교정", desc: "문장 다듬기·교정" },
  { key: "voc", label: "VOC 인사이트", desc: "VOC 인사이트·설문 분석·제조사 리포트" },
  { key: "production", label: "생산·재고 조언", desc: "생산/재고 AI 조언" },
];
const FEATURE_SETTING_KEY: Record<AiFeature, string> = {
  meeting: "ai_model_meeting",
  cs: "ai_model_cs", // 기존 CS 전용 키와 동일(하위호환)
  correct: "ai_model_correct",
  voc: "ai_model_voc",
  production: "ai_model_production",
};

// 기능별 설정값: 'inherit'(공통 따름·기본) 또는 특정 모델 키.
export async function getFeatureModelKey(f: AiFeature): Promise<ModelKey | "inherit"> {
  const key = await readModelKey(FEATURE_SETTING_KEY[f]);
  return key && key in MODELS ? (key as ModelKey) : "inherit";
}
export async function setFeatureModelKey(f: AiFeature, key: ModelKey | "inherit"): Promise<void> {
  await writeModelKey(FEATURE_SETTING_KEY[f], key);
}
// 기능이 실제로 쓸 모델 ID. 기능 설정이 있으면 그것, 없으면(inherit) 공통 기본.
export async function getFeatureModel(f: AiFeature): Promise<string> {
  const k = await getFeatureModelKey(f);
  if (k !== "inherit") return MODELS[k] ?? MODELS.sonnet;
  return getCurrentModel();
}

// ── 하위호환: 기존 CS 전용 API (동일 키 ai_model_cs 사용) ──
export const getCsModelKey = (): Promise<ModelKey | "inherit"> => getFeatureModelKey("cs");
export const setCsModelKey = (key: ModelKey | "inherit"): Promise<void> => setFeatureModelKey("cs", key);
export const getCsModel = (): Promise<string> => getFeatureModel("cs");
