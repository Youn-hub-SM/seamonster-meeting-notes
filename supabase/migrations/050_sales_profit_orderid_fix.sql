-- 050 채널이익 RPC 수정: 빈 order_id 뭉침 방지.
--  · 원본에 주문번호 없는 라인(order_id='')이 채널당 1개 주문으로 뭉쳐 주문수·택배보냉비가 틀어지는 결함 방어.
--  · 그룹키 = coalesce(nullif(order_id,''), 'row:'||id) → 빈 order_id 행은 각각 별개 주문으로 취급.
--  (나머지 계산은 049와 동일)

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
      coalesce(nullif(o.order_id, ''), 'row:' || o.id::text)  as order_key,   -- 빈 주문번호는 행별 분리
      sum(o.subtotal_amount)                              as revenue,
      sum(o.shipping_fee)                                 as actual_ship,
      sum(o.quantity * coalesce(r.cost, 0))              as pcost,
      round(sum(o.quantity * coalesce(r.weight, 0)), 1)  as wt,
      bool_or(o.product_name ilike '%정기배송%')          as is_sub
    from sales_orders o
    left join resolved r on r.sku = o.sku_code
    where o.order_date between p_from and p_to
    group by o.channel, coalesce(nullif(o.order_id, ''), 'row:' || o.id::text)
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
    sum(revenue * (1 - adjust))::bigint as pay_amount,
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
