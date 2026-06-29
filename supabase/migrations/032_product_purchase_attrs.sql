-- 상품 마스터 확장: 매입단가 + 원산지 + 속성(분류).
--  매입단가 = 구매 시 단가(외포장지 등 제외, 상품마다 다름). cost_price(제품단위원가)와 별개.
--  비고는 기존 notes 컬럼을 사용(화면에서 '비고'로 표기).
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table products
  add column if not exists purchase_price numeric(12,2) not null default 0,  -- 매입단가(구매 단가)
  add column if not exists origin text,                                       -- 원산지
  add column if not exists attrs  text;                                       -- 속성/분류(자유 입력)

NOTIFY pgrst, 'reload schema';
