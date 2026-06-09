-- 활동 로그에 작업자(actor) 기록 — 비밀번호별 사용자 구분 (지인/예지/현석/관리자)
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table activity_log
  add column if not exists actor text;

NOTIFY pgrst, 'reload schema';
