-- payments 테이블 — 발주별 입금 내역
-- 적용 방법: Supabase Dashboard > SQL Editor 에 전체 붙여넣고 Run.

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  amount numeric(14,2) not null,
  paid_at date not null default current_date,
  method text,                       -- '계좌이체' / '카드' / '현금' 등 자유 입력
  reference text,                    -- 송금명의·전표번호·메모 등
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists payments_order_id_idx on payments (order_id, paid_at desc);
create index if not exists payments_paid_at_idx on payments (paid_at desc);

alter table payments enable row level security;

-- payment_status 는 자동 트리거 없이 사용자가 수동 관리.
-- payments 합계와 orders.total 비교는 UI 에서 시각적으로 제시만 함.

NOTIFY pgrst, 'reload schema';
