-- 049 채널 매출 보정율: 할인 미반영 채널(카페24 등) 매출을 일정 비율 차감 보정.
--  · sales_channel_config.revenue_adjust: 총결제금액 차감율(0.055 = 5.5% 차감). 0이면 보정 없음.
--  · 보정 총결제금액 = 원본 결제금액 × (1 - revenue_adjust). 배송비매출·원가·보냉비는 그대로.
--  · 카페24 기본 5.5%(보수적) seed. 웹 '채널 설정'에서 조정 가능.

alter table sales_channel_config add column if not exists revenue_adjust numeric(6,4) not null default 0;
update sales_channel_config set revenue_adjust = 0.055, updated_at = now()
  where channel = '카페24' and revenue_adjust = 0;

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
    select o.channel, o.order_id,
      sum(o.subtotal_amount)                              as revenue,
      sum(o.shipping_fee)                                 as actual_ship,
      sum(o.quantity * coalesce(r.cost, 0))              as pcost,
      round(sum(o.quantity * coalesce(r.weight, 0)), 1)  as wt,
      bool_or(o.product_name ilike '%정기배송%')          as is_sub
    from sales_orders o
    left join resolved r on r.sku = o.sku_code
    where o.order_date between p_from and p_to
    group by o.channel, o.order_id
  ),
  ord2 as (
    select ord.channel, ord.revenue, ord.pcost, ord.wt,
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
  )
  select channel,
    count(*)::bigint                    as orders,
    sum(revenue * (1 - adjust))::bigint as pay_amount,   -- 매출 보정 반영
    sum(ship_rev)::bigint               as ship_revenue,
    sum(pcost)::bigint                  as product_cost,
    sum(
      case
        when wt >= 12.1 then 7860 when wt >= 10.1 then 7310 when wt >= 5.1 then 6930
        when wt >= 4.1 then 6760 when wt >= 3.1 then 5830 when wt >= 2.1 then 5720
        when wt >= 1.6 then 4680 else 4240
      end
    )::bigint                          as cooling,
    max(fee_rate)                      as fee_rate
  from ord2
  group by channel
  order by pay_amount desc;
$$;

notify pgrst, 'reload schema';
