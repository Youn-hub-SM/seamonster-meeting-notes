-- 037_product_bundles.sql
-- 묶음(세트) 제품 — 특정 상품(부모 SKU)을 여러 구성품(자식 상품 × 수량)으로 분해 인식.
--  예) SET-DG-100 = DG-100-O-100 × n + AG-100-K-100 × m.
--  묶음 부모는 자체 재고를 갖지 않고, 판매/구매(출고/입고) 시 구성품으로 분해되어 기록된다.
--  묶음 가용재고 = min( 구성품 현재고 ÷ 구성수량 ) — 만들 수 있는 세트 수.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

create table if not exists product_bundles (
  parent_id uuid not null references products(id) on delete cascade,   -- 묶음(세트) 상품
  component_id uuid not null references products(id) on delete cascade, -- 구성품
  qty integer not null default 1 check (qty > 0),                       -- 세트 1개당 구성품 수량
  primary key (parent_id, component_id)
);
create index if not exists product_bundles_parent_idx on product_bundles (parent_id);
create index if not exists product_bundles_component_idx on product_bundles (component_id);

alter table product_bundles enable row level security;

NOTIFY pgrst, 'reload schema';
