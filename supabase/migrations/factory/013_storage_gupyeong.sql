-- factory/013 기본 입고지 이름 구평창고1층 → 구평 (2026-11-27 대표 지시 — 입고지는 구평·외부, 언제든 추가)
-- ■ 화면에서 '보관처'라 부르던 storage 열을 '입고지'로 부른다(열 이름은 그대로). 기본값만 '구평'으로 바꾼다.
-- ■ 바뀌는 것: 기존 기록의 storage '구평창고1층' → '구평', 열 기본값, post_stock_txns(012 와 같고 기본 이름만 다르다).
--   stock_lots 뷰·cancel_stock_txn 은 storage 값을 그대로 비교하므로 손대지 않는다.
-- ■ 입고지 목록(구평·외부)은 DB 가 아니라 b2b_settings kv 'factory_storages' — 비어 있으면 코드가 구평·외부를 보인다.
-- ■ 적용 전에도 화면은 돈다(옛 이름을 기본으로 본다). 멱등 — 재실행 안전. public 은 건드리지 않는다.
--
-- 적용: 이 파일의 **내용 전체**를 Supabase Dashboard > SQL Editor 새 쿼리 창에 붙여넣고 Run(선택 영역 없이). 012 를 먼저 적용해야 한다.

update factory.stock_txns set storage = '구평' where storage = '구평창고1층';
alter table factory.stock_txns alter column storage set default '구평';
comment on column factory.stock_txns.storage is '입고지(창고). 로트를 나눈다. 기본 구평';

-- ── 기록 저장 — 012 와 같고 기본 입고지 이름만 구평 ──
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
    v_storage := coalesce(nullif(trim(r.storage), ''), '구평');
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
          case when v_storage <> '구평' then ' · ' || v_storage else '' end, trim_scale(v_bal))
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
grant execute on function factory.post_stock_txns(jsonb, text, uuid) to service_role;

notify pgrst, 'reload schema';

-- 확인: 옛 이름이 남아 있지 않으면 0
select count(*) as legacy_left from factory.stock_txns where storage = '구평창고1층';
