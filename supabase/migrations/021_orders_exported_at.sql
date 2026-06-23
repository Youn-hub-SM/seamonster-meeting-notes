-- 발주 → 매출 구글시트 전송 1회 가드.
--   exported_at 가 차 있으면 이미 시트로 전송된 발주 → 재전송 안 함.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table orders add column if not exists exported_at timestamptz;

NOTIFY pgrst, 'reload schema';
