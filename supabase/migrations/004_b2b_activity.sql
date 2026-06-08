-- activity_log 테이블 — B2B 변경 이력 (앱 내 활동 피드)
-- 적용 방법: Supabase Dashboard > SQL Editor 에 전체 붙여넣고 Run.

create table if not exists activity_log (
  id uuid primary key default gen_random_uuid(),
  event_type text not null,          -- order.created / order.status_changed / order.payment_status_changed / payment.added
  summary text not null,             -- 사람이 읽는 한 줄 요약
  order_id uuid references orders(id) on delete set null,  -- 발주 삭제돼도 이력은 남김
  order_no text,                     -- 발주번호 스냅샷 (order 삭제 대비)
  meta jsonb,                        -- 부가 데이터 (from/to 상태, 금액 등)
  created_at timestamptz not null default now()
);

create index if not exists activity_log_created_at_idx on activity_log (created_at desc);
create index if not exists activity_log_order_id_idx on activity_log (order_id);

alter table activity_log enable row level security;

NOTIFY pgrst, 'reload schema';
