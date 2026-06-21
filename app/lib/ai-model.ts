import { supabaseAdmin } from "./supabase";
import { MODELS, DEFAULT_MODEL, ModelKey } from "./config";

// 전역 AI 모델 설정 — b2b_settings(key-value) 테이블의 'ai_model' 키에 저장.
// 회의록·문장교정·CS 코치가 호출 시 이 값을 읽어 사용. (OCR 은 정확도 위해 sonnet 고정, 별개)
// 코드 수정·재배포 없이 /b2b/settings 화면에서 바꿀 수 있음.

const MODEL_SETTING_KEY = "ai_model";

// 현재 선택된 모델 키. 설정이 없거나 DB 오류면 기본값(sonnet).
export async function getAiModelKey(): Promise<ModelKey> {
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("b2b_settings")
      .select("value")
      .eq("key", MODEL_SETTING_KEY)
      .maybeSingle();
    if (error || !data) return DEFAULT_MODEL;
    const v = data.value as { key?: string } | string | null;
    const key = typeof v === "string" ? v : v?.key;
    return key && key in MODELS ? (key as ModelKey) : DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

export async function setAiModelKey(key: ModelKey): Promise<void> {
  const sb = supabaseAdmin();
  const { error } = await sb
    .from("b2b_settings")
    .upsert(
      { key: MODEL_SETTING_KEY, value: { key }, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
  if (error) throw error;
}

// 실제 모델 ID 문자열 (anthropic.messages.create 의 model 인자).
export async function getCurrentModel(): Promise<string> {
  const key = await getAiModelKey();
  return MODELS[key] ?? MODELS.sonnet;
}

// ─────────────────────────────────────────────
// CS 코치 전용 모델 (전체 설정과 별개로 둘 수 있음)
//  - "inherit": 전체 모델을 따름 (기본)
//  - 모델 키: CS 코치만 그 모델 사용
// ─────────────────────────────────────────────
const CS_MODEL_SETTING_KEY = "ai_model_cs";

export async function getCsModelKey(): Promise<ModelKey | "inherit"> {
  try {
    const sb = supabaseAdmin();
    const { data, error } = await sb
      .from("b2b_settings")
      .select("value")
      .eq("key", CS_MODEL_SETTING_KEY)
      .maybeSingle();
    if (error || !data) return "inherit";
    const v = data.value as { key?: string } | string | null;
    const key = typeof v === "string" ? v : v?.key;
    return key && key in MODELS ? (key as ModelKey) : "inherit";
  } catch {
    return "inherit";
  }
}

export async function setCsModelKey(key: ModelKey | "inherit"): Promise<void> {
  const sb = supabaseAdmin();
  const { error } = await sb
    .from("b2b_settings")
    .upsert(
      { key: CS_MODEL_SETTING_KEY, value: { key }, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );
  if (error) throw error;
}

// CS 코치가 실제로 쓸 모델 ID. CS 전용 설정이 있으면 그것, 없으면(inherit) 전체 모델.
export async function getCsModel(): Promise<string> {
  const csKey = await getCsModelKey();
  if (csKey !== "inherit") return MODELS[csKey] ?? MODELS.sonnet;
  return getCurrentModel();
}
