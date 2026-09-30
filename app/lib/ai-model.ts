import type Anthropic from "@anthropic-ai/sdk";
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
export type AiFeature = "meeting" | "cs" | "voc" | "production" | "report" | "briefing" | "margin" | "daily_analyst";
// inheritDefault: 기능 설정이 'inherit' 일 때 공통 기본 대신 쓰는 모델(정확도가 중요한 기능). 없으면 공통 기본을 따른다.
export const AI_FEATURES: { key: AiFeature; label: string; desc: string; inheritDefault?: ModelKey }[] = [
  { key: "meeting", label: "회의록 정리", desc: "회의 녹취 요약·정리" },
  { key: "cs", label: "CS 코치", desc: "CS 응대 코칭·답변 초안" },
  { key: "voc", label: "VOC 인사이트", desc: "VOC 인사이트·설문 분석·제조사 리포트" },
  { key: "production", label: "생산·재고 조언", desc: "생산/재고 AI 조언" },
  { key: "report", label: "커스텀 리포트", desc: "자연어→SQL 데이터 조회 (기본 opus·정교)", inheritDefault: "opus" },
  { key: "briefing", label: "업무 브리핑(중단)", desc: "06:30 업무 브리핑 — 2026-09-30 자동 생성 중단, 관리자용 재구성 전까지 미사용 (기본 opus)", inheritDefault: "opus" },
  { key: "margin", label: "이익률 계산기", desc: "AI 이익률 계산 (기본 sonnet — 2026-09-29 opus 에서 전환)", inheritDefault: "sonnet" },
  { key: "daily_analyst", label: "일일 종합 리포트(어제 분석)", desc: "어제 매출·광고 분석 에이전트 (기본 opus — 2026-09-30 대표 선택)", inheritDefault: "opus" },
];
const FEATURE_SETTING_KEY: Record<AiFeature, string> = {
  meeting: "ai_model_meeting",
  cs: "ai_model_cs", // 기존 CS 전용 키와 동일(하위호환)
  voc: "ai_model_voc",
  production: "ai_model_production",
  report: "ai_model_report",
  briefing: "ai_model_briefing",
  margin: "ai_model_margin",
  daily_analyst: "ai_model_daily_analyst",
};

// 기능별 설정값: 'inherit'(공통 따름·기본) 또는 특정 모델 키.
export async function getFeatureModelKey(f: AiFeature): Promise<ModelKey | "inherit"> {
  const key = await readModelKey(FEATURE_SETTING_KEY[f]);
  return key && key in MODELS ? (key as ModelKey) : "inherit";
}
export async function setFeatureModelKey(f: AiFeature, key: ModelKey | "inherit"): Promise<void> {
  await writeModelKey(FEATURE_SETTING_KEY[f], key);
}
// 기능이 실제로 쓸 모델 ID. 기능 설정이 있으면 그것, 없으면(inherit) 그 기능의 기본(inheritDefault) 또는 공통 기본.
export async function getFeatureModel(f: AiFeature): Promise<string> {
  const k = await getFeatureModelKey(f);
  if (k !== "inherit") return MODELS[k] ?? MODELS.sonnet;
  const def = AI_FEATURES.find((x) => x.key === f)?.inheritDefault;
  return def ? MODELS[def] : getCurrentModel();
}

// ── 생각 강도(effort) — 5.x 모델(Sonnet 5.5·Opus 5.5)에만 보낸다 ──
//  5.x 는 답하기 전에 생각(adaptive thinking)을 하고, 생략하면 Sonnet 은 high·Opus 는 medium 으로 돌아 비용·지연이 커진다.
//  Haiku 4.5 는 effort 를 받으면 400 이고, 4.6/4.8 로 되돌렸을 때도 요청이 종전과 같도록 그 밖의 모델엔 보내지 않는다.
export function effortParams(model: string, effort: "low" | "medium" | "high"): Pick<Anthropic.MessageCreateParamsNonStreaming, "output_config"> {
  return /^claude-(opus|sonnet)-5/.test(model) ? { output_config: { effort } } : {};
}

// ── 응답 텍스트 읽기 — 블록 종류로 읽고, 거절·잘림을 먼저 가린다 ──
//  5.x 응답은 빈 thinking 블록으로 시작할 수 있어 content[0] 을 읽으면 빈 문자열이 된다.
//  안전 필터 거절(stop_reason 'refusal')과 출력 한도 잘림('max_tokens')은 조용히 빈/깨진 결과가 되지 않게 오류로 올린다.
export class AiResponseError extends Error {}
export function readText(resp: Anthropic.Message, opts?: { allowTruncated?: boolean }): string {
  if (resp.stop_reason === "refusal") {
    const cat = resp.stop_details?.category;
    throw new AiResponseError(`AI 안전 필터가 응답을 거절했습니다${cat ? `(${cat})` : ""} — 표현을 바꿔 다시 시도해 주세요.`);
  }
  if (resp.stop_reason === "max_tokens" && !opts?.allowTruncated) {
    throw new AiResponseError("AI 결과가 길어 중간에 잘렸습니다 — 범위를 나눠 다시 시도해 주세요.");
  }
  return resp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
}

// ── 하위호환: 기존 CS 전용 API (동일 키 ai_model_cs 사용) ──
export const getCsModelKey = (): Promise<ModelKey | "inherit"> => getFeatureModelKey("cs");
export const setCsModelKey = (key: ModelKey | "inherit"): Promise<void> => setFeatureModelKey("cs", key);
export const getCsModel = (): Promise<string> => getFeatureModel("cs");
