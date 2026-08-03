-- 085 채널이익 RPC 수정: 택배보냉비를 '주문번호'가 아니라 '실제 택배(합배송)' 단위로.
--  · 문제: 톡스토어(톡딜)는 한 사람이 한 번에 사도 주문번호가 상품별로 갈려서,
--    주문번호마다 택배보냉비(최소 4,240원)가 따로 잡혀 과대 계산됐다.
--    (배송일지에서 이미 확인한 현상 — 실제 발송은 합배송 1박스인데 주문번호는 여러 개)
--  · 수정: 같은 채널 · 같은 주문일 · 같은 주문자(전화 해시 customer_key)는 한 택배로 묶어
--    무게를 합산한 뒤 요율표를 1회만 적용한다. 전화가 없는 행(customer_key='')은
--    묶을 근거가 없으므로 기존대로 주문번호별 1택배.
--  · 주문수·총결제금액·배송비매출·총상품원가·수수료율 계산은 050과 완전히 동일 — 택배보냉비만 바뀐다.
--
-- 적용: Supabase SQL Editor 에 이 파일 하나만 붙여넣고 Run. 멱등(재실행 안전).

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
      coalesce(nullif(o.order_id, ''), 'row:' || o.id::text)  as order_key,   -- 빈 주문번호는 행별 분리(050)
      max(coalesce(o.customer_key, ''))                       as ck,          -- 합배송 묶음용 주문자 해시
      min(o.order_date)                                       as od,          -- 합배송 묶음용 주문일
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
  -- 실제 택배 단위: 주문자·주문일이 같으면 주문번호가 몇 개든 1택배(무게 합산 → 요율 1회)
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
