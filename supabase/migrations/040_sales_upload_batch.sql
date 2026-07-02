-- 040 매출 업로드 배치 추적 — 업로드 단위 되돌리기(undo) 지원.
--  · sales_orders.upload_batch: 이 배치가 '새로 삽입한' 행에만 태깅(멱등 upsert라 기존 중복행은 미변경 → 되돌리기 시 정확히 이 배치분만 삭제).
--  · sales_uploads: 업로드 이력(파일명·건수·상태). 되돌리면 status=reverted.
alter table sales_orders add column if not exists upload_batch text;
create index if not exists sales_orders_upload_batch_idx on sales_orders (upload_batch);

create table if not exists sales_uploads (
  id           text primary key,                     -- 배치 id (예: web-20260702-143000-ab12)
  filename     text    not null default '',
  total_rows   integer not null default 0,           -- 파일 총 행수
  inserted     integer not null default 0,           -- 실제 신규 삽입 건수(= 되돌리기 시 삭제 예상 건수)
  skipped      integer not null default 0,           -- 중복/오류로 제외
  uploaded_by  text,
  status       text    not null default 'active' check (status in ('active','reverted')),
  created_at   timestamptz not null default now(),
  reverted_at  timestamptz
);
create index if not exists sales_uploads_status_idx on sales_uploads (status, created_at desc);

notify pgrst, 'reload schema';
