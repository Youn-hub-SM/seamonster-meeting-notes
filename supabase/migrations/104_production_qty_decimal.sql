-- 104: 생산요청 수량 소수점 허용 (2026-09-03 대표 요청)
--  도매 생산요청 수량이 간혹 소수점(kg 단위 등)으로 필요 — integer 였던 요청수량·입고수량을
--  재고 원장(inventory_txns.qty, 080 numeric(14,2))과 같은 소수 둘째 자리로 확장한다.
--  기존 check(qty <> 0) 등 제약은 타입 변경 후에도 유지된다.
-- 적용: Supabase SQL Editor 에 붙여넣고 Run. 멱등(이미 numeric 이면 무해).

alter table production_request_items
  alter column requested_qty type numeric(12,2) using requested_qty::numeric(12,2);

alter table production_receipts
  alter column qty type numeric(12,2) using qty::numeric(12,2);

notify pgrst, 'reload schema';
