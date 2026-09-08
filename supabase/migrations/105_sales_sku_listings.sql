-- 105: SKU 리스팅 찾기 — 특정 SKU(들)가 팔린 채널별 등록 상품(리스팅)과 최근 판매량 집계.
--  적용: Supabase SQL Editor 에 전체 붙여넣고 Run. 멱등 — 재실행 안전.
--
-- 리스팅 = 매출원장(sales_orders)의 (판매처, 상품명, 옵션명, 관리코드) 조합.
--  매일 업로드되는 매출이 사실상 채널별 등록 상품 카탈로그라, 별도 등록 없이 역으로 조회한다.
-- 검색 SKU 는 앱이 대문자로 정규화해 넘긴다(채널별 관리코드 표기 편차 대응) — 아래 upper 표현 인덱스가 커버.
-- p_today 는 KST 기준 오늘을 앱이 계산해 전달 — order_date 가 KST 기준일이라 current_date(UTC)를 쓰면 하루 어긋난다.

create index if not exists sales_orders_sku_upper_date_idx
  on sales_orders (upper(sku_code), order_date);

create or replace function sales_sku_listings(p_skus text[], p_today date, p_days int default 365)
returns table (
  channel text,
  product_name text,
  option_name text,
  sku_code text,
  qty_7 bigint,
  qty_30 bigint,
  qty_window bigint,
  last_sale date
)
language sql
stable
as $$
  select
    o.channel,
    o.product_name,
    o.option_name,
    o.sku_code,
    coalesce(sum(o.quantity) filter (where o.order_date >= p_today - 6), 0)::bigint,
    coalesce(sum(o.quantity) filter (where o.order_date >= p_today - 29), 0)::bigint,
    coalesce(sum(o.quantity), 0)::bigint,
    max(o.order_date)
  from sales_orders o
  where upper(o.sku_code) = any (p_skus)
    and o.order_date >= p_today - greatest(p_days, 1)
  group by 1, 2, 3, 4
$$;

NOTIFY pgrst, 'reload schema';
