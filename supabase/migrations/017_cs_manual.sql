-- 017: CS 코치 지식베이스(매뉴얼)를 코드에서 DB로 분리.
-- 팀이 코드 수정·재배포 없이 항목을 추가·수정·삭제할 수 있게 함.
-- 초기 내용은 앱이 비어 있을 때 자동 시드(app/lib/cs-manual.ts 의 DEFAULT_CS_MANUAL).

create table if not exists cs_manual (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  content text not null default '',
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists cs_manual_sort_idx on cs_manual (sort_order, created_at);

-- RLS 켜기 (정책 없음). 다른 테이블과 동일 — 앱은 service_role 로만 접근하므로
-- RLS 를 우회해 정상 동작하고, anon/authenticated 키로는 접근 불가(차단)된다.
alter table cs_manual enable row level security;
