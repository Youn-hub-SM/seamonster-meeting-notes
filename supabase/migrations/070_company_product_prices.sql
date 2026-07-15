-- 070 거래처별 상품 단가 — B2B 발주 시 거래처(company)마다 다른 단가 적용.
--  · 품목은 복제하지 않고(상품마스터 1행 유지), '거래처×상품 단가 오버라이드'만 저장.
--  · 재고는 거래처별로 나누지 않음(재고 채널은 도매/소매 그대로).
--  · 발주 화면에서 거래처 선택 시 이 표의 단가로 자동 채움, 없으면 상품 기본 판매가.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

create table if not exists company_product_prices (
  company_id uuid not null references companies(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  unit_price numeric(12,2) not null default 0,   -- 이 거래처의 이 상품 발주 단가
  memo text,
  updated_at timestamptz not null default now(),
  primary key (company_id, product_id)
);
create index if not exists cpp_company_idx on company_product_prices (company_id);
create index if not exists cpp_product_idx on company_product_prices (product_id);

alter table company_product_prices enable row level security;

notify pgrst, 'reload schema';
