-- hr/003 급여 — 급여 항목·직원별 고정 금액·간이세액표·월 급여(머리·줄)·확정과 근무대장 잠금 (2026-11-21, docs/payroll-leave-plan.md 3단계)
--
-- ■ 무엇을 저장하나
--   계산은 앱(app/lib/hr-pay.ts)이 한다. DB 에는 ① 손으로 넣거나 고친 것(payroll_lines.inputs) ② 그때의 계산 결과(result)를 둔다.
--   작성 중(draft)에는 화면을 열 때마다 근무대장·임금·요율로 다시 계산하고, [확정]하면 그 순간의 결과가 굳는다 —
--   뒤에 시급·요율·근무대장이 바뀌어도 확정한 달의 급여대장·명세서는 바뀌지 않는다.
--   근무대장에서 나오는 지급 6가지(기본급·주휴·연장·야간·휴일·연차)와 법정 공제 6가지(4대보험·소득세·지방소득세)는 표가 아니라 코드에 있다.
--   pay_items 는 그 밖에 직접 넣는 항목(식대·상여·정산 등)만 둔다.
-- ■ 확정 = 잠금
--   확정한 달은 급여를 고칠 수 없고(hr.save_payroll 이 거절), 그 사업장 직원의 그 달 근무대장도 고칠 수 없다(hr.save_work_logs 가 거절).
--   고치려면 [확정 취소](hr.unconfirm_payroll) — 이력에 남는다.
-- ■ 간이세액표
--   국세청 원본 엑셀을 요율 화면에서 올린다(tax_tables). 산식으로 흉내 내지 않는다 — 표가 없으면 소득세를 자동으로 내지 않고 직접 넣게 한다.
-- ■ 미적용이면
--   급여 화면이 'DB 준비 전(hr/003 적용)'만 보인다. 인사대장·근무대장·요율·사업장은 그대로 쓴다.
--
-- 이 번호열은 hr 스키마 밖을 건드리지 않는다. 적용: Supabase SQL Editor 에 이 파일 하나를 붙여넣고 Run. 멱등 — 재실행 안전. hr/002 다음.

-- ── 급여 항목(직접 넣는 것) ─────────────────────────────────────────
create table if not exists hr.pay_items (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,                       -- 급여대장·명세서에 찍히는 이름
  kind        text not null default 'pay' check (kind in ('pay', 'deduct')),            -- 지급 / 공제
  tax         text not null default 'taxable'
              check (tax in ('taxable', 'meal', 'car', 'childcare', 'exempt')),
              -- 과세 · 비과세(식대 한도) · 비과세(자가운전 한도) · 비과세(보육수당 한도 × 자녀 수) · 비과세(한도 없음). 공제 항목은 쓰지 않는다
  fixed       boolean not null default false,             -- 매월 고정: 한 번 넣은 금액이 다음 달에도 채워진다(employee_pay)
  sort        integer not null default 0,
  active      boolean not null default true,
  updated_by  text,
  updated_at  timestamptz not null default now()
);
comment on table hr.pay_items is '직접 넣는 급여 항목(식대·상여·정산 등). 근무대장에서 나오는 지급과 법정 공제는 코드(hr-pay.ts)에 있다';

insert into hr.pay_items (name, kind, tax, fixed, sort) values
  ('식대',           'pay',    'meal',      true,  10),
  ('자가운전보조금', 'pay',    'car',       true,  20),
  ('보육수당',       'pay',    'childcare', true,  30),
  ('상여',           'pay',    'taxable',   false, 40),
  ('연차수당',       'pay',    'taxable',   false, 50),
  ('기타 지급',      'pay',    'taxable',   false, 60),
  ('정산',           'deduct', 'taxable',   false, 70),   -- 건강보험 정산·연말정산: 더 내면 양수, 돌려받으면 음수
  ('기타 공제',      'deduct', 'taxable',   false, 80)
on conflict (name) do nothing;

-- ── 직원별 고정 금액 ────────────────────────────────────────────────
create table if not exists hr.employee_pay (
  employee_id  uuid not null references hr.employees(id) on delete cascade,
  item_id      uuid not null references hr.pay_items(id) on delete cascade,
  amount       integer not null default 0,
  qty          smallint not null default 1 check (qty between 1 and 20),   -- 보육수당: 6세 이하 자녀 수(비과세 한도에 곱한다)
  updated_by   text,
  updated_at   timestamptz not null default now(),
  primary key (employee_id, item_id)
);
comment on table hr.employee_pay is '매월 고정 항목의 직원별 금액. 월 급여를 저장할 때 그달에 넣은 금액으로 갱신된다';

-- ── 간이세액표 ──────────────────────────────────────────────────────
-- 한 줄 = 그 날짜 이후 지급분에 쓰는 표 하나. rows = [[이상(원), 미만(원), 가족 1명 세액, …, 가족 11명 세액], …] 이상 오름차순.
create table if not exists hr.tax_tables (
  effective_from  date primary key,                       -- 이 날 이후 지급분부터(예: 2026-03-01)
  rows            jsonb not null,
  row_count       integer not null default 0,
  source          text not null default '',               -- 올린 파일 이름
  uploaded_by     text,
  uploaded_at     timestamptz not null default now()
);
comment on table hr.tax_tables is '근로소득 간이세액표(국세청 원본을 올린 것). 지급일에 유효한 표로 소득세를 찾는다';

-- ── 월 급여 ─────────────────────────────────────────────────────────
create table if not exists hr.payrolls (
  id            uuid primary key default gen_random_uuid(),
  workplace_id  uuid not null references hr.workplaces(id),
  month         text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),   -- 귀속월(YYYY-MM)
  pay_date      date not null,                             -- 지급일
  status        text not null default 'draft' check (status in ('draft', 'confirmed')),
  confirmed_by  text,
  confirmed_at  timestamptz,
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_by    text,
  updated_at    timestamptz not null default now(),
  unique (workplace_id, month)
);
comment on table hr.payrolls is '월 급여 머리(사업장·귀속월·지급일·확정). 확정하면 그 달 급여와 근무대장이 잠긴다';

create table if not exists hr.payroll_lines (
  id            uuid primary key default gen_random_uuid(),
  payroll_id    uuid not null references hr.payrolls(id) on delete cascade,
  employee_id   uuid not null references hr.employees(id),
  inputs        jsonb not null default '{}'::jsonb,        -- 손으로 넣거나 고친 것 { overrides, extras, memo }
  result        jsonb not null default '{}'::jsonb,        -- 계산 결과(시간·항목별 금액·계산 방법·회사 부담) — 확정 때의 값 그대로
  snapshot      jsonb not null default '{}'::jsonb,        -- 그때의 직원 정보(성명·사번·부서·직위·생년월일·급여 형태)
  pay_total     integer not null default 0,
  deduct_total  integer not null default 0,
  net_pay       integer not null default 0,
  updated_by    text,
  updated_at    timestamptz not null default now(),
  unique (payroll_id, employee_id)
);
create index if not exists payroll_lines_employee_idx on hr.payroll_lines (employee_id);
comment on table hr.payroll_lines is '월 급여의 직원별 줄. result 에 확정 때의 시간·시급·금액을 그대로 보관한다';

alter table hr.pay_items     enable row level security;
alter table hr.employee_pay  enable row level security;
alter table hr.tax_tables    enable row level security;
alter table hr.payrolls      enable row level security;
alter table hr.payroll_lines enable row level security;
grant all on hr.pay_items, hr.employee_pay, hr.tax_tables, hr.payrolls, hr.payroll_lines to service_role;
revoke all on hr.pay_items, hr.employee_pay, hr.tax_tables, hr.payrolls, hr.payroll_lines from anon;
revoke all on hr.pay_items, hr.employee_pay, hr.tax_tables, hr.payrolls, hr.payroll_lines from authenticated;

-- ── 월 급여 저장(작성 중 저장 / 확정) ───────────────────────────────
-- 한 사업장의 한 달을 p_lines 와 같게 맞춘다(보낸 직원은 넣거나 고치고, 보내지 않은 직원의 줄은 지운다). 한 트랜잭션.
--  p_lines: [{ employee_id, inputs, result, snapshot, pay_total, deduct_total, net_pay }, …]
--  p_fixed: [{ employee_id, item_id, amount, qty }, …] — 매월 고정 항목의 금액을 직원에게 기억해 둔다(0 이면 지운다)
--  p_confirm = true 면 같은 트랜잭션에서 확정한다. 이미 확정된 달은 거절한다.
create or replace function hr.save_payroll(p_workplace uuid, p_month text, p_pay_date date, p_lines jsonb, p_fixed jsonb, p_confirm boolean, p_actor text)
returns uuid
language plpgsql
set search_path = hr, public
as $$
declare
  v_id uuid;
  v_status text;
  v_lines jsonb := coalesce(p_lines, '[]'::jsonb);
  v_fixed jsonb := coalesce(p_fixed, '[]'::jsonb);
begin
  if p_workplace is null or p_month is null or p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' or p_pay_date is null then
    raise exception '사업장·귀속월·지급일을 확인하세요.';
  end if;
  if jsonb_typeof(v_lines) <> 'array' or jsonb_typeof(v_fixed) <> 'array' then
    raise exception '줄 목록이 올바르지 않습니다.';
  end if;
  if not exists (select 1 from hr.workplaces w where w.id = p_workplace) then
    raise exception '없는 사업장입니다.';
  end if;
  if exists (select 1 from jsonb_array_elements(v_lines) r group by (r->>'employee_id') having count(*) > 1) then
    raise exception '같은 직원이 두 번 들어 있습니다.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_lines) r
     where not exists (select 1 from hr.employees e where e.id = (r->>'employee_id')::uuid)
  ) then
    raise exception '없는 직원이 들어 있습니다.';
  end if;

  -- 같은 달의 저장·확정이 겹치지 않게(두 창에서 동시에)
  perform pg_advisory_xact_lock(hashtext('hr.payrolls:' || p_workplace::text || ':' || p_month));

  select p.id, p.status into v_id, v_status from hr.payrolls p where p.workplace_id = p_workplace and p.month = p_month for update;
  if v_id is not null and v_status = 'confirmed' then
    raise exception '확정된 급여입니다. 고치려면 확정을 취소하세요.';
  end if;
  if v_id is null then
    insert into hr.payrolls (workplace_id, month, pay_date, created_by, updated_by)
    values (p_workplace, p_month, p_pay_date, p_actor, p_actor)
    returning id into v_id;
  else
    update hr.payrolls set pay_date = p_pay_date, updated_by = p_actor, updated_at = now() where id = v_id;
  end if;

  delete from hr.payroll_lines l
   where l.payroll_id = v_id
     and not exists (select 1 from jsonb_array_elements(v_lines) r where (r->>'employee_id')::uuid = l.employee_id);

  insert into hr.payroll_lines (payroll_id, employee_id, inputs, result, snapshot, pay_total, deduct_total, net_pay, updated_by, updated_at)
  select v_id,
         (r->>'employee_id')::uuid,
         coalesce(r->'inputs', '{}'::jsonb),
         coalesce(r->'result', '{}'::jsonb),
         coalesce(r->'snapshot', '{}'::jsonb),
         coalesce((r->>'pay_total')::integer, 0),
         coalesce((r->>'deduct_total')::integer, 0),
         coalesce((r->>'net_pay')::integer, 0),
         p_actor,
         now()
    from jsonb_array_elements(v_lines) r
  on conflict (payroll_id, employee_id) do update set
    inputs = excluded.inputs,
    result = excluded.result,
    snapshot = excluded.snapshot,
    pay_total = excluded.pay_total,
    deduct_total = excluded.deduct_total,
    net_pay = excluded.net_pay,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  -- 매월 고정 항목: 이번에 넣은 금액을 직원에게 기억해 둔다
  delete from hr.employee_pay ep
   using jsonb_array_elements(v_fixed) f
   where ep.employee_id = (f->>'employee_id')::uuid
     and ep.item_id = (f->>'item_id')::uuid
     and coalesce((f->>'amount')::integer, 0) = 0;
  insert into hr.employee_pay (employee_id, item_id, amount, qty, updated_by, updated_at)
  select (f->>'employee_id')::uuid, (f->>'item_id')::uuid, (f->>'amount')::integer, coalesce((f->>'qty')::smallint, 1), p_actor, now()
    from jsonb_array_elements(v_fixed) f
   where coalesce((f->>'amount')::integer, 0) <> 0
     and exists (select 1 from hr.pay_items i where i.id = (f->>'item_id')::uuid)
     and exists (select 1 from hr.employees e where e.id = (f->>'employee_id')::uuid)
  on conflict (employee_id, item_id) do update set
    amount = excluded.amount,
    qty = excluded.qty,
    updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  if coalesce(p_confirm, false) then
    if not exists (select 1 from hr.payroll_lines l where l.payroll_id = v_id) then
      raise exception '급여 줄이 없습니다.';
    end if;
    update hr.payrolls
       set status = 'confirmed', confirmed_by = p_actor, confirmed_at = now(), updated_by = p_actor, updated_at = now()
     where id = v_id;
  end if;
  return v_id;
end $$;

comment on function hr.save_payroll(uuid, text, date, jsonb, jsonb, boolean, text) is '한 사업장의 한 달 급여를 보낸 줄과 같게 맞춘다(넣기·고치기·지우기·고정 금액·확정을 한 트랜잭션으로)';

-- 확정 취소 — 작성 중으로 되돌린다(줄과 입력은 그대로). 확정된 달이 아니면 거절.
create or replace function hr.unconfirm_payroll(p_id uuid, p_actor text)
returns void
language plpgsql
set search_path = hr, public
as $$
begin
  update hr.payrolls
     set status = 'draft', confirmed_by = null, confirmed_at = null, updated_by = p_actor, updated_at = now()
   where id = p_id and status = 'confirmed';
  if not found then
    raise exception '확정된 급여가 아닙니다.';
  end if;
end $$;

comment on function hr.unconfirm_payroll(uuid, text) is '급여 확정 취소(작성 중으로). 근무대장 잠금도 함께 풀린다';

-- ── 근무대장 저장 — 급여가 확정된 달은 거절한다(hr/002 의 함수에 확인 한 가지를 더한 것) ──
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

  -- 같은 직원의 저장이 겹치지 않게(두 창에서 동시에)
  perform pg_advisory_xact_lock(hashtext('hr.work_logs:' || p_employee::text));

  -- 급여가 확정된 달은 고치지 않는다(그 직원 사업장의 그 달 급여)
  if exists (
    select 1
      from hr.payrolls p
      join hr.employees e on e.workplace_id = p.workplace_id
     where e.id = p_employee
       and p.status = 'confirmed'
       and p.month >= to_char(p_from, 'YYYY-MM')
       and p.month <= to_char(p_to, 'YYYY-MM')
  ) then
    raise exception '급여가 확정된 달입니다. 근무대장을 고치려면 급여 확정을 취소하세요.';
  end if;

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

revoke all on function hr.save_payroll(uuid, text, date, jsonb, jsonb, boolean, text) from public;
revoke all on function hr.save_payroll(uuid, text, date, jsonb, jsonb, boolean, text) from anon;
revoke all on function hr.save_payroll(uuid, text, date, jsonb, jsonb, boolean, text) from authenticated;
grant execute on function hr.save_payroll(uuid, text, date, jsonb, jsonb, boolean, text) to service_role;
revoke all on function hr.unconfirm_payroll(uuid, text) from public;
revoke all on function hr.unconfirm_payroll(uuid, text) from anon;
revoke all on function hr.unconfirm_payroll(uuid, text) from authenticated;
grant execute on function hr.unconfirm_payroll(uuid, text) to service_role;
revoke all on function hr.save_work_logs(uuid, date, date, jsonb, text) from public;
revoke all on function hr.save_work_logs(uuid, date, date, jsonb, text) from anon;
revoke all on function hr.save_work_logs(uuid, date, date, jsonb, text) from authenticated;
grant execute on function hr.save_work_logs(uuid, date, date, jsonb, text) to service_role;

notify pgrst, 'reload schema';
