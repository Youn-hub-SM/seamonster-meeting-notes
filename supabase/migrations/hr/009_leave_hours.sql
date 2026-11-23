-- hr/009 시간 단위 연차 (2026-11-23, docs/payroll-leave-plan.md 27장)
--
-- 대표: "근무 기록이 있어도 연차 메뉴에서 연차등록을 하면 근무 기록을 덮는 시스템이 필요해. … 그리고 시간 설정이 가능토록 … 연차 또는 시간 설정으로 하자."
-- ■ 무엇을 바꾸나
--   hr.work_logs.leave_days(그날 쓴 연차, 일 단위)는 0 · 0.25 · 0.5 · 1 만 받았다(반반차·반차·연차).
--   연차를 시간으로 넣게 되어 '시간 ÷ 하루 소정근로시간'이 들어온다(8시간 근무자의 3시간 = 0.375, 7시간 근무자의 2시간 = 0.2857).
--   · 칸을 소수 넷째 자리까지로 넓힌다: numeric(3,2) → numeric(5,4)
--   · 제약을 "0 이상 1 이하"로 바꾼다
--   이미 들어 있는 값(0.25 · 0.5 · 1)은 그대로다.
-- ■ 미적용이면
--   하루 연차와 8시간 근무자의 2시간·4시간처럼 0.25 · 0.5 로 떨어지는 시간은 지금도 들어간다.
--   그 밖의 시간(예: 3시간)을 넣으면 연차 화면이 'DB 준비 전(hr/009 적용)'을 보이고 아무것도 저장하지 않는다.
--
-- 이 번호열은 hr 스키마 밖을 건드리지 않는다. 적용: Supabase SQL Editor 에 이 파일 하나를 붙여넣고 Run. 멱등 — 재실행 안전. hr/008 다음.

do $$
declare
  c text;
begin
  -- leave_days 에 걸린 옛 제약(이름이 달라도)을 모두 걷는다
  for c in
    select con.conname
      from pg_constraint con
     where con.conrelid = 'hr.work_logs'::regclass and con.contype = 'c' and pg_get_constraintdef(con.oid) ilike '%leave_days%'
  loop
    execute format('alter table hr.work_logs drop constraint %I', c);
  end loop;
end $$;

alter table hr.work_logs alter column leave_days type numeric(5,4);
alter table hr.work_logs add constraint work_logs_leave_days_check check (leave_days >= 0 and leave_days <= 1);
comment on column hr.work_logs.leave_days is '그날 쓴 연차(일). 하루 = 1, 시간 단위 = 시간 ÷ 하루 소정근로시간(소수 넷째 자리까지)';

notify pgrst, 'reload schema';
