-- 재고관리 — 자체 재고 원장(박스히어로 대체).
--  품목은 products(상품 마스터)를 그대로 사용. 현재고 = inventory_txns.qty 합.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

-- 재고 원장: 입고(+)/출고(-)/조정(±) 한 줄씩. 현재고 = Σqty, 과거수량 = 특정일까지 Σqty.
create table if not exists inventory_txns (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  type text not null check (type in ('입고', '출고', '조정')),  -- 입고=매입, 출고=판매/소진, 조정=실사보정
  qty integer not null,                       -- 부호 있는 재고 변화량(입고+, 출고-, 조정±)
  unit_amount numeric(12,2),                  -- 입고=매입단가, 출고=판매단가(선택)
  txn_date date not null default current_date,-- 거래일(과거수량 산정 기준)
  partner text,                               -- 매입처/판매처(선택)
  memo text,                                  -- 사유/메모
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists inv_txn_product_idx on inventory_txns (product_id);
create index if not exists inv_txn_date_idx on inventory_txns (txn_date desc);
create index if not exists inv_txn_type_idx on inventory_txns (type);

-- 품목별 재고 설정(안전재고 등). 행이 없으면 min_qty=0 으로 간주.
create table if not exists inventory_items (
  product_id uuid primary key references products(id) on delete cascade,
  min_qty integer not null default 0,         -- 재고부족 기준(안전재고)
  barcode text,
  location text,                              -- 보관 위치
  memo text,
  updated_at timestamptz not null default now()
);

alter table inventory_txns enable row level security;
alter table inventory_items enable row level security;

-- 현재고/과거수량 집계(품목당 1행) — 클라이언트의 1000행 제한과 무관하게 정확히 합산.
--  asof 지정 시 그 날짜까지 누적. 서비스롤 rpc 로 호출.
create or replace function inventory_stock(asof date default null)
returns table (product_id uuid, qty bigint)
language sql stable as $$
  select t.product_id, coalesce(sum(t.qty), 0)::bigint
  from inventory_txns t
  where asof is null or t.txn_date <= asof
  group by t.product_id
$$;

NOTIFY pgrst, 'reload schema';
