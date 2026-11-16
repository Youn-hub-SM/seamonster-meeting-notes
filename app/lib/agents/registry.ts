// AI 에이전트 등록부 — 화면(/agents)과 서버가 같이 읽는다(클라이언트 안전: DB·SDK import 없음).
//  에이전트 = 정해진 일을 맡은 AI. 버전은 없다(2026-11-16 대표: "항상 최신 버전만 사용") — 지침을 고치면 그것이 곧 지금 에이전트다.
//  새 에이전트 = 여기 한 줄 + 서버 실행기(app/lib/agents/run.ts RUNNERS 또는 STAGED)에 같은 id 로 등록.

export type AgentMeta = {
  id: string;          // agent_reports.agent
  name: string;        // 화면 이름
  output: string;      // 보고서로 만들 수 있는 것(버튼·문구용 명사)
  kind?: "ideas";      // 보고서 모양. 없으면 요청서 초안(품목·수량 → 결재). "ideas" = 소재 목록(결재 없음, 피드백으로 다시 쓰기)
  stages?: string[];   // 단계로 나눠 실행하는 에이전트의 단계 이름(순서대로) — 단계마다 함수 호출이 따로라 한 단계가 270초 안에만 끝나면 된다
  schedule?: AgentSchedule; // 예약 기본값(없으면 DEFAULT_SCHEDULE)
};

export const AGENTS: AgentMeta[] = [
  {
    id: "wholesale-request",
    name: "도매 생산 요청서",
    output: "도매 생산 요청서",
  },
  {
    id: "ad-copy",
    name: "광고 카피",
    output: "신규 소재 목록",
    kind: "ideas",
    stages: ["고객 목소리 분석", "타깃 트렌드 조사", "소재 기획", "카피 작성"],
    schedule: { on: false, weekday: 1, hour: 9 },
  },
];

export const agentOf = (id: string): AgentMeta | undefined => AGENTS.find((a) => a.id === id);

// ── 보고서(화면 계약) ──
export type AgentReportStatus = "running" | "done" | "error";
// 제안 품목 한 줄 — 수량·이유는 에이전트, 근거 숫자는 코드가 작성 시점 값으로 채운다(에이전트가 옮겨 적다 틀리지 않게).
export type DraftItem = {
  sku: string;
  product_id: string | null;   // 요청서로 만들 때 쓰는 품목 id(못 찾으면 null — 요청서에 담지 못한다)
  name: string;
  spec: string | null;
  unit: string;
  qty: number;                 // 제안 수량
  reason: string;
  urgent: boolean;
  wholesale_stock: number | null; // 도매 가용 재고(발송일이 잡힌 선점까지 뺀 값). null = 도매 원장 없음
  daily_out: number;           // 도매 하루 평균 출고
  days_left: number | null;    // 지금 재고로 버티는 일수(출고 0 이면 null)
  formula: number;             // 수식 권장(이미 낸 요청을 뺀 값)
  open_req: number;            // 이미 낸 도매 요청 잔여
  retail_spare?: number | null; // 2026-11-11 이전 정의로 쓴 옛 보고서에만 있다(소매 여유) — 지금은 소매를 보지 않아 적지 않는다
  out7?: number;               // 최근 7일 순수 도매 출고(옛 보고서에는 없다)
  out30?: number;              // 최근 30일 순수 도매 출고
  need?: number;               // 다음 요청분이 입고될 때까지 필요한 양 = 하루 출고 × 버틸 일수
};
export type AppliedItem = { sku: string; product_id: string; qty: number; draft_qty: number | null };
// 광고 소재 한 건(ad-copy 의 draft 원소) — 소재 기획 규칙: 후킹+스토리+제안 3요소(meta-creatives.ts 와 같은 틀)
export type AdIdea = {
  title: string;         // 소재 이름(컨셉)
  kind: "새 시도" | "변주"; // 변주 = 효율이 좋았던 소재를 바꿔 본 것
  angle: string;         // 소구점
  target: string;        // 누구에게
  format: "이미지" | "영상" | "캐러셀";
  hook: string;          // ① 후킹(첫 문장·첫 1~3초)
  story: string;         // ② 스토리(문제→공감→해결)
  offer: string;         // ③ 제안(혜택·행동 유도)
  short_text?: string;   // 짧은 본문(3~4줄) — 2026-11-12 이전 보고서에는 없다
  primary_text: string;  // 광고 본문(긴 것)
  headline: string;      // 제목
  visual: string;        // 비주얼·촬영 안내
  basis: string;         // 근거(어느 고객 목소리·트렌드·성과·레퍼런스에서 나왔나)
};
export type AgentToolLog = { name: string; title: string; sql?: string; ok: boolean };
export type AgentReport = {
  id: string;
  agent: string;
  status: AgentReportStatus;
  instruction: string | null;
  summary: string | null;
  body_md: string | null;
  draft: DraftItem[];
  ideas: AdIdea[];       // kind "ideas" 에이전트의 결과(DB 에서는 draft 칸에 들어 있다)
  facts: {
    today?: string; horizon_days?: number; lead_days?: number; due_date?: string | null; rows?: number; warnings?: string[];
    next_arrival?: string;                                // 다음 요청분 입고 예정일 — 이번 요청이 버텨야 하는 날
    scheduled?: boolean;                                  // 예약 시각에 자동으로 작성된 초안
    run_started?: string;                                 // 지금(또는 마지막) 실행이 시작된 시각 — 피드백 반영은 created_at 이 아니라 이 시각으로 멈춤을 가린다
    revising?: boolean;                                   // 피드백을 반영해 다시 쓰는 중
    first_draft?: { sku: string; name: string; qty: number }[]; // 피드백 전 첫 초안(수정본과 비교용)
    revise_error?: string;                                // 피드백 반영 실패 사유(초안은 그대로 남는다)
    stage?: { done: number; total: number };              // (단계 실행) 끝낸 단계 수 / 전체 — done 번째 단계가 지금 도는 중
    notes?: Record<string, string>;                       // (단계 실행) 단계가 남긴 조사 요약 — 다음 단계와 피드백 반영이 읽는다
    counts?: Record<string, number>;                      // (ad-copy) 읽은 자료 수: reviews·inquiries·voc·ads·references·searches
  } | null;
  tool_log: AgentToolLog[];
  model: string | null;
  usage: { input?: number; output?: number; rounds?: number; tool_calls?: number; elapsed_ms?: number } | null;
  est_usd: number | null;
  error: string | null;
  created_by: string | null;
  created_at: string;
  finished_at: string | null;
  request_id: string | null;
  request_no: string | null;
  applied: AppliedItem[] | null;
  applied_by: string | null;
  applied_at: string | null;
  feedback: string | null;
  feedback_by: string | null;
  feedback_at: string | null;
};

// ── 예약(초안을 매주 n요일 n시까지) ──
//  Supabase pg_cron 이 매시 45분에 /api/agents/tick 을 두드리고(migration 165), 앱이 이 설정을 보고 작성 여부를 정한다.
//  'n시까지' = 그 시각 15분 전에 시작(작성 1~4분). 요일·시각은 한국 시간.
export type AgentSchedule = { on: boolean; weekday: number; hour: number }; // weekday 0=일 … 6=토
export const DEFAULT_SCHEDULE: AgentSchedule = { on: false, weekday: 2, hour: 10 }; // 요청서는 보통 화요일에 쓴다(2026-11-11 대표)
export const defaultScheduleOf = (agent: string): AgentSchedule => ({ ...(AGENTS.find((a) => a.id === agent)?.schedule ?? DEFAULT_SCHEDULE) });
export const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const KST = 9 * 3600_000, LEAD = 15 * 60_000;
// 지금이 예약 실행 차례인가 — 맞으면 그 목표 시각의 키(YYYY-MM-DDTHH, 한국 시간), 아니면 null. 같은 키로는 한 번만 실행한다.
export function dueTargetKey(s: AgentSchedule, nowMs: number): string | null {
  if (!s.on) return null;
  const t = new Date(nowMs + KST + LEAD);
  return t.getUTCDay() === s.weekday && t.getUTCHours() === s.hour && t.getUTCMinutes() < 30 ? t.toISOString().slice(0, 13) : null;
}
// 다음 목표 시각(한국 시간) — 화면 표시용 'M/D(요일) H시'
export function nextTargetLabel(s: AgentSchedule, nowMs: number): string {
  const now = new Date(nowMs + KST);
  const t = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), s.hour));
  t.setUTCDate(t.getUTCDate() + ((s.weekday - t.getUTCDay() + 7) % 7));
  if (t.getTime() - LEAD <= now.getTime()) t.setUTCDate(t.getUTCDate() + 7);
  return `${t.getUTCMonth() + 1}/${t.getUTCDate()}(${WEEKDAYS[t.getUTCDay()]}) ${s.hour}시`;
}

export const PENDING_166 = "자료 표가 없습니다 — supabase/migrations/166_ad_copy_agent.sql 을 적용하세요.";
export const PENDING_164 = "DB 준비 전입니다 — supabase/migrations/164_agent_reports.sql 을 적용하세요.";
