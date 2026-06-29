-- 재고 입출고 상태: 대기 / 완료. 즉시입고/즉시출고 미체크 시 '대기'로 기록되고, 현재고에 반영 안 됨.
--  '입고처리/출고처리' 로 완료 전환 시 재고 반영. 현재고(inventory_stock)는 '완료'만 집계.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table inventory_txns add column if not exists status text not null default '완료'
  check (status in ('대기', '완료'));
create index if not exists inv_txn_status_idx on inventory_txns (status);

-- 현재고/과거수량 = '완료' 건만 합산.
create or replace function inventory_stock(asof date default null)
returns table (product_id uuid, qty bigint)
language sql stable as $$
  select t.product_id, coalesce(sum(t.qty), 0)::bigint
  from inventory_txns t
  where t.status = '완료' and (asof is null or t.txn_date <= asof)
  group by t.product_id
$$;

NOTIFY pgrst, 'reload schema';
