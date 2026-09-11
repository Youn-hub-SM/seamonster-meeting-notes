-- 110: 재고 RPC 정확성 복원 (2026-09-11 전체 감사 확정 3건)
--  1) inventory_stock 에서 status='완료' 필터가 036 재정의 때 소실 — '대기' 입출고가 현재고에
--     즉시 반영되던 회귀(034 원칙: 대기는 미반영) 복원. 080 시그니처(asof, chan, numeric) 유지.
--  2) inventory_reconcile 이 099 재정의 때 052 의 도매(B2B 발송) sold 와 080 의 numeric 정밀도를
--     소리 없이 롤백 — 세 마이그레이션의 개선을 전부 합친 정본으로 재정의.
--  3) 대사에서 채널이동(소매↔도매 이동, partner='채널이동') 출고가 '판매 출고'로 집계되던 왜곡 —
--     협찬·폐기와 같은 비판매(out_nonsale)로 분리.
-- 적용: Supabase SQL Editor 에 이 파일 하나만 붙여넣고 Run. 멱등(재실행 안전).

-- 1) 현재고 집계 — 완료만, numeric, 채널 옵션(080 시그니처 그대로라 호출부 불변)
drop function if exists inventory_stock(date, text);
create function inventory_stock(asof date default null, chan text default null)
returns table (product_id uuid, qty numeric)
language sql stable as $$
  select t.product_id, coalesce(sum(t.qty), 0)::numeric(14,2)
  from inventory_txns t
  where t.status = '완료'
    and (asof is null or t.txn_date <= asof)
    and (chan is null or t.channel = chan)
  group by t.product_id
$$;

-- 2)+3) 대사 — 099(out_nonsale·reason) + 052(도매 sold) + 080(numeric) 합본, 완료 필터·채널이동 분리 추가.
--  반환 컬럼 구성은 099 와 동일(타입만 numeric) — 화면(추가 컬럼 무시)과 호환.
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
  sold_b2b as ( -- 도매 = B2B 발송완료 차수 배정 수량(052)
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
           when p_channel = '도매' then coalesce(sb.sold, 0)
           when p_channel = '소매' then coalesce(sr.sold, 0)
           else coalesce(sr.sold, 0) + coalesce(sb.sold, 0)
         end) <> 0;
$$;

notify pgrst, 'reload schema';
