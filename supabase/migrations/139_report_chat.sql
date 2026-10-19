-- 139 커스텀 리포트 대화형(2026-10-19 대표 결정 — "클로드 웹처럼 대화형 AI")
--
-- ■ 왜
--   /report 는 '질문 1회 → 보고서 1회' 구조라 매 턴 JSON 틀을 강제하고, 턴이 끝나면 조사 내용(도구 결과)을 버렸다.
--   대화형은 한 스레드의 메시지 전부(모델 응답 블록·도구 호출·도구 결과)를 그대로 보관해 다음 턴에 이어 붙인다.
--   스레드를 서버에 저장해 나중에 다시 열 수 있다(대표 결정 1 — 추천안).
--
-- ■ 표
--   report_threads   스레드(제목 = 첫 메시지, 만든 사람, 요약(앞부분 접기), 접은 지점 compact_seq)
--   report_messages  메시지(seq 순, role user/assistant, content = Anthropic 메시지 블록 JSON 그대로 — thinking·tool_use·tool_result 포함)
--   report_tables    run_sql 결과 표(화면 카드용 ≤1,000행) — tool_use_id 로 메시지 블록 자리에 끼운다
--
-- ■ 개인정보: 모델에 들어가는 검색 결과는 코드가 마스킹한 뒤 저장되므로(assistant.ts maskPii) 원문 PII 는 여기 들어오지 않는다.
--   run_report 는 sales_customers 를 막는다(068). 표 행은 그 결과 그대로.
--
-- 적용: Supabase Dashboard > SQL Editor 에 전체 붙여넣고 Run. 멱등 — 재실행 안전.
--   미적용이면 /report 화면이 "DB 준비 전" 안내를 띄운다(코드 폴백).

create table if not exists public.report_threads (
  id          uuid primary key default gen_random_uuid(),
  title       text not null default '',
  created_by  text not null,
  model       text,
  summary     text,                          -- 접힌 앞부분 요약(없으면 null)
  compact_seq integer not null default 0,    -- 이 seq 이하 메시지는 모델에 넣지 않고 summary 로 대신한다
  archived    boolean not null default false,
  est_usd     numeric(10,4) not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists report_threads_user_idx on public.report_threads (created_by, updated_at desc) where archived = false;

create table if not exists public.report_messages (
  id         uuid primary key default gen_random_uuid(),
  thread_id  uuid not null references public.report_threads(id) on delete cascade,
  seq        integer not null,
  role       text not null check (role in ('user', 'assistant')),
  content    jsonb not null,                 -- Anthropic content 블록 배열(또는 문자열) 그대로
  usage      jsonb,                          -- assistant 만: {input, output, cacheRead, cacheWrite, estUsd}
  created_at timestamptz not null default now(),
  unique (thread_id, seq)
);

create table if not exists public.report_tables (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references public.report_threads(id) on delete cascade,
  tool_use_id text not null,
  title       text not null,
  sql         text not null,
  columns     jsonb not null default '[]'::jsonb,
  rows        jsonb not null default '[]'::jsonb,   -- 화면용 ≤1,000행
  row_count   integer not null default 0,
  truncated   boolean not null default false,
  looker      jsonb,                                -- {mode, sql, note} | null
  created_at  timestamptz not null default now(),
  unique (thread_id, tool_use_id)
);

-- 서비스 롤(supabaseAdmin)만 접근 — 정책 없이 RLS 만 켠다(다른 표와 같다)
alter table public.report_threads enable row level security;
alter table public.report_messages enable row level security;
alter table public.report_tables enable row level security;

notify pgrst, 'reload schema';
