-- 071_production_request_due_date.sql
-- 도매 생산요청서에 '생산마감일' 컬럼 추가.
--  기본값은 폼에서 요청일+7영업일(주말·공휴일 제외)로 채우되, 급발주 시 사용자가 수정 가능.
--  코드는 이 컬럼이 없어도 죽지 않게 폴백을 두므로(미적용 환경 대비) 적용 전에도 요청서 생성은 정상 동작.
--
--  적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run.

alter table production_requests add column if not exists due_date date;

-- PostgREST 스키마 캐시 갱신
NOTIFY pgrst, 'reload schema';
