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
  -- restrict: 연결된 도매 입고 원장은 일반 재고툴에서 함부로 못 지운다(정합성 보호).
  --  취소는 반드시 cancel_production_receipt(아래)로만 → receipt 먼저 지운 뒤 원장 삭제(원자적).
  inv_txn_id uuid references inventory_txns(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index if not exists prod_receipt_req_idx on production_receipts (request_id);
create index if not exists prod_receipt_item_idx on production_receipts (item_id);
create index if not exists prod_receipt_txn_idx on production_receipts (inv_txn_id);

alter table production_requests enable row level security;
alter table production_request_items enable row level security;
alter table production_receipts enable row level security;

-- 입고 취소(원자적) — 증거(receipt)와 연결 도매 입고 원장을 한 트랜잭션에서 함께 삭제.
--  receipt를 먼저 지워 FK(restrict) 참조를 푼 뒤 원장을 삭제. 중간 실패 시 전체 롤백(재고·증거 정합).
create or replace function cancel_production_receipt(p_receipt_id uuid) returns void
language plpgsql as $$
declare v_txn uuid;
begin
  select inv_txn_id into v_txn from production_receipts where id = p_receipt_id;
  if not found then return; end if;
  delete from production_receipts where id = p_receipt_id;
  if v_txn is not null then
    delete from inventory_txns where id = v_txn;
  end if;
end;
$$;

notify pgrst, 'reload schema';
