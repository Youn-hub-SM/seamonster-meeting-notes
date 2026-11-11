-- 164: AI 에이전트 보고서 — 에이전트가 한 번 실행될 때마다 보고서 한 장이 쌓인다(/agents).
--  적용: Supabase SQL Editor 에 전체 붙여넣고 Run. 멱등 — 재실행 안전. (163 다음에 적용)
--
-- 에이전트 = 정해진 일을 맡은 AI(첫 에이전트: 도매 생산 요청서 작성 'wholesale-request').
-- 같은 에이전트도 지침·도구·모델을 바꾼 여러 버전이 나온다 — 보고서마다 어느 버전이 썼는지 남겨 버전끼리 비교한다.
-- 보고서의 제안(draft)을 사람이 확인·수정해 실제 요청서로 만들면(request_id) 그 차이(applied)와 평가(feedback)가
--  다음 실행의 참고 사례가 된다. 개인정보 없음(품목·수량·판단 근거뿐).

create table if not exists agent_reports (
  id uuid primary key default gen_random_uuid(),
  agent text not null,                         -- 에이전트 id (예: wholesale-request)
  version text not null,                       -- 그 에이전트의 버전 id (예: v1)
  status text not null default 'running',      -- running(작성 중) | done(완료) | error(실패)
  instruction text,                            -- 실행할 때 사람이 덧붙인 말(선택)
  summary text,                                -- 한 줄 요약
  body_md text,                                -- 보고서 본문(마크다운)
  draft jsonb,                                 -- 제안 품목: [{sku, product_id, name, spec, unit, qty, reason, urgent, ...근거 숫자}]
  facts jsonb,                                 -- 작성 시점에 코드가 모은 사실(기준일·목표 일수·경고 등)
  tool_log jsonb,                              -- 에이전트가 직접 조회한 내역: [{name, title, sql, ok}]
  model text,                                  -- 실제 쓴 모델 id
  usage jsonb,                                 -- 토큰·차례·걸린 시간
  est_usd numeric(10,4),                       -- 추정 비용(USD)
  error text,                                  -- 실패 사유(status=error)
  created_by text,                             -- 실행한 사람
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  request_id uuid references production_requests(id) on delete set null,  -- 이 보고서로 만든 생산 요청서
  request_no text,                             -- 그 요청서 번호(PR-000001) — 요청서가 지워져도 남는 표시용
  applied jsonb,                               -- 요청서로 만들 때 사람이 확정한 품목: [{sku, product_id, qty, draft_qty}]
  applied_by text,
  applied_at timestamptz,
  feedback text,                               -- 사람의 평가 — 같은 에이전트의 다음 실행이 읽는다
  feedback_by text,
  feedback_at timestamptz
);

comment on table agent_reports is 'AI 에이전트 보고서(/agents). 에이전트 실행 1회 = 1행. agent=에이전트 id(wholesale-request=도매 생산 요청서 작성), version=에이전트 버전. 사람이 제안을 확인해 요청서로 만들면 request_id·applied 가 찬다';
comment on column agent_reports.agent is '에이전트 id. wholesale-request = 도매 생산 요청서 작성 에이전트';
comment on column agent_reports.version is '에이전트 버전 id(v1, v2 …). 버전별 성과 비교의 기준';
comment on column agent_reports.status is 'running=작성 중, done=완료, error=실패';
comment on column agent_reports.draft is '에이전트가 제안한 품목 배열. 각 원소: sku, name, qty(제안 수량), reason(이유), urgent(급함 여부), wholesale_stock(도매 가용 재고), daily_out(도매 하루 평균 출고), formula(수식 권장 수량), open_req(이미 낸 도매 요청 잔여), retail_spare(소매에서 옮겨도 되는 여유)';
comment on column agent_reports.applied is '사람이 요청서로 만들 때 확정한 품목 배열. 각 원소: sku, qty(확정 수량), draft_qty(에이전트 제안 수량, 사람이 추가한 품목은 null). draft 와 비교하면 무수정 확정률이 나온다';
comment on column agent_reports.request_id is '이 보고서로 만든 생산 요청서(production_requests.id). null = 아직 요청서로 만들지 않음';
comment on column agent_reports.feedback is '보고서에 대한 사람의 평가 글. 같은 에이전트의 다음 실행에 참고 사례로 들어간다';
comment on column agent_reports.est_usd is '이 실행의 추정 AI 비용(USD)';
comment on column agent_reports.facts is '작성 시점 사실 요약(기준일, 목표 일수, 품목 수, 경고). 품목별 숫자는 draft 에 있다';
comment on column agent_reports.tool_log is '에이전트가 실행 중 직접 조회한 내역(도구 이름, 제목, SQL, 성공 여부)';

create index if not exists agent_reports_agent_created_idx on agent_reports (agent, created_at desc);

alter table agent_reports enable row level security;  -- service key 전용(정책 없음)
