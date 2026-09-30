-- factory/005 파도소리 재고 새 구조 (2026-09-30 대표 지시) — 품목 마스터 + 박스 원장
--
-- ■ 바뀌는 것
--   이전: 로트(창고·규격·테잎색·원산지…) 단위 원장(001 lots / lot_txns). 화면·API 에서 더 이상 쓰지 않는다.
--   이후: 품목 마스터(products) 1행 = SKU 1개. 재고는 박스 원장(stock_txns)의 합계.
--         같은 품목 안에서 [제조일자 × 박스 중량] 이 다르면 따로 센다(= 로트) — 16kg 3박스 · 10kg 2박스 · 총 68kg.
--   수량 단위는 박스(정수)로 통일. 중량(kg)은 박스 수 × 박스 중량으로 나온다.
--
-- ■ 기록은 지우지 않는다
--   취소 = cancelled_at/by 를 채우는 것(합계에서 빠지고 히스토리에 남는다).
--   조정 = '조정' 거래 한 줄(실사 수량 − 현재 수량, 실사 수량도 target 에 남긴다).
--   품목 등록·수정(원가·판매가 포함)은 트리거가 같은 트랜잭션에서 product_changes 에 남긴다 — 이력 누락이 없다.
--
-- ■ 옛 테이블(warehouses·lots·lot_txns·lot_stock, 004 백업)은 지우지 않고 그대로 둔다 — 새 화면은 읽지 않는다.
-- ■ factory 스키마 밖(public)은 건드리지 않는다(CLAUDE.md §3a).
--
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

-- ── 품목 마스터 ─────────────────────────────────────────────────────
create table if not exists factory.products (
  id uuid primary key default gen_random_uuid(),
  sku text not null,
  name text not null,                              -- 품목
  origin text,                                     -- 원산지
  note text,                                       -- 비고
  cost numeric(14,0) check (cost is null or cost >= 0),    -- 제품원가(원)
  price numeric(14,0) check (price is null or price >= 0), -- 판매가(원)
  stock_tracked boolean not null default true,     -- false = 재고관리 사용안함(재고 화면·입출고 대상에서 빠진다)
  created_by text,
  updated_by text,                                 -- 마지막 수정자 — 변경 이력 트리거가 '누가'로 쓴다
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists factory_products_sku_uq on factory.products (upper(sku));

-- ── 박스 원장 ───────────────────────────────────────────────────────
-- boxes 는 부호 있는 박스 수: 입고 +, 출고 −, 조정 ±. 현재고 = 취소 안 된 행의 합.
-- batch_id = 한 번에 저장한 여러 줄 묶음(입력 1회). 화면이 만들어 보내므로 다시 눌러도 두 번 기록되지 않는다.
create table if not exists factory.stock_txns (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null,
  product_id uuid not null references factory.products(id),
  txn_date date not null,
  type text not null check (type in ('입고', '출고', '조정')),
  mfg_date date,                                   -- 제조일자(모르면 비움)
  box_kg numeric(8,2) not null check (box_kg > 0), -- 박스 중량(kg)
  boxes integer not null check (boxes <> 0),
  target integer,                                  -- 조정만: 실사 박스 수(직전 수량 = target − boxes)
  partner text,                                    -- 입고처·출고처
  memo text,
  created_by text,
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by text,
  constraint factory_stock_txns_sign check ((type = '입고' and boxes > 0) or (type = '출고' and boxes < 0) or type = '조정')
);
create index if not exists factory_stock_txns_lot_idx on factory.stock_txns (product_id, mfg_date, box_kg);
create index if not exists factory_stock_txns_date_idx on factory.stock_txns (txn_date desc, created_at desc);
create index if not exists factory_stock_txns_created_idx on factory.stock_txns (created_at desc);
create index if not exists factory_stock_txns_batch_idx on factory.stock_txns (batch_id);
create index if not exists factory_stock_txns_cancel_idx on factory.stock_txns (cancelled_at) where cancelled_at is not null;

-- ── 품목 변경 이력(등록·수정·원가·판매가·삭제) ─────────────────────
-- 품목을 지워도 이력은 남도록 sku·name 을 함께 적어 둔다.
create table if not exists factory.product_changes (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references factory.products(id) on delete set null,
  sku text,
  name text,
  field text not null,          -- 등록·삭제·sku·name·origin·note·cost·price·stock_tracked
  old_value text,
  new_value text,
  changed_by text,
  changed_at timestamptz not null default now()
);
create index if not exists factory_product_changes_at_idx on factory.product_changes (changed_at desc);

-- 등록·수정 → 이력. 수정은 실제로 바뀐 칸만(동시 수정이어도 OLD 가 실제 직전 값이라 이력이 이어진다).
create or replace function factory.log_product_change()
returns trigger
language plpgsql
set search_path = factory, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    insert into factory.product_changes (product_id, sku, name, field, new_value, changed_by)
    values (new.id, new.sku, new.name, '등록',
      nullif(concat_ws(' · ',
        case when new.cost is not null then '원가 ' || to_char(new.cost, 'FM999,999,999,999') || '원' end,
        case when new.price is not null then '판매가 ' || to_char(new.price, 'FM999,999,999,999') || '원' end), ''),
      new.created_by);
    return new;
  end if;
  insert into factory.product_changes (product_id, sku, name, field, old_value, new_value, changed_by)
  select new.id, new.sku, new.name, v.f, v.o, v.n, new.updated_by
  from (values
    ('sku', old.sku, new.sku),
    ('name', old.name, new.name),
    ('origin', old.origin, new.origin),
    ('note', old.note, new.note),
    ('cost', old.cost::text, new.cost::text),
    ('price', old.price::text, new.price::text),
    ('stock_tracked', case when old.stock_tracked then '사용' else '사용안함' end, case when new.stock_tracked then '사용' else '사용안함' end)
  ) as v(f, o, n)
  where v.o is distinct from v.n;
  return new;
end;
$$;
drop trigger if exists factory_products_log on factory.products;
create trigger factory_products_log after insert or update on factory.products
  for each row execute function factory.log_product_change();

-- ── 로트 잔량 뷰 — 품목 × 제조일자 × 박스 중량 ─────────────────────
-- live_in_date = 남은 박스가 들어온 가장 오래된 입고일(먼저 들어온 것이 먼저 나간다고 보고,
--   최근 입고부터 거슬러 남은 수량을 채우는 입고 중 가장 오래된 날). 한 로트에 입고·소진·재입고가 반복돼도 맞다.
create or replace view factory.stock_lots as
with t as (
  select * from factory.stock_txns where cancelled_at is null
), agg as (
  select
    product_id, mfg_date, box_kg,
    sum(boxes)::int as boxes,
    coalesce(sum(boxes) filter (where type = '입고'), 0)::int as in_boxes,
    coalesce(-sum(boxes) filter (where type = '출고'), 0)::int as out_boxes,
    coalesce(sum(boxes) filter (where type = '조정'), 0)::int as adj_boxes,
    min(txn_date) filter (where type = '입고') as first_in_date,
    max(txn_date) filter (where type = '입고') as last_in_date,
    min(txn_date) as first_txn_date
  from t
  group by product_id, mfg_date, box_kg
), ins as (
  select product_id, mfg_date, box_kg, txn_date, sum(boxes)::int as b
  from t where type = '입고'
  group by product_id, mfg_date, box_kg, txn_date
), cum as (
  select ins.*, sum(b) over (partition by product_id, mfg_date, box_kg order by txn_date desc) as c
  from ins
)
select a.*,
  case when a.boxes > 0 then (
    select min(x.txn_date) from cum x
    where x.product_id = a.product_id and x.mfg_date is not distinct from a.mfg_date and x.box_kg = a.box_kg
      and x.c - x.b < a.boxes
  ) end as live_in_date
from agg a;

-- ── 기록 저장 — 품목 단위 잠금 안에서 잔량 확인 후 넣는다 ──────────
-- 두 사람이 같은 로트를 동시에 출고해도 합계가 마이너스로 가지 않게 한다.
-- p_rows: [{product_id, type, txn_date, mfg_date, box_kg, boxes, target, partner, memo}]
--   입고·출고 = boxes(양수), 조정 = target(실사 박스 수, 0 이상) → 차이만 기록. 차이 0 인 줄은 건너뛴다.
-- p_batch: 화면이 만든 입력 번호. 이미 저장된 번호면 새로 넣지 않고 그 기록을 돌려준다(응답이 늦어 다시 눌러도 한 번만).
create or replace function factory.post_stock_txns(p_rows jsonb, p_actor text, p_batch uuid)
returns setof factory.stock_txns
language plpgsql
set search_path = factory, pg_temp
as $$
declare
  v_batch uuid := coalesce(p_batch, gen_random_uuid());
  r record;
  v_bal integer;
  v_delta integer;
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
      product_id uuid, type text, txn_date date, mfg_date date, box_kg numeric,
      boxes integer, target integer, partner text, memo text)
  loop
    select coalesce(sum(t.boxes), 0) into v_bal from factory.stock_txns t
      where t.product_id = r.product_id and t.mfg_date is not distinct from r.mfg_date
        and t.box_kg = r.box_kg and t.cancelled_at is null;
    select p.name into v_name from factory.products p where p.id = r.product_id;

    if r.type = '입고' then
      if coalesce(r.boxes, 0) <= 0 then raise exception '입고 박스 수를 입력하세요.' using errcode = 'P0001'; end if;
      v_delta := r.boxes;
    elsif r.type = '출고' then
      if coalesce(r.boxes, 0) <= 0 then raise exception '출고 박스 수를 입력하세요.' using errcode = 'P0001'; end if;
      if v_bal < r.boxes then
        raise exception '% (제조 %, %kg) 재고 %박스보다 많이 출고할 수 없습니다.',
          v_name, coalesce(to_char(r.mfg_date, 'YYYY-MM-DD'), '미상'), trim_scale(r.box_kg), v_bal
          using errcode = 'P0001';
      end if;
      v_delta := -r.boxes;
    elsif r.type = '조정' then
      if r.target is null or r.target < 0 then raise exception '실사 박스 수를 0 이상으로 입력하세요.' using errcode = 'P0001'; end if;
      v_delta := r.target - v_bal;
      if v_delta = 0 then continue; end if;
    else
      raise exception '유형이 올바르지 않습니다: %', r.type using errcode = 'P0001';
    end if;

    insert into factory.stock_txns (batch_id, product_id, txn_date, type, mfg_date, box_kg, boxes, target, partner, memo, created_by)
    values (v_batch, r.product_id, r.txn_date, r.type, r.mfg_date, r.box_kg, v_delta,
      case when r.type = '조정' then r.target end, r.partner, r.memo, p_actor)
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
  v_bal integer;
begin
  select * into t from factory.stock_txns where id = p_id;
  if not found then raise exception '기록을 찾을 수 없습니다.' using errcode = 'P0001'; end if;
  perform pg_advisory_xact_lock(hashtextextended('factory.stock:' || t.product_id::text, 0));
  select * into t from factory.stock_txns where id = p_id for update;  -- 잠근 뒤 다시 읽는다
  if t.cancelled_at is not null then raise exception '이미 취소된 기록입니다.' using errcode = 'P0001'; end if;
  if t.boxes > 0 then
    select coalesce(sum(x.boxes), 0) into v_bal from factory.stock_txns x
      where x.product_id = t.product_id and x.mfg_date is not distinct from t.mfg_date
        and x.box_kg = t.box_kg and x.cancelled_at is null;
    if v_bal - t.boxes < 0 then
      raise exception '취소하면 재고가 %박스가 됩니다 — 이 로트의 출고 기록을 먼저 취소하세요.', v_bal - t.boxes
        using errcode = 'P0001';
    end if;
  end if;
  update factory.stock_txns set cancelled_at = now(), cancelled_by = p_actor where id = p_id returning * into t;
  return t;
end;
$$;

-- ── 품목 삭제 — 기록이 한 줄이라도 있으면(취소 포함) 막는다. 삭제 이력과 삭제를 한 트랜잭션으로 ──
create or replace function factory.delete_product(p_id uuid, p_actor text)
returns void
language plpgsql
set search_path = factory, pg_temp
as $$
declare
  p factory.products;
begin
  perform pg_advisory_xact_lock(hashtextextended('factory.stock:' || p_id::text, 0));
  select * into p from factory.products where id = p_id for update;
  if not found then raise exception '품목을 찾을 수 없습니다.' using errcode = 'P0001'; end if;
  if exists (select 1 from factory.stock_txns where product_id = p_id) then
    raise exception '입출고 기록이 있어 삭제할 수 없습니다 — ''재고관리 사용안함''으로 숨기세요.' using errcode = 'P0001';
  end if;
  insert into factory.product_changes (product_id, sku, name, field, changed_by) values (null, p.sku, p.name, '삭제', p_actor);
  delete from factory.products where id = p_id;
end;
$$;

-- ── 보안·권한 ───────────────────────────────────────────────────────
-- 앱은 service_role 로만 접근 — 정책 없이 RLS 만 켠다(001 과 동일). 함수도 service_role 만 실행.
alter table factory.products enable row level security;
alter table factory.stock_txns enable row level security;
alter table factory.product_changes enable row level security;

grant usage on schema factory to service_role;
grant all on factory.products, factory.stock_txns, factory.product_changes, factory.stock_lots to service_role;
revoke execute on function factory.post_stock_txns(jsonb, text, uuid) from public;
revoke execute on function factory.cancel_stock_txn(uuid, text) from public;
revoke execute on function factory.delete_product(uuid, text) from public;
revoke execute on function factory.log_product_change() from public;
grant execute on function factory.post_stock_txns(jsonb, text, uuid) to service_role;
grant execute on function factory.cancel_stock_txn(uuid, text) to service_role;
grant execute on function factory.delete_product(uuid, text) to service_role;

notify pgrst, 'reload schema';
