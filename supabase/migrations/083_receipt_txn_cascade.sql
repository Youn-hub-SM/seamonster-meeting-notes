-- 083_receipt_txn_cascade.sql
-- 생산 입고 증거(production_receipts) ↔ 재고 원장(inventory_txns) 연결을 restrict → cascade 로.
--
-- [배경] 입고 창구를 '입고 및 출고' 메뉴로 단일화(2026-07-29). 입고 시 열린 생산 요청에
--  자동 매칭돼 증거(receipt)가 남는데, 이제 원장의 주인은 입고/출고 쪽이므로
--  거기서 입고를 취소(원장 삭제)하면 연결된 증거도 함께 지워져 이행률이 자동 원복돼야 한다.
--  기존 restrict 는 '요청 화면의 입고 취소만 허용' 하던 규칙 — 단일 창구 구조에선 배치 취소를 막아버린다.
--
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등.
-- 미적용 시: 생산 요청과 연결된 입고를 입고/출고 쪽에서 취소하면 FK 오류(안내 문구 표시)가 난다.

alter table production_receipts drop constraint if exists production_receipts_inv_txn_id_fkey;
alter table production_receipts add constraint production_receipts_inv_txn_id_fkey
  foreign key (inv_txn_id) references inventory_txns(id) on delete cascade;

comment on column production_receipts.inv_txn_id is
  '연결된 재고 원장(입고) id. cascade: 원장을 지우면(입고 취소) 증거도 함께 삭제돼 이행률 원복.';

NOTIFY pgrst, 'reload schema';
