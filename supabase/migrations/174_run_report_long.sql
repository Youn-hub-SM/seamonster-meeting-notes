-- 174: 오래 걸리는 조회용 run_report_long — 제한 시간 60초 (2026-11-20, 오디언스 검색 타임아웃)
--
-- ■ 왜
--   오디언스 추출의 [고객 찾기]가 'canceling statement due to statement timeout' 으로 실패했다(11-20 베타 로그 2건, 약 8초에 끊김).
--   run_report(156 본문)는 함수 안에서 set_config('statement_timeout', 15초 또는 60초)를 부르지만,
--   제한 시간은 문장이 시작될 때 정해지므로 이미 실행 중인 그 호출에는 적용되지 않는다.
--   그래서 실제 제한은 Supabase 의 API 역할 기본값(약 8초)이었다.
--
-- ■ 무엇을
--   run_report 를 그대로 부르는 얇은 함수 run_report_long 을 만들고, 함수 정의에 statement_timeout = 60초를 붙인다.
--   함수 정의에 붙인 값은 API(PostgREST)가 호출 전에 적용하므로 실제로 듣는다(Supabase 문서의 함수 단위 타임아웃 방식).
--   차단 목록·읽기 전용·행 수 상한은 run_report 가 그대로 지킨다.
--   오디언스 추출의 고객 찾기·상품 선택지 조회만 이 함수를 쓴다(app/lib/audience.ts runLong). AI 비서·리포트는 바뀌지 않는다.
--
-- 적용 전에는 앱이 run_report 로 조회한다(지금과 같음 — 넓은 조건은 약 8초에 끊긴다).
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

create or replace function public.run_report_long(q text, p_limit int default 5000)
returns json
language sql
set statement_timeout to '60s'
as $$
  select public.run_report(q, p_limit);
$$;

comment on function public.run_report_long(text, int) is 'run_report 와 같되 제한 시간 60초(함수 정의의 statement_timeout). 오디언스 추출처럼 주문 전체를 훑는 서버 조회용';

revoke all on function public.run_report_long(text, int) from public;
revoke all on function public.run_report_long(text, int) from anon;
revoke all on function public.run_report_long(text, int) from authenticated;
grant execute on function public.run_report_long(text, int) to service_role;

notify pgrst, 'reload schema';
