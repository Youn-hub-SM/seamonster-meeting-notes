-- 정기배송 분석 결과 스냅샷(KPI만, 개인정보 미포함) 시계열 저장.
--   snapshot(jsonb) = getCurrentSnapshot() 14개 KPI 전체
--   data_date = 데이터 기준일(YYYY-MM-DD). 같은 기준일 재저장 시 API 에서 갱신(upsert).
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

create table if not exists subscription_snapshots (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  data_date  text,
  file_name  text,
  snapshot   jsonb not null
);

create index if not exists subscription_snapshots_data_date_idx on subscription_snapshots (data_date);
create index if not exists subscription_snapshots_created_at_idx on subscription_snapshots (created_at desc);

alter table subscription_snapshots enable row level security;

NOTIFY pgrst, 'reload schema';
