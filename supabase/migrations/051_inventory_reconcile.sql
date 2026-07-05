-- 051 재고 정합성 대사 RPC
--  매출(sales_orders)의 실제 판매수량을 '실제 출고'로 보고, 재고 원장(inventory_txns)과 대조한다.
--  품목(product)별로 반환: 현재고 · 기간 원장흐름(입고/출고/조정) · 실제 판매수량.
--  판매 sku_code 가 번들(세트) 부모면 구성품 수량(qty)으로 전개해 재고(구성품 단위)와 맞춘다.
--  현재고는 inventory_stock(036)과 동일 규칙(상태 무필터)으로 계산 — 다른 재고 화면과 수치 일치.
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
  stock as ( -- 현재고(전체 기간 순합, 채널 옵션) = inventory_stock 규칙과 동일
    select t.product_id, coalesce(sum(t.qty), 0) as qty
    from inventory_txns t
    where (p_channel is null or t.channel = p_channel)
    group by t.product_id
  ),
  flow as ( -- 선택 기간의 원장 흐름
    select t.product_id,
      sum(case when t.type = '입고' then t.qty else 0 end)  as l_in,
      sum(case when t.type = '출고' then -t.qty else 0 end) as l_out,  -- 출고 qty 는 음수 저장 → 양수화
      sum(case when t.type = '조정' then t.qty else 0 end)  as l_adj
    from inventory_txns t
    where t.txn_date between p_from and p_to
      and (p_channel is null or t.channel = p_channel)
    group by t.product_id
  ),
  prod as ( -- sku → product (중복 sku 는 최신 1개)
    select distinct on (sku) id, sku
    from products where sku is not null and sku <> '' order by sku, updated_at desc
  ),
  bundle as ( -- 번들 부모 sku → 구성품 sku × 배수
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
  sold_expanded as ( -- 번들이면 구성품으로 전개, 아니면 그대로
    select b.comp_sku as sku, (sr.q * b.mult) as q
    from sold_raw sr join bundle b on b.parent_sku = sr.sku_code
    union all
    select sr.sku_code as sku, sr.q
    from sold_raw sr
    where not exists (select 1 from bundle b where b.parent_sku = sr.sku_code)
  ),
  sold_by_prod as (
    select p.id as product_id, sum(se.q) as sold
    from sold_expanded se join prod p on p.sku = se.sku
    group by p.id
  )
  select
    pr.id, pr.sku, pr.name,
    coalesce(st.qty, 0)::bigint,
    coalesce(fl.l_in, 0)::bigint,
    coalesce(fl.l_out, 0)::bigint,
    coalesce(fl.l_adj, 0)::bigint,
    coalesce(sb.sold, 0)::bigint
  from products pr
  left join stock st        on st.product_id = pr.id
  left join flow  fl        on fl.product_id = pr.id
  left join sold_by_prod sb on sb.product_id = pr.id
  where coalesce(st.qty,0) <> 0 or coalesce(fl.l_in,0) <> 0 or coalesce(fl.l_out,0) <> 0
     or coalesce(fl.l_adj,0) <> 0 or coalesce(sb.sold,0) <> 0;
$$;

notify pgrst, 'reload schema';
