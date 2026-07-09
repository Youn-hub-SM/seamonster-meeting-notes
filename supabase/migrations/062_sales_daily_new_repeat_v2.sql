-- 062_sales_daily_new_repeat_v2.sql
-- 061 뷰 재정의: '미분류(안심번호+무전화)' 버킷 추가 → 총주문과 정확히 맞아떨어짐.
--  신규주문 + 재구매주문 + 미분류주문 = 총주문(total_orders).
--  · 신규/재구매 '고객 수'는 식별 가능한 주문(전화 있고 050 아님)만으로 계산 → 예전과 동일하게 정확.
--  · 미분류 = customer_key='' (무전화) 또는 050 안심번호 고객. 같은 사람인지 판별 불가라
--             신규/재구매로 못 나눔 → 주문 수/매출만 별도 버킷으로 노출(총합 맞춤용).
--
-- [왜 필요했나] 하루 주문 167 vs total_customers 132 의 차이(35)는 재구매(1)가 아니라
--   050 안심번호(32)+무전화(2) 였음. 이 버킷을 드러내 "132는 어디서, 나머지는 뭔지" 한눈에.
--
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등.
-- 061에서 컬럼 순서가 바뀌므로 create-or-replace 불가 → drop 후 create(뷰는 참조 대상 없음, 안전).

drop view if exists sales_daily_new_repeat;
create view sales_daily_new_repeat as
with base as (
  select
    o.order_date, o.order_id, o.subtotal_amount, o.customer_key,
    (o.customer_key = '' or coalesce(c.phone_digits, '') like '050%') as unclassified
  from sales_orders o
  left join sales_customers c on c.customer_key = o.customer_key
),
firsts as (                          -- 식별 가능한 고객의 최초 구매일(전 기간)
  select customer_key, min(order_date) as first_purchase_date
  from base where not unclassified
  group by customer_key
),
ident_day as (                       -- 식별 가능: 고객×일자 1행
  select b.customer_key, b.order_date,
         count(distinct b.order_id) as orders,
         sum(b.subtotal_amount)     as revenue
  from base b where not b.unclassified
  group by b.customer_key, b.order_date
),
ident_labeled as (
  select d.order_date, d.orders, d.revenue,
         (d.order_date = f.first_purchase_date) as is_new
  from ident_day d join firsts f on f.customer_key = d.customer_key
),
ident_agg as (
  select order_date,
    count(*) filter (where is_new)                       as new_customers,
    count(*) filter (where not is_new)                   as repeat_customers,
    coalesce(sum(orders)  filter (where is_new), 0)      as new_orders,
    coalesce(sum(orders)  filter (where not is_new), 0)  as repeat_orders,
    coalesce(sum(revenue) filter (where is_new), 0)      as new_revenue,
    coalesce(sum(revenue) filter (where not is_new), 0)  as repeat_revenue
  from ident_labeled group by order_date
),
unclass_agg as (                     -- 미분류(무전화+050): 주문 grain
  select order_date,
         count(distinct order_id) as unclassified_orders,
         sum(subtotal_amount)     as unclassified_revenue
  from base where unclassified group by order_date
),
all_agg as (                         -- 전체 주문(검증축)
  select order_date, count(distinct order_id) as total_orders, sum(subtotal_amount) as total_revenue
  from base group by order_date
)
select
  a.order_date,
  -- 고객 수(식별 가능 기준)
  coalesce(i.new_customers, 0)                                as new_customers,     -- 오늘 신규 고객
  coalesce(i.repeat_customers, 0)                             as repeat_customers,  -- 오늘 재구매 고객
  coalesce(i.new_customers, 0) + coalesce(i.repeat_customers, 0) as total_customers, -- 식별 고객 합
  round(100.0 * coalesce(i.repeat_customers, 0)
        / nullif(coalesce(i.new_customers, 0) + coalesce(i.repeat_customers, 0), 0), 1) as repeat_rate_pct,
  -- 주문 수(합 = 총주문): 신규 + 재구매 + 미분류
  coalesce(i.new_orders, 0)                                   as new_orders,
  coalesce(i.repeat_orders, 0)                                as repeat_orders,
  coalesce(u.unclassified_orders, 0)                          as unclassified_orders, -- 안심번호+무전화(판별불가)
  a.total_orders,                                                                     -- = 위 3개 합
  -- 매출(합 = 총매출)
  coalesce(i.new_revenue, 0)                                  as new_revenue,
  coalesce(i.repeat_revenue, 0)                               as repeat_revenue,
  coalesce(u.unclassified_revenue, 0)                         as unclassified_revenue,
  a.total_revenue
from all_agg a
left join ident_agg   i on i.order_date = a.order_date
left join unclass_agg u on u.order_date = a.order_date;

comment on view sales_daily_new_repeat is
  '일자별 신규(첫구매)·재구매 고객수 + 미분류(안심번호·무전화) 버킷. 신규주문+재구매주문+미분류주문=총주문.';

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'looker_ro') then
    grant select on sales_daily_new_repeat to looker_ro;
  end if;
end $$;

NOTIFY pgrst, 'reload schema';
