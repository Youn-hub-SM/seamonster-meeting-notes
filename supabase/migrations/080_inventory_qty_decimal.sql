-- 080 재고 수량 소수 둘째자리 허용
--  inventory_txns.qty(원장 수량)와 이를 1:1 로 기록하는 production_receipts.qty 를 numeric(14,2) 로 확장하고,
--  이 컬럼을 sum()::bigint 로 집계하던 의존 RPC(inventory_stock=036 현행, inventory_reconcile=052 현행)를
--  numeric 으로 재정의한다. 앱은 수량을 소수 둘째자리로 반올림(Math.round(n*100)/100)해 기록한다.
--  대상은 '재고 수량'만 — 금액/단가/박스수/운임/비율/구성 배수는 그대로 정수·기존 타입 유지.
-- 적용: Supabase Dashboard > SQL Editor 에 이 파일 하나만 붙여넣고 Run. 멱등(재실행 안전 — 이미 numeric 이면 no-op).

-- 1) 원장 수량(현재고 = Σqty)
alter table inventory_txns alter column qty type numeric(14,2) using qty::numeric(14,2);

-- 2) 도매 생산 입고 수량 — receive 시 inventory_txns(도매 입고) 1건과 함께 기록되므로 같이 확장.
--    check (qty <> 0) 은 numeric 에도 유효.
alter table production_receipts alter column qty type numeric(14,2) using qty::numeric(14,2);

-- 3) 현재고 집계 RPC — 반환 qty bigint→numeric, ::bigint→::numeric(14,2). (반환 타입 변경은 drop 필요)
--    본문(상태 무필터·채널 인자)은 036 현행 그대로, 캐스팅만 변경 — 호출부 시그니처 불변.
drop function if exists inventory_stock(date, text);
create function inventory_stock(asof date default null, chan text default null)
returns table (product_id uuid, qty numeric)
language sql stable as $$
  select t.product_id, coalesce(sum(t.qty), 0)::numeric(14,2)
  from inventory_txns t
  where (asof is null or t.txn_date <= asof)
    and (chan is null or t.channel = chan)
  group by t.product_id
$$;

-- 4) 재고 정합성 대사 RPC — 재고 유래 수량(current_qty·ledger_in/out/adj)을 numeric 으로. sold 는
--    판매/발송 수량(재고 아님)이나 반환 테이블 타입 일치를 위해 numeric(값은 불변). 본문은 052 현행 그대로.
drop function if exists inventory_reconcile(date, date, text) cascade;
create function inventory_reconcile(p_from date, p_to date, p_channel text default null)
returns table(
  product_id uuid, sku text, name text,
  current_qty numeric,
  ledger_in numeric, ledger_out numeric, ledger_adj numeric,
  sold numeric
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
  sold_retail as (
    select p.id as product_id, sum(se.q) as sold
    from sold_expanded se join prod p on p.sku = se.sku
    group by p.id
  ),
  sold_b2b as (
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
    coalesce(st.qty, 0)::numeric(14,2),
    coalesce(fl.l_in, 0)::numeric(14,2),
    coalesce(fl.l_out, 0)::numeric(14,2),
    coalesce(fl.l_adj, 0)::numeric(14,2),
    (case
       when p_channel = '도매' then coalesce(sb.sold, 0)
       when p_channel = '소매' then coalesce(sr.sold, 0)
       else coalesce(sr.sold, 0) + coalesce(sb.sold, 0)
     end)::numeric(14,2) as sold
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
