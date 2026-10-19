-- 140 AI 데이터 비서 — 회사 용어 사전 + 답 피드백 (2026-10-19 대표 결정: 개선안 1·5)
--
-- ■ 용어 사전(report_glossary)
--   대화에서 한 번 정한 정의("이유식 상품 = SKU 7개", "합배송 = 한 주문번호에 상품 2줄 이상")를 저장해
--   이후 모든 직원의 대화에 자동으로 넣는다 → 같은 걸 다시 묻지 않고, 사람마다 정의가 갈리지 않는다.
--   비서는 propose_term 도구로 '제안'만 하고(쓰기 도구 아님) 저장은 화면에서 사람이 누른다.
-- ■ 피드백(report_feedback)
--   비서의 답마다 [맞아요]/[틀려요]+사유. 관리자 AI 설정 카드에 30일 집계·최근 '틀려요' 사유가 모인다.
-- ■ 정기 리포트(개선안 3)는 저장 리포트(b2b_settings kv JSON)에 schedule 필드를 더해 표가 필요 없다.
--
-- 적용: Supabase Dashboard > SQL Editor 에 전체 붙여넣고 Run. 멱등 — 재실행 안전. 139 뒤에 적용.

create table if not exists public.report_glossary (
  id          uuid primary key default gen_random_uuid(),
  term        text not null,
  definition  text not null,
  created_by  text,
  updated_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists report_glossary_term_uq on public.report_glossary (lower(term));

create table if not exists public.report_feedback (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid references public.report_threads(id) on delete cascade,
  seq         integer,                       -- 비서 메시지 seq(report_messages)
  user_name   text not null,
  ok          boolean not null,              -- true 맞아요 / false 틀려요
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists report_feedback_at_idx on public.report_feedback (created_at desc);

alter table public.report_glossary enable row level security;
alter table public.report_feedback enable row level security;

notify pgrst, 'reload schema';
