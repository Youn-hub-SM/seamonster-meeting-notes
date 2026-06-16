-- SKU 중복 허용: products.sku 의 UNIQUE 제약 제거.
--   같은 SKU 를 여러 제품에 입력할 수 있게 함.
--   조회 성능용 비유일(non-unique) 인덱스로 대체.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

-- 1) 유니크 제약 제거 ('sku text unique' 가 만든 제약명: products_sku_key)
alter table products drop constraint if exists products_sku_key;

-- 2) 일반 인덱스로 대체 (검색·매칭용, 중복 허용)
create index if not exists products_sku_idx on products (sku);

NOTIFY pgrst, 'reload schema';
