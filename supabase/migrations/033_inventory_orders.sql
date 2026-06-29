-- 재고 입출고 묶음(주문) — 한 번에 입력한 라인들을 group_id + order_no(IN-/OUT- 일련번호)로 묶는다.
--  구매창/엑셀 일괄/단건 기록 모두 저장 시 같은 번호로 묶여 '주문 단위'로 조회 가능.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table inventory_txns add column if not exists group_id uuid;
alter table inventory_txns add column if not exists order_no text;
create index if not exists inv_txn_group_idx on inventory_txns (group_id);
create index if not exists inv_txn_orderno_idx on inventory_txns (order_no);

-- 유형별 일련번호(원자적). 입고=IN, 출고=OUT.
create sequence if not exists inv_order_in_seq;
create sequence if not exists inv_order_out_seq;

create or replace function next_inventory_order_no(p_type text) returns text
language sql volatile as $$
  select (case when p_type = '출고' then 'OUT-' else 'IN-' end)
    || lpad(nextval((case when p_type = '출고' then 'inv_order_out_seq' else 'inv_order_in_seq' end)::regclass)::text, 6, '0');
$$;

NOTIFY pgrst, 'reload schema';
