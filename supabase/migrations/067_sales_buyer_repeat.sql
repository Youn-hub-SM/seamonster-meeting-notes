-- 067_sales_buyer_repeat.sql
-- '특정 상품(SKU)을 구매한 고객'의 재구매/재재구매(상품 상관 없이) — 루커 코호트용.
--  066(sales_group_repeat)은 '그 상품을 몇 번째로 샀나'(구매차수)라면,
--  067은 '그 상품을 산 고객이 (아무 상품이나) 얼마나 다시 사나'(고객 리텐션)를 본다. 둘 다 유지.
--
-- [그레인] 고객 × sku_code 1행. = '이 SKU를 산 고객' 명부 + 그 고객의 재구매 지표.
--   ※ 축은 sku_code(관리코드) 그대로. 상품군 라벨은 추정이라 넣지 않음 → 필터는 sku_code 로 직접.
--     (여러 사이즈/옵션을 묶어 보려면 루커에서 sku_code '포함' 필터, 예: 'DG' 포함)
-- [참고 컬럼] sku_product_name = 그 SKU 로 가장 많이 팔린 실제 상품명(데이터 최빈값, 추정 아님) — 식별용.
-- [두 가지 재구매 기준] (둘 다 '상품 상관 없이' 전체 주문 기준)
--   · A 생애 기준  : total_orders            = 그 고객 평생 총 주문수. total_repeat_label.
--   · B 상품후 기준: orders_since_first_sku  = '이 SKU 첫 구매일 이후'의 총 주문수. repeat_since_label.
--       → "이 상품 산 뒤 다시 왔나"에 가장 정확(재구매의 정석). B ≤ A.
--   라벨(repeat_label): 1_첫구매(추가구매 없음) / 2_재구매 / 3_재재구매 / 4_4회이상.
-- [고객 기준] 058/061/062/066 동일: customer_key 있고 050 안심번호 제외.
-- [PII] 뷰 소유자(postgres) 권한으로 sales_customers 를 050 판별에만 사용, 전화 미출력. looker_ro 는 이 뷰만 SELECT.
--
-- 사용(루커): 데이터소스로 이 뷰 추가 →
--   · 필터: sku_code = 특정 상품코드   (여러 변형 묶으려면 sku_code '포함' 필터)
--   · 차원: repeat_since_label(권장, 상품후 재구매)  또는 total_repeat_label(생애)
--   · 측정: COUNT DISTINCT customer_key (구매 고객 수) → 첫/재/재재 깔때기. 재구매율 = 2회이상/전체.
--   ⚠ sku_code 로 필터해서 볼 것. 여러 SKU를 묶어(포함필터) 볼 땐 A(생애)는 정확, B(상품후)는 SKU마다
--     기준일이 달라 부정확 → 정밀 B는 SKU 하나로 필터.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등(drop+create). 066과 독립(공존).

create or replace function public.repeat_label(seq bigint) returns text language sql immutable as $$
  select case
    when seq = 1 then '1_첫구매'
    when seq = 2 then '2_재구매'
    when seq = 3 then '3_재재구매'
    when seq >= 4 then '4_4회이상'
    else null
  end
$$;

drop view if exists sales_buyer_repeat;
create view sales_buyer_repeat as
with base as (
  -- 전화 있는 고객만, 050 제외 (재구매 추적 가능한 주문)
  select o.order_date, o.order_id, o.subtotal_amount, o.customer_key, o.sku_code, o.product_name
  from sales_orders o
  left join sales_customers c on c.customer_key = o.customer_key
  where o.customer_key <> ''
    and coalesce(c.phone_digits, '') not like '050%'
    and o.sku_code is not null and o.sku_code <> ''
),
sku_name as (                      -- SKU별 대표(최빈) 실제 상품명 — 식별용(추정 아님)
  select sku_code, mode() within group (order by product_name) as sku_product_name
  from base group by sku_code
),
life as (                          -- 고객 생애(상품 무관)
  select customer_key,
         count(distinct order_id) as total_orders,
         min(order_date)          as first_order_date,
         max(order_date)          as last_order_date,
         sum(subtotal_amount)     as lifetime_revenue
  from base group by customer_key
),
cohort as (                        -- 고객 × SKU: 그 SKU 첫구매일 · 그 SKU 구매 주문수
  select customer_key, sku_code,
         min(order_date)          as first_sku_date,
         count(distinct order_id) as sku_orders
  from base group by customer_key, sku_code
),
since_first as (                   -- 그 SKU 첫구매일 이후(포함)의 총 주문수(상품 무관)
  select co.customer_key, co.sku_code,
         count(distinct b.order_id) as orders_since_first_sku
  from cohort co
  join base b on b.customer_key = co.customer_key and b.order_date >= co.first_sku_date
  group by co.customer_key, co.sku_code
)
select
  co.sku_code,
  sn.sku_product_name,                               -- 참고: 이 SKU 대표 상품명(데이터 최빈)
  co.customer_key,
  co.sku_orders,                                     -- 이 SKU 구매 주문수
  co.first_sku_date,                                 -- 이 SKU 첫 구매일
  l.total_orders,                                    -- 생애 총 주문(상품무관)
  public.repeat_label(l.total_orders) as total_repeat_label,               -- A: 생애 기준
  sf.orders_since_first_sku,                         -- 이 SKU 첫구매 이후 총 주문
  public.repeat_label(sf.orders_since_first_sku) as repeat_since_label,     -- B: 상품후 기준(권장)
  l.first_order_date, l.last_order_date,
  l.lifetime_revenue
from cohort co
join life l         on l.customer_key = co.customer_key
join since_first sf on sf.customer_key = co.customer_key and sf.sku_code = co.sku_code
left join sku_name sn on sn.sku_code = co.sku_code;

comment on view sales_buyer_repeat is
  '특정 SKU 구매 고객의 재구매/재재구매(상품 무관). 고객×sku_code 그레인. A=생애/B=상품후. 050·무전화 제외. 루커 코호트용.';

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'looker_ro') then
    grant select on sales_buyer_repeat to looker_ro;
  end if;
end $$;

NOTIFY pgrst, 'reload schema';
