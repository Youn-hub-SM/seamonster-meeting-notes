-- 발주 헤더 송장번호 — '발송완료' 상태 변경 시 입력 강제용
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table orders
  add column if not exists tracking_no text;

NOTIFY pgrst, 'reload schema';
