-- 061_sales_daily_new_repeat.sql
-- 일자별 '신규 vs 재구매' 고객 — 루커스튜디오 스코어카드/추세용.
--  · 신규(new)  = 그 날짜가 그 고객의 '첫 구매일'(전 채널 통틀어 최초). = 오늘 새로 유입된 고객.
--  · 재구매(repeat) = 그 날짜에 샀지만 그 이전에도 산 적 있는 고객.
--  ※ 058(sales_customer_summary)은 '고객 생애 세그먼트'(누적 2회+)라 질문이 다름. 061은 '일자별 획득/재방문'.
--
-- [집계 규칙 — 058과 동일한 base]
--  · 고객식별: sales_orders.customer_key (전화 HMAC). 빈 전화('') 제외.
--  · 050 안심번호 고객 제외(sales_customers.phone_digits LIKE '050%').
--  · 매출축 = subtotal_amount, 주문수 = distinct order_id.
--  · order_date 는 KST 기준일(정본) → 루커 타임존을 서울로 두면 'Today' 필터가 맞아떨어짐.
--
-- 사용: 루커에서 이 뷰를 데이터소스로 추가 → 날짜 컨트롤(또는 Today)로 order_date 필터.
--       '오늘'만 보려면 order_date 를 오늘로 필터. 추세로 보려면 order_date 를 축으로.
-- PII 안전: 뷰 소유자(postgres) 권한으로 sales_customers 를 읽어 050 판별에만 사용, 전화는 출력 안 함.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등(create or replace).

create or replace view sales_daily_new_repeat as
with base as (
  select o.customer_key, o.order_date, o.order_id, o.subtotal_amount
  from sales_orders o
  left join sales_customers c on c.customer_key = o.customer_key
  where o.customer_key <> ''
    and coalesce(c.phone_digits, '') not like '050%'
),
firsts as (                         -- 고객별 최초 구매일(전 기간)
  select customer_key, min(order_date) as first_purchase_date
  from base group by customer_key
),
per_cust_day as (                   -- 고객×일자 1행 (그날의 주문수·매출)
  select customer_key, order_date,
         count(distinct order_id) as orders,
         sum(subtotal_amount)     as revenue
  from base group by customer_key, order_date
),
labeled as (
  select d.order_date, d.customer_key, d.orders, d.revenue,
         (d.order_date = f.first_purchase_date) as is_new
  from per_cust_day d
  join firsts f on f.customer_key = d.customer_key
)
select
  order_date,
  count(*) filter (where is_new)               as new_customers,     -- 오늘 신규 고객 수
  count(*) filter (where not is_new)           as repeat_customers,  -- 오늘 재구매 고객 수
  count(*)                                     as total_customers,
  round(100.0 * count(*) filter (where not is_new) / nullif(count(*), 0), 1) as repeat_rate_pct, -- 재구매 비율(%)
  coalesce(sum(revenue) filter (where is_new), 0)     as new_revenue,
  coalesce(sum(revenue) filter (where not is_new), 0) as repeat_revenue,
  coalesce(sum(orders)  filter (where is_new), 0)     as new_orders,
  coalesce(sum(orders)  filter (where not is_new), 0) as repeat_orders
from labeled
group by order_date;

comment on view sales_daily_new_repeat is '일자별 신규(첫구매)·재구매 고객 수/매출/주문수. 루커 오늘·추세용. 050·무전화 제외.';

-- 루커 읽기전용 역할에 조회 권한(역할 있을 때만)
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'looker_ro') then
    grant select on sales_daily_new_repeat to looker_ro;
  end if;
end $$;

NOTIFY pgrst, 'reload schema';
