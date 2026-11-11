// AI 에이전트 등록부 — 화면(/agents)과 서버가 같이 읽는다(클라이언트 안전: DB·SDK import 없음).
//  에이전트 = 정해진 일을 맡은 AI. 같은 에이전트도 지침·도구·모델을 바꾼 여러 버전이 나온다.
//  새 버전 = 여기 versions 맨 앞에 한 줄 + 서버 실행기(app/lib/agents/run.ts RUNNERS)에 같은 id 로 등록.
//  옛 버전은 지우지 않는다 — 그 버전이 쓴 보고서가 남아 있고, 버전끼리 비교가 이 화면의 목적이다.
//  더는 실행하지 않을 버전은 retired: true (보고서·기록은 보이고 [업무 요청] 선택지에서만 빠진다).

export type AgentVersionMeta = {
  id: string;          // v1, v2 … (agent_reports.version)
  date: string;        // 이 버전을 낸 날(YYYY-MM-DD)
  changes: string[];   // 이 버전이 하는 일·앞 버전과 달라진 점(한 줄씩)
  retired?: true;
};
export type AgentMeta = {
  id: string;          // agent_reports.agent
  name: string;        // 화면 이름
  output: string;      // 보고서로 만들 수 있는 것(버튼·문구용 명사)
  versions: AgentVersionMeta[]; // 최신이 맨 앞
};

export const AGENTS: AgentMeta[] = [
  {
    id: "wholesale-request",
    name: "도매 생산 요청서",
    output: "도매 생산 요청서",
    versions: [
      {
        id: "v1", date: "2026-11-11",
        changes: [
          "맡은 일은 도매 생산 요청서 초안 작성 하나 — 다른 일은 하지 않음",
          "도매 재고·출고 속도·이미 낸 요청·소매 여유를 읽고 품목과 수량을 제안",
          "판단에 더 필요한 것은 원장·발주를 직접 조회",
          "담당자가 결재하면 초안 그대로, 피드백을 보내면 고친 수정본이 요청서로 작성됨",
          "지난 초안의 확정 수량과 피드백을 다음 작성에 반영",
        ],
      },
    ],
  },
];

export const agentOf = (id: string): AgentMeta | undefined => AGENTS.find((a) => a.id === id);
export const latestVersion = (a: AgentMeta): AgentVersionMeta => a.versions.find((v) => !v.retired) ?? a.versions[0];
export const versionOf = (a: AgentMeta, id: string): AgentVersionMeta | undefined => a.versions.find((v) => v.id === id);

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
  retail_spare: number | null; // 소매에서 옮겨도 소매가 부족해지지 않는 양. null = 소매 원장 없음
};
export type AppliedItem = { sku: string; product_id: string; qty: number; draft_qty: number | null };
export type AgentToolLog = { name: string; title: string; sql?: string; ok: boolean };
export type AgentReport = {
  id: string;
  agent: string;
  version: string;
  status: AgentReportStatus;
  instruction: string | null;
  summary: string | null;
  body_md: string | null;
  draft: DraftItem[];
  facts: {
    today?: string; horizon_days?: number; lead_days?: number; due_date?: string | null; rows?: number; warnings?: string[];
    scheduled?: boolean;                                  // 예약 시각에 자동으로 작성된 초안
    run_started?: string;                                 // 지금(또는 마지막) 실행이 시작된 시각 — 피드백 반영은 created_at 이 아니라 이 시각으로 멈춤을 가린다
    revising?: boolean;                                   // 피드백을 반영해 다시 쓰는 중
    first_draft?: { sku: string; name: string; qty: number }[]; // 피드백 전 첫 초안(수정본과 비교용)
    revise_error?: string;                                // 피드백 반영 실패 사유(초안은 그대로 남는다)
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
export const DEFAULT_SCHEDULE: AgentSchedule = { on: false, weekday: 3, hour: 14 };
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

export const PENDING_164 = "DB 준비 전입니다 — supabase/migrations/164_agent_reports.sql 을 적용하세요.";
