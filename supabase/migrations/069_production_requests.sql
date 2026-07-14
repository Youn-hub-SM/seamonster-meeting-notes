-- 069 도매 재고 생산 요청 (MD 직접 생산 → 생산담당자 확인 → 부분/수정 입고)
--  흐름: MD가 요청서(품목+요청수량) 작성 → 생산담당자가 실제 생산량을 '입고 처리'
--        (부분입고·초과입고·수정입고 가능) → 각 입고는 inventory_txns(도매 입고) 1건을 생성해
--        도매 재고에 반영. 입고 기록(production_receipts)이 증거로 남는다.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

-- 요청서 번호 순번(원자적). PR-000001 형식.
create sequence if not exists production_request_seq;
create or replace function next_production_request_no() returns text
language sql volatile as $$
  select 'PR-' || lpad(nextval('production_request_seq'::regclass)::text, 6, '0');
$$;

-- 요청서 헤더
create table if not exists production_requests (
  id uuid primary key default gen_random_uuid(),
  req_no text unique,                          -- PR-000001
  title text,                                  -- 요청 제목/메모(선택)
  requested_by text,                           -- 요청자(MD)
  request_date date not null default current_date,
  status text not null default '요청'          -- 요청→처리중→완료 / 취소
    check (status in ('요청', '처리중', '완료', '취소')),
  memo text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists prod_req_status_idx on production_requests (status);
create index if not exists prod_req_date_idx on production_requests (request_date desc);

-- 요청 품목(라인) — 요청수량. 입고수량은 production_receipts 합으로 도출(저장 안 함, 드리프트 없음).
create table if not exists production_request_items (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references production_requests(id) on delete cascade,
  product_id uuid not null references products(id),
  requested_qty integer not null,
  memo text,
  sort integer not null default 0
);
create index if not exists prod_req_item_req_idx on production_request_items (request_id);

-- 입고 기록(부분/초과/수정) = 증거. 각 입고는 inventory_txns(도매 입고) 1건과 1:1 연결.
--  qty 부호 허용: 정상 입고는 +, 수정(초과분 회수 등)은 -.
create table if not exists production_receipts (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references production_requests(id) on delete cascade,
  item_id uuid not null references production_request_items(id) on delete cascade,
  qty integer not null check (qty <> 0),
  receipt_date date not null default current_date,
  memo text,                                   -- 사유(부분/초과/수정 등)
  received_by text,
  inv_txn_id uuid references inventory_txns(id) on delete set null,  -- 생성된 도매 입고 원장
  created_at timestamptz not null default now()
);
create index if not exists prod_receipt_req_idx on production_receipts (request_id);
create index if not exists prod_receipt_item_idx on production_receipts (item_id);

alter table production_requests enable row level security;
alter table production_request_items enable row level security;
alter table production_receipts enable row level security;

notify pgrst, 'reload schema';
