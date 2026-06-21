-- 018: cs_manual 에 category 추가 (분류·검색용).
-- 017 적용 여부와 무관하게 안전하도록 self-healing 으로 작성:
--   테이블이 없으면 만들고, category 컬럼이 없으면 더하고, RLS 를 보장한다.
-- (017 을 아직 안 돌렸다면 이 018 하나만 돌려도 된다.)

create table if not exists cs_manual (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  content text not null default '',
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table cs_manual add column if not exists category text not null default '일반';

create index if not exists cs_manual_sort_idx on cs_manual (sort_order, created_at);

alter table cs_manual enable row level security;
