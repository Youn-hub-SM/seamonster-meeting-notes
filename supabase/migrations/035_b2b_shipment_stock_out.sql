-- 035_b2b_shipment_stock_out.sql
-- B2B 발송 일정 '등록 시점'에 재고를 즉시 출고(선점)하기 위한 컬럼.
--  소매 주문수집처럼 발송 잡는 순간 재고를 깎아 오버부킹을 막는다(발송완료 차감은 너무 늦음).
--
--  - shipments.stock_out : 이 차수 저장 시 재고원장에 '출고'를 즉시 기록할지. 기본 false(기존 발주엔 영향 없음).
--  - inventory_txns.shipment_id : 그 출고가 어느 발송 차수에서 나왔는지 연결.
--      발주 PUT 은 shipments 를 전부 삭제·재삽입하므로, on delete cascade 로 옛 출고가 자동 삭제(재고 원복)되고
--      재저장 시 다시 기록 → 편집/삭제해도 이중 차감이 생기지 않음.

alter table shipments add column if not exists stock_out boolean not null default false;

alter table inventory_txns add column if not exists shipment_id uuid references shipments(id) on delete cascade;
create index if not exists inv_txn_shipment_idx on inventory_txns(shipment_id);

-- PostgREST 스키마 캐시 갱신
NOTIFY pgrst, 'reload schema';
