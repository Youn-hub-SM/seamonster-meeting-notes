-- 157 채널별 이익 — 톡스토어(톡딜) 'TD_' 접두 SKU 를 상품마스터에 매칭(2026-10-30 대표: "톡스토어 이익률이 과도하게 높다")
--
--  증상: 톡딜 주문의 관리코드는 'TD_DSC-100-K-100X5' 처럼 상품마스터 코드 앞에 TD_ 가 붙는다. sales_profit_summary 는
--        products.sku 와 정확히 같을 때만 원가·중량을 가져오므로 이 줄들은 원가 0·중량 0 → 톡스토어 매출총이익률이 97% 로 보였다.
--  수정: 정확 일치가 없거나, 있어도 원가가 0(세트인데 구성품 미등록)이면 앞의 'TD_' 를 뗀 코드로 한 번 더 찾는다(원가·중량·미매칭 판정 모두).
--        TD_ 는 세트 상품이라 원칙은 상품마스터에 구성품(product_bundles)과 함께 등록하는 것 — 이 폴백은 등록 전의 안전망이다(대표 지적 2026-10-30).
--  범위 밖: 상품마스터에 아예 없는 코드(11팩 증정 구성 P_*-100X1+100, SH-100-K-100X5 등)는 그대로 미매칭 — 상품마스터에 세트로 등록해야 원가가 잡힌다.
--  146 의 함수 본문을 그대로 두고 resolved 조인만 바꿨다(주문 1건 키·택배보냉비 묶음·수수료·배송비매출 규칙 변경 없음). 멱등 — 재실행 안전.

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
      sum(o.quantity * coalesce(nullif(rx.cost, 0), nullif(rs.cost, 0), 0))         as pcost, -- 157: 정확 일치(rx)가 없거나 원가 0 이면 TD_ 뗀 코드(rs)
      round(sum(o.quantity * coalesce(nullif(rx.weight, 0), nullif(rs.weight, 0), 0)), 1) as wt,
      bool_or(o.product_name ilike '%정기배송%')          as is_sub
    from sales_orders o
    left join resolved rx on rx.sku = o.sku_code
    left join resolved rs on o.sku_code like 'TD\_%' and rs.sku = substr(o.sku_code, 4)
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

-- 미매칭 SKU 목록(045 본문 + TD_ 폴백) — 정확 일치와 TD_ 뗀 코드 둘 다 못 쓸 때만 미매칭
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
  left join resolved rx on rx.sku = o.sku_code
  left join resolved rs on o.sku_code like 'TD\_%' and rs.sku = substr(o.sku_code, 4)
  where o.order_date between p_from and p_to
    and (rx.sku is null or rx.bad) and (rs.sku is null or rs.bad)
  group by o.sku_code
  order by amount_sum desc;
$$;

comment on function sales_profit_summary(date, date) is '채널별 매출·원가·택배보냉비·수수료율(기간). 원가=상품마스터 products.cost_price(세트는 구성품 합), 톡딜 TD_ 접두는 떼고 매칭(157, 정확 일치 원가 0 이어도). 미매칭은 원가 0.';
comment on function sales_profit_unmatched(date, date) is '기간 내 상품마스터에 없거나 원가·중량이 빈 관리코드(TD_ 접두는 떼고도 비교, 157). 채널별 이익 화면의 "미매칭 SKU" 카드.';

notify pgrst, 'reload schema';
