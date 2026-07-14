-- 067_sales_buyer_repeat.sql
-- '특정 상품을 구매한 고객'의 재구매/재재구매(상품 상관 없이) — 루커 코호트용. 066과 공존.
--  066(sales_group_repeat)='그 상품 몇 번째로 샀나'(구매차수). 067='그 상품 산 고객이 아무거나 얼마나 다시 사나'(리텐션).
--
-- [축 선택형] 한 뷰에서 두 축으로 필터 가능:
--   · axis='sku'  → axis_value = sku_code (관리코드)      ← 권장(정확)
--   · axis='name' → axis_value = product_name (상품명)     ← 참고(주의: 아래)
--   루커에서 axis + axis_value 로 특정 상품을 고르면 그 상품 구매 고객의 재구매가 나온다.
--   ⚠ 상품명(name)은 마케팅 문구라 같은 상품이 여러 이름으로 쪼개짐 → 재구매율이 왜곡될 수 있음
--     (예: '씨몬스터 대구살 1kg …' 이름은 잠깐만 쓰여 재구매율 0.1%, 실제 재구매는 '대구순살 1kg' 등 다른 이름으로 잡힘).
--     정확한 재구매 분석은 axis='sku' 권장. display_name = 그 값의 대표(최빈) 실제 상품명(식별용).
--
-- [그레인] (axis, axis_value, customer_key) 1행. = '이 상품을 산 고객' 명부 + 재구매 지표.
-- [두 기준] 둘 다 '상품 상관 없이' 전체 주문 기준:
--   · A 생애  : total_orders            = 그 고객 평생 총 주문수. total_repeat_label.
--   · B 상품후: orders_since_first_anchor = '이 상품 첫 구매일 이후' 총 주문수. repeat_since_label(권장).
--   라벨: 1_첫구매(추가구매 없음)/2_재구매/3_재재구매/4_4회이상.
-- [고객 기준] 058/061/062/066 동일: customer_key 있고 050 안심번호 제외. PII: sales_customers 는 050 판별에만(전화 미출력).
--
-- 사용(루커): 데이터소스로 이 뷰 추가 →
--   · 필터: axis = 'sku'(또는 'name')  +  axis_value = 특정 상품
--   · 차원: repeat_since_label(권장) 또는 total_repeat_label
--   · 측정: COUNT DISTINCT customer_key. 재구매율 = 2회이상/전체.
--   ⚠ 반드시 하나의 axis_value 로 필터해서 볼 것(필터 없이 합계 내면 sku행+name행이 겹쳐 중복).
--     여러 SKU 묶어 볼 땐 A(생애)는 정확, B(상품후)는 부정확(상품마다 기준일 다름).
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등(drop+create).

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
  select o.order_date, o.order_id, o.subtotal_amount, o.customer_key, o.sku_code, o.product_name
  from sales_orders o
  left join sales_customers c on c.customer_key = o.customer_key
  where o.customer_key <> ''
    and coalesce(c.phone_digits, '') not like '050%'
    and o.sku_code is not null and o.sku_code <> ''
),
sku_name as (                      -- SKU별 대표(최빈) 실제 상품명 — 식별용
  select sku_code, mode() within group (order by product_name) as nm
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
-- ===== axis = sku =====
sku_cohort as (
  select customer_key, sku_code as av, min(order_date) as fad, count(distinct order_id) as ao
  from base group by customer_key, sku_code
),
sku_since as (
  select co.customer_key, co.av, count(distinct b.order_id) as so
  from sku_cohort co join base b on b.customer_key = co.customer_key and b.order_date >= co.fad
  group by co.customer_key, co.av
),
-- ===== axis = name =====
name_cohort as (
  select customer_key, product_name as av, min(order_date) as fad, count(distinct order_id) as ao
  from base where product_name is not null and product_name <> ''
  group by customer_key, product_name
),
name_since as (
  select co.customer_key, co.av, count(distinct b.order_id) as so
  from name_cohort co join base b on b.customer_key = co.customer_key and b.order_date >= co.fad
  group by co.customer_key, co.av
)
select 'sku'::text as axis, co.av as axis_value, coalesce(sn.nm, co.av) as display_name,
       co.customer_key, co.ao as anchor_orders, co.fad as first_anchor_date,
       l.total_orders, public.repeat_label(l.total_orders) as total_repeat_label,
       s.so as orders_since_first_anchor, public.repeat_label(s.so) as repeat_since_label,
       l.first_order_date, l.last_order_date, l.lifetime_revenue
from sku_cohort co
join life l on l.customer_key = co.customer_key
join sku_since s on s.customer_key = co.customer_key and s.av = co.av
left join sku_name sn on sn.sku_code = co.av
union all
select 'name'::text, co.av, co.av,
       co.customer_key, co.ao, co.fad,
       l.total_orders, public.repeat_label(l.total_orders),
       s.so, public.repeat_label(s.so),
       l.first_order_date, l.last_order_date, l.lifetime_revenue
from name_cohort co
join life l on l.customer_key = co.customer_key
join name_since s on s.customer_key = co.customer_key and s.av = co.av;

comment on view sales_buyer_repeat is
  '특정 상품(axis=sku/name) 구매 고객의 재구매/재재구매(상품 무관). A=생애/B=상품후. name축은 이름변경 왜곡 주의. 050 제외.';

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'looker_ro') then
    grant select on sales_buyer_repeat to looker_ro;
  end if;
end $$;

NOTIFY pgrst, 'reload schema';
