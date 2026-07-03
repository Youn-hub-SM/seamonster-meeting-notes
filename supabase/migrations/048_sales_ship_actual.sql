-- 048 배송비매출: '실제 배송비결제금액(shipping_fee)' 모드 추가 + 기본값으로 전환.
--  · sales_orders.shipping_fee = 원본 '배송비결제금액'(주문당 한 줄에만 저장 확인) → sum = 실제 배송비.
--    무료배송(임계·정기 등)이 이미 데이터에 반영돼 있어 모델링보다 정확.
--  · ship_mode 'actual' 추가. 기존 flat 채널을 actual 로 전환. 미설정 채널도 기본 actual.

alter table sales_channel_config drop constraint if exists sales_channel_config_ship_mode_check;
alter table sales_channel_config add constraint sales_channel_config_ship_mode_check
  check (ship_mode in ('flat','free_over','none','actual'));

update sales_channel_config set ship_mode = 'actual', updated_at = now() where ship_mode = 'flat';

drop function if exists sales_profit_summary(date, date);
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
      sum(o.shipping_fee)                                 as actual_ship,   -- 실제 배송비결제금액(주문당 1줄)
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
      coalesce(cfg.fee_rate, 0) as fee_rate,
      case
        when coalesce(cfg.ship_mode, 'actual') = 'actual' then ord.actual_ship
        when cfg.ship_mode = 'none' then 0
        when cfg.ship_mode = 'free_over' then
          case when ord.revenue >=
            (case when ord.is_sub and coalesce(cfg.ship_free_over_sub, 0) > 0
                  then cfg.ship_free_over_sub else cfg.ship_free_over end)
          then 0 else coalesce(cfg.ship_fee, 4000) end
        else coalesce(cfg.ship_fee, 4000)   -- flat
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
