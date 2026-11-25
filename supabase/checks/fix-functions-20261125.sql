-- 함수 두 개를 최신 파일의 정의로 다시 만든다 (2026-11-25 점검 결과)
--
-- 점검(schema-check.sql)에서 두 함수의 본문이 옛 파일과 같게 나왔다:
--   factory.log_product_change = factory/005 판 (최신은 factory/006 — 규격 변경을 히스토리에 남긴다)
--   hr.save_work_logs          = hr/002 판     (최신은 hr/003 — 급여가 확정된 달의 근무대장 저장을 거절한다)
--
-- 아래 정의는 두 최신 파일에서 그대로 뽑은 것이다(글자 하나 바꾸지 않음). 표·자료는 건드리지 않는다.
-- 함수 이름·인자가 같아 권한(grant)은 그대로 남는다. 다시 실행해도 안전하다.
-- 적용: Supabase Dashboard > SQL Editor 에 전체를 붙여넣고 Run.

-- ── factory/006_products_spec.sql 에서 ──
create or replace function factory.log_product_change()
returns trigger
language plpgsql
set search_path = factory, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    insert into factory.product_changes (product_id, sku, name, field, new_value, changed_by)
    values (new.id, new.sku, new.name, '등록',
      nullif(concat_ws(' · ',
        case when new.spec is not null then '규격 ' || new.spec end,
        case when new.cost is not null then '원가 ' || to_char(new.cost, 'FM999,999,999,999') || '원' end,
        case when new.price is not null then '판매가 ' || to_char(new.price, 'FM999,999,999,999') || '원' end), ''),
      new.created_by);
    return new;
  end if;
  insert into factory.product_changes (product_id, sku, name, field, old_value, new_value, changed_by)
  select new.id, new.sku, new.name, v.f, v.o, v.n, new.updated_by
  from (values
    ('sku', old.sku, new.sku),
    ('name', old.name, new.name),
    ('spec', old.spec, new.spec),
    ('origin', old.origin, new.origin),
    ('note', old.note, new.note),
    ('cost', old.cost::text, new.cost::text),
    ('price', old.price::text, new.price::text),
    ('stock_tracked', case when old.stock_tracked then '사용' else '사용안함' end, case when new.stock_tracked then '사용' else '사용안함' end)
  ) as v(f, o, n)
  where v.o is distinct from v.n;
  return new;
end;
$$;

-- ── hr/003_payroll.sql 에서 ──
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

notify pgrst, 'reload schema';

-- 확인: 두 줄 모두 '최신'이 나오면 끝.
select n.nspname || '.' || p.proname as "함수",
       case md5(regexp_replace(p.prosrc, '[ \t\n\r\f\v]+', '', 'g'))
         when '983aaf4eb14d7b3ef453f0cf036a23a9' then '최신'
         when '60a75af9a1d09cf396a0ac5fd3177d7e' then '최신'
         else '아직 옛 판' end as "상태"
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where (n.nspname, p.proname) in (('hr', 'save_work_logs'), ('factory', 'log_product_change'));
