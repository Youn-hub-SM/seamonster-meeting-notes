-- 077_crm_message_fields.sql
-- CRM 메시지맵 — 메시지 분류 필드 2개 추가(사용자 필드 개편).
--  customer = 고객(어느 스토어 고객 대상): naver(네이버) / mall(공식몰) / etc(기타)
--  msg_type = 유형(메시지 형식): alimtalk(알림톡) / friendtalk(친구톡)
--  발송채널·상태 개편(카카오/솔라피/카페24/블룸ai · 활성/비활성)은 기존 text 컬럼 값 체계 변경이라 DDL 불필요.
--  적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등(IF NOT EXISTS).
--  ⚠ 앱은 이 컬럼이 없어도 동작함(폴백: 고객·유형 입력만 숨김) — 074와 같은 패턴.

alter table crm_messages add column if not exists customer text not null default '';
alter table crm_messages add column if not exists msg_type text not null default '';

NOTIFY pgrst, 'reload schema';
