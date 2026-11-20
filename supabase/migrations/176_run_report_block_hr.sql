-- 176: run_report 가 hr 스키마를 읽지 못하게 (2026-11-20, 급여·연차 창 — docs/payroll-leave-plan.md 2장)
--
-- ■ 왜
--   급여·주민등록번호는 새 스키마 hr 에 둔다(supabase/migrations/hr/001). run_report 는 security definer 라
--   함수 주인의 권한으로 실행되므로, 스키마 이름을 정규식으로 막지 않으면 AI 비서·커스텀 리포트가 'hr.employees' 를 읽을 수 있다.
--   지금 정규식은 이름을 적은 스키마(factory·auth·storage 등)만 막는다 — hr 을 더한다.
-- ■ 무엇을
--   156 의 run_report 본문 그대로, 스키마 차단 정규식에 hr 한 단어만 추가.
--   부작용: 조회문에서 표 별칭을 hr 로 쓰면(hr.칸) 막힌다 — 별칭을 다른 이름으로 쓰면 된다.
--
-- 적용: Supabase Dashboard > SQL Editor 에 이 파일 하나만 붙여넣고 Run. 멱등(재실행 안전). hr/001 과 순서 무관 — 먼저 적용해도 된다.

create or replace function public.run_report(q text, p_limit int default 5000)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  r json;
  cap int := least(greatest(coalesce(p_limit, 5000), 1), 100000);
begin
  if q ~* '\m(sales_customers|b2b_settings|app_users|okr_checkins|bank_deposits|bank_deposit_names|shipments|companies|survey_responses|utm_settings|channel_commands|tax_invoices|report_threads|report_messages|report_tables|report_glossary|report_feedback|briefings|ms365_doc_index|fulfill_customers)\M' then
    raise exception '비공개 테이블(개인정보·계정·설정·면담·입금·문서 본문)은 조회할 수 없습니다. 업체명은 companies_report, 발송은 shipments_report 를 사용하세요.';
  end if;
  -- 다른 스키마·카탈로그 참조 차단(비서의 스키마 조회문 '/*schema*/' 만 예외)
  if q !~ '^\s*/\*schema\*/' and q ~* '\m(pg_catalog|pg_[a-z_]+|information_schema|factory|hr|auth|storage|extensions)\s*\.' then
    raise exception 'public 스키마의 표·뷰만 조회할 수 있습니다.';
  end if;
  perform set_config('statement_timeout', case when cap > 5000 then '60000' else '15000' end, true);
  execute format(
    'select coalesce(json_agg(t), ''[]''::json) from (select * from (%s) _sub limit %s) t',
    q, cap
  ) into r;
  return r;
end $$;

revoke all on function public.run_report(text, int) from public;
revoke all on function public.run_report(text, int) from anon;
revoke all on function public.run_report(text, int) from authenticated;
grant execute on function public.run_report(text, int) to service_role;

notify pgrst, 'reload schema';
