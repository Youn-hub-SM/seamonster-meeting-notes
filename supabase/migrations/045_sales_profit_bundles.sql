-- 045 채널별 이익: 묶음(세트)상품 원가·중량을 '구성품 합'으로 산출.
--  · 판매 SKU가 product_bundles 부모면 → 원가=Σ(구성품 cost_price×qty), 중량=Σ(구성품 volume_kg×qty).
--    아니면(단품) → 자기 cost_price/volume_kg. (1단계 전개: 구성품은 단품 가정)
--  · 중량은 구성품 중 volume_kg null 이 하나라도 있으면 null(=결측 표시). 원가는 구성품 중 0 있으면 결측 플래그.
--  · 미매칭 = products 없음 OR (묶음/단품) 원가·부피 결측 → 상품마스터/구성품에서 채워야.

drop function if exists sales_profit_summary(date, date);
create or replace function sales_profit_summary(p_from date, p_to date)
returns table(channel text, orders bigint, pay_amount bigint, product_cost bigint, cooling bigint)
language sql stable as $$
  with prod as (
    select distinct on (sku) id, sku, cost_price, volume_kg
    from products where sku is not null and sku <> '' order by sku, updated_at desc
  ),
  comp as (   -- 묶음 부모 sku → 구성품 합
    select pp.sku as parent_sku,
      sum(c.cost_price * pb.qty)                                            as cost,
      case when bool_or(c.volume_kg is null) then null else sum(c.volume_kg * pb.qty) end as weight
    from product_bundles pb
    join products pp on pp.id = pb.parent_id
    join products c  on c.id  = pb.component_id
    group by pp.sku
  ),
  resolved as (   -- sku → 최종 원가·중량 (묶음이면 구성품합, 아니면 자기값)
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
  )
  select channel,
    count(*)::bigint     as orders,
    sum(revenue)::bigint as pay_amount,
    sum(pcost)::bigint   as product_cost,
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
    )::bigint            as cooling
  from ord
  group by channel
  order by pay_amount desc;
$$;

create or replace function sales_profit_unmatched(p_from date, p_to date)
returns table(sku_code text, line_count bigint, qty_sum bigint, amount_sum bigint, channels text)
language sql stable as $$
  with prod as (
    select distinct on (sku) id, sku, cost_price, volume_kg
    from products where sku is not null and sku <> '' order by sku, updated_at desc
  ),
  comp as (
    select pp.sku as parent_sku,
      bool_or(coalesce(c.cost_price, 0) = 0) as cost_missing,
      bool_or(c.volume_kg is null)           as wt_missing
    from product_bundles pb
    join products pp on pp.id = pb.parent_id
    join products c  on c.id  = pb.component_id
    group by pp.sku
  ),
  resolved as (
    select p.sku,
      case when cm.parent_sku is not null then (cm.cost_missing or cm.wt_missing)
           else (coalesce(p.cost_price, 0) = 0 or p.volume_kg is null) end as bad
    from prod p left join comp cm on cm.parent_sku = p.sku
  )
  select o.sku_code,
    count(*)::bigint               as line_count,
    sum(o.quantity)::bigint        as qty_sum,
    sum(o.subtotal_amount)::bigint as amount_sum,
    string_agg(distinct o.channel, ', ') as channels
  from sales_orders o
  left join resolved r on r.sku = o.sku_code
  where o.order_date between p_from and p_to
    and (r.sku is null or r.bad)
  group by o.sku_code
  order by amount_sum desc;
$$;

notify pgrst, 'reload schema';
