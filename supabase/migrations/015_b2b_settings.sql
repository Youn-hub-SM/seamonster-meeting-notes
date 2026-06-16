-- B2B 설정 저장소 (키-값). Zapier 알림 on/off 등 운영 설정 보관.
--   key='zapier_notify' → 이벤트별 발송 여부 설정 (value jsonb)
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

create table if not exists b2b_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table b2b_settings enable row level security;

NOTIFY pgrst, 'reload schema';
