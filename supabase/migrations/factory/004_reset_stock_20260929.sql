-- factory/004 파도소리 재고 전체 리셋 (2026-09-29 대표 지시)
--
-- ■ 하는 일
--   1) 현재 로트·입출고 기록을 백업 테이블로 복사한다(factory.bak20260929_lots / _lot_txns).
--   2) factory.lot_txns · factory.lots 를 모두 비운다. 현재고(lot_stock 뷰)는 0건이 된다.
--   창고(factory.warehouses)는 그대로 둔다.
--
-- ■ 주의
--   - **재실행 금지.** 두 번째 실행 때는 백업이 이미 있어 새로 복사하지 않고, 그 사이 입력한 재고를 지운다.
--   - 베타·운영이 같은 DB 라 실행 즉시 양쪽 모두 빈 재고가 된다.
--   - 되돌리기(필요할 때만):
--       insert into factory.lots select * from factory.bak20260929_lots;
--       insert into factory.lot_txns select * from factory.bak20260929_lot_txns;
--   - factory 스키마 밖(public)은 건드리지 않는다(CLAUDE.md §3a).
--
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run.

begin;

create table if not exists factory.bak20260929_lots as table factory.lots;
create table if not exists factory.bak20260929_lot_txns as table factory.lot_txns;
alter table factory.bak20260929_lots enable row level security;
alter table factory.bak20260929_lot_txns enable row level security;

delete from factory.lot_txns;
update factory.lots set origin_lot_id = null where origin_lot_id is not null;  -- 자기참조 FK 먼저 끊는다
delete from factory.lots;

commit;

-- 확인: 네 값이 (백업 로트 수, 백업 거래 수, 0, 0) 이면 정상
select
  (select count(*) from factory.bak20260929_lots)     as backup_lots,
  (select count(*) from factory.bak20260929_lot_txns) as backup_txns,
  (select count(*) from factory.lots)                 as lots_now,
  (select count(*) from factory.lot_txns)             as txns_now;
