-- 043 채널별 매출·이익 계산 (파이썬 채널별_매출이익 이식).
--  · sales_sku_cost: 관리코드(sku_code)별 원가·중량. 백데이터(이익률계산백데이터.xlsx 시트1) 시드/갱신.
--    products는 sku 체계가 달라 매칭 안 됨 → 별도 원장.
--  · 매출은 sales_orders(기간). 택배보냉비=중량→총액 계단(백데이터 택배포장, 계절 무관 고정), 주문당 1회(합배송).
--    수수료율·배송비매출(4,000/주문)은 API에서 적용(파이썬 값 그대로).

create table if not exists sales_sku_cost (
  sku_code     text primary key,
  product_name text,
  weight_kg    numeric(10,3) not null default 0,   -- 상품 1개 중량(kg)
  cost_price   bigint        not null default 0,   -- 상품 1개 원가(원)
  updated_at   timestamptz   not null default now()
);

-- 채널별 집계: 주문수·총결제금액·총상품원가·총택배보냉비. (원가/중량 미매칭은 0으로 계산 = 파이썬 fillna(0))
create or replace function sales_profit_summary(p_from date, p_to date)
returns table(channel text, orders bigint, pay_amount bigint, product_cost bigint, cooling bigint)
language sql stable as $$
  with ord as (
    select o.channel, o.order_id,
      sum(o.subtotal_amount)                                as revenue,
      sum(o.quantity * coalesce(c.cost_price, 0))           as pcost,
      round(sum(o.quantity * coalesce(c.weight_kg, 0)), 1)  as wt   -- 주문 총중량(0.1 그리드)
    from sales_orders o
    left join sales_sku_cost c on c.sku_code = o.sku_code
    where o.order_date between p_from and p_to
    group by o.channel, o.order_id
  )
  select channel,
    count(*)::bigint                     as orders,
    sum(revenue)::bigint                 as pay_amount,
    sum(pcost)::bigint                   as product_cost,
    sum(                                              -- 택배포장 총액 계단(중량→비용), 주문당 1회
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
    )::bigint                            as cooling
  from ord
  group by channel
  order by pay_amount desc;
$$;

-- 원가/중량 백데이터에 없는 관리코드(미매칭) 요약 — 파이썬 '미매칭_관리코드' 시트.
create or replace function sales_profit_unmatched(p_from date, p_to date)
returns table(sku_code text, line_count bigint, qty_sum bigint, amount_sum bigint, channels text)
language sql stable as $$
  select o.sku_code,
    count(*)::bigint             as line_count,
    sum(o.quantity)::bigint      as qty_sum,
    sum(o.subtotal_amount)::bigint as amount_sum,
    string_agg(distinct o.channel, ', ') as channels
  from sales_orders o
  left join sales_sku_cost c on c.sku_code = o.sku_code
  where o.order_date between p_from and p_to
    and c.sku_code is null
  group by o.sku_code
  order by amount_sum desc;
$$;

notify pgrst, 'reload schema';
