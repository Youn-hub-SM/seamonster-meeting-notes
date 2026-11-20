-- factory/011 기록에 구분·보관처·단가·이동 (2026-11-20 대표 지시, 기획 docs/factory-ledger-export-plan.md)
--
-- ■ 입고·출고에 구분을 붙인다: 입고 = 매입·생산·반품, 출고 = 매출·현장투입. 창고 사이 이동은 '출고(이동) + 입고(이동)' 두 줄을
--   같은 move_id 로 묶는다. 구분이 빈 옛 기록은 추출할 때 입고 = 생산, 출고 = 매출로 본다(대표 확정).
-- ■ 보관처(storage)가 로트를 나눈다: 로트 = 품목 × 제조일자 × 박스 중량 × 보관처. 옛 기록은 전부 '구평창고1층'.
-- ■ 단가(unit_price)는 kg당 원. 매입·매출·반품 기록에 적는다(모든 계정).
-- ■ 재고 계산은 그대로다. 이동은 보관처만 바꾸므로 품목 합계의 누적 입고·출고에는 넣지 않는다(뷰가 뺀다).
-- ■ 바뀌는 것: stock_txns 열 4개, stock_lots 뷰(storage 열), post_stock_txns·cancel_stock_txn(보관처까지 맞춰 잔량 확인, 이동은 함께 취소).
-- ■ 뷰는 drop 뒤 다시 만든다 — '파괴적 작업' 확인 창은 확인(데이터 삭제 아님). 멱등 — 재실행 안전.
-- ■ 적용 전·후 어느 쪽에서도 지금 화면이 돈다(새 칸을 안 보내면 구분 없음·구평창고1층으로 저장). public 은 건드리지 않는다.
--
-- 적용: 이 파일의 **내용 전체**를 Supabase Dashboard > SQL Editor 새 쿼리 창에 붙여넣고 Run(선택 영역 없이).

alter table factory.stock_txns add column if not exists kind text;
alter table factory.stock_txns add column if not exists storage text not null default '구평창고1층';
alter table factory.stock_txns add column if not exists unit_price numeric(14,2);
alter table factory.stock_txns add column if not exists move_id uuid;

comment on column factory.stock_txns.kind is '구분 — 입고: 매입·생산·반품·이동 / 출고: 매출·현장투입·이동. 비어 있으면 옛 기록(입고 = 생산, 출고 = 매출로 본다)';
comment on column factory.stock_txns.storage is '보관처(창고). 로트를 나눈다. 기본 구평창고1층';
comment on column factory.stock_txns.unit_price is 'kg당 단가(원). 매입·매출·반품에 적는다';
comment on column factory.stock_txns.move_id is '창고 사이 이동의 짝 번호 — 나간 줄(출고)과 들어온 줄(입고)이 같은 값';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'factory_stock_txns_kind_chk') then
    alter table factory.stock_txns add constraint factory_stock_txns_kind_chk check (
      kind is null
      or (type = '입고' and kind in ('매입', '생산', '반품', '이동'))
      or (type = '출고' and kind in ('매출', '현장투입', '이동')));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'factory_stock_txns_price_chk') then
    alter table factory.stock_txns add constraint factory_stock_txns_price_chk check (unit_price is null or unit_price >= 0);
  end if;
end $$;

create index if not exists factory_stock_txns_lot4_idx on factory.stock_txns (product_id, mfg_date, box_kg, storage);
create index if not exists factory_stock_txns_move_idx on factory.stock_txns (move_id) where move_id is not null;

-- ── 로트 뷰 — 보관처까지 나눈다. 누적 입고·출고에서 이동은 뺀다(품목 합계가 부풀지 않게) ──
drop view if exists factory.stock_lots;
create view factory.stock_lots as
with t as (
  select * from factory.stock_txns where cancelled_at is null
), agg as (
  select
    product_id, mfg_date, box_kg, storage,
    sum(kg) as kg,
    coalesce(sum(kg) filter (where type = '입고' and kind is distinct from '이동'), 0) as in_kg,
    coalesce(-sum(kg) filter (where type = '출고' and kind is distinct from '이동'), 0) as out_kg,
    coalesce(sum(kg) filter (where type = '조정'), 0) as adj_kg,
    min(txn_date) filter (where type = '입고') as first_in_date,
    max(txn_date) filter (where type = '입고') as last_in_date,
    min(txn_date) as first_txn_date
  from t
  group by product_id, mfg_date, box_kg, storage
), ins as (
  select product_id, mfg_date, box_kg, storage, txn_date, sum(kg) as k
  from t where type = '입고'
  group by product_id, mfg_date, box_kg, storage, txn_date
), cum as (
  select ins.*, sum(k) over (partition by product_id, mfg_date, box_kg, storage order by txn_date desc) as c
  from ins
)
select a.*,
  case when a.kg > 0 then (
    select min(x.txn_date) from cum x
    where x.product_id = a.product_id and x.mfg_date is not distinct from a.mfg_date and x.box_kg is not distinct from a.box_kg
      and x.storage = a.storage and x.c - x.k < a.kg
  ) end as live_in_date
from agg a;
grant all on factory.stock_lots to service_role;

-- ── 기록 저장 — 로트(품목 × 제조일자 × 박스 중량 × 보관처) 잔량(kg) 확인 후 넣는다 ──
--  p_rows 한 줄에 kind·storage·unit_price·move_id 를 더 받는다(없으면 구분 없음·구평창고1층).
--  이동은 화면(API)이 '출고(이동) 줄 + 입고(이동) 줄'로 풀어 같은 move_id 로 보낸다 — 나간 줄이 먼저 와야 한다.
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
  v_storage text;
  v_kind text;
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
      kg numeric, box_kg numeric, boxes integer, target_kg numeric, target integer, partner text, memo text, tape_color text,
      kind text, storage text, unit_price numeric, move_id uuid)
  loop
    v_storage := coalesce(nullif(trim(r.storage), ''), '구평창고1층');
    v_kind := nullif(trim(r.kind), '');
    select coalesce(sum(t.kg), 0) into v_bal from factory.stock_txns t
      where t.product_id = r.product_id and t.mfg_date is not distinct from r.mfg_date
        and t.box_kg is not distinct from r.box_kg and t.storage = v_storage and t.cancelled_at is null;
    select p.name into v_name from factory.products p where p.id = r.product_id;
    v_kg := coalesce(r.kg, case when r.boxes is not null and r.box_kg is not null then abs(r.boxes) * r.box_kg end);

    if r.type = '입고' then
      if coalesce(v_kg, 0) <= 0 then raise exception '입고 kg 을 입력하세요.' using errcode = 'P0001'; end if;
      if v_kind is not null and v_kind not in ('매입', '생산', '반품', '이동') then raise exception '구분이 올바르지 않습니다: %', v_kind using errcode = 'P0001'; end if;
      v_delta := v_kg;
    elsif r.type = '출고' then
      if coalesce(v_kg, 0) <= 0 then raise exception '출고 kg 을 입력하세요.' using errcode = 'P0001'; end if;
      if v_kind is not null and v_kind not in ('매출', '현장투입', '이동') then raise exception '구분이 올바르지 않습니다: %', v_kind using errcode = 'P0001'; end if;
      if v_bal < v_kg then
        raise exception '%', format('%s (제조 %s%s%s) 재고 %skg보다 많이 출고할 수 없습니다.',
          v_name, coalesce(to_char(r.mfg_date, 'YYYY-MM-DD'), '미상'),
          case when r.box_kg is not null then ' · ' || trim_scale(r.box_kg) || 'kg박스' else '' end,
          case when v_storage <> '구평창고1층' then ' · ' || v_storage else '' end, trim_scale(v_bal))
          using errcode = 'P0001';
      end if;
      v_delta := -v_kg;
    elsif r.type = '조정' then
      v_kind := null;
      v_target := coalesce(r.target_kg, case when r.target is not null and r.box_kg is not null then r.target * r.box_kg end);
      if v_target is null or v_target < 0 then raise exception '실사 kg 을 0 이상으로 입력하세요.' using errcode = 'P0001'; end if;
      v_delta := v_target - v_bal;
      if v_delta = 0 then continue; end if;
    else
      raise exception '유형이 올바르지 않습니다: %', r.type using errcode = 'P0001';
    end if;

    insert into factory.stock_txns (batch_id, product_id, txn_date, type, mfg_date, kg, box_kg, boxes, target_kg, partner, memo, tape_color,
      kind, storage, unit_price, move_id, created_by)
    values (v_batch, r.product_id, r.txn_date, r.type, r.mfg_date, v_delta, r.box_kg,
      case when r.boxes is null then null when r.type = '출고' then -abs(r.boxes) when r.type = '입고' then abs(r.boxes) else r.boxes end,
      case when r.type = '조정' then v_target end, r.partner, r.memo, nullif(trim(r.tape_color), ''),
      v_kind, v_storage, case when r.type = '조정' then null else r.unit_price end, case when v_kind = '이동' then r.move_id end, p_actor)
    returning * into v_out;
    return next v_out;
  end loop;
  return;
end;
$$;

-- ── 기록 취소 — 같은 로트(보관처까지) 잔량으로 판정. 이동은 나간 줄·들어온 줄을 함께 취소한다 ──
create or replace function factory.cancel_stock_txn(p_id uuid, p_actor text)
returns factory.stock_txns
language plpgsql
set search_path = factory, pg_temp
as $$
declare
  t factory.stock_txns;
  s factory.stock_txns;
  v_bal numeric;
begin
  select * into t from factory.stock_txns where id = p_id;
  if not found then raise exception '기록을 찾을 수 없습니다.' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('factory.stock:' || t.product_id::text, 0));
  select * into t from factory.stock_txns where id = p_id for update;
  if t.cancelled_at is not null then raise exception '이미 취소된 기록입니다.' using errcode = 'P0001'; end if;

  for s in
    select * from factory.stock_txns x
    where x.cancelled_at is null and (x.id = p_id or (t.move_id is not null and x.move_id = t.move_id))
    for update
  loop
    if s.kg > 0 then
      select coalesce(sum(x.kg), 0) into v_bal from factory.stock_txns x
        where x.product_id = s.product_id and x.mfg_date is not distinct from s.mfg_date
          and x.box_kg is not distinct from s.box_kg and x.storage = s.storage and x.cancelled_at is null;
      if v_bal - s.kg < 0 then
        raise exception '취소하면 재고가 %kg가 됩니다 — 이 로트의 출고 기록을 먼저 취소하세요.', trim_scale(v_bal - s.kg)
          using errcode = 'P0001';
      end if;
    end if;
  end loop;

  update factory.stock_txns set cancelled_at = now(), cancelled_by = p_actor
    where cancelled_at is null and (id = p_id or (t.move_id is not null and move_id = t.move_id));
  select * into t from factory.stock_txns where id = p_id;
  return t;
end;
$$;

revoke execute on function factory.post_stock_txns(jsonb, text, uuid) from public;
revoke execute on function factory.cancel_stock_txn(uuid, text) from public;
grant execute on function factory.post_stock_txns(jsonb, text, uuid) to service_role;
grant execute on function factory.cancel_stock_txn(uuid, text) to service_role;

notify pgrst, 'reload schema';

-- 확인: 열 4개가 생겼으면 4, 로트 수와 kg 합은 적용 전과 같아야 한다
select
  (select count(*) from information_schema.columns where table_schema = 'factory' and table_name = 'stock_txns'
     and column_name in ('kind', 'storage', 'unit_price', 'move_id')) as new_columns,
  (select count(*) from factory.stock_lots) as lots,
  (select trim_scale(coalesce(sum(kg), 0)) from factory.stock_lots) as total_kg;
