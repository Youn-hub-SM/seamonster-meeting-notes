-- 상품 마스터 가격 정리: 소비자 판매가(retail_price) 추가.
--  기존 sale_price 는 'B2B 도매가(소비자가의 10% 할인가)' 로 의미 확정.
--  기존 행은 도매가로부터 소비자가를 역산해 백필: retail = round(sale_price / 0.9).
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table products add column if not exists retail_price numeric(12,2) not null default 0; -- 소비자 판매가

-- 최초 1회 백필(아직 소비자가가 비어있고 도매가가 있는 행만)
update products set retail_price = round(sale_price / 0.9)
  where retail_price = 0 and sale_price > 0;

NOTIFY pgrst, 'reload schema';
