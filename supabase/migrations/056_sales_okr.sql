-- 056 OKR 지표 뷰 (Looker Studio 스코어카드용). looker_ro(041) 가 읽는다.
--  OKR1) 2026년에 '첫 구매'한 고객 수            (목표 30,000)
--  OKR2) 첫 구매 후 3개월 이내 재구매(2번째 주문) 비율  (목표 50%)
--  OKR3) 이유식 매출 비중 / 도매 매출 비중        (각각 목표 10%)
--  · 고객 = customer_key(전화 해시). 전화 없는 주문(도매·마스킹번호)은 고객 집계 제외.
--  · '구매 횟수' = order_id 단위(같은 주문의 여러 상품행은 1건).
--  · 이유식 SKU 는 아래 sales_okr_babyfood_sku 테이블로 관리 → insert/delete 만으로 뷰가 자동 반영(뷰 재생성 불필요).
--  · 뷰는 definer 권한(041 sales_looker 와 동일)으로 sales_orders·config 를 읽으므로 looker_ro 는 sales_okr 만 있으면 됨.
--  적용: Supabase SQL Editor 에 붙여넣고 Run(멱등). 이후 [사용자 조치] 2가지 수행.

-- 이유식 SKU 목록(관리자만 insert). 예:
--   insert into sales_okr_babyfood_sku(sku_code) values ('SKU-A'),('SKU-B') on conflict do nothing;
create table if not exists public.sales_okr_babyfood_sku (
  sku_code text primary key
);

-- OKR 스코어카드 뷰 — 2026 기준 4개 지표를 1행으로. (연도 바뀌면 아래 날짜만 수정)
create or replace view public.sales_okr as
with
firsts as (   -- 첫 주문이 2026년인 고객
  select customer_key, min(order_date) as first_order
  from public.sales_orders
  where customer_key <> ''
  group by customer_key
  having min(order_date) >= date '2026-01-01' and min(order_date) < date '2027-01-01'
),
ord as (      -- 고객·주문 단위(상품 여러 행 → 주문 1건)
  select customer_key, order_id, min(order_date) as order_date
  from public.sales_orders
  where customer_key <> '' and order_id <> ''
  group by customer_key, order_id
),
rep as (      -- 그중 첫 주문 후 3개월 이내에 또 주문한 고객
  select distinct f.customer_key
  from firsts f
  join ord x on x.customer_key = f.customer_key
  where x.order_date > f.first_order
    and x.order_date <= (f.first_order + interval '3 months')::date
),
rev as (      -- 2026 매출: 전체 / 이유식(SKU) / 도매(채널)
  select
    coalesce(sum(subtotal_amount), 0)::bigint as total_rev,
    coalesce(sum(subtotal_amount) filter (
      where sku_code in (select sku_code from public.sales_okr_babyfood_sku)), 0)::bigint as babyfood_rev,
    coalesce(sum(subtotal_amount) filter (where channel = '도매'), 0)::bigint as wholesale_rev
  from public.sales_orders
  where order_date >= date '2026-01-01' and order_date < date '2027-01-01'
)
select
  -- OKR1
  (select count(*) from firsts)::bigint                                                  as okr1_first_buyers,
  30000::int                                                                             as okr1_target,
  -- OKR2
  (select count(*) from rep)::bigint                                                     as repeated_within_3m,
  round(100.0 * (select count(*) from rep) / nullif((select count(*) from firsts), 0), 1) as okr2_repeat_pct,
  50.0::numeric                                                                          as okr2_target,
  -- OKR3
  rev.total_rev,
  rev.babyfood_rev,
  round(100.0 * rev.babyfood_rev  / nullif(rev.total_rev, 0), 1)                         as okr3_babyfood_pct,
  rev.wholesale_rev,
  round(100.0 * rev.wholesale_rev / nullif(rev.total_rev, 0), 1)                         as okr3_wholesale_pct,
  10.0::numeric                                                                          as okr3_target
from rev;

grant select on public.sales_okr to looker_ro;

notify pgrst, 'reload schema';

-- [사용자 조치]
--  1) 이유식 SKU 등록(OKR3-이유식 활성화):
--       insert into public.sales_okr_babyfood_sku(sku_code)
--       values ('여기에','이유식','SKU들') on conflict do nothing;
--  2) (041 미완 시) looker_ro 비밀번호 설정:
--       alter role looker_ro with password '강한_무작위_비밀번호_16자이상';
