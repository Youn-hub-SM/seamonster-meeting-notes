-- 057_fulfill_scan.sql
-- 온라인 발주 · 송장 스캔 집계 스테이션
--  업로더가 그날 '송장번호 → 단품코드 · 주문수량' 데이터를 올려 배치(batch)를 만들고,
--  스캐너(다른 기기/장소)가 송장번호를 스캔 → 상품별 누적 수량을 실시간 집계한다.
--  묶음(세트)은 상품마스터/product_bundles 로 구성품 전개 → 웹앱에서 계산(DB엔 원자료만 보관).
--  파이썬 seamonster_invoice 도구(scanned_invoices + product_mapping 시트)를 웹으로 이관.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

-- 업로드 단위(배치). 그날/그 파일 한 번 업로드 = 한 배치.
create table if not exists fulfill_scan_batches (
  id            uuid primary key default gen_random_uuid(),
  title         text not null default '',           -- 표시명(파일명/날짜 등)
  created_by    text,                                -- 업로더
  created_at    timestamptz not null default now(),
  closed        boolean not null default false,      -- 마감(스캔 종료) 표시
  invoice_count integer not null default 0,          -- 배치 내 고유 송장 수
  item_count    integer not null default 0,          -- 라인 수
  note          text
);
create index if not exists fulfill_scan_batches_created_idx on fulfill_scan_batches (created_at desc);

-- 배치의 송장 라인(원자료). 한 송장에 여러 단품코드 가능.
create table if not exists fulfill_scan_items (
  id         bigint generated always as identity primary key,
  batch_id   uuid not null references fulfill_scan_batches(id) on delete cascade,
  invoice_no text not null,                          -- 송장번호(문자열 비교)
  sku_code   text not null,                          -- 단품코드(상품마스터 SKU 와 매칭)
  qty        integer not null default 0
);
create index if not exists fulfill_scan_items_batch_inv_idx on fulfill_scan_items (batch_id, invoice_no);

-- 스캔 이벤트(송장 1건 = 1행). (batch, invoice) 유니크로 중복 스캔 무시.
create table if not exists fulfill_scan_events (
  batch_id   uuid not null references fulfill_scan_batches(id) on delete cascade,
  invoice_no text not null,
  scanned_at timestamptz not null default now(),
  scanned_by text,
  primary key (batch_id, invoice_no)
);
create index if not exists fulfill_scan_events_batch_idx on fulfill_scan_events (batch_id, scanned_at desc);

alter table fulfill_scan_batches enable row level security;
alter table fulfill_scan_items  enable row level security;
alter table fulfill_scan_events enable row level security;

NOTIFY pgrst, 'reload schema';
