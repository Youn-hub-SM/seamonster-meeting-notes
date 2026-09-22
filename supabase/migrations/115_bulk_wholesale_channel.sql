-- 115: 도매 대량 = 넷째 재고 칸 (2026-09-22 대표 확정)
--  · 대량 도매 발주는 선결제 건이라 이미 씨몬스터 물건이 아니다. 도매 일반 주문이 가져가지 못하게
--    칸을 따로 둔다 — 113 이 프로모션을 셋째 칸으로 만든 것과 같은 패턴.
--  · 칸을 나누면 '예약'(도매 재고 안에서 임자 있는 몫을 계산으로 갈라내던 장치)이 통째로 필요 없어진다.
--    docs/demand-streams-plan.md 2절 결정 4~8.
--  · 도매 대량 칸엔 자동 합류를 두지 않는다(프로모션 풀과 다른 점) — 이미 팔린 물건이라 돌려보낼 근거가 없다.
-- 적용: Supabase SQL Editor 에 이 파일 하나만 붙여넣고 Run. 멱등(재실행 안전).

-- 1) 재고 칸 확장: 도매/소매/프로모션 → +도매 대량
alter table inventory_txns drop constraint if exists inventory_txns_channel_chk;
alter table inventory_txns add constraint inventory_txns_channel_chk
  check (channel in ('도매', '소매', '프로모션', '도매 대량'));

comment on column inventory_txns.channel is
  '재고 칸: 도매(B2B 일반) | 소매(온라인몰) | 프로모션(행사 확보 — 종료 시 소매로 자동 합류) | 도매 대량(선결제 대량 발주 확보 — 자동 합류 없음). 도매·프로모션·도매 대량은 이동으로만 채운다';

-- 2) 생산 요청 용도 확장: 재고 보충/도매 납품/프로모션 → +도매 대량
alter table production_requests drop constraint if exists production_requests_purpose_check;
alter table production_requests add constraint production_requests_purpose_check
  check (purpose in ('재고 보충', '도매 납품', '프로모션', '도매 대량'));

comment on column production_requests.purpose is
  '생산 용도: 재고 보충(제조사) | 도매 납품(MD) | 프로모션(행사 확보) | 도매 대량(선결제 대량 발주 확보 — 소매→도매 대량 이동 배정으로 이행)';

-- 3) 대량 발주 표식 — 발송 차감이 어느 칸에서 뺄지 정하는 스위치(담당자가 발주 단위로 체크)
alter table orders add column if not exists is_bulk boolean not null default false;
comment on column orders.is_bulk is
  '대량 발주 여부(사람이 판단). true 면 발송 선점 출고가 도매 대량 칸에서 빠지고, 도매 일반 속도 집계에서도 제외된다';

-- 4) 확정형 요청서 ↔ 발주/거래처 연결
--  order_id : 요청서가 어느 발주의 몫인지. 발주가 지워져도 요청서는 남아야 한다(물건은 만들었을 수 있다)
--  company_id: 발주가 아직 시스템에 없을 때(영업이 구두 확보 당일 등록) 거래처만 채운다
alter table production_requests add column if not exists order_id uuid references orders(id) on delete set null;
alter table production_requests add column if not exists company_id uuid references companies(id) on delete set null;

-- 5) 열린 확정형 요청서를 목표일 순으로 훑는 조회용(재고 목록이 화면당 1회 스캔)
create index if not exists prod_req_purpose_due_idx
  on production_requests (purpose, due_date)
  where status in ('요청', '진행중');

-- 6) 대사 RPC 정본 재정의 — 110 본문 그대로에 sold_b2b 한 곳만 바꾼다.
--  대량 발주의 발송은 '도매 대량' 칸에서 빠지므로, 도매 칸 대사에서 그 판매를 빼야 재고 변동과 짝이 맞는다.
--  (재정의 전에 orders.is_bulk 가 있어야 하므로 3) 뒤에 온다)
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
  sold_b2b as ( -- 도매 = B2B 발송완료 차수 배정 수량(052). 115 부터 대량 발주는 제외 —
                --  대량 물량은 '도매 대량' 칸에서 빠지므로 도매 칸 대사에 넣으면 판매만 잡히고 재고 변동이 없어 어긋난다
    select oi.product_id, sum(si.qty) as sold
    from shipments sh
    join orders        o  on o.id = sh.order_id
    join shipment_items si on si.shipment_id = sh.id
    join order_items   oi on oi.id = si.order_item_id
    where sh.status = '발송완료'
      and sh.ship_date between p_from and p_to
      and oi.product_id is not null
      and coalesce(o.is_bulk, false) = false
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
