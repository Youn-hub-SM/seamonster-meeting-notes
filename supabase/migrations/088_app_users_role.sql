-- 088 계정 역할 — 파도소리(제조사) 계정을 /factory 안에만 가두기 위한 구분.
--  internal = 기존 내부 계정(전 메뉴 접근, 기본값) / factory = 파도소리 계정(/factory 만)
--  미들웨어는 세션 토큰에 실린 역할만 검증한다(매 요청 DB 조회 없음) — 이 컬럼은 로그인 시점에 읽힌다.
--  주의: 역할 변경은 다음 로그인부터 적용된다(기존 토큰은 만료까지 이전 역할 유지).
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등.

alter table app_users add column if not exists role text not null default 'internal';

alter table app_users drop constraint if exists app_users_role_check;
alter table app_users add constraint app_users_role_check check (role in ('internal', 'factory'));

notify pgrst, 'reload schema';
