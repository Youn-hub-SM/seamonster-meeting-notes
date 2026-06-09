-- 발주 단위 이익률용: 발주별 배송 박스 수 (박스 단위 배송비 계산)
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table orders
  add column if not exists box_count int not null default 1;

NOTIFY pgrst, 'reload schema';
