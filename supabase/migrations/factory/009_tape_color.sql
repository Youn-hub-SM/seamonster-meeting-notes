-- factory/009 기록에 '테잎색' 칸 (2026-11-17 대표 지시: 재고마다 거래처명·박스테잎 색상, 칸 노출은 설정으로)
--
-- ■ 거래처명은 기존 stock_txns.partner(입고처·출고처)를 그대로 쓴다. 테잎색만 열을 더한다(입고 줄마다 적는다).
-- ■ 칸을 보일지 말지는 b2b_settings kv 'factory_fields' 로(코드가 관리, 마이그레이션 없음). 이전에 적은 값 목록도 코드가 stock_txns 에서 모은다.
-- ■ post_stock_txns 가 tape_color 를 받아 저장한다(008 과 같고 열 하나만 추가). 멱등 — 재실행 안전. public 은 건드리지 않는다.

alter table factory.stock_txns add column if not exists tape_color text;
comment on column factory.stock_txns.tape_color is '박스 테잎색(입고 때 적음, 자유 입력). 로트 구분에는 쓰지 않는다';

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
      kg numeric, box_kg numeric, boxes integer, target_kg numeric, target integer, partner text, memo text, tape_color text)
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
        raise exception '%', format('%s (제조 %s%s) 재고 %skg보다 많이 출고할 수 없습니다.',
          v_name, coalesce(to_char(r.mfg_date, 'YYYY-MM-DD'), '미상'),
          case when r.box_kg is not null then ' · ' || trim_scale(r.box_kg) || 'kg박스' else '' end, trim_scale(v_bal))
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

    insert into factory.stock_txns (batch_id, product_id, txn_date, type, mfg_date, kg, box_kg, boxes, target_kg, partner, memo, tape_color, created_by)
    values (v_batch, r.product_id, r.txn_date, r.type, r.mfg_date, v_delta, r.box_kg,
      case when r.boxes is null then null when r.type = '출고' then -abs(r.boxes) when r.type = '입고' then abs(r.boxes) else r.boxes end,
      case when r.type = '조정' then v_target end, r.partner, r.memo, nullif(trim(r.tape_color), ''), p_actor)
    returning * into v_out;
    return next v_out;
  end loop;
  return;
end;
$$;

revoke execute on function factory.post_stock_txns(jsonb, text, uuid) from public;
grant execute on function factory.post_stock_txns(jsonb, text, uuid) to service_role;

notify pgrst, 'reload schema';

-- 확인: 열이 생겼으면 1
select count(*) from information_schema.columns where table_schema = 'factory' and table_name = 'stock_txns' and column_name = 'tape_color';
