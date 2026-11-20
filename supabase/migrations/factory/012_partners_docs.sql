-- factory/012 거래처 목록 · 출고 번호(출고증) · 본선명 (2026-11-20 대표 지시 — ERP 대체 1단계, 기획 docs/factory-erp-stage1-plan.md)
--
-- ■ partners: 거래처 목록(매출처·매입처). 칸은 씨몬스터 거래처와 같다. 기록의 거래처는 지금처럼 이름(글자)으로 남고,
--   이 표는 고르는 목록과 사업자 정보의 원본이다 — 이름이 같으면 같은 거래처로 본다(대소문자·앞뒤 공백 무시).
-- ■ out_docs: 출고 한 건(= [출고 저장] 한 번 = batch_id)의 번호. 번호 = 출고일(YYYYMMDD) + '-' + 그날 일련번호 4자리.
--   issue_out_doc 이 출고일마다 잠그고 다음 번호를 준다(같은 건을 다시 부르면 같은 번호). 취소해도 번호는 당겨 쓰지 않는다.
-- ■ stock_txns.vessel: 본선명(입고 때 적는 선택 칸). 로트 구분에는 쓰지 않는다. post_stock_txns 가 받아 저장한다(011 과 같고 열 하나만 추가).
-- ■ 적용 전에도 지금 화면은 그대로 돈다. public 은 건드리지 않는다. 멱등 — 재실행 안전.
--
-- 적용: 이 파일의 **내용 전체**를 Supabase Dashboard > SQL Editor 새 쿼리 창에 붙여넣고 Run(선택 영역 없이). 011 을 먼저 적용해야 한다.

create table if not exists factory.partners (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null default '매출처' check (kind in ('매출처', '매입처', '둘 다')),
  biz_no text,
  ceo_name text,
  contact_name text,
  contact_phone text,
  contact_email text,
  address text,
  payment_terms text,
  memo text,
  created_by text,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists factory_partners_name_uq on factory.partners (lower(btrim(name)));
comment on table factory.partners is '파도소리 거래처 목록(매출처·매입처). 기록(stock_txns.partner)과는 이름으로 이어진다';
comment on column factory.partners.kind is '매출처 · 매입처 · 둘 다';

create table if not exists factory.out_docs (
  batch_id uuid primary key,
  doc_no text not null unique,
  out_date date not null,
  seq integer not null,
  partner text,
  created_by text,
  created_at timestamptz not null default now(),
  unique (out_date, seq)
);
comment on table factory.out_docs is '출고 한 건의 번호(출고증 번호). batch_id = stock_txns.batch_id';

alter table factory.stock_txns add column if not exists vessel text;
comment on column factory.stock_txns.vessel is '본선명(입고 때 적는 선택 칸). 로트 구분에는 쓰지 않는다';

-- 출고 번호 매기기 — 그 묶음(batch)의 취소 안 된 출고 기록에서 출고일·거래처를 읽는다. 이미 있으면 그 번호를 돌려준다.
create or replace function factory.issue_out_doc(p_batch uuid, p_actor text)
returns factory.out_docs
language plpgsql
set search_path = factory, pg_temp
as $$
declare
  d factory.out_docs;
  v_date date;
  v_partner text;
  v_seq integer;
begin
  select * into d from factory.out_docs where batch_id = p_batch;
  if found then return d; end if;

  select min(t.txn_date), max(t.partner) into v_date, v_partner
    from factory.stock_txns t
    where t.batch_id = p_batch and t.type = '출고' and t.cancelled_at is null and coalesce(t.kind, '매출') = '매출';
  if v_date is null then raise exception '출고증을 낼 출고 기록이 없습니다.' using errcode = 'P0001'; end if;

  perform pg_advisory_xact_lock(hashtextextended('factory.out_doc:' || v_date::text, 0));
  select * into d from factory.out_docs where batch_id = p_batch;
  if found then return d; end if;
  select coalesce(max(seq), 0) + 1 into v_seq from factory.out_docs where out_date = v_date;
  insert into factory.out_docs (batch_id, doc_no, out_date, seq, partner, created_by)
    values (p_batch, to_char(v_date, 'YYYYMMDD') || '-' || lpad(v_seq::text, 4, '0'), v_date, v_seq, v_partner, p_actor)
    returning * into d;
  return d;
end;
$$;

-- ── 기록 저장 — 011 과 같고 본선명(vessel)만 더 받는다 ──
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
      kind text, storage text, unit_price numeric, move_id uuid, vessel text)
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
      kind, storage, unit_price, move_id, vessel, created_by)
    values (v_batch, r.product_id, r.txn_date, r.type, r.mfg_date, v_delta, r.box_kg,
      case when r.boxes is null then null when r.type = '출고' then -abs(r.boxes) when r.type = '입고' then abs(r.boxes) else r.boxes end,
      case when r.type = '조정' then v_target end, r.partner, r.memo, nullif(trim(r.tape_color), ''),
      v_kind, v_storage, case when r.type = '조정' then null else r.unit_price end, case when v_kind = '이동' then r.move_id end,
      case when r.type = '입고' then nullif(trim(r.vessel), '') end, p_actor)
    returning * into v_out;
    return next v_out;
  end loop;
  return;
end;
$$;

revoke execute on function factory.post_stock_txns(jsonb, text, uuid) from public;
revoke execute on function factory.issue_out_doc(uuid, text) from public;
grant execute on function factory.post_stock_txns(jsonb, text, uuid) to service_role;
grant execute on function factory.issue_out_doc(uuid, text) to service_role;
grant all on factory.partners to service_role;
grant all on factory.out_docs to service_role;

notify pgrst, 'reload schema';

-- 확인: 표 2개와 열 1개가 생겼으면 3
select
  (select count(*) from information_schema.tables where table_schema = 'factory' and table_name in ('partners', 'out_docs'))
  + (select count(*) from information_schema.columns where table_schema = 'factory' and table_name = 'stock_txns' and column_name = 'vessel') as created;
