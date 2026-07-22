-- 081_sales_new_repeat_looker.sql
-- sales_new_repeat 재정의 — 루커(062 sales_daily_new_repeat)와 동일 기준으로 통일 + 미분류 버킷 추가.
--
--  · 신규/재구매 '고객 수'는 식별 가능(전화 있고 050 안심번호 아님) 고객만으로 계산.
--    생애 최초 구매가 기간 내면 신규, 기간 시작 이전 구매 이력이 있으면 재구매.
--  · 미분류 = 무전화(customer_key='') 또는 050 안심번호 고객.
--    안심번호는 주문마다 번호가 바뀌어 동일인 판별이 불가 → 신규/재구매로 못 나눔.
--    주문 수·매출만 별도 버킷으로 노출(리포트에서 "132는 신규/재구매, 나머지는 미분류" 로 총합 맞춤).
--
--  [기존(039)과의 차이 — 왜 값이 바뀌나]
--    039는 050 안심번호를 customer_key 로 그대로 세었다. 안심번호는 주문마다 키가 달라
--    대부분 '신규'로 잡혀 신규 고객수가 부풀려졌다. 이제 안심번호·무전화를 미분류로 분리하므로
--    신규 고객 수가 실제값(루커 기준)으로 내려간다. 재구매·총매출은 그대로.
--
-- 반환 컬럼이 늘어 create-or-replace 불가(Postgres 42P13) → drop 후 create.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등.

drop function if exists sales_new_repeat(date, date);
create function sales_new_repeat(p_from date, p_to date)
returns table (
  total                bigint,   -- 식별 가능 고객 합(신규+재구매)
  new_cust             bigint,   -- 신규 고객(생애 첫 구매가 기간 내)
  repeat_cust          bigint,   -- 재구매 고객(기간 이전 구매 이력 있음)
  unclassified_orders  bigint,   -- 미분류 주문 수(안심번호+무전화)
  unclassified_revenue bigint    -- 미분류 매출
)
language sql stable as $$
  with win as (                       -- 기간 내 주문 + 식별/미분류 라벨
    select o.order_id, o.customer_key, o.subtotal_amount,
           (o.customer_key = '' or coalesce(c.phone_digits, '') like '050%') as unclassified
    from sales_orders o
    left join sales_customers c on c.customer_key = o.customer_key
    where o.order_date between p_from and p_to
  ),
  ident as (                          -- 식별 가능 고객(distinct)
    select distinct customer_key from win where not unclassified
  ),
  flagged as (
    select i.customer_key,
           exists(select 1 from sales_orders b
                    where b.customer_key = i.customer_key and b.order_date < p_from) as is_repeat
    from ident i
  )
  select
    (select count(*) from flagged)::bigint,
    (select count(*) filter (where not is_repeat) from flagged)::bigint,
    (select count(*) filter (where is_repeat) from flagged)::bigint,
    (select count(distinct order_id) from win where unclassified)::bigint,
    coalesce((select sum(subtotal_amount) from win where unclassified), 0)::bigint
$$;

comment on function sales_new_repeat(date, date) is
  '기간 신규/재구매 고객수(식별 가능·생애 첫구매 기준) + 미분류(안심번호·무전화) 주문수·매출. 루커 sales_daily_new_repeat 와 동일 기준.';

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'looker_ro') then
    grant execute on function sales_new_repeat(date, date) to looker_ro;
  end if;
end $$;

NOTIFY pgrst, 'reload schema';
