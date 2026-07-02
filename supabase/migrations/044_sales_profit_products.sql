-- 044 채널별 이익 원가·중량 소스를 '상품마스터(products)'로 전환.
--  · 원가 = products.cost_price(제조원가+포장재), 중량 = products.volume_kg. sku 매칭(products.sku = sales_orders.sku_code).
--  · products.sku 중복 가능(014에서 UNIQUE 제거) → distinct on 으로 최신(updated_at) 1건만.
--  · 미매칭 = products 없음 OR cost_price=0 OR volume_kg null (상품마스터에서 채워야 함). sales_sku_cost(백데이터)는 더 이상 사용 안 함.

create or replace function sales_profit_summary(p_from date, p_to date)
returns table(channel text, orders bigint, pay_amount bigint, product_cost bigint, cooling bigint)
language sql stable as $$
  with prod as (
    select distinct on (sku) sku, cost_price, volume_kg
    from products where sku is not null and sku <> ''
    order by sku, updated_at desc
  ),
  ord as (
    select o.channel, o.order_id,
      sum(o.subtotal_amount)                                 as revenue,
      sum(o.quantity * coalesce(pr.cost_price, 0))           as pcost,
      round(sum(o.quantity * coalesce(pr.volume_kg, 0)), 1)  as wt
    from sales_orders o
    left join prod pr on pr.sku = o.sku_code
    where o.order_date between p_from and p_to
    group by o.channel, o.order_id
  )
  select channel,
    count(*)::bigint       as orders,
    sum(revenue)::bigint   as pay_amount,
    sum(pcost)::bigint     as product_cost,
    sum(
      case
        when wt >= 12.1 then 7860
        when wt >= 10.1 then 7310
        when wt >= 5.1  then 6930
        when wt >= 4.1  then 6760
        when wt >= 3.1  then 5830
        when wt >= 2.1  then 5720
        when wt >= 1.6  then 4680
        else 4240
      end
    )::bigint              as cooling
  from ord
  group by channel
  order by pay_amount desc;
$$;

create or replace function sales_profit_unmatched(p_from date, p_to date)
returns table(sku_code text, line_count bigint, qty_sum bigint, amount_sum bigint, channels text)
language sql stable as $$
  with prod as (
    select distinct on (sku) sku, cost_price, volume_kg
    from products where sku is not null and sku <> ''
    order by sku, updated_at desc
  )
  select o.sku_code,
    count(*)::bigint               as line_count,
    sum(o.quantity)::bigint        as qty_sum,
    sum(o.subtotal_amount)::bigint as amount_sum,
    string_agg(distinct o.channel, ', ') as channels
  from sales_orders o
  left join prod pr on pr.sku = o.sku_code
  where o.order_date between p_from and p_to
    and (pr.sku is null or pr.cost_price is null or pr.cost_price = 0 or pr.volume_kg is null)
  group by o.sku_code
  order by amount_sum desc;
$$;

notify pgrst, 'reload schema';
