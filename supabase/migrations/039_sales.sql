-- 039_sales.sql
-- 매출 서브시스템: 분석 원장(PII 없음) + 고객 조회(PII 격리) + 리포트 발송 이력.
--  customer_key = HMAC-SHA256(SALES_PII_PEPPER, digits(phone)) — 백필=웹업로드=검색 동일 로직(app/lib/sales-normalize.ts).
--  멱등키 = row_hash(정규화 비즈니스컬럼 파이프조인 SHA-256) → 재업로드/백필 재실행 안전(중복 0).
--  적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등(IF NOT EXISTS)이라 재실행 안전.

-- ── (a) 분석 원장 : 넓게·자주 조회 → PII 없음(customer_key만). 루커 친화 플랫. ──
create table if not exists sales_orders (
  id              uuid primary key default gen_random_uuid(),
  channel         text    not null default '',
  order_date      date    not null,                  -- KST 기준일(정본). 루커/월·주 경계 집계용
  order_date_int  integer not null,                  -- yyyymmdd (파이썬 정규화 1:1, row_hash 재현)
  order_year      integer generated always as (extract(year  from order_date)::int) stored,
  order_month     integer generated always as (extract(month from order_date)::int) stored,
  order_id        text    not null default '',
  product_name    text    not null default '',
  option_name     text    not null default '',
  sku_code        text    not null default '',       -- Top10 집계축
  quantity        integer not null default 0,
  selling_price   bigint  not null default 0,
  option_price    bigint  not null default 0,
  subtotal_amount bigint  not null default 0,         -- 매출 합계축
  shipping_fee    bigint  not null default 0,
  customer_key    text    not null default '',        -- HMAC. 원본 전화 없음. 빈 전화=''
  row_hash        text    not null,                   -- 멱등 유니크키
  source          text    not null default 'web',     -- 'web' | 'backfill-YYYYMMDD'
  created_at      timestamptz not null default now()
);
create unique index if not exists sales_orders_row_hash_uk    on sales_orders (row_hash);
create index if not exists sales_orders_date_idx         on sales_orders (order_date);
create index if not exists sales_orders_ym_idx           on sales_orders (order_year, order_month);
create index if not exists sales_orders_channel_date_idx on sales_orders (channel, order_date);
create index if not exists sales_orders_sku_date_idx     on sales_orders (sku_code, order_date);
create index if not exists sales_orders_custkey_date_idx on sales_orders (customer_key, order_date);
create index if not exists sales_orders_orderid_idx      on sales_orders (order_id);

-- ── (b) 고객 조회 : 좁은 용도(주문검색 API 전용). 원본 전화 보유(우리 소유 사본). ──
create table if not exists sales_customers (
  customer_key    text primary key,                  -- HMAC(pepper, digits(phone))
  phone           text not null,                     -- 원본 정규화(하이픈 포맷)
  phone_digits    text not null,                     -- 숫자만(부분검색 폴백 인덱스)
  customer_name   text,
  first_seen_date date,
  last_seen_date  date,
  order_count     integer not null default 0,        -- 배치 종료 후 재집계로 세팅(멱등)
  updated_at      timestamptz not null default now()
);
create index if not exists sales_customers_digits_idx on sales_customers (phone_digits);

-- ── (c) 리포트 발송 이력 + stats 스냅샷. 발송 성공 시에만 insert(미리보기는 미기록). ──
create table if not exists sales_reports (
  id           uuid primary key default gen_random_uuid(),
  report_type  text not null check (report_type in ('daily','weekly')),
  base_date    date not null,
  period_start date,
  period_end   date,
  subject      text not null,
  html         text,                                 -- 발송 스냅샷(감사·재열람)
  stats        jsonb,                                 -- 계산값 원본(추세·재현)
  status       text not null default 'sent' check (status in ('sent','failed')),
  recipients   text[],
  sent_by      text,
  error        text,
  sent_at      timestamptz not null default now()
);
create index if not exists sales_reports_type_date_idx on sales_reports (report_type, base_date desc);

alter table sales_orders    enable row level security;
alter table sales_customers enable row level security;
alter table sales_reports   enable row level security;

-- ═════════════ 집계 RPC (지표별, service role stable). 200k+ DB 집계 ═════════════

-- 기간 요약(매출/주문수/객단가)
create or replace function sales_summary(p_from date, p_to date, p_channel text default null)
returns table (revenue bigint, orders bigint, aov bigint)
language sql stable as $$
  select coalesce(sum(subtotal_amount),0)::bigint,
         count(distinct order_id)::bigint,
         case when count(distinct order_id) > 0
              then round(sum(subtotal_amount)::numeric / count(distinct order_id))::bigint else 0 end
  from sales_orders
  where order_date between p_from and p_to
    and (p_channel is null or channel = p_channel)
$$;

-- 누적(연/전년/월/전월) 4버킷 단일 스캔 — 파이썬 line 491-501 1:1
create or replace function sales_cumulative(p_year int, p_month int)
returns table (this_year bigint, last_year bigint, this_month bigint, prev_month bigint)
language sql stable as $$
  select
    coalesce(sum(subtotal_amount) filter (where order_year = p_year),0)::bigint,
    coalesce(sum(subtotal_amount) filter (where order_year = p_year-1),0)::bigint,
    coalesce(sum(subtotal_amount) filter (where order_year = p_year and order_month = p_month),0)::bigint,
    coalesce(sum(subtotal_amount) filter (
      where order_year  = case when p_month = 1 then p_year-1 else p_year end
        and order_month = case when p_month = 1 then 12 else p_month-1 end),0)::bigint
  from sales_orders
$$;

-- 채널별 누적(연/전년/월/전월)
create or replace function sales_channel_cumulative(p_year int, p_month int)
returns table (channel text, this_year bigint, last_year bigint, this_month bigint, prev_month bigint)
language sql stable as $$
  select channel,
    coalesce(sum(subtotal_amount) filter (where order_year = p_year),0)::bigint,
    coalesce(sum(subtotal_amount) filter (where order_year = p_year-1),0)::bigint,
    coalesce(sum(subtotal_amount) filter (where order_year = p_year and order_month = p_month),0)::bigint,
    coalesce(sum(subtotal_amount) filter (
      where order_year  = case when p_month = 1 then p_year-1 else p_year end
        and order_month = case when p_month = 1 then 12 else p_month-1 end),0)::bigint
  from sales_orders group by channel order by 2 desc
$$;

-- 채널별 기간 매출(window)
create or replace function sales_channel_window(p_from date, p_to date)
returns table (channel text, revenue bigint)
language sql stable as $$
  select channel, coalesce(sum(subtotal_amount),0)::bigint from sales_orders
  where order_date between p_from and p_to group by channel order by 2 desc
$$;

-- Top SKU(기간)
create or replace function sales_top_sku(p_from date, p_to date, p_limit int default 10)
returns table (sku_code text, revenue bigint, qty bigint)
language sql stable as $$
  select sku_code, coalesce(sum(subtotal_amount),0)::bigint, coalesce(sum(quantity),0)::bigint
  from sales_orders where order_date between p_from and p_to and sku_code <> ''
  group by sku_code order by 2 desc limit p_limit
$$;

-- 신규:재구매 — window 고객이 window '이전'에도 등장했는지 (파이썬 line 544-553 1:1)
create or replace function sales_new_repeat(p_from date, p_to date)
returns table (total bigint, new_cust bigint, repeat_cust bigint)
language sql stable as $$
  with win as (
    select distinct customer_key from sales_orders
    where order_date between p_from and p_to and customer_key <> ''
  ), flagged as (
    select w.customer_key,
           exists(select 1 from sales_orders b
                    where b.customer_key = w.customer_key and b.order_date < p_from) as is_repeat
    from win w
  )
  select count(*)::bigint,
         count(*) filter (where not is_repeat)::bigint,
         count(*) filter (where is_repeat)::bigint
  from flagged
$$;

-- 객단가+최고/최저 주문건(주문단위 재구성 = 파이썬 line 564-573)
create or replace function sales_order_extremes(p_from date, p_to date)
returns table (aov bigint, order_count bigint, max_order bigint, min_order bigint,
               max_order_id text, min_order_id text)
language sql stable as $$
  with per_order as (
    select order_id, sum(subtotal_amount)::bigint amt from sales_orders
    where order_date between p_from and p_to group by order_id
  )
  select case when count(*) > 0 then (sum(amt)/count(*))::bigint else 0 end,
         count(*)::bigint, coalesce(max(amt),0), coalesce(min(amt),0),
         (select order_id from per_order order by amt desc, order_id limit 1),
         (select order_id from per_order order by amt asc,  order_id limit 1)
  from per_order
$$;

-- 일별 매출(일요일 금~일 3줄 / 주간 트렌드 공용)
create or replace function sales_daily_breakdown(p_from date, p_to date)
returns table (d date, revenue bigint)
language sql stable as $$
  select order_date, coalesce(sum(subtotal_amount),0)::bigint from sales_orders
  where order_date between p_from and p_to group by order_date order by order_date
$$;

-- 한 주문의 sku 목록(최고/최저 주문건 품목코드 재현)
create or replace function sales_order_skus(p_order_id text)
returns table (sku_code text)
language sql stable as $$
  select distinct sku_code from sales_orders where order_id = p_order_id and sku_code <> '' order by 1
$$;

-- 데이터 범위(최소/최대 주문일) — base 기본값·업로드 안내용
create or replace function sales_date_bounds()
returns table (min_date date, max_date date, total_rows bigint)
language sql stable as $$
  select min(order_date), max(order_date), count(*)::bigint from sales_orders
$$;

NOTIFY pgrst, 'reload schema';
