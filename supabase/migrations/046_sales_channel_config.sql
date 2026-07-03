-- 046 채널별 이익: 수수료율·배송비매출 정책을 커스텀(설정 테이블).
--  · sales_channel_config: 채널별 수수료율 + 배송비매출 정책(flat 정액 / free_over N원↑무료 / none 없음).
--  · 배송비매출은 '주문 금액' 기준으로 판정 → RPC에서 주문 단위 적용 후 채널 합산.
--  · 미설정 채널은 수수료 0·배송 정액 4,000(기존 동작)으로 처리.

create table if not exists sales_channel_config (
  channel        text primary key,
  fee_rate       numeric(6,4) not null default 0,     -- 0.10 = 10%
  ship_mode      text not null default 'flat' check (ship_mode in ('flat','free_over','none')),
  ship_fee       bigint not null default 4000,        -- 주문당 배송비매출(원)
  ship_free_over bigint not null default 0,           -- free_over: 주문금액 >= 이 값 이면 무료(0)
  updated_at     timestamptz not null default now()
);

-- 기존 동작 유지 seed(파이썬 요율 + 배송 정액 4,000). 이미 있으면 유지.
insert into sales_channel_config (channel, fee_rate, ship_mode, ship_fee, ship_free_over) values
  ('스마트스토어', 0.10, 'flat', 4000, 0),
  ('쿠팡',        0.12, 'flat', 4000, 0),
  ('카페24',      0.04, 'flat', 4000, 0),
  ('토스',        0.12, 'flat', 4000, 0),
  ('톡스토어',     0.12, 'flat', 4000, 0),
  ('도매',        0.00, 'flat', 4000, 0),
  ('팔도감',      0.00, 'flat', 4000, 0)
on conflict (channel) do nothing;

create or replace function sales_profit_summary(p_from date, p_to date)
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
    select o.channel, o.order_id,
      sum(o.subtotal_amount)                              as revenue,
      sum(o.quantity * coalesce(r.cost, 0))              as pcost,
      round(sum(o.quantity * coalesce(r.weight, 0)), 1)  as wt
    from sales_orders o
    left join resolved r on r.sku = o.sku_code
    where o.order_date between p_from and p_to
    group by o.channel, o.order_id
  ),
  ord2 as (
    select ord.channel, ord.revenue, ord.pcost, ord.wt,
      coalesce(cfg.fee_rate, 0) as fee_rate,
      case
        when coalesce(cfg.ship_mode, 'flat') = 'none' then 0
        when cfg.ship_mode = 'free_over' and ord.revenue >= cfg.ship_free_over then 0
        else coalesce(cfg.ship_fee, 4000)
      end as ship_rev
    from ord left join sales_channel_config cfg on cfg.channel = ord.channel
  )
  select channel,
    count(*)::bigint      as orders,
    sum(revenue)::bigint  as pay_amount,
    sum(ship_rev)::bigint as ship_revenue,
    sum(pcost)::bigint    as product_cost,
    sum(
      case
        when wt >= 12.1 then 7860 when wt >= 10.1 then 7310 when wt >= 5.1 then 6930
        when wt >= 4.1 then 6760 when wt >= 3.1 then 5830 when wt >= 2.1 then 5720
        when wt >= 1.6 then 4680 else 4240
      end
    )::bigint             as cooling,
    max(fee_rate)         as fee_rate
  from ord2
  group by channel
  order by pay_amount desc;
$$;

notify pgrst, 'reload schema';
