-- 분할 발송: 한 발주에 발송 일정 여러 개 + 발송별 상품/수량
-- 적용: Supabase Dashboard > SQL Editor 에 전체 붙여넣고 Run.
-- 멱등 — 재실행 안전.

-- ─────────────────────────────────────────────
-- 1) shipments 확장: 발송예정일 + 상태 + 순번
-- ─────────────────────────────────────────────
alter table shipments
  add column if not exists ship_date date,
  add column if not exists status text not null default '발송대기'
    check (status in ('발송대기', '발송중', '발송완료', '취소')),
  add column if not exists seq int not null default 1;

-- 기존 단일 송장 데이터 호환: shipped_at 이 있으면 발송완료로 간주
update shipments set status = '발송완료'
  where shipped_at is not null and status = '발송대기';

create index if not exists shipments_ship_date_idx on shipments (ship_date);
create index if not exists shipments_status_idx on shipments (status);

-- ─────────────────────────────────────────────
-- 2) shipment_items: 각 발송 일정에 담길 상품/수량 (정밀 분할)
-- ─────────────────────────────────────────────
create table if not exists shipment_items (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references shipments(id) on delete cascade,
  order_item_id uuid references order_items(id) on delete set null,
  product_name text not null,   -- 스냅샷
  spec text,                    -- 옵션 스냅샷
  qty numeric(12,3) not null,
  created_at timestamptz not null default now()
);

create index if not exists shipment_items_shipment_id_idx on shipment_items (shipment_id);
create index if not exists shipment_items_order_item_id_idx on shipment_items (order_item_id);

alter table shipment_items enable row level security;

NOTIFY pgrst, 'reload schema';
