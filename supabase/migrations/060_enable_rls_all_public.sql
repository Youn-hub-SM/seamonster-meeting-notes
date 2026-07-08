-- 060_enable_rls_all_public.sql
-- 목적: Supabase 보안 경고 "rls_disabled_in_public" (Table publicly accessible) 해소.
--   public 스키마에서 RLS 가 아직 꺼진 모든 일반 테이블에 RLS 를 켠다(정책 없음).
--
-- ▣ 왜 안전한가 (이 앱 구조 기준)
--   1) 앱은 전부 service_role 키(서버 API 라우트/스크립트)로만 접근 → RLS 우회. 동작 영향 0.
--      · 브라우저/anon 키로 Supabase 를 직접 읽는 코드 없음(정기배송 대시보드도 /api/subscription/* 경유).
--   2) Looker 는 sales_looker · sales_okr · sales_customer_summary '뷰'로만 읽는다(041).
--      뷰가 소유자 권한으로 실행(security_invoker 미사용)되고 뷰·기반테이블 소유자가 동일(postgres)
--      → 기반테이블 RLS 는 소유자에게 적용 안 됨. Looker 영향 0.
--      (근거: sales_orders/customers/reports 는 039부터 RLS 켜진 채 Looker 정상 동작 중)
--   정책(policy)을 안 붙이므로 anon/authenticated 역할은 이 테이블들에 '접근 불가'(= 원하는 잠금).
--   FORCE ROW LEVEL SECURITY 는 쓰지 않는다(소유자/서비스롤 우회 유지가 목적).
--
-- ▣ 이번에 실제로 RLS 가 빠져 있던 테이블(참고)
--   sales_uploads(040) · sales_sku_cost(043) · sales_channel_config(046) · sales_okr_babyfood_pattern(056)
--   아래 블록은 위 4개를 포함해 "아직 꺼진 모든 public 테이블"을 한 번에 켠다(멱등 — 반복 실행 안전).

do $$
declare r record;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'            -- 일반 테이블만 (뷰/시퀀스/파티션 상위 제외)
      and c.relrowsecurity = false   -- 아직 RLS 꺼진 것만
  loop
    execute format('alter table public.%I enable row level security;', r.relname);
    raise notice 'RLS enabled: public.%', r.relname;
  end loop;
end $$;

-- ▣ 확인용(선택): 아래를 실행하면 public 테이블별 RLS 상태를 볼 수 있다. 모두 true 여야 정상.
--   select c.relname as table_name, c.relrowsecurity as rls_enabled
--   from pg_class c join pg_namespace n on n.oid = c.relnamespace
--   where n.nspname = 'public' and c.relkind = 'r'
--   order by c.relrowsecurity, c.relname;
