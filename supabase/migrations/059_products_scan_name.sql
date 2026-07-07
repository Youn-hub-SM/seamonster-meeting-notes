-- 059_products_scan_name.sql
-- 상품마스터에 '송장 스캔 표시명'(scan_name) 추가.
--  송장 스캔 피킹 리스트 출력에 나오는 상품명을 코드(SKU)별로 지정. 비어있으면 products.name 을 사용.
--  (택배 발주서 품목명 courier_name 과는 별개 — 창고 피킹용 짧은 이름을 따로 둘 수 있게.)
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table products add column if not exists scan_name text;

NOTIFY pgrst, 'reload schema';
