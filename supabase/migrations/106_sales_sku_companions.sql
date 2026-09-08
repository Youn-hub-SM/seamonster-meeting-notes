-- 106: SKU 리스팅 찾기 — 어미상품 추정(같은 주문에 함께 찍힌 상품 집계).
--  적용: Supabase SQL Editor 에 전체 붙여넣고 Run. 멱등 — 재실행 안전. (105 다음에 적용)
--
-- 네이버 등에서 '추가상품'은 매출에 자기 상품명으로만 찍혀, 그 추가상품이 어느 본상품(어미상품)
-- 페이지에 붙어 있는지 찾아다녀야 한다. 어미상품 컬럼은 없지만 같은 주문번호 안에 본상품 라인이
-- 함께 있으므로, 리스팅별로 '같은 주문에 함께 등장한 다른 상품'을 세어 동반 비율이 높은 상품을
-- 어미상품 후보로 돌려준다(판단·표시 기준은 앱이 정함 — 리스팅당 상위 3개만 반환).
-- 주문번호가 라인 단위로 갈리는 채널(톡딜 등)은 동반이 안 잡혀 빈 결과가 될 뿐 — 무해.
-- 조인 인덱스는 039 의 sales_orders_orderid_idx(order_id)가 이미 커버 — 신규 인덱스 없음.

create or replace function sales_sku_companions(p_skus text[], p_today date, p_days int default 365)
returns table (
  channel text,
  product_name text,
  option_name text,
  sku_code text,
  companion_name text,
  together_orders bigint,
  total_orders bigint
)
language sql
stable
as $$
  with target as (
    -- 검색 SKU 리스팅이 등장한 주문들 (주문번호 없는 행은 같은 주문 판별 불가 — 제외)
    select distinct o.channel, o.order_id, o.product_name, o.option_name, o.sku_code
    from sales_orders o
    where upper(o.sku_code) = any (p_skus)
      and o.order_date >= p_today - greatest(p_days, 1)
      and o.order_id <> ''
  ),
  totals as (
    select t.channel, t.product_name, t.option_name, t.sku_code,
           count(distinct t.order_id) as total_orders
    from target t
    group by 1, 2, 3, 4
  ),
  comp as (
    select t.channel, t.product_name, t.option_name, t.sku_code,
           s.product_name as companion_name,
           count(distinct t.order_id) as together_orders
    from target t
    join sales_orders s
      on s.channel = t.channel
     and s.order_id = t.order_id
    where s.product_name <> t.product_name
      and s.order_date >= p_today - greatest(p_days, 1)
    group by 1, 2, 3, 4, 5
  ),
  ranked as (
    select c.*,
           row_number() over (
             partition by c.channel, c.product_name, c.option_name, c.sku_code
             order by c.together_orders desc, c.companion_name
           ) as rn
    from comp c
  )
  select r.channel, r.product_name, r.option_name, r.sku_code,
         r.companion_name, r.together_orders, t.total_orders
  from ranked r
  join totals t
    on t.channel = r.channel
   and t.product_name = r.product_name
   and t.option_name = r.option_name
   and t.sku_code = r.sku_code
  where r.rn <= 3
  -- 조인이 행 순서를 뒤섞을 수 있으므로 출력 정렬을 명시(리스팅 내 동반 순위) — 앱도 재정렬하지만 계약을 SQL 에도 둔다
  order by r.channel, r.product_name, r.option_name, r.sku_code, r.together_orders desc, r.companion_name
$$;

NOTIFY pgrst, 'reload schema';
