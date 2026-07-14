-- 066_sales_group_repeat.sql
-- 상품군별 '첫구매 / 재구매 / 재재구매' — 루커스튜디오 코호트 분석용.
--  · 상품군(product_group) = 관리코드(sku_code)의 '코어 코드'.
--      P_/S_(정기·번들 접두) 제거 후 첫 토큰 = 생선 라인. 예) DG-100-O-100, P_DG-100X1, S_DG-…500X2 → 모두 'DG'(대구).
--      → 같은 생선의 사이즈·옵션·정기배송이 하나의 상품군으로 묶여 재구매가 정확히 집계됨.
--  · 구매차수(group_purchase_seq) = 그 고객이 '그 상품군'을 산 주문을 시간순으로 매긴 순번(주문 단위).
--      1=첫구매, 2=재구매, 3=재재구매, 4+=4회이상. (한 주문에 같은 군 여러 줄이어도 같은 차수)
--  · 고객 기준은 058/061/062 와 동일: customer_key(전화 HMAC) 있고, 050 안심번호(sales_customers.phone_digits LIKE '050%') 제외.
--      050은 주문마다 번호가 달라 동일인 추적 불가 → 재구매 분석에서 제외(각 뷰와 일관).
--  · PII 안전: 뷰 소유자(postgres) 권한으로 sales_customers 를 '050 판별'에만 사용, 전화는 출력 안 함.
--      looker_ro 는 이 뷰만 SELECT(원본 테이블 접근 없음).
-- 사용(루커): 데이터소스로 이 뷰 추가 → group_name(또는 product_group) 을 '특정 상품군'으로 필터
--            → 차원 group_purchase_label, 측정 COUNT DISTINCT customer_key(고객 수) 또는 order_id(주문 수)·SUM subtotal_amount(매출).
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등(create or replace).

create or replace view sales_group_repeat as
with base as (
  -- 전화 있는 고객만, 050 안심번호 제외 (재구매 추적 가능한 주문만)
  select
    o.order_date, o.order_year, o.order_month, o.channel, o.order_id,
    o.product_name, o.option_name, o.sku_code, o.quantity, o.subtotal_amount, o.customer_key,
    upper(split_part(regexp_replace(o.sku_code, '^(P_|S_)', ''), '-', 1)) as product_group
  from sales_orders o
  left join sales_customers c on c.customer_key = o.customer_key
  where o.customer_key <> ''
    and coalesce(c.phone_digits, '') not like '050%'
    and o.sku_code is not null and o.sku_code <> ''
),
grp_orders as (            -- 고객 × 상품군 × 주문(첫 등장일)
  select customer_key, product_group, order_id, min(order_date) as od
  from base
  group by customer_key, product_group, order_id
),
ranked as (               -- 상품군별 구매 차수(날짜 → 주문번호 순, 동일인 내)
  select customer_key, product_group, order_id,
         dense_rank() over (partition by customer_key, product_group order by od asc, order_id asc) as seq
  from grp_orders
)
select
  b.order_date, b.order_year, b.order_month, b.channel, b.order_id,
  b.product_name, b.option_name, b.sku_code, b.quantity, b.subtotal_amount, b.customer_key,
  b.product_group,
  case b.product_group
    when 'DG'  then '대구살'        when 'DSC' then '삼치순살'      when 'YA'  then '연어순살'
    when 'GA'  then '광어순살'      when 'T'   then '틸라피아순살'  when 'NA'  then '농어순살'
    when 'AG'  then '아귀순살'      when 'CD'  then '참돔순살'      when 'MSG' then '만새기순살'
    when 'DAL' then '달고기순살'    when 'SH'  then '새우살'        when 'SQ'  then '오징어살'
    when 'R'   then '삼치순살(렌지용)'  when 'BULK' then '벌크포장'
    when 'PACKAGE' then '맛보기패키지'  when 'DRYICE' then '드라이아이스'
    else b.product_group
  end as group_name,
  r.seq as group_purchase_seq,
  case
    when r.seq = 1 then '1_첫구매'
    when r.seq = 2 then '2_재구매'
    when r.seq = 3 then '3_재재구매'
    else '4_4회이상'
  end as group_purchase_label
from base b
join ranked r
  on  r.customer_key  = b.customer_key
  and r.product_group = b.product_group
  and r.order_id      = b.order_id;

comment on view sales_group_repeat is
  '상품군(sku 코어코드)별 구매차수(1첫/2재/3재재/4+). 주문 단위 순번, 050·무전화 제외. 루커 코호트용.';

-- 루커 읽기전용 역할에 조회 권한(역할 있을 때만)
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'looker_ro') then
    grant select on sales_group_repeat to looker_ro;
  end if;
end $$;

NOTIFY pgrst, 'reload schema';
