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
  kind?: "ideas";      // 보고서 모양. 없으면 요청서 초안(품목·수량 → 결재). "ideas" = 소재 목록(결재 없음, 피드백으로 다시 쓰기)
  stages?: string[];   // 단계로 나눠 실행하는 에이전트의 단계 이름(순서대로) — 단계마다 함수 호출이 따로라 한 단계가 270초 안에만 끝나면 된다
  schedule?: AgentSchedule; // 예약 기본값(없으면 DEFAULT_SCHEDULE)
  versions: AgentVersionMeta[]; // 최신이 맨 앞
};

export const AGENTS: AgentMeta[] = [
  {
    id: "wholesale-request",
    name: "도매 생산 요청서",
    output: "도매 생산 요청서",
    versions: [
      {
        id: "v3", date: "2026-11-11",
        changes: [
          "판단 재료를 순수 도매 출고량과 도매 재고 둘로 한정 — 소매 재고·소매 판매는 보지 않음, 도매 대량 제외",
          "주 1회 요청·리드타임 7~10일 기준: 요청한 주의 다음 주 금요일 입고, 다음 요청분이 입고될 때까지 버틸 양만 요청",
          "최근 7일·30일·90일 도매 출고를 함께 보고 일회성 발주는 걸러 냄",
          "아직 확정하지 않은 도매 요청서의 잔여도 이미 요청한 양으로 뺌",
        ],
      },
      {
        id: "v2", date: "2026-11-11", retired: true,
        changes: [
          "도매 수요를 도매 칸의 일반 B2B 발송으로만 한정 — 소매·도매 대량·프로모션으로 옮긴 양과 대량 발주는 수요로 세지 않음",
          "발송 대기 발주 자료에서 대량 발주를 뺌",
          "칸 이동으로 재고가 줄어든 품목은 '확인 필요'에 따로 적음",
        ],
      },
      {
        id: "v1", date: "2026-11-11", retired: true,
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
  {
    id: "ad-copy",
    name: "광고 카피",
    output: "신규 소재 목록",
    kind: "ideas",
    stages: ["고객 목소리 분석", "타깃 트렌드 조사", "소재 기획", "카피 작성"],
    schedule: { on: false, weekday: 1, hour: 9 },
    versions: [
      {
        id: "v5", date: "2026-11-12",
        changes: [
          "후킹에서 걱정이나 질문을 꺼내면 같은 광고 안에서 답함 — 답을 다음 편으로 미루지 않음",
          "소재는 광고 한 편만 봐도 뜻이 서게 기획하고, 걱정에서 출발하는 소재는 무엇으로 답할지까지 정함",
          "일부 고객의 말을 부풀리지 않되 '한 고객이 알려 준 방법'처럼 어색하게 쓰지 않음 — 얼마나 넓게 말할지는 리뷰 분석 자료의 건수로 가늠",
        ],
      },
      {
        id: "v4", date: "2026-11-12", retired: true,
        changes: [
          "리뷰를 매번 160건씩 읽는 대신, 전체 리뷰(약 3만 5천 건)를 분석해 둔 '리뷰 분석 자료'를 읽음",
          "주제별 최근 90일 건수를 실행할 때마다 다시 세어 요즘 늘어난 이야기를 가림",
          "첫 단계는 최근 4주 글에서 분석 자료에 없는 새 이야기만 뽑음",
          "공식몰 리뷰에서 리뷰 앱 자동 문구와 스마트스토어 복사본을 뺌",
        ],
      },
      {
        id: "v3", date: "2026-11-12", retired: true,
        changes: [
          "중량·개수 같은 상품 숫자는 상품 마스터의 규격에 있는 값만 씀",
          "정부·기관·전문가 권장, 인증, 통계는 광고 문구에 쓰지 않고 근거에만 적음",
          "일부 고객의 말을 모두의 일처럼 넓혀 쓰지 않음",
          "본문을 짧은 본문(3~4줄)과 긴 본문 둘로 냄",
        ],
      },
      {
        id: "v2", date: "2026-11-11", retired: true,
        changes: [
          "소재 작성을 '소재 기획'과 '카피 작성' 두 단계로 나눔 — v1 은 한 번에 쓰다가 시간 초과로 실패",
          "품질 우선: 모든 단계를 생각 강도 높음으로 실행하고 단계마다 시간을 800초까지 씀",
          "문구는 소재 4건씩 나눠 동시에 작성 — 한 묶음이 실패해도 나머지는 남음",
          "피드백이 말하지 않은 소재는 문구까지 그대로 둠",
        ],
      },
      {
        id: "v1", date: "2026-11-11", retired: true,
        changes: [
          "맡은 일은 메타 광고 신규 소재 목록 작성 하나 — 광고를 켜거나 끄지 않음",
          "공식몰 리뷰·스마트스토어 문의·VOC 에서 고객이 쓰는 말과 구매 이유를 뽑음",
          "타깃의 최근 경향을 웹에서 조사하고 출처를 남김",
          "메타 광고 성과에서 효율이 좋았던 소구와 아직 해 보지 않은 소구를 가림",
          "담당자가 올린 타사 광고 레퍼런스를 참고(문구를 베끼지 않음)",
          "소재마다 후킹·스토리·제안과 광고 본문, 근거를 적음",
          "지난 목록과 피드백을 읽어 같은 소재를 되풀이하지 않음",
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
  retail_spare: number | null; // (v1·v2 보고서만) 소매에서 옮겨도 소매가 부족해지지 않는 양. v3 부터는 소매를 보지 않아 늘 null
  out7?: number;               // (v3~) 최근 7일 순수 도매 출고
  out30?: number;              // (v3~) 최근 30일 순수 도매 출고
  need?: number;               // (v3~) 다음 요청분이 입고될 때까지 필요한 양 = 하루 출고 × 버틸 일수
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
  short_text?: string;   // (v3~) 짧은 본문(3~4줄)
  primary_text: string;  // 광고 본문(긴 것)
  headline: string;      // 제목
  visual: string;        // 비주얼·촬영 안내
  basis: string;         // 근거(어느 고객 목소리·트렌드·성과·레퍼런스에서 나왔나)
};
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
  ideas: AdIdea[];       // kind "ideas" 에이전트의 결과(DB 에서는 draft 칸에 들어 있다)
  facts: {
    today?: string; horizon_days?: number; lead_days?: number; due_date?: string | null; rows?: number; warnings?: string[];
    next_arrival?: string;                                // (v3~) 다음 요청분 입고 예정일 — 이번 요청이 버텨야 하는 날
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
