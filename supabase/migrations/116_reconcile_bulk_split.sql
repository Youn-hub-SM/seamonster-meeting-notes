-- 116: 대사 RPC — 대량 발송을 탭별로 옳게 센다 (115 보정)
--  115 는 sold_b2b 에서 대량을 통째로 뺐는데 그러면 '전체' 탭이 어긋난다.
--  전체 탭은 도매 대량 칸의 재고 감소까지 함께 보므로 그 판매도 세어야 짝이 맞는다
--  (검증에서 확인 — 대량 발송이 '재고에서만 빠진 유령 차이'로 떴다).
--
--   도매      → 일반 발주 발송만   (대량은 그 칸을 거치지 않는다)
--   도매 대량 → 대량 발주 발송만
--   소매      → 소매 판매만
--   프로모션  → 0  (자동 출고 경로가 없는 보호 칸)
--   전체      → 셋 다
-- 적용: Supabase SQL Editor 에 붙여넣고 Run. 멱등(재실행 안전). 115 다음에 올 것.

drop function if exists inventory_reconcile(date, date, text) cascade;
create function inventory_reconcile(p_from date, p_to date, p_channel text default null)
returns table(
  product_id uuid, sku text, name text,
  current_qty numeric,
  ledger_in numeric, ledger_out numeric, ledger_adj numeric,
  sold numeric,
  out_nonsale numeric
) language sql stable as $$
  with
  stock as ( -- 현재고 = inventory_stock 규칙(완료만)과 동일
    select t.product_id, coalesce(sum(t.qty), 0) as qty
    from inventory_txns t
    where t.status = '완료'
      and (p_channel is null or t.channel = p_channel)
    group by t.product_id
  ),
  flow as ( -- 선택 기간의 원장 흐름(완료만). 비판매 = 사유 있는 출고(협찬·폐기) + 채널이동
    select t.product_id,
      sum(case when t.type = '입고' then t.qty else 0 end)  as l_in,
      sum(case when t.type = '출고' then -t.qty else 0 end) as l_out,
      sum(case when t.type = '조정' then t.qty else 0 end)  as l_adj,
      sum(case when t.type = '출고'
                and ((t.reason is not null and t.reason <> '판매') or t.partner = '채널이동')
               then -t.qty else 0 end)                      as l_out_nonsale
    from inventory_txns t
    where t.status = '완료'
      and t.txn_date between p_from and p_to
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
  sold_retail as (
    select p.id as product_id, sum(se.q) as sold
    from sold_expanded se join prod p on p.sku = se.sku
    group by p.id
  ),
  sold_b2b as ( -- 도매 = B2B 발송완료 차수 배정 수량(052). 대량 여부를 갈라 담는다(116) —
                --  대량은 '도매 대량' 칸에서 빠지므로 도매 탭에는 넣지 않고, 전체 탭에는 넣어야 짝이 맞는다.
    select oi.product_id,
           coalesce(sum(si.qty) filter (where coalesce(o.is_bulk, false) = false), 0) as sold,
           coalesce(sum(si.qty) filter (where coalesce(o.is_bulk, false)), 0)         as sold_bulk
    from shipments sh
    join orders        o  on o.id = sh.order_id
    join shipment_items si on si.shipment_id = sh.id
    join order_items   oi on oi.id = si.order_item_id
    where sh.status = '발송완료'
      and sh.ship_date between p_from and p_to
      and oi.product_id is not null
    group by oi.product_id
  )
  select
    pr.id, pr.sku, pr.name,
    coalesce(st.qty, 0)::numeric(14,2),
    coalesce(fl.l_in, 0)::numeric(14,2),
    coalesce(fl.l_out, 0)::numeric(14,2),
    coalesce(fl.l_adj, 0)::numeric(14,2),
    (case
       when p_channel = '도매'      then coalesce(sb.sold, 0)
       when p_channel = '도매 대량' then coalesce(sb.sold_bulk, 0)
       when p_channel = '소매'      then coalesce(sr.sold, 0)
       when p_channel = '프로모션'  then 0
       else coalesce(sr.sold, 0) + coalesce(sb.sold, 0) + coalesce(sb.sold_bulk, 0)
     end)::numeric(14,2) as sold,
    coalesce(fl.l_out_nonsale, 0)::numeric(14,2)
  from products pr
  left join stock st        on st.product_id = pr.id
  left join flow  fl        on fl.product_id = pr.id
  left join sold_retail sr  on sr.product_id = pr.id
  left join sold_b2b   sb   on sb.product_id = pr.id
  where coalesce(st.qty,0) <> 0 or coalesce(fl.l_in,0) <> 0 or coalesce(fl.l_out,0) <> 0
     or coalesce(fl.l_adj,0) <> 0
     or (case
           when p_channel = '도매'      then coalesce(sb.sold, 0)
           when p_channel = '도매 대량' then coalesce(sb.sold_bulk, 0)
           when p_channel = '소매'      then coalesce(sr.sold, 0)
           when p_channel = '프로모션'  then 0
           else coalesce(sr.sold, 0) + coalesce(sb.sold, 0) + coalesce(sb.sold_bulk, 0)
         end) <> 0;
$$;

notify pgrst, 'reload schema';
