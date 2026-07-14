-- 068_report_readonly.sql
-- AI 커스텀 리포트(자연어→SQL) 안전 실행 기반.
--  · report_ro : 로그인 없는 '권한 경계' 역할. 화이트리스트 관계에만 SELECT. PII(sales_customers) 미포함.
--  · run_report(q) : SECURITY DEFINER 함수(소유자=report_ro) → 어떤 호출자든 report_ro 권한으로만 q 실행.
--      - q 를 서브쿼리로 감싸 다중문/DDL 무력화 + 5000행 캡 + statement_timeout 15s.
--      - report_ro 는 쓰기 권한이 없어(SELECT만) delete/update/drop 등은 권한거부로 실패(이중 방어).
--      - EXECUTE 는 service_role 에만(우리 서버 API). anon/authenticated 회수.
--  앱 코드에서도 '단일 SELECT'만 통과시키는 1차 검증을 별도로 함.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등.

-- 1) 읽기전용 권한 경계 역할(로그인 불가)
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'report_ro') then
    create role report_ro nologin;
  end if;
end $$;

grant usage on schema public to report_ro;

-- 화이트리스트: 매출·재고 분석에 필요한 비-PII 관계만. (sales_customers=전화/이름 PII → 제외)
grant select on
  sales_orders,
  sales_looker,
  sales_group_repeat,
  sales_buyer_repeat,
  sales_daily_new_repeat,
  sales_customer_summary,
  sales_okr,
  products,
  inventory_txns,
  inventory_items
to report_ro;

-- 1-b) RLS 정책: 060 에서 '정책 없이' RLS만 켜져 있어, 비소유자 report_ro 는 원장/재고 '테이블'을
--   직접 읽으면 0행이 됨. → 화이트리스트 '테이블'에 report_ro 전용 SELECT 정책(읽기만) 부여.
--   (분석 '뷰'는 소유자(postgres) 권한으로 실행되어 RLS 우회 → 정책 불필요. sales_customers 는 정책 없음=차단 유지.)
do $$
declare t text;
begin
  foreach t in array array['sales_orders','products','inventory_txns','inventory_items'] loop
    execute format('drop policy if exists report_ro_sel on public.%I', t);
    execute format('create policy report_ro_sel on public.%I for select to report_ro using (true)', t);
  end loop;
end $$;

-- 2) 안전 실행 함수 — q(단일 SELECT)를 report_ro 권한으로 실행, JSON 배열 반환
create or replace function public.run_report(q text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare r json;
begin
  perform set_config('statement_timeout', '15000', true);  -- 15s
  execute format(
    'select coalesce(json_agg(t), ''[]''::json) from (select * from (%s) _sub limit 5000) t',
    q
  ) into r;
  return r;
end $$;

grant report_ro to current_user;                             -- 소유권 이전엔 대상 역할의 멤버여야 함(42501 방지)
alter function public.run_report(text) owner to report_ro;   -- definer = report_ro 권한으로 실행
revoke all on function public.run_report(text) from public;
grant execute on function public.run_report(text) to service_role;  -- 서버(서비스키)만 호출

NOTIFY pgrst, 'reload schema';
