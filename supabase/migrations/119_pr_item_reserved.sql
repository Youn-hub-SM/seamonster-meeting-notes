-- 119: 제조사 요청서 품목의 '행사·대량 몫'(reserved_qty) — 2026-09-28 대표 결정
--  프로모션·도매 대량 물량은 가장 가까운 제조사(재고 보충) 요청서에 수동으로 더한다(요청 창의 '담기').
--  더한 몫이 소매 '입고 예정'으로 잡히면 그만큼 소매 권장생산이 줄어든다(물건은 도착 후 프로모션·도매 대량 칸으로 옮겨 간다).
--  그래서 담은 몫을 줄별로 기록해, 입고 예정에서 '아직 옮기지 않은 확정형 잔여' 한도 안에서 빼 준다(production-inbound).
--  requested_qty 는 담은 몫을 포함한 전체 요청 수량 그대로(제조사 엑셀·이행률 불변). reserved_qty ≤ requested_qty 는 앱이 맞춘다.
--  미적용이어도 앱은 동작한다(담기는 수량만 더하고, 입고 예정 보정이 빠진다).
alter table production_request_items add column if not exists reserved_qty numeric not null default 0;
alter table production_request_items drop constraint if exists production_request_items_reserved_qty_chk;
alter table production_request_items add constraint production_request_items_reserved_qty_chk check (reserved_qty >= 0);
comment on column production_request_items.reserved_qty is '제조사 요청서에 담은 프로모션·도매 대량 몫(요청수량에 포함). 입고 예정 보정용(119)';
