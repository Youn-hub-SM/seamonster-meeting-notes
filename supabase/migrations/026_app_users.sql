-- 로그인 계정(아이디 관리 화면용). 환경변수(B2B_PASSWORD/B2B_USERS) 계정과 병행 — 둘 다 로그인 가능.
-- 적용: SQL Editor 에 붙여넣고 Run. 멱등.

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,          -- 표시 이름(중복 불가)
  password text not null,             -- 로그인 비밀번호(신원 구분)
  active boolean not null default true,
  created_by text,
  created_at timestamptz not null default now()
);

alter table app_users enable row level security;  -- 서비스롤로만 접근(정책 없음)

NOTIFY pgrst, 'reload schema';
