-- 면세/과세 분리 기능
-- 적용 방법: Supabase Dashboard > SQL Editor 에 전체 붙여넣고 Run.
-- 멱등성 — 이미 적용된 환경에서도 안전하게 재실행 가능.

-- ─────────────────────────────────────────────
-- 1) products.tax_type 추가 (과세/면세)
-- ─────────────────────────────────────────────
alter table products
  add column if not exists tax_type text not null default 'taxable'
    check (tax_type in ('taxable', 'exempt'));

-- ─────────────────────────────────────────────
-- 2) order_items.tax_type 스냅샷 컬럼 추가
--    제품의 tax_type 이 나중에 바뀌어도 기존 발주는 보존되도록 스냅샷.
-- ─────────────────────────────────────────────
alter table order_items
  add column if not exists tax_type text not null default 'taxable'
    check (tax_type in ('taxable', 'exempt'));

-- ─────────────────────────────────────────────
-- 3) 합계 재계산 트리거 — 면세 라인은 VAT 제외
--    기존 함수를 CREATE OR REPLACE 로 교체.
-- ─────────────────────────────────────────────
create or replace function recalc_order_totals() returns trigger as $$
declare
  target_order_id uuid;
  s_total   numeric(14,2);      -- 전체 라인 합 (소계)
  s_taxable numeric(14,2);      -- 과세 라인 합 (VAT 대상)
  v         numeric(14,2);
begin
  target_order_id := coalesce(new.order_id, old.order_id);

  select coalesce(sum(line_total), 0)
    into s_total
    from order_items
   where order_id = target_order_id;

  select coalesce(sum(line_total), 0)
    into s_taxable
    from order_items
   where order_id = target_order_id and tax_type = 'taxable';

  v := round(s_taxable * 0.1, 0);

  update orders
     set subtotal = s_total,
         vat = v,
         total = s_total + v
   where id = target_order_id;
  return null;
end;
$$ language plpgsql;

-- 트리거 자체는 그대로 — 함수만 교체.
