-- 052 재고 정합성 대사 RPC — '팔린 수'를 채널별 소스로 분리.
--   · 소매(또는 전체의 소매분): sales_orders 판매수량(번들 구성품 전개)  ← 051과 동일
--   · 도매(또는 전체의 도매분): B2B 발송완료(shipments status='발송완료')의 shipment_items 수량
--   · 채널 미지정(전체) = 소매 + 도매
--  즉 도매 화면에서는 도매 재고를 도매 판매(B2B 발송)와 비교한다.
--  나머지(현재고·기간 원장흐름)는 051과 동일하게 채널 필터 적용.
--
-- 적용: Supabase SQL Editor 에 이 파일 하나만 붙여넣고 Run. 멱등(재실행 안전).

drop function if exists inventory_reconcile(date, date, text) cascade;
create function inventory_reconcile(p_from date, p_to date, p_channel text default null)
returns table(
  product_id uuid, sku text, name text,
  current_qty bigint,
  ledger_in bigint, ledger_out bigint, ledger_adj bigint,
  sold bigint
) language sql stable as $$
  with
  stock as (
    select t.product_id, coalesce(sum(t.qty), 0) as qty
    from inventory_txns t
    where (p_channel is null or t.channel = p_channel)
    group by t.product_id
  ),
  flow as (
    select t.product_id,
      sum(case when t.type = '입고' then t.qty else 0 end)  as l_in,
      sum(case when t.type = '출고' then -t.qty else 0 end) as l_out,
      sum(case when t.type = '조정' then t.qty else 0 end)  as l_adj
    from inventory_txns t
    where t.txn_date between p_from and p_to
      and (p_channel is null or t.channel = p_channel)
    group by t.product_id
  ),
  prod as (
    select distinct on (sku) id, sku
    from products where sku is not null and sku <> '' order by sku, updated_at desc
  ),
  bundle as (
    select pp.sku as parent_sku, c.sku as comp_sku, pb.qty as mult
    from product_bundles pb
    join products pp on pp.id = pb.parent_id
    join products c  on c.id  = pb.component_id
    where c.sku is not null and c.sku <> ''
  ),
  sold_raw as (
    select sku_code, sum(quantity) as q
    from sales_orders
    where order_date between p_from and p_to and sku_code is not null and sku_code <> ''
    group by sku_code
  ),
  sold_expanded as (
    select b.comp_sku as sku, (sr.q * b.mult) as q
    from sold_raw sr join bundle b on b.parent_sku = sr.sku_code
    union all
    select sr.sku_code as sku, sr.q
    from sold_raw sr
    where not exists (select 1 from bundle b where b.parent_sku = sr.sku_code)
  ),
  sold_retail as ( -- 소매 판매(품목별)
    select p.id as product_id, sum(se.q) as sold
    from sold_expanded se join prod p on p.sku = se.sku
    group by p.id
  ),
  sold_b2b as ( -- 도매 판매 = B2B 발송완료 수량(품목별)
    select oi.product_id, sum(si.qty) as sold
    from shipments sh
    join shipment_items si on si.shipment_id = sh.id
    join order_items   oi on oi.id = si.order_item_id
    where sh.status = '발송완료'
      and sh.ship_date between p_from and p_to
      and oi.product_id is not null
    group by oi.product_id
  )
  select
    pr.id, pr.sku, pr.name,
    coalesce(st.qty, 0)::bigint,
    coalesce(fl.l_in, 0)::bigint,
    coalesce(fl.l_out, 0)::bigint,
    coalesce(fl.l_adj, 0)::bigint,
    (case
       when p_channel = '도매' then coalesce(sb.sold, 0)
       when p_channel = '소매' then coalesce(sr.sold, 0)
       else coalesce(sr.sold, 0) + coalesce(sb.sold, 0)
     end)::bigint as sold
  from products pr
  left join stock st        on st.product_id = pr.id
  left join flow  fl        on fl.product_id = pr.id
  left join sold_retail sr  on sr.product_id = pr.id
  left join sold_b2b   sb   on sb.product_id = pr.id
  where coalesce(st.qty,0) <> 0 or coalesce(fl.l_in,0) <> 0 or coalesce(fl.l_out,0) <> 0 or coalesce(fl.l_adj,0) <> 0
     or (case
           when p_channel = '도매' then coalesce(sb.sold, 0)
           when p_channel = '소매' then coalesce(sr.sold, 0)
           else coalesce(sr.sold, 0) + coalesce(sb.sold, 0)
         end) <> 0;
$$;

notify pgrst, 'reload schema';
