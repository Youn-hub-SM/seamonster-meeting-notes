-- factory/008 로트에 박스 중량을 다시 붙인다 — 기준은 kg, 박스 수는 kg ÷ 박스 중량으로 보인다 (2026-10-22 대표: "박스가 보이면서 기준은 kg")
--
-- ■ 007 에서 로트를 품목 × 제조일자로 합쳤더니 박스 수를 보여 줄 수 없었다. 로트 = 품목 × 제조일자 × 박스 중량으로 되돌리되
--   수량 기준은 kg 그대로다. 박스 수 = Σkg ÷ 박스 중량(소수 가능: 21.25박스). 박스 중량이 없는 로트는 kg 만 보인다.
-- ■ 바뀌는 것: stock_lots 뷰(box_kg 열 복귀), post_stock_txns·cancel_stock_txn 의 잔량 계산이 box_kg 까지 맞춘다. 표·열은 그대로.
-- ■ 뷰는 drop 뒤 다시 만든다 — '파괴적 작업' 확인 창은 확인(데이터 삭제 아님). 멱등 — 재실행 안전.
-- ■ 적용 순서: 007 → 008 → 배포. factory 스키마 밖(public)은 건드리지 않는다.

create index if not exists factory_stock_txns_lot3_idx on factory.stock_txns (product_id, mfg_date, box_kg);

drop view if exists factory.stock_lots;
create view factory.stock_lots as
with t as (
  select * from factory.stock_txns where cancelled_at is null
), agg as (
  select
    product_id, mfg_date, box_kg,
    sum(kg) as kg,
    coalesce(sum(kg) filter (where type = '입고'), 0) as in_kg,
    coalesce(-sum(kg) filter (where type = '출고'), 0) as out_kg,
    coalesce(sum(kg) filter (where type = '조정'), 0) as adj_kg,
    min(txn_date) filter (where type = '입고') as first_in_date,
    max(txn_date) filter (where type = '입고') as last_in_date,
    min(txn_date) as first_txn_date
  from t
  group by product_id, mfg_date, box_kg
), ins as (
  select product_id, mfg_date, box_kg, txn_date, sum(kg) as k
  from t where type = '입고'
  group by product_id, mfg_date, box_kg, txn_date
), cum as (
  select ins.*, sum(k) over (partition by product_id, mfg_date, box_kg order by txn_date desc) as c
  from ins
)
select a.*,
  case when a.kg > 0 then (
    select min(x.txn_date) from cum x
    where x.product_id = a.product_id and x.mfg_date is not distinct from a.mfg_date and x.box_kg is not distinct from a.box_kg
      and x.c - x.k < a.kg
  ) end as live_in_date
from agg a;
grant all on factory.stock_lots to service_role;

-- ── 기록 저장 — 로트(품목 × 제조일자 × 박스 중량) 잔량(kg) 확인 후 넣는다 ──────────
create or replace function factory.post_stock_txns(p_rows jsonb, p_actor text, p_batch uuid)
returns setof factory.stock_txns
language plpgsql
set search_path = factory, pg_temp
as $$
declare
  v_batch uuid := coalesce(p_batch, gen_random_uuid());
  r record;
  v_bal numeric;
  v_kg numeric;
  v_target numeric;
  v_delta numeric;
  v_name text;
  v_out factory.stock_txns;
begin
  perform pg_advisory_xact_lock(hashtextextended('factory.stock:' || s.pid, 0))
    from (select distinct (e->>'product_id')::uuid::text as pid from jsonb_array_elements(p_rows) e order by 1) s;

  if exists (select 1 from factory.stock_txns where batch_id = v_batch) then
    return query select * from factory.stock_txns where batch_id = v_batch order by created_at;
    return;
  end if;

  for r in
    select * from jsonb_to_recordset(p_rows) as x(
      product_id uuid, type text, txn_date date, mfg_date date,
      kg numeric, box_kg numeric, boxes integer, target_kg numeric, target integer, partner text, memo text)
  loop
    select coalesce(sum(t.kg), 0) into v_bal from factory.stock_txns t
      where t.product_id = r.product_id and t.mfg_date is not distinct from r.mfg_date
        and t.box_kg is not distinct from r.box_kg and t.cancelled_at is null;
    select p.name into v_name from factory.products p where p.id = r.product_id;
    v_kg := coalesce(r.kg, case when r.boxes is not null and r.box_kg is not null then abs(r.boxes) * r.box_kg end);

    if r.type = '입고' then
      if coalesce(v_kg, 0) <= 0 then raise exception '입고 kg 을 입력하세요.' using errcode = 'P0001'; end if;
      v_delta := v_kg;
    elsif r.type = '출고' then
      if coalesce(v_kg, 0) <= 0 then raise exception '출고 kg 을 입력하세요.' using errcode = 'P0001'; end if;
      if v_bal < v_kg then
        raise exception '% (제조 %%) 재고 %kg보다 많이 출고할 수 없습니다.',
          v_name, coalesce(to_char(r.mfg_date, 'YYYY-MM-DD'), '미상'),
          case when r.box_kg is not null then ' · ' || trim_scale(r.box_kg) || 'kg박스' else '' end, trim_scale(v_bal)
          using errcode = 'P0001';
      end if;
      v_delta := -v_kg;
    elsif r.type = '조정' then
      v_target := coalesce(r.target_kg, case when r.target is not null and r.box_kg is not null then r.target * r.box_kg end);
      if v_target is null or v_target < 0 then raise exception '실사 kg 을 0 이상으로 입력하세요.' using errcode = 'P0001'; end if;
      v_delta := v_target - v_bal;
      if v_delta = 0 then continue; end if;
    else
      raise exception '유형이 올바르지 않습니다: %', r.type using errcode = 'P0001';
    end if;

    insert into factory.stock_txns (batch_id, product_id, txn_date, type, mfg_date, kg, box_kg, boxes, target_kg, partner, memo, created_by)
    values (v_batch, r.product_id, r.txn_date, r.type, r.mfg_date, v_delta, r.box_kg,
      case when r.boxes is null then null when r.type = '출고' then -abs(r.boxes) when r.type = '입고' then abs(r.boxes) else r.boxes end,
      case when r.type = '조정' then v_target end, r.partner, r.memo, p_actor)
    returning * into v_out;
    return next v_out;
  end loop;
  return;
end;
$$;

-- ── 기록 취소 — 같은 로트(박스 중량까지) 잔량으로 판정 ──
create or replace function factory.cancel_stock_txn(p_id uuid, p_actor text)
returns factory.stock_txns
language plpgsql
set search_path = factory, pg_temp
as $$
declare
  t factory.stock_txns;
  v_bal numeric;
begin
  select * into t from factory.stock_txns where id = p_id;
  if not found then raise exception '기록을 찾을 수 없습니다.' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('factory.stock:' || t.product_id::text, 0));
  select * into t from factory.stock_txns where id = p_id for update;
  if t.cancelled_at is not null then raise exception '이미 취소된 기록입니다.' using errcode = 'P0001'; end if;
  if t.kg > 0 then
    select coalesce(sum(x.kg), 0) into v_bal from factory.stock_txns x
      where x.product_id = t.product_id and x.mfg_date is not distinct from t.mfg_date
        and x.box_kg is not distinct from t.box_kg and x.cancelled_at is null;
    if v_bal - t.kg < 0 then
      raise exception '취소하면 재고가 %kg가 됩니다 — 이 로트의 출고 기록을 먼저 취소하세요.', trim_scale(v_bal - t.kg)
        using errcode = 'P0001';
    end if;
  end if;
  update factory.stock_txns set cancelled_at = now(), cancelled_by = p_actor where id = p_id returning * into t;
  return t;
end;
$$;

revoke execute on function factory.post_stock_txns(jsonb, text, uuid) from public;
revoke execute on function factory.cancel_stock_txn(uuid, text) from public;
grant execute on function factory.post_stock_txns(jsonb, text, uuid) to service_role;
grant execute on function factory.cancel_stock_txn(uuid, text) to service_role;

notify pgrst, 'reload schema';

-- 확인: 로트 수(품목×제조일자×박스중량)와 kg 합
select count(*) as lots, trim_scale(coalesce(sum(kg), 0)) as total_kg from factory.stock_lots;
