// =============================================
// 씨몬스터 팀 설정
// 이 파일만 수정 후 git push → vercel 재배포하면 반영됩니다
// =============================================

// =============================================
// AI 모델 — 여기 세 줄이 업무도우미의 모든 AI 기능(CS·VOC·리포트·AI 비서·에이전트·사업자등록증 OCR)의
// 실제 모델이다. 설정 화면(/b2b/settings/ai)과 DB 는 모델 ID 가 아니라 키(sonnet/haiku/opus)만 저장한다.
//   sonnet : 균형 (기본) — $2 / $10  per 1M 토큰 (Sonnet 5.5, 2026-09-29 전환 · 이전 4.6 $3 / $15)
//   haiku  : 저렴·빠름   — $1 / $5
//   opus   : 최고 품질   — $4 / $20 (Opus 5.5, 2026-09-29 전환 · 이전 4.8 $5 / $25)
// 5.x 는 답하기 전에 생각(adaptive thinking)한다 — 호출부는 ai-model.ts 의 effortParams(생각 강도)·readText(응답 읽기)를 쓴다.
//  되돌릴 때는 여기 두 줄만 이전 ID(claude-sonnet-4-6 / claude-opus-4-8)로 — effortParams 가 5.x 가 아니면 effort 를 보내지 않는다.
// 모델 ID는 별칭 그대로 사용 (날짜 접미사 붙이지 말 것).
// =============================================
export const MODELS = {
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-4-5",
  opus: "claude-opus-5-5",
  fable: "claude-fable-5-1", // 2026-10-19 추가 — Opus 위 등급(Mythos 급). 대표: 새 계정 크레딧(월 $200)으로 상위 모델 사용
} as const;

export type ModelKey = keyof typeof MODELS;

// 기본 AI 모델 — sonnet / haiku / opus 중 하나.
// 설정 화면(/b2b/settings)에서 바꾼 값이 있으면 그게 우선(app/lib/ai-model.ts).
export const DEFAULT_MODEL: ModelKey = "sonnet";

// 설정 화면에서 모델 버튼을 그릴 때 쓰는 메타 (클라이언트 import 안전 — supabase 미포함)
export const MODEL_OPTIONS: { key: ModelKey; label: string; desc: string; price: string }[] = [
  { key: "haiku", label: "빠름 · 저렴", desc: "간단한 작업, 가장 빠르고 저렴", price: "$1 / $5" },
  { key: "sonnet", label: "균형 (기본)", desc: "품질과 비용의 균형", price: "$2 / $10" },
  { key: "opus", label: "높은 품질", desc: "정확·신중 (비용 ↑)", price: "$4 / $20" },
  { key: "fable", label: "최상위", desc: "Opus 위 등급 — 가장 깊은 분석 (비용 ↑↑, 느림)", price: "콘솔 요금표" },
];
