-- 074_crm_message_dates.sql
-- CRM 메시지맵 — 메시지(캠페인)에 진행 기간 추가.
--  "일자별로 진행 중인 캠페인이 달라진다" → 보드/흐름에서 기준일을 골라 그날 진행분만 보는 필터의 근거.
--  둘 다 NULL = 상시(기간 제한 없음). 시작만 있으면 그날부터 계속, 종료만 있으면 그날까지.
--  적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등(IF NOT EXISTS).
--  ⚠ 앱은 이 컬럼이 없어도 동작함(폴백: 날짜 기능만 숨김) — 적용 전에도 화면이 깨지지 않는다.

alter table crm_messages add column if not exists start_date date;
alter table crm_messages add column if not exists end_date date;

NOTIFY pgrst, 'reload schema';
