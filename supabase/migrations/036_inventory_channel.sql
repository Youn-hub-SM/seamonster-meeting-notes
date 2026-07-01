-- 036_inventory_channel.sql
-- 재고를 '도매/소매' 채널로 분리. 같은 품목(SKU)이라도 채널별로 현재고를 따로 집계한다.
--  - inventory_txns.channel : 이 입·출고·조정이 어느 채널 재고를 움직였는지. 기존 원장은 전부 '소매'.
--  - inventory_stock(asof, chan) : chan 지정 시 그 채널만, null 이면 전체(도매+소매) 합산.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

-- 1) 채널 컬럼(기존 행은 default 로 전부 '소매'로 채워짐 = 사용자 선택: 기존은 소매로 시작)
alter table inventory_txns add column if not exists channel text not null default '소매';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'inventory_txns_channel_chk') then
    alter table inventory_txns add constraint inventory_txns_channel_chk check (channel in ('도매', '소매'));
  end if;
end $$;

create index if not exists inv_txn_channel_idx on inventory_txns (channel);

-- 2) 집계 함수에 채널 인자 추가. 기존 1-인자 함수는 제거하고 2-인자(둘 다 기본값)로 대체.
--    chan is null → 전체(도매+소매), chan='도매'/'소매' → 해당 채널만.
--    기존 호출부( .rpc('inventory_stock', {asof}) )는 chan 이 기본 null 이라 그대로 전체 합산으로 동작.
drop function if exists inventory_stock(date);
create or replace function inventory_stock(asof date default null, chan text default null)
returns table (product_id uuid, qty bigint)
language sql stable as $$
  select t.product_id, coalesce(sum(t.qty), 0)::bigint
  from inventory_txns t
  where (asof is null or t.txn_date <= asof)
    and (chan is null or t.channel = chan)
  group by t.product_id
$$;

NOTIFY pgrst, 'reload schema';
