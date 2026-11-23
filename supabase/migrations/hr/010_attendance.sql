-- hr/010 — 세콤 출근 기록으로 근무대장을 채우는 흐름(2026-11-23 대표): 파일 넣기 → 보정 → 입력 완료 → 근무대장 확정 → 급여
--
-- ■ 무엇이 생기나
--   punch_names    세콤 파일의 이름 ↔ 직원 짝. 세콤의 이름은 인사대장과 다를 수 있다("김정숙-1", "미가르(스리랑카)").
--                  한 번 짝지으면 다음 달부터 자동이다. skip = 넣지 않는 이름(세콤을 안 쓰는 사람·퇴사자).
--   punches        세콤 원본(직원·날짜마다 마지막으로 넣은 출근·퇴근 시각). 근무대장(work_logs)은 보정한 값이고 이 표는 찍힌 그대로다.
--   punch_notes    미리 적기 — "오늘 못 찍었어요"를 들은 날 적어 두면 파일을 넣을 때 그날 줄에 붙는다.
--   punch_settings 보정 기준(한 줄): 지각·조퇴로 보지 않는 분, 연장을 확인하는 분.
--   work_closings  근무대장 확정(사업장·달). 확정한 달은 근무대장을 고칠 수 없고(아래 방아쇠), 확정해야 급여를 저장·확정할 수 있다(앱이 본다).
-- ■ 잠금
--   확정한 달의 work_logs 를 넣거나 고치거나 지우면 방아쇠가 거절한다 — 화면·엑셀 올리기·연차 등록 어느 길로 와도 같다.
--   고치려면 [근무대장 확정 취소]. 직원이 지워지는 중(cascade)에는 막지 않는다.
-- ■ 미적용이면
--   근무대장·급여는 지금까지처럼 돈다(확정 없이 급여 저장 가능). [세콤 파일 넣기]·[미리 적기]·[근무대장 확정]만 'DB 준비 전(hr/010 적용)'을 보인다.
--
-- 이 번호열은 hr 스키마 밖을 건드리지 않는다. 적용: Supabase SQL Editor 에 이 파일 하나를 붙여넣고 Run. 멱등 — 재실행 안전. hr/009 다음.

-- ── 세콤 이름 ↔ 직원 ────────────────────────────────────────────────
create table if not exists hr.punch_names (
  source_name  text primary key,                                        -- 세콤 파일의 이름 그대로
  employee_id  uuid references hr.employees(id) on delete cascade,      -- 짝지은 직원. skip 이면 null
  skip         boolean not null default false,                          -- 넣지 않는 이름
  updated_by   text,
  updated_at   timestamptz not null default now(),
  constraint punch_names_one_of check ((skip and employee_id is null) or (not skip and employee_id is not null))
);
comment on table hr.punch_names is '세콤 출근 기록의 이름 ↔ 직원 짝. skip = 넣지 않는 이름';

-- ── 세콤 원본 ───────────────────────────────────────────────────────
create table if not exists hr.punches (
  employee_id  uuid not null references hr.employees(id) on delete cascade,
  work_date    date not null,
  in_time      text check (in_time is null or in_time ~ '^([01]\d|2[0-3]):[0-5]\d$'),     -- 찍힌 출근(HH:MM). 안 찍혔으면 null
  out_time     text check (out_time is null or out_time ~ '^([01]\d|2[0-3]):[0-5]\d$'),   -- 찍힌 퇴근
  schedule     text not null default '',      -- 세콤의 근무스케줄 칸(평일·휴일·공휴일 이름)
  source_name  text not null default '',      -- 세콤 파일의 이름
  file_name    text not null default '',
  imported_by  text,
  imported_at  timestamptz not null default now(),
  primary key (employee_id, work_date)
);
create index if not exists punches_date_idx on hr.punches (work_date);
comment on table hr.punches is '세콤 출근 기록 원본(찍힌 그대로). 근무대장 work_logs 는 이것을 보정한 값이다';

-- ── 미리 적기 ───────────────────────────────────────────────────────
create table if not exists hr.punch_notes (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null references hr.employees(id) on delete cascade,
  work_date    date not null,
  kind         text not null default 'both' check (kind in ('in', 'out', 'both', 'etc')),   -- 출근 못 찍음 · 퇴근 못 찍음 · 둘 다 · 기타
  in_time      text check (in_time is null or in_time ~ '^([01]\d|2[0-3]):[0-5]\d$'),       -- 실제 출근(들은 대로)
  out_time     text check (out_time is null or out_time ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  memo         text not null default '',
  created_by   text,
  created_at   timestamptz not null default now(),
  unique (employee_id, work_date)
);
create index if not exists punch_notes_date_idx on hr.punch_notes (work_date);
comment on table hr.punch_notes is '출근 기록을 못 찍었다고 미리 들은 것. 세콤 파일을 넣을 때 그날 줄에 붙는다';

-- ── 보정 기준(한 줄) ────────────────────────────────────────────────
create table if not exists hr.punch_settings (
  id            boolean primary key default true check (id),
  grace_min     integer not null default 10 check (grace_min between 0 and 60),         -- 이 분 안의 지각·조퇴는 소정 시각으로 본다
  overtime_min  integer not null default 30 check (overtime_min between 0 and 240),     -- 소정 퇴근보다 이 분 넘게 남으면 연장인지 확인한다
  updated_by    text,
  updated_at    timestamptz not null default now()
);
insert into hr.punch_settings (id) values (true) on conflict (id) do nothing;
comment on table hr.punch_settings is '세콤 기록 보정 기준(한 줄)';

-- ── 근무대장 확정 ───────────────────────────────────────────────────
create table if not exists hr.work_closings (
  workplace_id  uuid not null references hr.workplaces(id) on delete cascade,
  month         text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  closed_by     text,
  closed_at     timestamptz not null default now(),
  primary key (workplace_id, month)
);
comment on table hr.work_closings is '근무대장 확정(사업장·달). 줄이 있으면 그 달 근무대장은 잠긴다';

alter table hr.punch_names    enable row level security;
alter table hr.punches        enable row level security;
alter table hr.punch_notes    enable row level security;
alter table hr.punch_settings enable row level security;
alter table hr.work_closings  enable row level security;
grant all on hr.punch_names, hr.punches, hr.punch_notes, hr.punch_settings, hr.work_closings to service_role;
revoke all on hr.punch_names, hr.punches, hr.punch_notes, hr.punch_settings, hr.work_closings from anon;
revoke all on hr.punch_names, hr.punches, hr.punch_notes, hr.punch_settings, hr.work_closings from authenticated;

-- ── 확정한 달의 근무대장은 고치지 못한다 ────────────────────────────
create or replace function hr.work_logs_closed_guard()
returns trigger
language plpgsql
set search_path = hr, public
as $$
declare
  v_employee uuid;
  v_date date;
  v_wp uuid;
begin
  if tg_op = 'DELETE' then
    v_employee := old.employee_id; v_date := old.work_date;
  else
    v_employee := new.employee_id; v_date := new.work_date;
  end if;
  select e.workplace_id into v_wp from hr.employees e where e.id = v_employee;
  -- 직원이 지워지는 중(cascade)이면 그 줄도 같이 지워져야 한다
  if v_wp is not null and exists (
    select 1 from hr.work_closings c where c.workplace_id = v_wp and c.month = to_char(v_date, 'YYYY-MM')
  ) then
    raise exception '근무대장이 확정된 달입니다. 고치려면 [근무대장 확정 취소]를 누르세요.';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

drop trigger if exists work_logs_closed_guard on hr.work_logs;
create trigger work_logs_closed_guard
  before insert or update or delete on hr.work_logs
  for each row execute function hr.work_logs_closed_guard();

revoke all on function hr.work_logs_closed_guard() from public;
revoke all on function hr.work_logs_closed_guard() from anon;
revoke all on function hr.work_logs_closed_guard() from authenticated;

notify pgrst, 'reload schema';
