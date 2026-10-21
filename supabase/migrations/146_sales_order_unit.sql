-- 146 주문 건수 기준 — 톡스토어는 '같은 주문자 + 같은 주문일 = 1건' (2026-10-21 대표 결정)
--
-- ■ 왜
--   톡스토어(톡딜)는 한 사람이 한 번에 여러 상품을 사도 주문번호가 상품마다 따로 나온다(줄 수 = 주문번호 수).
--   실제로는 합배송 1박스(085 택배보냉비가 이미 이 기준으로 묶음) — 그런데 주문 '건수'는 주문번호로 세어
--   10월 1,792건(합배송 기준 1,277건)처럼 약 1.4배로 잡혔다. 같은 날 한 번에 산 고객이 '구매 2회'(재구매)로도 잡혔다.
--   다른 채널은 주문번호 하나에 여러 상품이 들어가므로 그대로 주문번호.
-- ■ 무엇을
--   ① sales_orders.order_unit(생성 칸) = 주문 1건을 가리키는 키
--        톡스토어 + 주문자 있음 → 'tk:' || customer_key || '|' || order_date_int
--        그 밖 → order_id(빈 주문번호는 null)
--      주문 건수 = count(distinct order_unit). 앱·뷰·함수가 모두 이 칸 하나를 센다(기준이 갈리지 않게).
--   ② 주문 건수를 세던 뷰·함수를 order_unit 으로 — 058·062·066·067·081·085 정의를 그대로 두고 키만 바꿈
--   ③ 루커 뷰(sales_looker)에 order_unit 추가 — 루커에서도 주문수 = COUNT DISTINCT order_unit
-- ■ 매출 금액·수량은 바뀌지 않는다. 바뀌는 것 = 톡스토어 주문 건수·객단가·구매 횟수(재구매 판정)·구매차수.
--
-- 적용: Supabase Dashboard > SQL Editor 에 전체 붙여넣고 Run. 멱등(재실행 안전). 생성 칸 추가 때 표를 한 번 다시 쓴다(수 초).

-- ① 주문 건수 키 ─────────────────────────────────────────────
alter table public.sales_orders
  add column if not exists order_unit text generated always as (
    case when channel = '톡스토어' and coalesce(customer_key, '') <> ''
         then 'tk:' || customer_key || '|' || order_date_int::text
         else nullif(order_id, '') end
  ) stored;
create index if not exists sales_orders_order_unit_idx on public.sales_orders (order_unit);

comment on column public.sales_orders.order_unit is '주문 1건 키 — 주문 건수는 count(distinct order_unit). 톡스토어는 상품마다 주문번호가 갈려 같은 주문자·같은 주문일을 1건으로(''tk:''||customer_key||''|''||yyyymmdd), 그 밖은 order_id. 주문번호(order_id)로 건수를 세지 않는다';

-- ③ 루커 뷰 — 끝에 order_unit 추가(앞 칸 순서 그대로라 create or replace 가능)
create or replace view public.sales_looker as
  select
    order_date, order_year, order_month, channel, order_id, product_name, option_name, sku_code,
    quantity, selling_price, option_price, subtotal_amount, shipping_fee, customer_key,
    order_unit                          -- 주문 1건 키(주문수 = COUNT DISTINCT order_unit, 톡스토어 합배송 반영)
  from public.sales_orders;
comment on view public.sales_looker is 'sales_orders 의 분석용 투영(내부컬럼 제외). 루커 노출용. 컬럼은 sales_orders 와 동일(id/row_hash/source 등 제외) + customer_key(해시) + order_unit(주문수 = COUNT DISTINCT order_unit)';

-- ② 058 고객 요약 — 구매 횟수·첫 주문을 주문 1건 키로 ───────────────
create or replace view sales_customer_summary as
with base as (
  select o.customer_key, o.order_unit as order_id, o.order_date, o.sku_code
  from sales_orders o
  left join sales_customers c on c.customer_key = o.customer_key
  where o.customer_key <> ''
    and coalesce(c.phone_digits, '') not like '050%'
    and o.order_unit is not null
),
firsts as (
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
  (a.purchase_count >= 2)                        as is_repeat,
  case when a.purchase_count >= 2 then '재구매' else '신규' end as customer_type,
  coalesce(s.first_order_skus, '')               as first_order_skus
from firsts f
join agg a  on a.customer_key = f.customer_key
left join skus s on s.customer_key = f.customer_key;
comment on view sales_customer_summary is '고객 1인당 요약(첫구매·누적주문·신규/재구매). 앱스스크립트 OKR_고객요약 이관. 050·무전화 제외. 구매 횟수 = 주문 1건 키(order_unit) 기준(146 — 톡스토어 합배송 1건)';

-- ② 062 일별 신규·재구매 — 주문수를 주문 1건 키로 ─────────────────
drop view if exists sales_daily_new_repeat;
create view sales_daily_new_repeat as
with base as (
  select
    o.order_date, o.order_unit as order_id, o.subtotal_amount, o.customer_key,
    (o.customer_key = '' or coalesce(c.phone_digits, '') like '050%') as unclassified
  from sales_orders o
  left join sales_customers c on c.customer_key = o.customer_key
),
firsts as (
  select customer_key, min(order_date) as first_purchase_date
  from base where not unclassified
  group by customer_key
),
ident_day as (
  select b.customer_key, b.order_date,
         count(distinct b.order_id) as orders,
         sum(b.subtotal_amount)     as revenue
  from base b where not b.unclassified
  group by b.customer_key, b.order_date
),
ident_labeled as (
  select d.order_date, d.orders, d.revenue,
         (d.order_date = f.first_purchase_date) as is_new
  from ident_day d join firsts f on f.customer_key = d.customer_key
),
ident_agg as (
  select order_date,
    count(*) filter (where is_new)                       as new_customers,
    count(*) filter (where not is_new)                   as repeat_customers,
    coalesce(sum(orders)  filter (where is_new), 0)      as new_orders,
    coalesce(sum(orders)  filter (where not is_new), 0)  as repeat_orders,
    coalesce(sum(revenue) filter (where is_new), 0)      as new_revenue,
    coalesce(sum(revenue) filter (where not is_new), 0)  as repeat_revenue
  from ident_labeled group by order_date
),
unclass_agg as (
  select order_date,
         count(distinct order_id) as unclassified_orders,
         sum(subtotal_amount)     as unclassified_revenue
  from base where unclassified group by order_date
),
all_agg as (
  select order_date, count(distinct order_id) as total_orders, sum(subtotal_amount) as total_revenue
  from base group by order_date
)
select
  a.order_date,
  coalesce(i.new_customers, 0)                                as new_customers,
  coalesce(i.repeat_customers, 0)                             as repeat_customers,
  coalesce(i.new_customers, 0) + coalesce(i.repeat_customers, 0) as total_customers,
  round(100.0 * coalesce(i.repeat_customers, 0)
        / nullif(coalesce(i.new_customers, 0) + coalesce(i.repeat_customers, 0), 0), 1) as repeat_rate_pct,
  coalesce(i.new_orders, 0)                                   as new_orders,
  coalesce(i.repeat_orders, 0)                                as repeat_orders,
  coalesce(u.unclassified_orders, 0)                          as unclassified_orders,
  a.total_orders,
  coalesce(i.new_revenue, 0)                                  as new_revenue,
  coalesce(i.repeat_revenue, 0)                               as repeat_revenue,
  coalesce(u.unclassified_revenue, 0)                         as unclassified_revenue,
  a.total_revenue
from all_agg a
left join ident_agg   i on i.order_date = a.order_date
left join unclass_agg u on u.order_date = a.order_date;
comment on view sales_daily_new_repeat is
  '일자별 신규(첫구매)·재구매 고객수 + 미분류(안심번호·무전화) 버킷. 신규주문+재구매주문+미분류주문=총주문. 주문수 = 주문 1건 키(order_unit, 146)';

-- ② 066 구매차수 — 주문 1건 키로 차수를 매김(같은 날 한 번에 산 톡스토어 상품 = 같은 차수) ──
drop view if exists sales_group_repeat;
create view sales_group_repeat as
with base as (
  select
    o.order_date, o.order_year, o.order_month, o.channel, o.order_id, o.order_unit,
    o.product_name, o.option_name, o.sku_code, o.quantity, o.subtotal_amount, o.customer_key,
    upper(split_part(regexp_replace(o.sku_code, '^(P_|S_)', ''), '-', 1)) as product_group
  from sales_orders o
  left join sales_customers c on c.customer_key = o.customer_key
  where o.customer_key <> ''
    and coalesce(c.phone_digits, '') not like '050%'
    and o.sku_code is not null and o.sku_code <> ''
    and o.order_unit is not null
),
canon as (
  select b.*, min(b.order_date) over (partition by b.customer_key, b.order_unit) as od
  from base b
),
seq as (
  select c.*,
    dense_rank() over (partition by c.customer_key, c.product_group order by c.od, c.order_unit) as group_purchase_seq,
    dense_rank() over (partition by c.customer_key, c.sku_code      order by c.od, c.order_unit) as sku_purchase_seq,
    dense_rank() over (partition by c.customer_key, c.product_name  order by c.od, c.order_unit) as name_purchase_seq,
    dense_rank() over (partition by c.customer_key                  order by c.od, c.order_unit) as cust_order_seq
  from canon c
)
select
  order_date, order_year, order_month, channel, order_id,
  (customer_key || '|' || order_unit) as order_key,
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
  '축별(상품군/상품코드/상품명/전체) 구매차수(1첫/2재/3재재/4+). 주문 단위(order_unit — 톡스토어 합배송 1건, 146), 050·무전화 제외. 주문수 = COUNT DISTINCT order_key';

-- ② 067 구매 고객 재구매 — 주문수를 주문 1건 키로 ─────────────────
drop view if exists sales_buyer_repeat;
create view sales_buyer_repeat as
with base as (
  select o.order_date, o.order_unit as order_id, o.subtotal_amount, o.customer_key, o.sku_code, o.product_name
  from sales_orders o
  left join sales_customers c on c.customer_key = o.customer_key
  where o.customer_key <> ''
    and coalesce(c.phone_digits, '') not like '050%'
    and o.sku_code is not null and o.sku_code <> ''
    and o.order_unit is not null
),
sku_name as (
  select sku_code, mode() within group (order by product_name) as nm
  from base group by sku_code
),
life as (
  select customer_key,
         count(distinct order_id) as total_orders,
         min(order_date)          as first_order_date,
         max(order_date)          as last_order_date,
         sum(subtotal_amount)     as lifetime_revenue
  from base group by customer_key
),
sku_cohort as (
  select customer_key, sku_code as av, min(order_date) as fad, count(distinct order_id) as ao
  from base group by customer_key, sku_code
),
sku_since as (
  select co.customer_key, co.av, count(distinct b.order_id) as so
  from sku_cohort co join base b on b.customer_key = co.customer_key and b.order_date >= co.fad
  group by co.customer_key, co.av
),
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
  '특정 상품(axis=sku/name) 구매 고객의 재구매/재재구매(상품 무관). A=생애/B=상품후. name축은 이름변경 왜곡 주의. 050 제외. 주문수 = 주문 1건 키(order_unit, 146)';

-- 루커 권한(뷰를 다시 만들면 권한이 사라진다)
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'looker_ro') then
    grant select on public.sales_looker, sales_customer_summary, sales_daily_new_repeat, sales_group_repeat, sales_buyer_repeat to looker_ro;
  end if;
end $$;

-- ② 081 기간 신규·재구매 — 미분류 주문수를 주문 1건 키로 ───────────
drop function if exists sales_new_repeat(date, date);
create function sales_new_repeat(p_from date, p_to date)
returns table (
  total                bigint,
  new_cust             bigint,
  repeat_cust          bigint,
  unclassified_orders  bigint,
  unclassified_revenue bigint
)
language sql stable as $$
  with win as (
    select o.order_unit as order_id, o.customer_key, o.subtotal_amount,
           (o.customer_key = '' or coalesce(c.phone_digits, '') like '050%') as unclassified
    from sales_orders o
    left join sales_customers c on c.customer_key = o.customer_key
    where o.order_date between p_from and p_to
  ),
  ident as (
    select distinct customer_key from win where not unclassified
  ),
  flagged as (
    select i.customer_key,
           exists(select 1 from sales_orders b
                    where b.customer_key = i.customer_key and b.order_date < p_from) as is_repeat
    from ident i
  )
  select
    (select count(*) from flagged)::bigint,
    (select count(*) filter (where not is_repeat) from flagged)::bigint,
    (select count(*) filter (where is_repeat) from flagged)::bigint,
    (select count(distinct order_id) from win where unclassified)::bigint,
    coalesce((select sum(subtotal_amount) from win where unclassified), 0)::bigint
$$;
comment on function sales_new_repeat(date, date) is
  '기간 신규/재구매 고객수(식별 가능·생애 첫구매 기준) + 미분류(안심번호·무전화) 주문수·매출. 루커 sales_daily_new_repeat 와 동일 기준. 주문수 = order_unit(146)';
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'looker_ro') then
    grant execute on function sales_new_repeat(date, date) to looker_ro;
  end if;
end $$;

-- ② 039 매출 리포트 요약 — 주문수·객단가·최고/최저 주문을 주문 1건 키로 ──────
create or replace function sales_summary(p_from date, p_to date, p_channel text default null)
returns table (revenue bigint, orders bigint, aov bigint)
language sql stable as $$
  select coalesce(sum(subtotal_amount),0)::bigint,
         count(distinct order_unit)::bigint,
         case when count(distinct order_unit) > 0
              then round(sum(subtotal_amount)::numeric / count(distinct order_unit))::bigint else 0 end
  from sales_orders
  where order_date between p_from and p_to
    and (p_channel is null or channel = p_channel)
$$;

create or replace function sales_order_extremes(p_from date, p_to date)
returns table (aov bigint, order_count bigint, max_order bigint, min_order bigint,
               max_order_id text, min_order_id text)
language sql stable as $$
  with per_order as (
    select order_unit as order_id, sum(subtotal_amount)::bigint amt from sales_orders
    where order_date between p_from and p_to and order_unit is not null group by order_unit
  )
  select case when count(*) > 0 then (sum(amt)/count(*))::bigint else 0 end,
         count(*)::bigint, coalesce(max(amt),0), coalesce(min(amt),0),
         (select order_id from per_order order by amt desc, order_id limit 1),
         (select order_id from per_order order by amt asc,  order_id limit 1)
  from per_order
$$;

-- 한 주문(주문 1건 키 — sales_order_extremes 가 돌려준 값)의 sku 목록
create or replace function sales_order_skus(p_order_id text)
returns table (sku_code text)
language sql stable as $$
  select distinct sku_code from sales_orders where order_unit = p_order_id and sku_code <> '' order by 1
$$;

-- ② 085 채널 이익 — 주문수(·주문별 무료배송 기준)를 주문 1건 키로. 택배보냉비 묶음은 그대로 ──
drop function if exists sales_profit_summary(date, date) cascade;
create function sales_profit_summary(p_from date, p_to date)
returns table(channel text, orders bigint, pay_amount bigint, ship_revenue bigint, product_cost bigint, cooling bigint, fee_rate numeric)
language sql stable as $$
  with prod as (
    select distinct on (sku) id, sku, cost_price, volume_kg
    from products where sku is not null and sku <> '' order by sku, updated_at desc
  ),
  comp as (
    select pp.sku as parent_sku,
      sum(c.cost_price * pb.qty) as cost,
      case when bool_or(c.volume_kg is null) then null else sum(c.volume_kg * pb.qty) end as weight
    from product_bundles pb
    join products pp on pp.id = pb.parent_id
    join products c  on c.id  = pb.component_id
    group by pp.sku
  ),
  resolved as (
    select p.sku,
      case when cm.parent_sku is not null then cm.cost   else p.cost_price end as cost,
      case when cm.parent_sku is not null then cm.weight else p.volume_kg  end as weight
    from prod p left join comp cm on cm.parent_sku = p.sku
  ),
  ord as (
    select o.channel,
      coalesce(o.order_unit, 'row:' || o.id::text)            as order_key,   -- 주문 1건 키(146), 빈 주문번호는 행별 분리(050)
      max(coalesce(o.customer_key, ''))                       as ck,
      min(o.order_date)                                       as od,
      sum(o.subtotal_amount)                              as revenue,
      sum(o.shipping_fee)                                 as actual_ship,
      sum(o.quantity * coalesce(r.cost, 0))              as pcost,
      round(sum(o.quantity * coalesce(r.weight, 0)), 1)  as wt,
      bool_or(o.product_name ilike '%정기배송%')          as is_sub
    from sales_orders o
    left join resolved r on r.sku = o.sku_code
    where o.order_date between p_from and p_to
    group by o.channel, coalesce(o.order_unit, 'row:' || o.id::text)
  ),
  ord2 as (
    select ord.channel, ord.order_key, ord.ck, ord.od, ord.revenue, ord.pcost, ord.wt,
      coalesce(cfg.fee_rate, 0)       as fee_rate,
      coalesce(cfg.revenue_adjust, 0) as adjust,
      case
        when coalesce(cfg.ship_mode, 'actual') = 'actual' then ord.actual_ship
        when cfg.ship_mode = 'none' then 0
        when cfg.ship_mode = 'free_over' then
          case when ord.revenue >=
            (case when ord.is_sub and coalesce(cfg.ship_free_over_sub, 0) > 0
                  then cfg.ship_free_over_sub else cfg.ship_free_over end)
          then 0 else coalesce(cfg.ship_fee, 4000) end
        else coalesce(cfg.ship_fee, 4000)
      end as ship_rev
    from ord left join sales_channel_config cfg on cfg.channel = ord.channel
  ),
  parcel as (
    select ord2.channel, sum(ord2.wt) as wt
    from ord2
    group by ord2.channel,
      case when ord2.ck <> '' then 'c:' || ord2.ck || '|' || ord2.od::text
           else 'o:' || ord2.order_key end
  ),
  cool as (
    select parcel.channel,
      sum(
        case
          when parcel.wt >= 12.1 then 7860 when parcel.wt >= 10.1 then 7310 when parcel.wt >= 5.1 then 6930
          when parcel.wt >= 4.1 then 6760 when parcel.wt >= 3.1 then 5830 when parcel.wt >= 2.1 then 5720
          when parcel.wt >= 1.6 then 4680 else 4240
        end
      )::bigint as cooling
    from parcel
    group by parcel.channel
  ),
  chan as (
    select ord2.channel,
      count(*)::bigint                    as orders,
      sum(revenue * (1 - adjust))::bigint as pay_amount,
      sum(ship_rev)::bigint               as ship_revenue,
      sum(pcost)::bigint                  as product_cost,
      max(fee_rate)                       as fee_rate
    from ord2
    group by ord2.channel
  )
  select chan.channel, chan.orders, chan.pay_amount, chan.ship_revenue, chan.product_cost,
    coalesce(cool.cooling, 0) as cooling, chan.fee_rate
  from chan left join cool on cool.channel = chan.channel
  order by chan.pay_amount desc;
$$;

notify pgrst, 'reload schema';
