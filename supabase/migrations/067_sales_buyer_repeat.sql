-- 067_sales_buyer_repeat.sql
-- '특정 상품(군)을 구매한 고객'의 재구매/재재구매(상품 상관 없이) — 루커 코호트용.
--  066(sales_group_repeat)은 '그 상품군을 몇 번 샀나'(축별 구매차수)라면,
--  067은 '그 상품을 산 고객이 (아무 상품이나) 얼마나 다시 사나'(고객 리텐션)를 본다. 둘 다 유지.
--
-- [그레인] 고객 × 상품군(product_group) 1행. 즉 '이 상품군을 산 고객' 명부 + 그 고객의 재구매 지표.
-- [상품군] = 관리코드 코어코드(P_/S_ 제거 후 첫 토큰, 대문자). 066과 동일. group_name 친화라벨.
-- [두 가지 재구매 기준] (둘 다 '상품 상관 없이' 전체 주문 기준)
--   · A 생애 기준  : total_orders        = 그 고객의 평생 총 주문수(아무 상품). total_repeat_label.
--   · B 상품후 기준: orders_since_first_group = '이 상품군 첫 구매일 이후'의 총 주문수. repeat_since_label.
--       → "이 상품을 산 뒤 다시 왔나"에 가장 정확(재구매의 정석). B ≤ A (군 구매 전 주문은 B에서 빠짐).
--   라벨(공통 repeat_label): 1_첫구매(추가구매 없음) / 2_재구매 / 3_재재구매 / 4_4회이상.
-- [고객 기준] 058/061/062/066 동일: customer_key(전화 HMAC) 있고 050 안심번호 제외(추적 불가).
-- [PII] 뷰 소유자(postgres) 권한으로 sales_customers 를 050 판별에만 사용, 전화 미출력. looker_ro 는 이 뷰만 SELECT.
--
-- 사용(루커): 데이터소스로 이 뷰 추가 →
--   · 필터: group_name = 특정 상품군(예: 대구살)
--   · 차원: repeat_since_label(권장, 상품후 재구매)  또는 total_repeat_label(생애)
--   · 측정: COUNT DISTINCT customer_key (구매 고객 수) → 첫/재/재재 깔때기. 재구매율 = 2회이상/전체.
--   ⚠ 이 뷰는 '상품군으로 필터해서' 보는 용도. 필터 없이 합계를 내면 한 고객이 산 상품군 수만큼 중복됨
--     (lifetime_revenue 등 고객단위 값은 group_name 필터를 건 상태에서만 정확).
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등(drop+create). 066과 독립(공존).

-- 라벨 함수(066에서 이미 생성됐으면 그대로, 없어도 안전하게 재정의)
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
  select o.order_date, o.order_id, o.subtotal_amount, o.customer_key,
         upper(split_part(regexp_replace(o.sku_code, '^(P_|S_)', ''), '-', 1)) as product_group
  from sales_orders o
  left join sales_customers c on c.customer_key = o.customer_key
  where o.customer_key <> ''
    and coalesce(c.phone_digits, '') not like '050%'
    and o.sku_code is not null and o.sku_code <> ''
),
life as (                          -- 고객 생애(상품 무관)
  select customer_key,
         count(distinct order_id) as total_orders,
         min(order_date)          as first_order_date,
         max(order_date)          as last_order_date,
         sum(subtotal_amount)     as lifetime_revenue
  from base group by customer_key
),
cohort as (                        -- 고객 × 상품군: 그 군 첫구매일 · 그 군 구매 주문수
  select customer_key, product_group,
         min(order_date)          as first_group_date,
         count(distinct order_id) as group_orders
  from base group by customer_key, product_group
),
since_first as (                   -- 그 군 첫구매일 이후(포함)의 총 주문수(상품 무관)
  select co.customer_key, co.product_group,
         count(distinct b.order_id) as orders_since_first_group
  from cohort co
  join base b on b.customer_key = co.customer_key and b.order_date >= co.first_group_date
  group by co.customer_key, co.product_group
)
select
  co.product_group,
  case co.product_group
    when 'DG'  then '대구살'        when 'DSC' then '삼치순살'      when 'YA'  then '연어순살'
    when 'GA'  then '광어순살'      when 'T'   then '틸라피아순살'  when 'NA'  then '농어순살'
    when 'AG'  then '아귀순살'      when 'CD'  then '참돔순살'      when 'MSG' then '만새기순살'
    when 'DAL' then '달고기순살'    when 'SH'  then '새우살'        when 'SQ'  then '오징어살'
    when 'R'   then '삼치순살(렌지용)'  when 'BULK' then '벌크포장'
    when 'PACKAGE' then '맛보기패키지'  when 'DRYICE' then '드라이아이스'
    else co.product_group
  end as group_name,
  co.customer_key,
  co.group_orders,                                   -- 이 상품군 구매 주문수
  co.first_group_date,                               -- 이 상품군 첫 구매일
  l.total_orders,                                    -- 생애 총 주문(상품무관)
  public.repeat_label(l.total_orders) as total_repeat_label,           -- A: 생애 기준
  sf.orders_since_first_group,                       -- 이 상품군 첫구매 이후 총 주문
  public.repeat_label(sf.orders_since_first_group) as repeat_since_label, -- B: 상품후 기준(권장)
  l.first_order_date, l.last_order_date,
  l.lifetime_revenue
from cohort co
join life l          on l.customer_key = co.customer_key
join since_first sf  on sf.customer_key = co.customer_key and sf.product_group = co.product_group;

comment on view sales_buyer_repeat is
  '특정 상품군 구매 고객의 재구매/재재구매(상품 무관). 고객×상품군 그레인. A=생애/B=상품후. 050·무전화 제외. 루커 코호트용.';

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'looker_ro') then
    grant select on sales_buyer_repeat to looker_ro;
  end if;
end $$;

NOTIFY pgrst, 'reload schema';
