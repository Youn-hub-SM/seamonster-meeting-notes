-- 업체 사업자등록증 첨부 — Storage 경로 보관 (파일은 비공개 버킷 company-docs)
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table companies
  add column if not exists biz_doc_path text;

NOTIFY pgrst, 'reload schema';
