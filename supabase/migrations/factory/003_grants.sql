-- factory/003 service_role 권한 부여 — 001 누락분.
--  public 스키마는 Supabase가 기본 grant 를 깔아주지만, 직접 만든 스키마는 아무 권한이 없다.
--  API(서비스 키 = service_role)가 "permission denied for schema factory [42501]" 를 맞는 이유.
--  anon/authenticated 에는 주지 않는다 — 파도소리 앱은 service_role 로만 접근(최소 권한).
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

grant usage on schema factory to service_role;
grant all on all tables in schema factory to service_role;   -- 뷰(lot_stock) 포함

-- 이후 factory 마이그레이션이 만드는 테이블도 자동으로 권한이 따라오게(SQL Editor 실행 주체 = postgres).
alter default privileges for role postgres in schema factory grant all on tables to service_role;

notify pgrst, 'reload schema';
