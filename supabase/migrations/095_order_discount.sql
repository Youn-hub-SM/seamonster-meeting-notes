-- 095: 발주 할인 — 할인금액과 사유를 발주 헤더에 기록하고 합계(total)에 반영한다.
--  적용: Supabase SQL Editor 에 전체 붙여넣고 Run. 멱등 — 재실행 안전.
--
-- 저장은 '확정 금액(원)'만 한다 — 화면에서 % 로 입력해도 저장 시 금액으로 환산된다
--  (율을 저장하면 라인 수정 때마다 합계가 따라 움직여 재현이 안 된다).
-- total 은 두 경로로 재계산된다:
--  · 라인(order_items) 변경 → recalc_order_totals (아래에서 할인 반영 버전으로 교체)
--  · 할인만 변경 → orders BEFORE 트리거(apply_order_discount)가 new.total 을 보정
--  두 트리거는 서로를 발화시키지 않는다(recalc 의 UPDATE 는 discount_amount 를 건드리지 않음).

alter table orders
  add column if not exists discount_amount numeric(14,2) not null default 0,  -- 할인금액(원, 부가세 포함 총액에서 차감)
  add column if not exists discount_reason text;                               -- 할인 사유

-- 라인 변경 시 재계산 — 002 버전에 할인 차감만 추가
create or replace function recalc_order_totals() returns trigger as $$
declare
  target_order_id uuid;
  s_total   numeric(14,2);
  s_taxable numeric(14,2);
  v         numeric(14,2);
begin
  target_order_id := coalesce(new.order_id, old.order_id);

  select coalesce(sum(line_total), 0) into s_total
    from order_items where order_id = target_order_id;

  select coalesce(sum(line_total), 0) into s_taxable
    from order_items where order_id = target_order_id and tax_type = 'taxable';

  v := round(s_taxable * 0.1, 0);

  update orders
     set subtotal = s_total,
         vat = v,
         total = s_total + v - coalesce(discount_amount, 0)
   where id = target_order_id;
  return null;
end;
$$ language plpgsql;

-- 할인(discount_amount)이 바뀔 때 total 보정 — BEFORE 라 재귀 없음.
--  recalc 의 UPDATE 는 discount_amount 를 SET 하지 않으므로 이 트리거를 발화시키지 않는다.
create or replace function apply_order_discount() returns trigger as $$
begin
  new.total := coalesce(new.subtotal, 0) + coalesce(new.vat, 0) - coalesce(new.discount_amount, 0);
  return new;
end;
$$ language plpgsql;

drop trigger if exists orders_discount_total on orders;
create trigger orders_discount_total
  before update of discount_amount on orders
  for each row execute function apply_order_discount();

NOTIFY pgrst, 'reload schema';
