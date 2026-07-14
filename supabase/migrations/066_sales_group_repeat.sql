-- 066_sales_group_repeat.sql
-- 첫구매 / 재구매 / 재재구매 코호트 — 루커스튜디오에서 '여러 축'으로 자유 분석.
--  루커는 행 간 순번(윈도우)을 못 만들므로, 분석하고 싶은 축마다 '구매차수'를 미리 계산해 컬럼으로 제공한다.
--  4개 축의 차수를 모두 넣어, 루커에서 원하는 축으로 필터/그룹만 하면 첫·재·재재구매가 나온다.
--    ① product_group (상품군: sku 코어코드)   → group_purchase_seq / group_purchase_label
--    ② sku_code      (상품코드)               → sku_purchase_seq   / sku_purchase_label
--    ③ product_name  (상품명)                 → name_purchase_seq  / name_purchase_label
--    ④ (상품 무관, 고객 전체 주문)            → cust_order_seq     / cust_order_label
--  그 외 channel·order_date·option_name 등은 그냥 차원/필터로 쓰면 된다(루커 네이티브 필터).
--
-- [정의]
--  · 구매차수 = 그 고객이 '그 축의 값'을 산 주문을 시간순으로 매긴 순번(주문 단위). 1=첫,2=재,3=재재,4+=4회이상.
--     한 주문에 같은 값이 여러 줄이어도 같은 차수. 주문 날짜는 그 주문의 최소 order_date(캐논)로 고정(동일 주문번호가
--     다른 날짜로 쪼개진 소수 케이스까지 정확히 1주문=1차수 처리).
--  · 상품군(product_group) = 관리코드의 코어코드: P_/S_(정기·번들 접두) 제거 후 첫 토큰(대문자).
--     예) DG-100-O-100, P_DG-100X1, S_DG-…500X2 → 모두 'DG'(대구). group_name 에 친화라벨 제공.
--  · 고객 기준은 058/061/062 와 동일: customer_key(전화 HMAC) 있고, 050 안심번호 제외(추적 불가).
--  · order_key = customer_key|order_id : order_id 가 고객 간 149건 겹쳐서, '주문 수'는 이 키로 COUNT DISTINCT.
--  ⚠ 상품명(③)은 마케팅 문구라 표기가 바뀌면 다른 상품명으로 잡힘(같은 상품이 여러 이름). 정확도는 ②sku ≥ ①군 > ③명.
--  · PII 안전: 뷰 소유자(postgres) 권한으로 sales_customers 를 '050 판별'에만 사용, 전화 미출력. looker_ro 는 이 뷰만 SELECT.
--
-- 사용(루커): 데이터소스로 이 뷰 추가 →
--   · 특정 상품군 첫/재/재재: group_name 필터 + 차원 group_purchase_label + 측정 COUNT DISTINCT customer_key(고객)·order_key(주문)·SUM subtotal_amount(매출)
--   · 특정 상품코드: sku_code 필터 + sku_purchase_label
--   · 특정 상품명:   product_name 필터 + name_purchase_label
--   · 전체 재구매(상품무관): cust_order_label
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등(drop+create).

-- 구매차수 → 한글 라벨(정렬용 숫자 접두)
create or replace function public.repeat_label(seq bigint) returns text language sql immutable as $$
  select case
    when seq = 1 then '1_첫구매'
    when seq = 2 then '2_재구매'
    when seq = 3 then '3_재재구매'
    when seq >= 4 then '4_4회이상'
    else null
  end
$$;

drop view if exists sales_group_repeat;
create view sales_group_repeat as
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
canon as (
  -- 주문 캐논 날짜(그 주문의 최소 order_date) → 1주문=1차수 보장
  select b.*, min(b.order_date) over (partition by b.customer_key, b.order_id) as od
  from base b
),
seq as (
  select c.*,
    dense_rank() over (partition by c.customer_key, c.product_group order by c.od, c.order_id) as group_purchase_seq,
    dense_rank() over (partition by c.customer_key, c.sku_code      order by c.od, c.order_id) as sku_purchase_seq,
    dense_rank() over (partition by c.customer_key, c.product_name  order by c.od, c.order_id) as name_purchase_seq,
    dense_rank() over (partition by c.customer_key                  order by c.od, c.order_id) as cust_order_seq
  from canon c
)
select
  order_date, order_year, order_month, channel, order_id,
  (customer_key || '|' || order_id) as order_key,
  product_name, option_name, sku_code, quantity, subtotal_amount, customer_key,
  product_group,
  case product_group
    when 'DG'  then '대구살'        when 'DSC' then '삼치순살'      when 'YA'  then '연어순살'
    when 'GA'  then '광어순살'      when 'T'   then '틸라피아순살'  when 'NA'  then '농어순살'
    when 'AG'  then '아귀순살'      when 'CD'  then '참돔순살'      when 'MSG' then '만새기순살'
    when 'DAL' then '달고기순살'    when 'SH'  then '새우살'        when 'SQ'  then '오징어살'
    when 'R'   then '삼치순살(렌지용)'  when 'BULK' then '벌크포장'
    when 'PACKAGE' then '맛보기패키지'  when 'DRYICE' then '드라이아이스'
    else product_group
  end as group_name,
  group_purchase_seq, public.repeat_label(group_purchase_seq) as group_purchase_label,
  sku_purchase_seq,   public.repeat_label(sku_purchase_seq)   as sku_purchase_label,
  name_purchase_seq,  public.repeat_label(name_purchase_seq)  as name_purchase_label,
  cust_order_seq,     public.repeat_label(cust_order_seq)     as cust_order_label
from seq;

comment on view sales_group_repeat is
  '축별(상품군/상품코드/상품명/전체) 구매차수(1첫/2재/3재재/4+). 주문 단위, 050·무전화 제외. 루커 코호트 다축 분석용.';

-- 루커 읽기전용 역할에 조회 권한(역할 있을 때만)
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'looker_ro') then
    grant select on sales_group_repeat to looker_ro;
  end if;
end $$;

NOTIFY pgrst, 'reload schema';
