-- 058_sales_customer_summary.sql
-- 신규/재구매 고객 분류 — 기존 구글시트 앱스스크립트(신규재구매.txt, OKR_고객요약 시트)를 SQL 뷰로 이관.
--  루커스튜디오가 이 뷰를 데이터소스로 쓰면 예전과 동일하게 신규/재구매를 판단할 수 있다.
--
-- [앱스스크립트 → SQL 매핑]
--  · 고객 식별: customer_phone(정규화 digits) → sales_orders.customer_key (전화 HMAC). 동일 로직.
--  · 첫 주문: order_date 가장 이른 것, 동률이면 order_id 작은 것 (distinct on + order by).
--  · purchase_count: distinct order_id (전 기간 누적).
--  · first_purchase_flag(연도): first_purchase_year 로 판단 (루커에서 연도 필터).
--  · repurchase_flag: first_purchase_year = 대상연도 AND purchase_count >= 2 → 아래 is_repeat + 연도필터.
--  · 제외규칙:
--     - 무전화/더미(01000000000 등): 정규화 단계에서 customer_key='' 로 이미 제외(뒤 8자리 0 마스킹 규칙).
--     - 050 안심번호: sales_customers.phone_digits LIKE '050%' 인 고객 제외(앱스스크립트 other 시트 처리와 동일).
--  · first_order_sku_1..N: first_order_skus 로 콤마 결합.
--  ⚠️ 앱스스크립트는 첫주문 비교에 시각(시간)까지 썼으나, sales_orders 는 날짜(date)라 '날짜+order_id'로 동률 처리.
--
-- PII 안전: 뷰는 phone/phone_digits 를 '출력'하지 않고 050 판별 필터에만 사용. 뷰 소유자(postgres) 권한으로
--   sales_customers 를 읽으므로 looker_ro 는 원본 전화 접근 없이 파생 결과만 조회.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등(create or replace) — 재실행 안전.

create or replace view sales_customer_summary as
with base as (
  -- 전화 있는 고객(customer_key<>''), 050 안심번호 제외
  select o.customer_key, o.order_id, o.order_date, o.sku_code
  from sales_orders o
  left join sales_customers c on c.customer_key = o.customer_key
  where o.customer_key <> ''
    and coalesce(c.phone_digits, '') not like '050%'
),
firsts as (
  -- 첫 주문: 이른 날짜 → 동률이면 작은 order_id
  select distinct on (customer_key)
    customer_key, order_date as first_purchase_date, order_id as first_order_id
  from base
  order by customer_key, order_date asc, order_id asc
),
agg as (
  select customer_key, count(distinct order_id) as purchase_count
  from base group by customer_key
),
skus as (
  -- 첫 주문에 담긴 SKU들(콤마 결합)
  select b.customer_key, string_agg(distinct b.sku_code, ', ' order by b.sku_code) as first_order_skus
  from base b
  join firsts f on f.customer_key = b.customer_key and b.order_id = f.first_order_id
  where b.sku_code <> ''
  group by b.customer_key
)
select
  f.customer_key,
  f.first_purchase_date,
  extract(year from f.first_purchase_date)::int as first_purchase_year,
  a.purchase_count,
  (a.purchase_count >= 2)                        as is_repeat,          -- 재구매 고객(누적 2회+)
  case when a.purchase_count >= 2 then '재구매' else '신규' end as customer_type,  -- 첫구매연도 기준 세그먼트
  coalesce(s.first_order_skus, '')               as first_order_skus
from firsts f
join agg a  on a.customer_key = f.customer_key
left join skus s on s.customer_key = f.customer_key;

comment on view sales_customer_summary is '고객 1인당 요약(첫구매·누적주문·신규/재구매). 앱스스크립트 OKR_고객요약 이관. 050·무전화 제외.';

-- 루커 읽기전용 역할에 조회 권한(역할 있을 때만)
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'looker_ro') then
    grant select on sales_customer_summary to looker_ro;
  end if;
end $$;

NOTIFY pgrst, 'reload schema';
