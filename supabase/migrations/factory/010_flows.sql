-- factory/010 출고·생산 예상 화면의 저장 구조 (2026-11-20 대표 지시, 기획 docs/factory-forecast-plan.md)
--
-- ■ ERP 엑셀 두 개(출고 파일 · 매입생산 파일)를 브라우저가 읽어 '흐름'으로 나누고, 일자 × 흐름 × 품명(× 거래처)로 합친 결과만 여기에 넣는다.
--   원본 행은 저장하지 않는다. 중량은 올릴 때 수량 × 단위로 다시 계산한 값이다(app/lib/factory-flow.ts).
-- ■ 올리기는 여러 묶음으로 나눠 들어온다. 묶음이 다 들어오기 전에는 committed = false 라 화면에 안 보이고,
--   commit_flows 가 한 번에 '같은 기간의 옛 기록 삭제 + 새 기록 공개'를 한다 — 같은 파일을 다시 올려도 두 번 쌓이지 않는다.
-- ■ 화면은 flow_overview() 한 번으로 필요한 합계를 전부 받는다(표를 줄 단위로 읽지 않는다 — 1000행 한도·호출 수 때문).
-- ■ public 스키마는 건드리지 않는다. 멱등 — 재실행 안전.
--
-- 적용: 이 파일의 **내용 전체**를 Supabase Dashboard > SQL Editor 새 쿼리 창에 붙여넣고 Run(선택 영역 없이).

create table if not exists factory.flows (
  id bigint generated always as identity primary key,
  flow_date date not null,
  kind text not null check (kind in ('buy', 'prod_stock', 'use_floor', 'ship_stock', 'ship_order', 'ship_etc')),
  item text not null,
  partner text not null default '',
  kg numeric(14,3) not null,
  processed boolean not null default false,
  big boolean not null default false,
  batch_id uuid not null,
  committed boolean not null default false,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists factory_flows_date_idx on factory.flows (flow_date) where committed;
create index if not exists factory_flows_batch_idx on factory.flows (batch_id);

comment on table factory.flows is '파도소리 ERP 엑셀에서 뽑은 일자별 흐름 합계(매입·창고 생산·현장 출고·거래처 출고). 예상 화면 전용';
comment on column factory.flows.kind is 'buy=매입 · prod_stock=창고에 넣는 생산 · use_floor=창고에서 현장으로 다시 나간 반제품 · ship_stock=창고에서 거래처로 · ship_order=그날 만들어 거래처로(=주문 생산) · ship_etc=그 밖 출고·반품';
comment on column factory.flows.partner is '거래처 — ship_stock 과 대량 거래에만 채운다. 나머지는 빈 값(일자 × 품명으로 합침)';
comment on column factory.flows.kg is '수량 × 단위로 다시 계산한 중량(kg). 반품은 음수';
comment on column factory.flows.processed is '가공품(품명에 순살·토막·채 등이 붙음)이면 true, 원물이면 false';
comment on column factory.flows.big is '수산물잔재물이거나 한 줄 3000kg 이상 — 출고·품목별 예상에서 뺀다';
comment on column factory.flows.committed is '올리기가 끝나 화면에 보이는 기록이면 true';

-- 올리기 마무리 — 같은 기간의 옛 기록을 지우고 이번 묶음을 공개한다. 끝나지 않은 다른 묶음도 치운다.
create or replace function factory.commit_flows(p_batch uuid, p_from date, p_to date)
returns integer
language plpgsql
set search_path = factory, pg_temp
as $$
declare
  n integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('factory.flows', 0));
  if not exists (select 1 from factory.flows where batch_id = p_batch) then
    raise exception '올린 기록이 없습니다.' using errcode = 'P0001';
  end if;
  delete from factory.flows where batch_id <> p_batch and (not committed or flow_date between p_from and p_to);
  update factory.flows set committed = true where batch_id = p_batch;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- 예상 화면이 쓰는 합계 한 묶음
create or replace function factory.flow_overview()
returns jsonb
language sql
stable
set search_path = factory, pg_temp
as $$
with f as (select * from factory.flows where committed),
b as (select min(flow_date) as d0, max(flow_date) as d1 from f),
up as (select created_at, created_by from f order by created_at desc limit 1)
select jsonb_build_object(
  'first_date', (select d0 from b),
  'last_date', (select d1 from b),
  'uploaded_at', (select created_at from up),
  'uploaded_by', (select created_by from up),
  -- 월 × 흐름 × 가공품 여부 × 대량 여부 (잔재물 제외)
  'monthly', coalesce((
    select jsonb_agg(jsonb_build_array(ym, kind, processed, big, kg) order by ym, kind)
    from (select to_char(flow_date, 'YYYY-MM') as ym, kind, processed, big, round(sum(kg)) as kg
          from f where item <> '수산물잔재물' group by 1, 2, 3, 4) m), '[]'::jsonb),
  -- 가공품이 창고에서 빠진 양: 주(월요일 시작) × 품명 — 현장으로 / 거래처로. 최근 60주
  'weekly', coalesce((
    select jsonb_agg(jsonb_build_array(wk, item, floor_kg, ship_kg) order by wk, item)
    from (select date_trunc('week', flow_date)::date as wk, item,
                 round(coalesce(sum(kg) filter (where kind = 'use_floor'), 0), 1) as floor_kg,
                 round(coalesce(sum(kg) filter (where kind = 'ship_stock'), 0), 1) as ship_kg
          from f, b
          where processed and not big and kind in ('use_floor', 'ship_stock') and flow_date > b.d1 - 420
          group by 1, 2) w), '[]'::jsonb),
  -- 가공품 월 × 품명: 창고에서 빠진 양 / 창고 생산. 최근 14개월
  'item_monthly', coalesce((
    select jsonb_agg(jsonb_build_array(ym, item, out_kg, prod_kg) order by ym, item)
    from (select to_char(flow_date, 'YYYY-MM') as ym, item,
                 round(coalesce(sum(kg) filter (where kind in ('use_floor', 'ship_stock')), 0), 1) as out_kg,
                 round(coalesce(sum(kg) filter (where kind = 'prod_stock'), 0), 1) as prod_kg
          from f, b
          where processed and not big and kind in ('use_floor', 'ship_stock', 'prod_stock')
            and flow_date >= (date_trunc('month', b.d1) - interval '13 months')::date
          group by 1, 2) im), '[]'::jsonb),
  'last_prod', coalesce((
    select jsonb_agg(jsonb_build_array(item, d))
    from (select item, max(flow_date) as d from f where kind = 'prod_stock' and processed group by 1) lp), '[]'::jsonb),
  -- 품목마다 거래처로 바로 나간 양의 1위 거래처(최근 1년)
  'top_partner', coalesce((
    select jsonb_agg(jsonb_build_array(item, partner, round(kg), round(total)))
    from (select item, partner, sum(kg) as kg,
                 sum(sum(kg)) over (partition by item) as total,
                 row_number() over (partition by item order by sum(kg) desc) as rn
          from f, b
          where kind = 'ship_stock' and processed and not big and flow_date > b.d1 - 365
          group by item, partner) tp
    where rn = 1 and total > 0), '[]'::jsonb),
  -- 주문 생산(그날 만들어 나간 양) 일별. 최근 8주
  'order_daily', coalesce((
    select jsonb_agg(jsonb_build_array(d, kg) order by d)
    from (select flow_date as d, round(sum(kg)) as kg from f, b
          where kind = 'ship_order' and not big and flow_date > b.d1 - 56 group by 1) od), '[]'::jsonb),
  -- 대량 거래(잔재물 제외) 최근 300건
  'big', coalesce((
    select jsonb_agg(jsonb_build_array(flow_date, kind, item, partner, round(kg)) order by flow_date desc)
    from (select flow_date, kind, item, partner, kg from f
          where big and item <> '수산물잔재물' order by flow_date desc limit 300) bg), '[]'::jsonb),
  'waste_kg', coalesce((
    select round(sum(kg)) from f, b
    where item = '수산물잔재물' and kind in ('ship_stock', 'ship_order', 'ship_etc') and flow_date > b.d1 - 365), 0)
);
$$;

-- 품목 하나의 월별 흐름(최근 24개월)과 거래처별 출고(최근 1년)
create or replace function factory.flow_item(p_item text)
returns jsonb
language sql
stable
set search_path = factory, pg_temp
as $$
with f as (select * from factory.flows where committed and item = p_item and not big),
b as (select max(flow_date) as d1 from factory.flows where committed)
select jsonb_build_object(
  'monthly', coalesce((
    select jsonb_agg(jsonb_build_array(ym, prod_kg, floor_kg, ship_kg, order_kg) order by ym)
    from (select to_char(flow_date, 'YYYY-MM') as ym,
                 round(coalesce(sum(kg) filter (where kind = 'prod_stock'), 0)) as prod_kg,
                 round(coalesce(sum(kg) filter (where kind = 'use_floor'), 0)) as floor_kg,
                 round(coalesce(sum(kg) filter (where kind = 'ship_stock'), 0)) as ship_kg,
                 round(coalesce(sum(kg) filter (where kind = 'ship_order'), 0)) as order_kg
          from f, b
          where flow_date >= (date_trunc('month', b.d1) - interval '23 months')::date
          group by 1) m), '[]'::jsonb),
  'partners', coalesce((
    select jsonb_agg(jsonb_build_array(partner, kg) order by kg desc)
    from (select partner, round(sum(kg)) as kg from f, b
          where kind = 'ship_stock' and flow_date > b.d1 - 365
          group by 1 order by 2 desc limit 6) p), '[]'::jsonb)
);
$$;

revoke execute on function factory.commit_flows(uuid, date, date) from public;
revoke execute on function factory.flow_overview() from public;
revoke execute on function factory.flow_item(text) from public;
grant execute on function factory.commit_flows(uuid, date, date) to service_role;
grant execute on function factory.flow_overview() to service_role;
grant execute on function factory.flow_item(text) to service_role;
grant all on factory.flows to service_role;

notify pgrst, 'reload schema';

-- 확인: 올린 기록 수(적용 직후에는 0)
select count(*) as committed_rows from factory.flows where committed;
