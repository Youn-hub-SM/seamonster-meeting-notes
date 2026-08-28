-- 099 재고 출고 사유 + 대사 협찬 분리 (2026-08-28)
--  협찬·폐기 등 '판매가 아닌 출고'가 매출(판매)과 비교돼 대사 차이가 한 방향으로 계속 커지던 문제.
--  출고에 사유(reason)를 남기고, 대사 RPC 가 비판매 출고를 out_nonsale 로 분리 반환한다.
--  기존 데이터(reason null)는 전부 '판매' 취급 — 과거 협찬 건은 표기가 없어 소급 구분 불가(대표 확인).
--
-- 적용: Supabase SQL Editor 에 이 파일 하나만 붙여넣고 Run. 멱등(재실행 안전).

alter table inventory_txns add column if not exists reason text;
comment on column inventory_txns.reason is '출고 사유 — null=판매(기본), 협찬/폐기/기타는 대사에서 분리 집계';

-- inventory_reconcile v2 — 051 본문에 out_nonsale(비판매 출고)만 추가.
--  기존 반환 컬럼·이름은 그대로라 구버전 화면(운영)도 계속 동작한다(추가 컬럼은 무시됨).
drop function if exists inventory_reconcile(date, date, text) cascade;
create function inventory_reconcile(p_from date, p_to date, p_channel text default null)
returns table(
  product_id uuid, sku text, name text,
  current_qty bigint,
  ledger_in bigint, ledger_out bigint, ledger_adj bigint,
  sold bigint,
  out_nonsale bigint
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
      sum(case when t.type = '조정' then t.qty else 0 end)  as l_adj,
      sum(case when t.type = '출고' and t.reason is not null and t.reason <> '판매'
               then -t.qty else 0 end)                      as l_out_nonsale -- 협찬·폐기 등 비판매 출고
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
    coalesce(sb.sold, 0)::bigint,
    coalesce(fl.l_out_nonsale, 0)::bigint
  from products pr
  left join stock st        on st.product_id = pr.id
  left join flow  fl        on fl.product_id = pr.id
  left join sold_by_prod sb on sb.product_id = pr.id
  where coalesce(st.qty,0) <> 0 or coalesce(fl.l_in,0) <> 0 or coalesce(fl.l_out,0) <> 0
     or coalesce(fl.l_adj,0) <> 0 or coalesce(sb.sold,0) <> 0;
$$;

notify pgrst, 'reload schema';
