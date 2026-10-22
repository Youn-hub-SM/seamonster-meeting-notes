-- factory/007 수량 기준을 박스 → kg 으로 (2026-10-22 대표 지시: 원물 관리라 기준은 총 kg)
--
-- ■ 바뀌는 것
--   - stock_txns.kg(부호 있는 kg)가 수량이다. 현재고 = Σkg. 출고·조정은 소수점 kg(0.001 단위)도 된다.
--   - boxes·box_kg 는 입고 때 적은 참고 정보(박스 중량 × 박스 수)로만 남고 비워도 된다.
--   - 로트 = 품목 × 제조일자. 박스 중량은 더 이상 로트를 나누지 않는다(같은 제조일자 16kg·10kg 박스는 한 로트).
--   - 조정은 target_kg(실사 kg)로 — 차이만 기록. 옛 target(박스)은 남겨 두되 쓰지 않는다.
--   - 기존 기록은 kg = boxes × box_kg 로 채운다(취소된 기록 포함). 수량 합계는 전과 같다(박스 수 × 중량 = kg).
-- ■ 뷰 stock_lots 는 열이 바뀌어 drop 뒤 다시 만든다 — SQL Editor 가 '파괴적 작업' 확인 창을 띄우면 확인한다(데이터 삭제 아님).
-- ■ 적용 순서: 이 파일 적용 → 바로 운영 배포. 적용 전 새 코드는 "DB 준비 전" 안내를 띄우고, 적용 뒤 옛 코드는 저장이 막힌다 —
--   둘 사이 몇 분은 괜찮다. 멱등 — 재실행 안전.
-- ■ factory 번호열은 factory 스키마 밖(public)을 건드리지 않는다(CLAUDE.md §3a).

alter table factory.stock_txns add column if not exists kg numeric(14,3);
alter table factory.stock_txns add column if not exists target_kg numeric(14,3);
comment on column factory.stock_txns.kg is '수량(kg, 부호 있음: 입고 +, 출고 −, 조정 ±). 재고 = Σkg (007 부터 수량 기준)';
comment on column factory.stock_txns.target_kg is '조정만: 실사 kg(직전 = target_kg − kg)';
comment on column factory.stock_txns.boxes is '참고: 박스 수(입고 때 적은 값, 부호 있음). 007 부터 수량 기준이 아니다';
comment on column factory.stock_txns.box_kg is '참고: 박스 중량(kg). 007 부터 로트 구분에 쓰지 않는다';
comment on column factory.stock_txns.target is '옛 조정 실사 박스 수(007 전). 지금은 target_kg';

update factory.stock_txns set kg = boxes * box_kg where kg is null and boxes is not null and box_kg is not null;
update factory.stock_txns set target_kg = target * box_kg where target_kg is null and target is not null and box_kg is not null;

alter table factory.stock_txns alter column kg set not null;
alter table factory.stock_txns alter column box_kg drop not null;
alter table factory.stock_txns alter column boxes drop not null;
alter table factory.stock_txns drop constraint if exists factory_stock_txns_sign;
alter table factory.stock_txns drop constraint if exists factory_stock_txns_kg_sign;
alter table factory.stock_txns add constraint factory_stock_txns_kg_sign
  check (kg <> 0 and ((type = '입고' and kg > 0) or (type = '출고' and kg < 0) or type = '조정'));
create index if not exists factory_stock_txns_lot2_idx on factory.stock_txns (product_id, mfg_date);

-- ── 로트 잔량 뷰 — 품목 × 제조일자, kg ─────────────────────────────
-- live_in_date = 남은 kg 가 들어온 가장 오래된 입고일(먼저 들어온 것이 먼저 나간다고 보고, 최근 입고부터 거슬러
--   남은 양을 채우는 입고 중 가장 오래된 날). 005 의 로직을 kg 로 옮겼다.
drop view if exists factory.stock_lots;
create view factory.stock_lots as
with t as (
  select * from factory.stock_txns where cancelled_at is null
), agg as (
  select
    product_id, mfg_date,
    sum(kg) as kg,
    coalesce(sum(kg) filter (where type = '입고'), 0) as in_kg,
    coalesce(-sum(kg) filter (where type = '출고'), 0) as out_kg,
    coalesce(sum(kg) filter (where type = '조정'), 0) as adj_kg,
    min(txn_date) filter (where type = '입고') as first_in_date,
    max(txn_date) filter (where type = '입고') as last_in_date,
    min(txn_date) as first_txn_date
  from t
  group by product_id, mfg_date
), ins as (
  select product_id, mfg_date, txn_date, sum(kg) as k
  from t where type = '입고'
  group by product_id, mfg_date, txn_date
), cum as (
  select ins.*, sum(k) over (partition by product_id, mfg_date order by txn_date desc) as c
  from ins
)
select a.*,
  case when a.kg > 0 then (
    select min(x.txn_date) from cum x
    where x.product_id = a.product_id and x.mfg_date is not distinct from a.mfg_date
      and x.c - x.k < a.kg
  ) end as live_in_date
from agg a;
grant all on factory.stock_lots to service_role;

-- ── 기록 저장 — 품목 단위 잠금 안에서 잔량(kg) 확인 후 넣는다 ──────────
-- p_rows: [{product_id, type, txn_date, mfg_date, kg, box_kg, boxes, target_kg, partner, memo}]
--   입고·출고 = kg(양수). kg 가 없고 boxes·box_kg 가 있으면 곱해서 쓴다(옛 화면 호환).
--   조정 = target_kg(실사 kg, 0 이상) → 차이만 기록. 차이 0 인 줄은 건너뛴다. 옛 target(박스)도 box_kg 가 있으면 받는다.
--   boxes·box_kg 는 참고로 저장(입고 +, 출고 −).
-- p_batch: 화면이 만든 입력 번호. 이미 저장된 번호면 새로 넣지 않고 그 기록을 돌려준다.
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
      where t.product_id = r.product_id and t.mfg_date is not distinct from r.mfg_date and t.cancelled_at is null;
    select p.name into v_name from factory.products p where p.id = r.product_id;
    v_kg := coalesce(r.kg, case when r.boxes is not null and r.box_kg is not null then abs(r.boxes) * r.box_kg end);

    if r.type = '입고' then
      if coalesce(v_kg, 0) <= 0 then raise exception '입고 kg 을 입력하세요.' using errcode = 'P0001'; end if;
      v_delta := v_kg;
    elsif r.type = '출고' then
      if coalesce(v_kg, 0) <= 0 then raise exception '출고 kg 을 입력하세요.' using errcode = 'P0001'; end if;
      if v_bal < v_kg then
        raise exception '% (제조 %) 재고 %kg보다 많이 출고할 수 없습니다.',
          v_name, coalesce(to_char(r.mfg_date, 'YYYY-MM-DD'), '미상'), trim_scale(v_bal)
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

-- ── 기록 취소 — 지우지 않고 표시만. 이미 출고된 입고분은 취소할 수 없다 ──
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
      where x.product_id = t.product_id and x.mfg_date is not distinct from t.mfg_date and x.cancelled_at is null;
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

-- 확인: 전 기록의 kg 가 채워졌는지(둘 다 0 이면 정상)
select count(*) filter (where kg is null) as kg_missing,
       count(*) filter (where boxes is not null and box_kg is not null and kg <> boxes * box_kg) as kg_mismatch
from factory.stock_txns;
