-- 120: 대사 RPC — B2B 발송을 '실제로 재고가 빠진 칸' 기준으로 도매/도매 대량 탭에 나눈다 (116 보정)
--  (119 는 결번 — 폐기한 '담기' 기능 번호. 적용했더라도 이 파일과 무관하다.)
--
--  116 은 발주의 '지금' is_bulk 로 판매를 나눴다. 그런데 이미 나간 발주는 대량 체크를 바꿔도
--  차감 칸이 그대로 남는다(b2b-shipments: 발송된 선점은 칸 유지). 그래서 배포 후 지난 대량 발주를
--  소급 체크하면(기획 결정 17) 도매 탭엔 '안 빠진 판매 −N', 도매 대량 탭엔 '산 기록 없음'이 가짜로 뜬다.
--  이제 발주마다 'B2B 자동출고' 선점 행의 칸을 먼저 보고, 선점 행이 없을 때만 is_bulk 로 나눈다.
--  나머지(현재고·흐름·소매 판매·전체 탭 합)는 116 과 같다.
--
-- 적용: Supabase SQL Editor 에 붙여넣고 Run. 멱등(재실행 안전). 116 다음에 올 것.

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
  ord_ch as ( -- 발주별 실제 차감 칸 = 'B2B 자동출고' 선점 행의 칸(발송 후 대량 체크를 바꿔도 유지된다)
    select sh2.order_id, max(t.channel) as ch
    from inventory_txns t
    join shipments sh2 on sh2.id = t.shipment_id
    where t.created_by = 'B2B 자동출고'
      and t.channel in ('도매', '도매 대량')
    group by sh2.order_id
  ),
  sold_b2b as ( -- 도매 = B2B 발송완료 차수 배정 수량(052). 실제 차감 칸으로 갈라 담는다(120) —
                --  선점 행이 없는 발주(재고 차감 꺼짐·옛 데이터)만 is_bulk 로 나눈다. 전체 탭에는 둘 다 넣는다.
    select oi.product_id,
           coalesce(sum(si.qty) filter (where coalesce(oc.ch, case when coalesce(o.is_bulk, false) then '도매 대량' else '도매' end) = '도매'), 0)      as sold,
           coalesce(sum(si.qty) filter (where coalesce(oc.ch, case when coalesce(o.is_bulk, false) then '도매 대량' else '도매' end) = '도매 대량'), 0) as sold_bulk
    from shipments sh
    join orders        o  on o.id = sh.order_id
    left join ord_ch   oc on oc.order_id = o.id
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
