-- 발주번호 채번 버그 수정.
-- 기존 count(*)+1 방식의 문제:
--   1) 같은 날짜 발주를 삭제한 뒤 새로 등록하면 기존 번호와 충돌 (unique 위반 → 등록 실패)
--   2) 두 명이 동시에 등록하면 같은 번호가 발번되어 한쪽이 실패
-- 수정: max(기존 번호)+1 + 날짜별 advisory lock 으로 직렬화.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

create or replace function gen_order_no() returns trigger as $$
declare
  d text := to_char(new.order_date, 'YYYYMMDD');
  n int;
begin
  if new.order_no is null or new.order_no = '' then
    -- 같은 날짜의 발번을 트랜잭션 단위로 직렬화 (동시 등록 충돌 방지)
    perform pg_advisory_xact_lock(hashtext('b2b_order_no_' || d));
    select coalesce(max(nullif(split_part(order_no, '-', 2), '')::int), 0) + 1
      into n
      from orders
     where order_no like d || '-%';
    new.order_no := d || '-' || lpad(n::text, 3, '0');
  end if;
  return new;
end;
$$ language plpgsql;

NOTIFY pgrst, 'reload schema';
