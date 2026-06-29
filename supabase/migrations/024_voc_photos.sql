-- VOC 개선요청서용: 제품 생산일 + 사진 첨부.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table voc add column if not exists production_date date;           -- 제품 생산일(제조사 배치 추적용)
alter table voc add column if not exists photos jsonb not null default '[]'::jsonb; -- 첨부 사진 공개 URL 배열

NOTIFY pgrst, 'reload schema';
