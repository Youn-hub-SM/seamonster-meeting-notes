-- 093: 원가 변경 예약 — "n월 n일부터 이 원가" 를 미리 걸어두고 그날 자동 반영한다.
--
-- 배경: 인상일에 맞춰 사람이 원가를 고치고 입고를 잡는 건 현실적으로 놓치기 쉽다.
--  예약해 두면 그날 새벽 pg_cron 이 반영한다.
--
-- 설계: 반영이 순수 DB 작업(products UPDATE)이라 HTTP 호출·인증키·미들웨어 예외가 필요 없다.
--  pg_cron 이 함수를 직접 부른다 — 크론 키가 틀려 조용히 죽는 사고(§5 함정)를 아예 만들지 않는다.
--
-- 이력: products.cost_price 가 바뀌면 기존 트리거(log_cost_change)가 cost_history 에 자동 기록한다.
-- 과거 보호: 발주 라인은 등록 시점 원가를 order_items.cost_at_order 로 스냅샷하므로,
--  예약이 반영돼도 지난 발주의 이익률은 흔들리지 않는다.

create table if not exists product_cost_schedules (
  id             uuid primary key default gen_random_uuid(),
  product_id     uuid not null references products(id) on delete cascade,
  effective_date date not null,                      -- 이 날짜(KST)부터 적용
  -- 반영할 값. 상세(제품원가+포장재) 합이 0 보다 크면 cost_price 는 그 합으로 저장한다(앱 규칙과 동일).
  cost_material  numeric(12,2) not null default 0,
  pkg_inner      numeric(12,2) not null default 0,
  pkg_label      numeric(12,2) not null default 0,
  pkg_outer      numeric(12,2) not null default 0,
  cost_price     numeric(12,2) not null default 0,
  memo           text,
  applied_at     timestamptz,                        -- null = 대기, 값 있으면 반영 완료
  created_by     text,
  created_at     timestamptz not null default now()
);

create index if not exists cost_sched_pending_idx on product_cost_schedules (effective_date) where applied_at is null;
create index if not exists cost_sched_product_idx on product_cost_schedules (product_id, effective_date desc);

alter table product_cost_schedules enable row level security;

-- 반영 함수 — 오늘(KST) 이하의 대기 예약을 products 에 적용하고 '반영됨' 으로 표시한다.
--  · 같은 품목에 밀린 예약이 여러 건이면 가장 나중 날짜가 이긴다(중간 값을 거치지 않는다).
--  · 지난 날짜도 함께 처리 — 크론이 하루 걸러도 다음 실행에서 따라잡는다.
--  · 멱등: applied_at 이 찍힌 행은 다시 잡히지 않는다.
create or replace function apply_due_cost_schedules() returns integer
language plpgsql as $$
declare
  today_kst date := (now() at time zone 'Asia/Seoul')::date;
  changed int := 0;
begin
  with due as (
    select distinct on (product_id)
      product_id, cost_material, pkg_inner, pkg_label, pkg_outer, cost_price
    from product_cost_schedules
    where applied_at is null and effective_date <= today_kst
    order by product_id, effective_date desc, created_at desc
  )
  update products p set
    cost_material = d.cost_material,
    pkg_inner     = d.pkg_inner,
    pkg_label     = d.pkg_label,
    pkg_outer     = d.pkg_outer,
    cost_price    = case
                      when d.cost_material + d.pkg_inner + d.pkg_label + d.pkg_outer > 0
                      then d.cost_material + d.pkg_inner + d.pkg_label + d.pkg_outer
                      else d.cost_price
                    end
  from due d
  where p.id = d.product_id;
  get diagnostics changed = row_count;

  -- 밀려서 덮인 중간 예약들도 함께 소진 처리(다음 실행에서 되살아나지 않게)
  update product_cost_schedules
     set applied_at = now()
   where applied_at is null and effective_date <= today_kst;

  return changed;
end;
$$;

-- 매일 00:10 KST(= 15:10 UTC). pg_cron 스케줄은 UTC 기준이다.
create extension if not exists pg_cron;

do $$ begin perform cron.unschedule('product-cost-schedule-apply'); exception when others then null; end $$;

select cron.schedule('product-cost-schedule-apply', '10 15 * * *', $$ select apply_due_cost_schedules(); $$);

NOTIFY pgrst, 'reload schema';
