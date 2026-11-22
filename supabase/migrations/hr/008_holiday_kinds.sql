-- hr/008 휴무일 — 쉬는 날의 구분과 적용 범위 (2026-11-23, docs/payroll-leave-plan.md 24장)
--
-- 대표: "휴무일 등록도 가능한가?" → "넓혀서 진행"
-- ■ 무엇을 바꾸나
--   hr.holidays(hr/007)는 날짜 하나에 한 줄이고 모두 '유급 휴일'로만 쓰였다. 여기에 두 가지를 더한다.
--   · kind — 구분
--       public = 공휴일(관공서 공휴일). 지금까지의 줄은 모두 이것이다. 상시 5인 이상 사업장만 유급 휴일로 채운다(5인 미만은 노동절만).
--       paid   = 유급 휴무일(회사가 정한 유급 휴일 — 창립기념일 등). 사업장 크기와 상관없이 '유급 휴일'로 채운다.
--       unpaid = 무급 휴무일(공장이 쉬는 날 등). '무급 휴무'로 채운다.
--   · workplace_id · affiliation — 적용 범위
--       둘 다 비면 전체, workplace_id 만 있으면 그 사업장, 둘 다 있으면 그 사업장의 그 소속.
--       같은 날에 줄이 여럿이면 범위가 좁은 줄이 이긴다(소속 > 사업장 > 전체).
--   그래서 날짜 하나에 여러 줄이 올 수 있다 → 기본 키를 holiday_date 에서 id 로 바꾸고,
--   (날짜, 사업장, 소속) 이 같은 줄은 하나만 있게 유일 색인을 둔다.
-- ■ 쓰이는 곳(코드)
--   · 근무대장 [평소대로 채우기] — 그 직원에게 걸리는 줄의 구분대로 '유급 휴일' 또는 '무급 휴무'로 채운다.
--   · 연차 [사용 등록] — 그 날을 건너뛴다(유급·무급 모두).
--   급여 계산은 지금까지와 같이 근무대장에 저장된 줄만 본다.
-- ■ 미적용이면
--   지금까지처럼 돈다(모든 줄이 공휴일·전체). 구분이나 적용 범위를 골라 넣으려 하면 'DB 준비 전(hr/008 적용)'을 보인다.
-- ■ 주의
--   이 파일을 적용한 뒤에는 hr/007 을 다시 실행하지 않는다 — 007 의 처음 값 넣기가 holiday_date 유일 제약에 기대는데, 그 제약이 없어진다.
--
-- 이 번호열은 hr 스키마 밖을 건드리지 않는다. 적용: Supabase SQL Editor 에 이 파일 하나를 붙여넣고 Run. 멱등 — 재실행 안전. hr/007 다음.

alter table hr.holidays add column if not exists id uuid not null default gen_random_uuid();
alter table hr.holidays add column if not exists kind text not null default 'public';
alter table hr.holidays add column if not exists workplace_id uuid references hr.workplaces(id) on delete cascade;
alter table hr.holidays add column if not exists affiliation text not null default '';

comment on table hr.holidays is '쉬는 날 목록(공휴일·유급 휴무일·무급 휴무일) — 근무대장의 [평소대로 채우기]가 이 날을 유급 휴일·무급 휴무로 채우고, 연차 사용 등록이 이 날을 건너뛴다';
comment on column hr.holidays.kind is '구분: public=공휴일(5인 이상 사업장만 유급 휴일, 5인 미만은 노동절만) · paid=유급 휴무일(회사가 정한 유급 휴일) · unpaid=무급 휴무일';
comment on column hr.holidays.workplace_id is '적용 사업장. null = 모든 사업장';
comment on column hr.holidays.affiliation is '적용 소속(그 사업장 affiliations 가운데 하나의 이름). 빈 값 = 그 사업장 전원. workplace_id 가 있을 때만 쓴다';

do $$
declare
  pk text;
begin
  if not exists (select 1 from pg_constraint where conrelid = 'hr.holidays'::regclass and conname = 'holidays_kind_check') then
    alter table hr.holidays add constraint holidays_kind_check check (kind in ('public', 'paid', 'unpaid'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'hr.holidays'::regclass and conname = 'holidays_scope_check') then
    alter table hr.holidays add constraint holidays_scope_check check (affiliation = '' or workplace_id is not null);
  end if;

  -- 기본 키: holiday_date → id (날짜 하나에 범위가 다른 줄이 여럿 올 수 있게)
  select c.conname into pk
    from pg_constraint c
   where c.conrelid = 'hr.holidays'::regclass and c.contype = 'p'
     and (select array_agg(a.attname::text) from pg_attribute a where a.attrelid = c.conrelid and a.attnum = any (c.conkey)) = array['holiday_date'];
  if pk is not null then
    execute format('alter table hr.holidays drop constraint %I', pk);
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'hr.holidays'::regclass and contype = 'p') then
    alter table hr.holidays add constraint holidays_pkey primary key (id);
  end if;
end $$;

-- (날짜, 사업장, 소속)이 같은 줄은 하나만 — 사업장이 빈 줄(전체)끼리도 겹치지 않게 빈 값을 0 으로 본다
create unique index if not exists holidays_scope_uq
  on hr.holidays (holiday_date, coalesce(workplace_id, '00000000-0000-0000-0000-000000000000'::uuid), affiliation);

notify pgrst, 'reload schema';
