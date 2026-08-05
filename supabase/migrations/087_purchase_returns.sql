-- 087: 제조사 반품 — 월간 매입 결산에서 매입금액을 깎기 위한 기록.
--  재고와는 무관하다(inventory_txns 를 쓰지 않는다). 물건이 실제로 빠지는 처리는
--  재고목록의 출고·조정에서 따로 하며, 여기서 또 차감하면 이중으로 빠진다.
--  단가를 비워 두면 결산이 그 달의 가중평균 매입가를 그대로 쓴다.

create table if not exists purchase_returns (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references products(id) on delete cascade,
  return_date  date not null,
  qty          numeric(12, 2) not null check (qty > 0),
  unit_amount  numeric(12, 2),           -- 반품 단가. null 이면 그 달 매입가(가중평균) 사용
  partner      text,                     -- 제조사
  memo         text,
  created_by   text,
  created_at   timestamptz not null default now()
);

-- 결산은 항상 '한 달' 단위로 읽는다
create index if not exists purchase_returns_date_idx on purchase_returns (return_date);
create index if not exists purchase_returns_product_idx on purchase_returns (product_id);

-- 서비스롤 전용(앱 서버만 접근) — 정책을 두지 않는 기존 관행 그대로
alter table purchase_returns enable row level security;
