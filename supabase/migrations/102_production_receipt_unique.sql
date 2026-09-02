-- 102: 생산요청 입고 링크 중복 방지 (2026-09-02)
--  같은 원장 입고(inv_txn_id)가 같은 요청 품목(item_id)에 두 번 연결되는 것을 DB 가 막는다.
--  기간 소급 매칭(syncWindowReceipts)과 이벤트 매칭이 동시에 돌면(두 화면 동시 조회 등)
--  둘 다 '아직 연결 안 됨'을 읽고 각자 삽입하는 경합이 가능한데, 그 결과가 이행률 이중 집계다.
--  코드는 upsert(ignoreDuplicates)로 이 인덱스를 쓰며, 미적용 환경에서는 일반 insert 로 폴백한다.
--
--  inv_txn_id 가 null 인 수기 입고(구 요청화면 직접 입고)는 NULLS DISTINCT 규칙으로 영향 없다.
-- 적용: Supabase SQL Editor 에 붙여넣고 Run. 멱등.

create unique index if not exists prod_receipt_item_txn_uniq
  on production_receipts (item_id, inv_txn_id);

notify pgrst, 'reload schema';
