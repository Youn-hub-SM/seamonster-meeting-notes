-- hr/002 근무대장 — 직원별 하루 한 줄(일한 시간·종류) + 한 달 저장 함수 (2026-11-20, docs/payroll-leave-plan.md 2단계)
--
-- ■ 왜
--   급여가 시급 기준이라 급여 계산의 원천이 근무대장이다. 한 줄 = 한 직원의 하루.
--   주휴·연장·야간·휴일 시간은 저장하지 않는다 — 이 줄들에서 앱(app/lib/hr-work.ts)이 계산한다(저장하면 반드시 어긋난다).
--   연차 사용도 이 표에 있다(종류 '연차', 또는 근무한 날의 반차·반반차 = leave_days). 연차 화면(4단계)이 같은 줄을 본다.
-- ■ 저장
--   화면은 한 직원의 한 달을 통째로 보낸다. hr.save_work_logs 가 한 트랜잭션에서 그 기간의 줄을 보낸 내용과 같게 맞춘다
--   (보낸 날짜는 넣거나 고치고, 보내지 않은 날짜는 지운다). 중간에 실패하면 아무것도 바뀌지 않는다.
-- ■ 미적용이면
--   근무대장 화면이 'DB 준비 전(hr/002 적용)'만 보인다. 인사대장·요율·사업장은 그대로 쓴다.
--
-- 이 번호열은 hr 스키마 밖을 건드리지 않는다. 적용: Supabase SQL Editor 에 이 파일 하나를 붙여넣고 Run. 멱등 — 재실행 안전. hr/001 다음.

create table if not exists hr.work_logs (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null references hr.employees(id) on delete cascade,
  work_date    date not null,
  kind         text not null default 'work'
               check (kind in ('work', 'holiday_work', 'paid_holiday', 'leave', 'absent', 'unpaid')),
               -- 근무 · 휴일 근무 · 유급 휴일 · 연차 · 결근 · 무급 휴무
  start_time   text check (start_time is null or start_time ~ '^([01]\d|2[0-3]):[0-5]\d$'),   -- 출근(HH:MM). 시간만 적으면 null
  end_time     text check (end_time is null or end_time ~ '^([01]\d|2[0-3]):[0-5]\d$'),       -- 퇴근. 출근보다 이르면 다음 날
  break_min    integer not null default 0 check (break_min between 0 and 600),                -- 휴게(분)
  hours        numeric(5,2) not null default 0 check (hours >= 0 and hours <= 24),            -- 실제 일한 시간
  night_hours  numeric(5,2) not null default 0 check (night_hours >= 0),                      -- 그 가운데 22:00~06:00
  leave_days   numeric(3,2) not null default 0 check (leave_days in (0, 0.25, 0.5, 1)),       -- 그날 쓴 연차(일)
  memo         text not null default '',
  updated_by   text,
  updated_at   timestamptz not null default now(),
  constraint work_logs_night_within_hours check (night_hours <= hours),
  unique (employee_id, work_date)
);
create index if not exists work_logs_date_idx on hr.work_logs (work_date);
comment on table hr.work_logs is '근무대장. 직원별 하루 한 줄. 주휴·연장·야간·휴일 시간은 저장하지 않고 이 줄에서 계산한다';

alter table hr.work_logs enable row level security;
grant all on hr.work_logs to service_role;
revoke all on hr.work_logs from anon;
revoke all on hr.work_logs from authenticated;

-- 한 직원의 [p_from, p_to] 기간을 p_rows 와 같게 맞춘다. 반환 = 넣거나 고친 줄 수.
--  p_rows: [{ work_date, kind, start_time, end_time, break_min, hours, night_hours, leave_days, memo }, …]
--  같은 날짜가 두 번 오면 거절한다(화면·API 가 미리 걸러 보낸다).
create or replace function hr.save_work_logs(p_employee uuid, p_from date, p_to date, p_rows jsonb, p_actor text)
returns integer
language plpgsql
set search_path = hr, public
as $$
declare
  n integer := 0;
  v_rows jsonb := coalesce(p_rows, '[]'::jsonb);
begin
  if p_employee is null or p_from is null or p_to is null or p_to < p_from or p_to - p_from > 45 then
    raise exception '기간이 올바르지 않습니다.';
  end if;
  if jsonb_typeof(v_rows) <> 'array' then
    raise exception '줄 목록이 올바르지 않습니다.';
  end if;
  if not exists (select 1 from hr.employees e where e.id = p_employee) then
    raise exception '없는 직원입니다.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_rows) r
     group by (r->>'work_date') having count(*) > 1
  ) then
    raise exception '같은 날짜가 두 번 들어 있습니다.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_rows) r
     where (r->>'work_date')::date < p_from or (r->>'work_date')::date > p_to
  ) then
    raise exception '기간 밖의 날짜가 들어 있습니다.';
  end if;

  -- 같은 직원의 저장이 겹치지 않게(두 창에서 동시에 저장)
  perform pg_advisory_xact_lock(hashtext('hr.work_logs:' || p_employee::text));

  delete from hr.work_logs w
   where w.employee_id = p_employee
     and w.work_date between p_from and p_to
     and not exists (select 1 from jsonb_array_elements(v_rows) r where (r->>'work_date')::date = w.work_date);

  insert into hr.work_logs (employee_id, work_date, kind, start_time, end_time, break_min, hours, night_hours, leave_days, memo, updated_by, updated_at)
  select p_employee,
         (r->>'work_date')::date,
         r->>'kind',
         nullif(r->>'start_time', ''),
         nullif(r->>'end_time', ''),
         coalesce((r->>'break_min')::integer, 0),
         coalesce((r->>'hours')::numeric, 0),
         coalesce((r->>'night_hours')::numeric, 0),
         coalesce((r->>'leave_days')::numeric, 0),
         coalesce(r->>'memo', ''),
         p_actor,
         now()
    from jsonb_array_elements(v_rows) r
  on conflict (employee_id, work_date) do update set
    kind = excluded.kind,
    start_time = excluded.start_time,
    end_time = excluded.end_time,
    break_min = excluded.break_min,
    hours = excluded.hours,
    night_hours = excluded.night_hours,
    leave_days = excluded.leave_days,
    memo = excluded.memo,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;
  get diagnostics n = row_count;
  return n;
end $$;

comment on function hr.save_work_logs(uuid, date, date, jsonb, text) is '한 직원의 기간을 보낸 줄과 같게 맞춘다(넣기·고치기·지우기를 한 트랜잭션으로)';

revoke all on function hr.save_work_logs(uuid, date, date, jsonb, text) from public;
revoke all on function hr.save_work_logs(uuid, date, date, jsonb, text) from anon;
revoke all on function hr.save_work_logs(uuid, date, date, jsonb, text) from authenticated;
grant execute on function hr.save_work_logs(uuid, date, date, jsonb, text) to service_role;

notify pgrst, 'reload schema';
