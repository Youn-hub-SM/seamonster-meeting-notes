-- hr/004 연차 — 발생 건(자동·직접 추가) (2026-11-21, docs/payroll-leave-plan.md 4단계)
--
-- ■ 무엇을 저장하나
--   발생 건만 둔다. 한 줄 = 언제 며칠이 생겼고 언제까지 쓸 수 있는가.
--   사용은 여기 없다 — 근무대장(hr.work_logs)의 연차 줄(종류 '연차', 또는 근무한 날의 반차·반반차 = leave_days)이 곧 사용 내역이다.
--   연차 화면의 [사용 등록]은 근무대장에 그 줄을 넣고, 급여는 그 줄을 유급 시간으로 계산한다. 잔여는 저장하지 않고 화면이 계산한다
--   (먼저 끝나는 발생 건부터 차감 — app/lib/hr-leave.ts).
-- ■ 자동 발생
--   화면을 열 때 "오늘까지 생겼어야 할 건"을 규칙으로 계산해 없는 것만 넣는다. 예약 실행은 없다.
--   같은 건이 두 번 생기지 않게 (employee_id, auto_key) 가 유일하다. auto_key = 'm:<개월 수>'(입사 1년 미만 월 발생) 또는 'a:<발생일>'(연 발생).
--   자동 건은 지우지 않는다 — 지우면 다음에 화면을 열 때 다시 생긴다. 없던 것으로 하려면 voided 로 표시한다(일수·만료일·사유는 고칠 수 있다).
--   직접 추가(kind = 'manual', auto_key 없음)는 포상·이월·차감·도입 시점 잔여 맞추기에 쓴다. 일수가 음수면 빼는 건이다.
-- ■ 미적용이면
--   연차 화면이 'DB 준비 전(hr/004 적용)'만 보인다. 근무대장의 연차 줄과 급여 계산은 그대로 된다.
--
-- 이 번호열은 hr 스키마 밖을 건드리지 않는다. 적용: Supabase SQL Editor 에 이 파일 하나를 붙여넣고 Run. 멱등 — 재실행 안전. hr/003 다음.

create table if not exists hr.leave_grants (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null references hr.employees(id) on delete cascade,
  grant_date   date not null,                              -- 발생일(이 날부터 쓸 수 있다)
  expire_date  date,                                       -- 이 날까지 쓸 수 있다. null = 기한 없음
  days         numeric(5,2) not null check (days between -100 and 100),   -- 일수(직원의 하루 소정근로시간 단위). 음수 = 빼는 건
  kind         text not null default 'manual' check (kind in ('monthly', 'annual', 'manual')),  -- 월 발생 · 연 발생 · 직접 추가
  auto_key     text,                                       -- 자동 발생 건의 열쇠. 직접 추가는 null
  reason       text not null default '',
  voided       boolean not null default false,             -- 없던 것으로 한 건(합계에서 빠진다)
  created_by   text,
  created_at   timestamptz not null default now(),
  updated_by   text,
  updated_at   timestamptz not null default now(),
  constraint leave_grants_dates check (expire_date is null or expire_date >= grant_date),
  unique (employee_id, auto_key)                           -- null 은 서로 다른 값으로 치므로 직접 추가는 몇 건이든 된다
);
create index if not exists leave_grants_employee_idx on hr.leave_grants (employee_id, grant_date);
comment on table hr.leave_grants is '연차 발생 건(자동·직접 추가). 사용은 근무대장(work_logs.leave_days)에 있고 잔여는 화면이 계산한다';

alter table hr.leave_grants enable row level security;
grant all on hr.leave_grants to service_role;
revoke all on hr.leave_grants from anon;
revoke all on hr.leave_grants from authenticated;

notify pgrst, 'reload schema';
