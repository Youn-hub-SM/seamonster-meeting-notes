-- 100 커스텀 리포트: 조회 범위 전면 개방 + 행 한도 이원화 (2026-08-28, 대표 지시)
--  ① 비공개 테이블 하드 차단 — 화이트리스트를 회사 데이터 전반으로 확장하면서 RPC 단에서 이중 방어.
--     · sales_customers            — 고객 전화·이름 PII
--     · b2b_settings               — 웹훅 URL·API 토큰 등 비밀 저장소
--     · app_users                  — 로그인 계정(비밀번호)
--     · okr_checkins               — 1:1 면담 비공개 요약
--     · bank_deposits(+names)      — 은행 입금 내역(경영 비공개)
--     · shipments / companies      — 수령인·담당자 전화, 배송 주소 등 개인정보 → 아래 *_report 뷰로 대체
--     · survey_responses           — 설문 응답 원문(어떤 개인정보든 담길 수 있는 구조)
--  ② 비민감 대체 뷰 — 업체명 조인·발송 분석은 가능하게(개인정보 컬럼 제외).
--  ③ p_limit 파라미터 — 화면 조회 기본 5,000행, 엑셀 내보내기 100,000행(전량). "한도로 데이터가
--     끊긴다"(대표) 해결. 상한 100,000·타임아웃(기본 15s, 대량 60s) 하드 클램프.
--  기존 run_report(text) 는 제거하고 (text, int default 5000) 하나로 — 기존 { q } 호출은 그대로 동작.
-- 적용: Supabase SQL Editor 에 붙여넣고 Run. 멱등.

-- 비민감 대체 뷰(단어경계 차단 정규식에 걸리지 않는 이름)
create or replace view public.companies_report as
  select id, name from public.companies;
create or replace view public.shipments_report as
  select id, order_id, courier, tracking_no, shipped_at, created_at from public.shipments;

drop function if exists public.run_report(text) cascade;
drop function if exists public.run_report(text, int) cascade;

create function public.run_report(q text, p_limit int default 5000)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  r json;
  cap int := least(greatest(coalesce(p_limit, 5000), 1), 100000);
begin
  if q ~* '\m(sales_customers|b2b_settings|app_users|okr_checkins|bank_deposits|bank_deposit_names|shipments|companies|survey_responses)\M' then
    raise exception '비공개 테이블(개인정보·계정·설정·면담·입금)은 조회할 수 없습니다. 업체명은 companies_report, 발송은 shipments_report 를 사용하세요.';
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
grant execute on function public.run_report(text, int) to service_role;  -- 서버(서비스키)만 호출

NOTIFY pgrst, 'reload schema';
