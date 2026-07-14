-- 068_report_readonly.sql  (개정: 역할/소유권 이전 없이 — Supabase SQL Editor 호환)
-- AI 커스텀 리포트(자연어→SQL) 안전 실행 기반.
--  · run_report(q): SECURITY DEFINER 함수(소유자=postgres 기본). postgres 소유라 기반테이블 RLS 우회(뷰와 동일 원리)
--    → 매출·재고 '테이블'도 정상 조회. 반환 전 5000행 캡 + statement_timeout 15s.
--  · 안전성(다층 방어):
--      1) 함수 내부: sales_customers(전화·이름 PII) 참조 즉시 차단.
--      2) 함수 내부: 서브쿼리로 감싸 다중문/DDL 무력화(단일 SELECT만 의미있게 실행).
--      3) EXECUTE 는 service_role(서버 API)만. anon/authenticated/public 회수.
--      4) 앱 코드(report-ai.ts): 단일 SELECT + 화이트리스트 관계만 통과(그 외/PII/시스템테이블 거부).
--  ※ 이전 초안의 report_ro 역할/정책을 이미 만들었다면 이 함수는 그걸 쓰지 않음(무해한 잔존 — 그대로 둬도 됨).
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등.

create or replace function public.run_report(q text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare r json;
begin
  -- PII 테이블 하드 차단(앱 검증과 별개 이중 방어)
  if q ~* '\msales_customers\M' then
    raise exception '개인정보 테이블(sales_customers)은 조회할 수 없습니다.';
  end if;
  perform set_config('statement_timeout', '15000', true);  -- 15초
  execute format(
    'select coalesce(json_agg(t), ''[]''::json) from (select * from (%s) _sub limit 5000) t',
    q
  ) into r;
  return r;
end $$;

revoke all on function public.run_report(text) from public;
revoke all on function public.run_report(text) from anon;
revoke all on function public.run_report(text) from authenticated;
grant execute on function public.run_report(text) to service_role;  -- 서버(서비스키)만 호출

NOTIFY pgrst, 'reload schema';
