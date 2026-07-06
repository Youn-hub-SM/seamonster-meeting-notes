-- 057_fulfill_scan.sql
-- 온라인 발주 · 송장 스캔 집계 (단일 풀 모델)
--  업로더가 그날 '송장번호 → 상품코드 · 수량' 엑셀/CSV를 여러 개 올려도 모두 하나의 풀에 쌓인다.
--  스캐너는 배치 구분 없이 '전체 풀'을 대상으로 송장 바코드를 스캔 → 상품별 필요 수량 집계.
--  · 송장번호는 하이픈·공백 제거 후 대문자로 정규화해 저장(바코드엔 '-'가 없어 매칭되도록).
--  · 묶음(세트)은 상품마스터/product_bundles 로 구성품 전개(웹앱에서 계산).
--  · 파이썬 seamonster_invoice 도구 웹 이관.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run.
-- ⚠️ 송장 스캔 전용 테이블을 '단일 풀' 스키마로 (재)구성합니다. 초기 batches 버전에서 넘어오며
--    컬럼이 바뀌므로 기존 스캔 테이블을 새로 만듭니다. 이 4개 테이블은 송장 스캔 기능 전용이라
--    다른 데이터에 영향이 없고, 그동안의 업로드/스캔 테스트 데이터만 초기화됩니다.
drop table if exists fulfill_scan_events  cascade;
drop table if exists fulfill_scan_items   cascade;
drop table if exists fulfill_scan_batches cascade;   -- 구버전(batches 모델) 잔재
drop table if exists fulfill_scan_uploads cascade;

-- 업로드 이력(파일 1개 = 1행). 목록/삭제·추적용. 실제 데이터는 items.
create table fulfill_scan_uploads (
  id            uuid primary key default gen_random_uuid(),
  title         text not null default '',       -- 파일명 등
  created_by    text,
  created_at    timestamptz not null default now(),
  invoice_count integer not null default 0,
  item_count    integer not null default 0
);
create index if not exists fulfill_scan_uploads_created_idx on fulfill_scan_uploads (created_at desc);

-- 풀의 송장 라인(원자료). invoice_no 는 정규화(하이픈·공백 제거·대문자) 저장.
create table if not exists fulfill_scan_items (
  id         bigint generated always as identity primary key,
  upload_id  uuid not null references fulfill_scan_uploads(id) on delete cascade,
  invoice_no text not null,
  sku_code   text not null,
  qty        integer not null default 0
);
create index if not exists fulfill_scan_items_invoice_idx on fulfill_scan_items (invoice_no);

-- 스캔 진행(전역 단일 풀). 송장 1건 = 1행, invoice_no PK 로 중복 스캔 무시.
create table if not exists fulfill_scan_events (
  invoice_no text primary key,     -- 정규화 저장
  scanned_at timestamptz not null default now(),
  scanned_by text
);
create index if not exists fulfill_scan_events_at_idx on fulfill_scan_events (scanned_at desc);

alter table fulfill_scan_uploads enable row level security;
alter table fulfill_scan_items   enable row level security;
alter table fulfill_scan_events  enable row level security;

NOTIFY pgrst, 'reload schema';
