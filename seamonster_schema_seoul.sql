-- seamonster helper (서울) 스키마 일괄 적용 — 마이그레이션 001~065 합본
-- 새 프로젝트 SQL Editor에 전체 붙여넣기 후 실행


-- ======================================================================
-- 001_b2b_init.sql
-- ======================================================================
-- 씨몬스터 B2B 관리툴 초기 스키마
-- 적용 방법: Supabase Dashboard > SQL Editor 에 전체 붙여넣고 Run.
-- 멱등성을 위해 drop 부터 시작 — 처음 적용 시엔 drop 들이 그냥 무시됨.

-- ─────────────────────────────────────────────
-- 익스텐션
-- ─────────────────────────────────────────────
create extension if not exists "pgcrypto"; -- gen_random_uuid()

-- ─────────────────────────────────────────────
-- companies (업체 주소록)
-- ─────────────────────────────────────────────
create table if not exists companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  biz_no text,                       -- 사업자번호 (예: 123-45-67890)
  ceo_name text,                     -- 대표자명
  contact_name text,                 -- 담당자명
  contact_phone text,
  contact_email text,
  address text,                      -- 기본 배송지 (한 줄)
  payment_terms text,                -- 결제조건 (예: "월말정산", "선입금")
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists companies_name_idx on companies (name);

-- ─────────────────────────────────────────────
-- products (제품 카탈로그 / 원가표)
-- ─────────────────────────────────────────────
create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  sku text unique,                   -- 내부 코드 (선택)
  name text not null,                -- 품목명
  spec text,                         -- 규격 (예: "100g")
  unit text not null default '개',   -- '개', 'kg', '박스' 등
  cost_price numeric(12,2) not null default 0,  -- 현재 원가
  sale_price numeric(12,2) not null default 0,  -- 기본 판매가
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists products_name_idx on products (name);
create index if not exists products_active_idx on products (active);

-- 원가 변경 이력 (products.cost_price 변경 시 트리거로 자동 기록)
create table if not exists cost_history (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  cost_price numeric(12,2) not null,
  changed_at timestamptz not null default now(),
  reason text
);
create index if not exists cost_history_product_id_idx on cost_history (product_id, changed_at desc);

-- ─────────────────────────────────────────────
-- orders (발주 헤더)
-- ─────────────────────────────────────────────
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  order_no text unique,              -- 자동발번 yyyymmdd-NNN
  company_id uuid not null references companies(id) on delete restrict,
  order_date date not null,
  production_date date,              -- 생산예정일
  ship_date date,                    -- 발송예정일
  status text not null default '발주확인/생산대기'
    check (status in ('발주확인/생산대기','생산요청/생산중','생산완료/발송대기','발송완료','취소')),
  payment_status text not null default '미입금'
    check (payment_status in ('미입금','부분입금','입금완료','확인불필요')),
  tax_invoice_status text not null default '미발행'
    check (tax_invoice_status in ('미발행','발행대기','발행완료','면제')),
  subtotal numeric(14,2) not null default 0,  -- order_items 합 (트리거로 자동 갱신)
  vat numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists orders_company_id_idx on orders (company_id);
create index if not exists orders_order_date_idx on orders (order_date desc);
create index if not exists orders_production_date_idx on orders (production_date);
create index if not exists orders_ship_date_idx on orders (ship_date);
create index if not exists orders_status_idx on orders (status);

-- ─────────────────────────────────────────────
-- order_items (발주 라인)
-- ─────────────────────────────────────────────
create table if not exists order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  product_id uuid references products(id) on delete restrict,
  product_name text not null,        -- 스냅샷 (제품명 변경되어도 발주에 남음)
  option_label text,                 -- 옵션
  spec text,                         -- 규격 스냅샷
  qty numeric(12,3) not null,
  unit_price numeric(12,2) not null,
  line_total numeric(14,2) generated always as (qty * unit_price) stored,
  cost_at_order numeric(12,2),       -- 발주 시점 원가 스냅샷 (마진 계산용)
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists order_items_order_id_idx on order_items (order_id, sort_order);
create index if not exists order_items_product_id_idx on order_items (product_id);

-- ─────────────────────────────────────────────
-- shipments (송장)
-- ─────────────────────────────────────────────
-- 한 발주에 송장 여러 개 가능 (분할배송)
create table if not exists shipments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  recipient_name text not null,
  recipient_phone text not null,
  address text not null,             -- 한 줄 합산 주소
  delivery_memo text,
  courier text,                      -- 예: 'CJ대한통운'
  tracking_no text,
  shipped_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists shipments_order_id_idx on shipments (order_id);
create index if not exists shipments_tracking_no_idx on shipments (tracking_no);

-- ─────────────────────────────────────────────
-- 트리거 함수: updated_at 자동 갱신
-- ─────────────────────────────────────────────
create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists companies_touch on companies;
create trigger companies_touch before update on companies
  for each row execute function touch_updated_at();

drop trigger if exists products_touch on products;
create trigger products_touch before update on products
  for each row execute function touch_updated_at();

drop trigger if exists orders_touch on orders;
create trigger orders_touch before update on orders
  for each row execute function touch_updated_at();

-- ─────────────────────────────────────────────
-- 트리거 함수: products.cost_price 변경 시 cost_history 자동 기록
-- ─────────────────────────────────────────────
create or replace function log_cost_change() returns trigger as $$
begin
  if (tg_op = 'INSERT' and new.cost_price > 0) then
    insert into cost_history (product_id, cost_price) values (new.id, new.cost_price);
  elsif (tg_op = 'UPDATE' and new.cost_price is distinct from old.cost_price) then
    insert into cost_history (product_id, cost_price) values (new.id, new.cost_price);
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists products_cost_log on products;
create trigger products_cost_log
  after insert or update of cost_price on products
  for each row execute function log_cost_change();

-- ─────────────────────────────────────────────
-- 트리거 함수: order_items 변경 시 orders.subtotal/vat/total 재계산
-- ─────────────────────────────────────────────
create or replace function recalc_order_totals() returns trigger as $$
declare
  target_order_id uuid;
  s numeric(14,2);
begin
  target_order_id := coalesce(new.order_id, old.order_id);
  select coalesce(sum(line_total), 0) into s from order_items where order_id = target_order_id;
  update orders
     set subtotal = s,
         vat = round(s * 0.1, 0),
         total = s + round(s * 0.1, 0)
   where id = target_order_id;
  return null;
end;
$$ language plpgsql;

drop trigger if exists order_items_recalc on order_items;
create trigger order_items_recalc
  after insert or update or delete on order_items
  for each row execute function recalc_order_totals();

-- ─────────────────────────────────────────────
-- 트리거 함수: 발주번호 자동 발번 (yyyymmdd-NNN)
-- ─────────────────────────────────────────────
create or replace function gen_order_no() returns trigger as $$
declare
  d text := to_char(new.order_date, 'YYYYMMDD');
  cnt int;
begin
  if new.order_no is null or new.order_no = '' then
    select count(*) + 1 into cnt from orders where to_char(order_date, 'YYYYMMDD') = d;
    new.order_no := d || '-' || lpad(cnt::text, 3, '0');
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists orders_gen_no on orders;
create trigger orders_gen_no
  before insert on orders
  for each row execute function gen_order_no();

-- ─────────────────────────────────────────────
-- RLS
-- ─────────────────────────────────────────────
-- 인증 도입 전: 모든 DB 접근은 서버 측 service_role 키로만 일어남.
-- service_role 은 RLS 를 우회 — RLS 활성화만 해두면 anon 키로의 직접 접근은 막힘.
-- 나중에 사내 Auth 도입 시 'authenticated' 역할 정책 추가 예정.
alter table companies     enable row level security;
alter table products      enable row level security;
alter table cost_history  enable row level security;
alter table orders        enable row level security;
alter table order_items   enable row level security;
alter table shipments     enable row level security;


-- ======================================================================
-- 002_b2b_vat.sql
-- ======================================================================
-- 면세/과세 분리 기능
-- 적용 방법: Supabase Dashboard > SQL Editor 에 전체 붙여넣고 Run.
-- 멱등성 — 이미 적용된 환경에서도 안전하게 재실행 가능.

-- ─────────────────────────────────────────────
-- 1) products.tax_type 추가 (과세/면세)
-- ─────────────────────────────────────────────
alter table products
  add column if not exists tax_type text not null default 'taxable'
    check (tax_type in ('taxable', 'exempt'));

-- ─────────────────────────────────────────────
-- 2) order_items.tax_type 스냅샷 컬럼 추가
--    제품의 tax_type 이 나중에 바뀌어도 기존 발주는 보존되도록 스냅샷.
-- ─────────────────────────────────────────────
alter table order_items
  add column if not exists tax_type text not null default 'taxable'
    check (tax_type in ('taxable', 'exempt'));

-- ─────────────────────────────────────────────
-- 3) 합계 재계산 트리거 — 면세 라인은 VAT 제외
--    기존 함수를 CREATE OR REPLACE 로 교체.
-- ─────────────────────────────────────────────
create or replace function recalc_order_totals() returns trigger as $$
declare
  target_order_id uuid;
  s_total   numeric(14,2);      -- 전체 라인 합 (소계)
  s_taxable numeric(14,2);      -- 과세 라인 합 (VAT 대상)
  v         numeric(14,2);
begin
  target_order_id := coalesce(new.order_id, old.order_id);

  select coalesce(sum(line_total), 0)
    into s_total
    from order_items
   where order_id = target_order_id;

  select coalesce(sum(line_total), 0)
    into s_taxable
    from order_items
   where order_id = target_order_id and tax_type = 'taxable';

  v := round(s_taxable * 0.1, 0);

  update orders
     set subtotal = s_total,
         vat = v,
         total = s_total + v
   where id = target_order_id;
  return null;
end;
$$ language plpgsql;

-- 트리거 자체는 그대로 — 함수만 교체.


-- ======================================================================
-- 003_b2b_payments.sql
-- ======================================================================
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


-- ======================================================================
-- 004_b2b_activity.sql
-- ======================================================================
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


-- ======================================================================
-- 005_b2b_split_shipments.sql
-- ======================================================================
-- 분할 발송: 한 발주에 발송 일정 여러 개 + 발송별 상품/수량
-- 적용: Supabase Dashboard > SQL Editor 에 전체 붙여넣고 Run.
-- 멱등 — 재실행 안전.

-- ─────────────────────────────────────────────
-- 1) shipments 확장: 발송예정일 + 상태 + 순번
-- ─────────────────────────────────────────────
alter table shipments
  add column if not exists ship_date date,
  add column if not exists status text not null default '발송대기'
    check (status in ('발송대기', '발송중', '발송완료', '취소')),
  add column if not exists seq int not null default 1;

-- 기존 단일 송장 데이터 호환: shipped_at 이 있으면 발송완료로 간주
update shipments set status = '발송완료'
  where shipped_at is not null and status = '발송대기';

create index if not exists shipments_ship_date_idx on shipments (ship_date);
create index if not exists shipments_status_idx on shipments (status);

-- ─────────────────────────────────────────────
-- 2) shipment_items: 각 발송 일정에 담길 상품/수량 (정밀 분할)
-- ─────────────────────────────────────────────
create table if not exists shipment_items (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references shipments(id) on delete cascade,
  order_item_id uuid references order_items(id) on delete set null,
  product_name text not null,   -- 스냅샷
  spec text,                    -- 옵션 스냅샷
  qty numeric(12,3) not null,
  created_at timestamptz not null default now()
);

create index if not exists shipment_items_shipment_id_idx on shipment_items (shipment_id);
create index if not exists shipment_items_order_item_id_idx on shipment_items (order_item_id);

alter table shipment_items enable row level security;

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 006_b2b_product_costs.sql
-- ======================================================================
-- 이익률 계산용 원가 상세: 제품원가 + 포장재(내/라벨/외) + 제품부피
-- 적용: Supabase Dashboard > SQL Editor 에 전체 붙여넣고 Run.
-- 멱등 — 재실행 안전.
--
-- 포장비(부피별 아이스박스·운반비)와 보냉비(계절별)는 거의 바뀌지 않는
-- 정적 참조표라 앱 코드 상수(app/lib/b2b-margin.ts)로 관리한다.

alter table products
  add column if not exists cost_material numeric(12,2) not null default 0,  -- 제품원가(제조)
  add column if not exists pkg_inner    numeric(12,2) not null default 0,  -- 내포장지
  add column if not exists pkg_label    numeric(12,2) not null default 0,  -- 라벨
  add column if not exists pkg_outer    numeric(12,2) not null default 0,  -- 외포장지
  add column if not exists volume_kg    numeric(8,3);                       -- 제품부피(kg), null=배송비 계산 제외

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 007_b2b_order_box_count.sql
-- ======================================================================
-- 발주 단위 이익률용: 발주별 배송 박스 수 (박스 단위 배송비 계산)
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table orders
  add column if not exists box_count int not null default 1;

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 008_b2b_fix_order_no.sql
-- ======================================================================
-- 발주번호 채번 버그 수정.
-- 기존 count(*)+1 방식의 문제:
--   1) 같은 날짜 발주를 삭제한 뒤 새로 등록하면 기존 번호와 충돌 (unique 위반 → 등록 실패)
--   2) 두 명이 동시에 등록하면 같은 번호가 발번되어 한쪽이 실패
-- 수정: max(기존 번호)+1 + 날짜별 advisory lock 으로 직렬화.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

create or replace function gen_order_no() returns trigger as $$
declare
  d text := to_char(new.order_date, 'YYYYMMDD');
  n int;
begin
  if new.order_no is null or new.order_no = '' then
    -- 같은 날짜의 발번을 트랜잭션 단위로 직렬화 (동시 등록 충돌 방지)
    perform pg_advisory_xact_lock(hashtext('b2b_order_no_' || d));
    select coalesce(max(nullif(split_part(order_no, '-', 2), '')::int), 0) + 1
      into n
      from orders
     where order_no like d || '-%';
    new.order_no := d || '-' || lpad(n::text, 3, '0');
  end if;
  return new;
end;
$$ language plpgsql;

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 009_b2b_activity_actor.sql
-- ======================================================================
-- 활동 로그에 작업자(actor) 기록 — 비밀번호별 사용자 구분 (지인/예지/현석/관리자)
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table activity_log
  add column if not exists actor text;

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 010_b2b_order_tracking_no.sql
-- ======================================================================
-- 발주 헤더 송장번호 — '발송완료' 상태 변경 시 입력 강제용
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table orders
  add column if not exists tracking_no text;

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 011_b2b_company_doc.sql
-- ======================================================================
-- 업체 사업자등록증 첨부 — Storage 경로 보관 (파일은 비공개 버킷 company-docs)
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table companies
  add column if not exists biz_doc_path text;

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 012_b2b_shipment_status_5stage.sql
-- ======================================================================
-- 발송 차수(하위 발주) 상태를 일반 발주와 동일한 5단계로 변경 ('발송중' 제거).
--   발주확인/생산대기 · 생산요청/생산중 · 생산완료/발송대기 · 발송완료 · 취소
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

-- 1) 기존 CHECK 제약 먼저 제거 (안 그러면 아래 update 가 구 제약에 막힘)
alter table shipments drop constraint if exists shipments_status_check;

-- 2) 기존 값 매핑 (발송대기·발송중 → 생산완료/발송대기)
update shipments set status = '생산완료/발송대기' where status in ('발송대기', '발송중');

-- 3) 새 CHECK 제약 추가 (5단계 + 구값 호환)
alter table shipments add constraint shipments_status_check
  check (status in (
    '발주확인/생산대기', '생산요청/생산중', '생산완료/발송대기', '발송완료', '취소',
    '발송대기', '발송중'   -- 구버전 호환 (UI 에선 더 이상 생성 안 함)
  ));

-- 4) 기본값
alter table shipments alter column status set default '발주확인/생산대기';

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 013_b2b_shipment_box_count.sql
-- ======================================================================
-- 발송 차수(하위 발주)별 박스 수 — 송장 출력 행 수 + 송장번호 입력칸 수의 기준.
--   2박스면 송장 출력 시 2행(이름 넘버링 + '(N박스 중 n)'), 송장번호도 박스당 1개.
-- 발주 단위 box_count(orders.box_count, 이익률용)는 차수 박스 수의 합으로 자동 동기화.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table shipments
  add column if not exists box_count int not null default 1;

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 014_b2b_products_sku_allow_duplicate.sql
-- ======================================================================
-- SKU 중복 허용: products.sku 의 UNIQUE 제약 제거.
--   같은 SKU 를 여러 제품에 입력할 수 있게 함.
--   조회 성능용 비유일(non-unique) 인덱스로 대체.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

-- 1) 유니크 제약 제거 ('sku text unique' 가 만든 제약명: products_sku_key)
alter table products drop constraint if exists products_sku_key;

-- 2) 일반 인덱스로 대체 (검색·매칭용, 중복 허용)
create index if not exists products_sku_idx on products (sku);

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 015_b2b_settings.sql
-- ======================================================================
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


-- ======================================================================
-- 016_b2b_backfill_production_date.sql
-- ======================================================================
-- 016: 생산일 백필
-- 발주 등록 시 보통 생산일을 비워두고 발송일만 지정한다.
-- 기존 발주 중 생산일이 비어 있고 발송일이 있는 건은 생산일을 발송일과 동일하게 채운다.
-- (앞으로는 발주 저장(POST/PUT) 시점에 API 가 자동으로 채움 — 이건 기존 데이터용 1회성 백필)

UPDATE orders
SET production_date = ship_date
WHERE production_date IS NULL
  AND ship_date IS NOT NULL;


-- ======================================================================
-- 017_cs_manual.sql
-- ======================================================================
-- 017: CS 코치 지식베이스(매뉴얼)를 코드에서 DB로 분리.
-- 팀이 코드 수정·재배포 없이 항목을 추가·수정·삭제할 수 있게 함.
-- 초기 내용은 앱이 비어 있을 때 자동 시드(app/lib/cs-manual.ts 의 DEFAULT_CS_MANUAL).

create table if not exists cs_manual (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  content text not null default '',
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists cs_manual_sort_idx on cs_manual (sort_order, created_at);

-- RLS 켜기 (정책 없음). 다른 테이블과 동일 — 앱은 service_role 로만 접근하므로
-- RLS 를 우회해 정상 동작하고, anon/authenticated 키로는 접근 불가(차단)된다.
alter table cs_manual enable row level security;


-- ======================================================================
-- 018_cs_manual_category.sql
-- ======================================================================
-- 018: cs_manual 에 category 추가 (분류·검색용).
-- 017 적용 여부와 무관하게 안전하도록 self-healing 으로 작성:
--   테이블이 없으면 만들고, category 컬럼이 없으면 더하고, RLS 를 보장한다.
-- (017 을 아직 안 돌렸다면 이 018 하나만 돌려도 된다.)

create table if not exists cs_manual (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  content text not null default '',
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table cs_manual add column if not exists category text not null default '일반';

create index if not exists cs_manual_sort_idx on cs_manual (sort_order, created_at);

alter table cs_manual enable row level security;


-- ======================================================================
-- 019_utm_builder.sql
-- ======================================================================
-- UTM 빌더 백엔드: Google Sheet/Apps Script → Supabase 전환.
--   utm_links     : 생성 히스토리 (행 단위 추가/조회/삭제)
--   utm_settings  : 즐겨찾기(랜딩 URL 프리셋) + 소스·매체 맵 (키-값 설정)
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

-- 생성 히스토리 ---------------------------------------------------------------
create table if not exists utm_links (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  base_url   text not null default '',
  source     text not null default '',
  medium     text not null default '',
  campaign   text not null default '',
  content    text not null default '',
  term       text not null default '',
  note       text not null default '',
  full_url   text not null default ''
);

create index if not exists utm_links_created_at_idx on utm_links (created_at desc);

alter table utm_links enable row level security;

-- 설정(즐겨찾기 + 소스·매체 맵) -------------------------------------------------
--   key='url_presets'        → [{label, value}] 배열 (랜딩페이지 즐겨찾기)
--   key='source_medium_map'  → { source: [medium, ...] } 객체 (소스별 추천 매체)
create table if not exists utm_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

alter table utm_settings enable row level security;

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 020_subscription_snapshots.sql
-- ======================================================================
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


-- ======================================================================
-- 021_orders_exported_at.sql
-- ======================================================================
-- 발주 → 매출 구글시트 전송 1회 가드.
--   exported_at 가 차 있으면 이미 시트로 전송된 발주 → 재전송 안 함.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table orders add column if not exists exported_at timestamptz;

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 022_b2b_status_4axis.sql
-- ======================================================================
-- 발주 상태 4축 재설계: 생산(발주 단위) · 발송(차수) · 입금 · 발행 분리.
--   생산: 생산대기/생산중/생산완료  (orders.production_status 신설, 발주 단위)
--   발송: 발송대기/발송완료/취소     (orders.status = 차수 롤업, shipments.status = 차수별)
--   입금: 입금전/일부입금/입금완료/불필요
--   발행: 미발행/발행완료/불필요
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

-- 1) 기존/신규 CHECK 제약 제거 (재실행 안전)
alter table orders drop constraint if exists orders_status_check;
alter table orders drop constraint if exists orders_production_status_check;
alter table orders drop constraint if exists orders_payment_status_check;
alter table orders drop constraint if exists orders_tax_invoice_status_check;
alter table shipments drop constraint if exists shipments_status_check;

-- 2) 생산 상태 컬럼 신설 (발주 단위)
alter table orders add column if not exists production_status text not null default '생산대기';

-- 3) 데이터 매핑
--   3a) 생산상태 = 기존 status 로부터 도출 (status 가 아직 옛 값일 때만 — 재실행 안전)
update orders set production_status = case
    when status in ('생산완료/발송대기','발송완료') then '생산완료'
    when status = '생산요청/생산중' then '생산중'
    else '생산대기' end
  where status in ('발주확인/생산대기','생산요청/생산중','생산완료/발송대기','발송완료','취소');
--   3b) orders.status → 발송 축
update orders set status = case
    when status = '발송완료' then '발송완료'
    when status = '취소' then '취소'
    else '발송대기' end;
--   3c) shipments.status → 발송 축
update shipments set status = case
    when status = '발송완료' then '발송완료'
    when status = '취소' then '취소'
    else '발송대기' end;
--   3d) 입금 라벨
update orders set payment_status = case
    when payment_status = '미입금' then '입금전'
    when payment_status = '부분입금' then '일부입금'
    when payment_status = '확인불필요' then '불필요'
    else payment_status end;
--   3e) 발행 라벨
update orders set tax_invoice_status = case
    when tax_invoice_status = '면제' then '불필요'
    when tax_invoice_status = '발행대기' then '미발행'
    else tax_invoice_status end;

-- 4) 기본값 + 새 CHECK 제약
alter table orders alter column status set default '발송대기';
alter table orders alter column production_status set default '생산대기';
alter table orders alter column payment_status set default '입금전';
alter table orders alter column tax_invoice_status set default '미발행';
alter table shipments alter column status set default '발송대기';

-- CHECK 는 신·구 값을 모두 허용(permissive) — 마이그레이션을 배포 전에 먼저 적용해도
-- 구 코드(옛 라벨로 insert)가 깨지지 않도록. 배포 후엔 신 코드가 신 값만 기록함.
alter table orders add constraint orders_status_check
  check (status in ('발송대기','발송완료','취소','발주확인/생산대기','생산요청/생산중','생산완료/발송대기'));
alter table orders add constraint orders_production_status_check
  check (production_status in ('생산대기','생산중','생산완료'));
alter table orders add constraint orders_payment_status_check
  check (payment_status in ('입금전','일부입금','입금완료','불필요','미입금','부분입금','확인불필요'));
alter table orders add constraint orders_tax_invoice_status_check
  check (tax_invoice_status in ('미발행','발행완료','불필요','발행대기','면제'));
alter table shipments add constraint shipments_status_check
  check (status in ('발송대기','발송완료','취소','발주확인/생산대기','생산요청/생산중','생산완료/발송대기'));

create index if not exists orders_production_status_idx on orders (production_status);

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 023_voc.sql
-- ======================================================================
-- VOC(고객의 소리) 관리 — 직접 입력부터. 설문(탈리)·리뷰는 source 로 구분해 같은 표에 적재.
-- 적용: Supabase Dashboard > SQL Editor 에 전체 붙여넣고 Run. 멱등 — 재실행 안전.
-- (이전 버전 023 을 이미 실행했다면, 데이터가 없을 때 먼저 `drop table if exists voc cascade;` 한 줄 실행 후 아래 실행.)

create table if not exists voc (
  id uuid primary key default gen_random_uuid(),
  received_at date not null default current_date,        -- 접수일
  channel text,                                          -- 접수채널 (전화/카톡/이메일/리뷰/설문 등)
  source text not null default '직접입력'
    check (source in ('직접입력', '설문', '리뷰', '기타')), -- 수집 방식(자동수집 구분용; 직접입력 폼 기본값)
  customer text,                                         -- 고객명
  purchase_date date,                                    -- 구매일
  purchase_place text,                                   -- 구매처
  product text,                                          -- 구매상품
  category text not null default '배송'
    check (category in ('배송', '품질', '포장', '누락', '오배송', '가시', '이물', '기타')), -- 클레임 유형
  content text not null,                                 -- 상세내용
  resolution text,                                       -- 처리내용
  cause text,                                            -- 원인
  status text not null default '대기'
    check (status in ('대기', '진행중', '완료')),          -- 처리 상태
  improvement text,                                      -- 개선 필요사항
  assignee text,                                         -- 담당자(선택)
  sentiment text check (sentiment in ('긍정', '부정', '중립')), -- 자동분류 대비(선택)
  loss_amount numeric(12,0) not null default 0,          -- 손해/보상 금액(손해금액 산정 기능용)
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists voc_status_idx on voc (status);
create index if not exists voc_received_idx on voc (received_at desc);
create index if not exists voc_category_idx on voc (category);
create index if not exists voc_source_idx on voc (source);

alter table voc enable row level security;  -- 서비스롤로만 접근(정책 없음)

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 024_voc_photos.sql
-- ======================================================================
-- VOC 개선요청서용: 제품 생산일 + 사진 첨부.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table voc add column if not exists production_date date;           -- 제품 생산일(제조사 배치 추적용)
alter table voc add column if not exists photos jsonb not null default '[]'::jsonb; -- 첨부 사진 공개 URL 배열

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 025_survey_responses.sql
-- ======================================================================
-- 설문 응답 수집(Tally 등) — VOC 클레임과 분리된 별도 수집란.
-- 폼이 제각각이므로 답변을 통째로 jsonb 로 보존. 적용: SQL Editor 에 붙여넣고 Run. 멱등.

create table if not exists survey_responses (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'tally',          -- 수집 출처
  form_id text,                                  -- 폼 식별자
  form_name text,                                -- 폼 이름
  submission_id text unique,                     -- 제출 고유 id (중복 방지)
  respondent text,                               -- 응답자(이름/이메일 등, 추출 시)
  submitted_at timestamptz,                      -- 제출 시각
  answers jsonb not null default '[]'::jsonb,    -- [{label, value}] 질문·답변 전체
  summary text,                                  -- 미리보기/검색용 합친 텍스트
  photos jsonb not null default '[]'::jsonb,     -- 첨부 파일 URL 배열
  created_at timestamptz not null default now()
);

create index if not exists survey_responses_submitted_idx on survey_responses (submitted_at desc);
create index if not exists survey_responses_form_idx on survey_responses (form_id);

alter table survey_responses enable row level security;  -- 서비스롤로만 접근(정책 없음)

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 026_app_users.sql
-- ======================================================================
-- 로그인 계정(아이디 관리 화면용). 환경변수(B2B_PASSWORD/B2B_USERS) 계정과 병행 — 둘 다 로그인 가능.
-- 적용: SQL Editor 에 붙여넣고 Run. 멱등.

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,          -- 표시 이름(중복 불가)
  password text not null,             -- 로그인 비밀번호(신원 구분)
  active boolean not null default true,
  created_by text,
  created_at timestamptz not null default now()
);

alter table app_users enable row level security;  -- 서비스롤로만 접근(정책 없음)

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 027_voc_buyer_comp.sql
-- ======================================================================
-- VOC 폼 강화: 구매자 구분(첫/재구매) + 보상유형·수량(손해금액 자동계산) + 고객 특이사항.
-- 접수채널(channel)은 UI 에서만 제거하고 컬럼은 유지(기존 데이터 보존). 멱등 — 재실행 안전.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run.

alter table voc add column if not exists buyer_type text
  check (buyer_type in ('첫구매', '재구매'));                         -- 구매자 구분(선택)
alter table voc add column if not exists comp_type text not null default '없음'
  check (comp_type in ('환불', '반품', '교환·재발송', '추가보상', '부분환불', '없음')); -- 보상유형
alter table voc add column if not exists comp_qty integer not null default 1;  -- 보상 수량(자동계산용)
alter table voc add column if not exists customer_note text;          -- 고객 특이사항

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 028_product_retail_price.sql
-- ======================================================================
-- 상품 마스터 가격 정리: 소비자 판매가(retail_price) 추가.
--  기존 sale_price 는 'B2B 도매가(소비자가의 10% 할인가)' 로 의미 확정.
--  기존 행은 도매가로부터 소비자가를 역산해 백필: retail = round(sale_price / 0.9).
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table products add column if not exists retail_price numeric(12,2) not null default 0; -- 소비자 판매가

-- 최초 1회 백필(아직 소비자가가 비어있고 도매가가 있는 행만)
update products set retail_price = round(sale_price / 0.9)
  where retail_price = 0 and sale_price > 0;

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 029_voc_status_stages.sql
-- ======================================================================
-- VOC 처리상태 3단계 재정의: 접수 / 응대·개선중 / 개선완료 (씨몬스터 기본 워크플로)
--  기존(대기·진행중·완료) → 신규로 매핑 후 체크 제약·기본값 교체. 멱등 — 재실행 안전.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run.

alter table voc drop constraint if exists voc_status_check;
alter table voc alter column status drop default;

update voc set status = '접수'       where status = '대기';
update voc set status = '응대·개선중' where status = '진행중';
update voc set status = '개선완료'    where status = '완료';

alter table voc alter column status set default '접수';
alter table voc add constraint voc_status_check check (status in ('접수', '응대·개선중', '개선완료'));

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 030_voc_fault.sql
-- ======================================================================
-- VOC 손해 귀책(누구 책임인가) — 제조사 청구가능액 vs 자사 부담액 분리용.
--  제조사 / 물류 / 자사 / 고객 / 미분류. 기존 행은 클레임유형 기준 1차 자동 추정 백필.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table voc add column if not exists fault text not null default '미분류'
  check (fault in ('제조사', '물류', '자사', '고객', '미분류'));

-- 최초 1회 추정 백필(아직 미분류인 행만; 사람이 건별로 보정 가능)
update voc set fault = '제조사' where fault = '미분류' and category in ('품질', '가시', '이물', '포장');
update voc set fault = '물류'   where fault = '미분류' and category in ('배송', '오배송');
update voc set fault = '자사'   where fault = '미분류' and category in ('누락');

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 031_inventory.sql
-- ======================================================================
-- 재고관리 — 자체 재고 원장(박스히어로 대체).
--  품목은 products(상품 마스터)를 그대로 사용. 현재고 = inventory_txns.qty 합.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

-- 재고 원장: 입고(+)/출고(-)/조정(±) 한 줄씩. 현재고 = Σqty, 과거수량 = 특정일까지 Σqty.
create table if not exists inventory_txns (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  type text not null check (type in ('입고', '출고', '조정')),  -- 입고=매입, 출고=판매/소진, 조정=실사보정
  qty integer not null,                       -- 부호 있는 재고 변화량(입고+, 출고-, 조정±)
  unit_amount numeric(12,2),                  -- 입고=매입단가, 출고=판매단가(선택)
  txn_date date not null default current_date,-- 거래일(과거수량 산정 기준)
  partner text,                               -- 매입처/판매처(선택)
  memo text,                                  -- 사유/메모
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists inv_txn_product_idx on inventory_txns (product_id);
create index if not exists inv_txn_date_idx on inventory_txns (txn_date desc);
create index if not exists inv_txn_type_idx on inventory_txns (type);

-- 품목별 재고 설정(안전재고 등). 행이 없으면 min_qty=0 으로 간주.
create table if not exists inventory_items (
  product_id uuid primary key references products(id) on delete cascade,
  min_qty integer not null default 0,         -- 재고부족 기준(안전재고)
  barcode text,
  location text,                              -- 보관 위치
  memo text,
  updated_at timestamptz not null default now()
);

alter table inventory_txns enable row level security;
alter table inventory_items enable row level security;

-- 현재고/과거수량 집계(품목당 1행) — 클라이언트의 1000행 제한과 무관하게 정확히 합산.
--  asof 지정 시 그 날짜까지 누적. 서비스롤 rpc 로 호출.
create or replace function inventory_stock(asof date default null)
returns table (product_id uuid, qty bigint)
language sql stable as $$
  select t.product_id, coalesce(sum(t.qty), 0)::bigint
  from inventory_txns t
  where asof is null or t.txn_date <= asof
  group by t.product_id
$$;

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 032_product_purchase_attrs.sql
-- ======================================================================
-- 상품 마스터 확장: 매입단가 + 원산지 + 속성(분류).
--  매입단가 = 구매 시 단가(외포장지 등 제외, 상품마다 다름). cost_price(제품단위원가)와 별개.
--  비고는 기존 notes 컬럼을 사용(화면에서 '비고'로 표기).
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table products
  add column if not exists purchase_price numeric(12,2) not null default 0,  -- 매입단가(구매 단가)
  add column if not exists origin text,                                       -- 원산지
  add column if not exists attrs  text;                                       -- 속성/분류(자유 입력)

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 033_inventory_orders.sql
-- ======================================================================
-- 재고 입출고 묶음(주문) — 한 번에 입력한 라인들을 group_id + order_no(IN-/OUT- 일련번호)로 묶는다.
--  구매창/엑셀 일괄/단건 기록 모두 저장 시 같은 번호로 묶여 '주문 단위'로 조회 가능.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table inventory_txns add column if not exists group_id uuid;
alter table inventory_txns add column if not exists order_no text;
create index if not exists inv_txn_group_idx on inventory_txns (group_id);
create index if not exists inv_txn_orderno_idx on inventory_txns (order_no);

-- 유형별 일련번호(원자적). 입고=IN, 출고=OUT.
create sequence if not exists inv_order_in_seq;
create sequence if not exists inv_order_out_seq;

create or replace function next_inventory_order_no(p_type text) returns text
language sql volatile as $$
  select (case when p_type = '출고' then 'OUT-' else 'IN-' end)
    || lpad(nextval((case when p_type = '출고' then 'inv_order_out_seq' else 'inv_order_in_seq' end)::regclass)::text, 6, '0');
$$;

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 034_inventory_status.sql
-- ======================================================================
-- 재고 입출고 상태: 대기 / 완료. 즉시입고/즉시출고 미체크 시 '대기'로 기록되고, 현재고에 반영 안 됨.
--  '입고처리/출고처리' 로 완료 전환 시 재고 반영. 현재고(inventory_stock)는 '완료'만 집계.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table inventory_txns add column if not exists status text not null default '완료'
  check (status in ('대기', '완료'));
create index if not exists inv_txn_status_idx on inventory_txns (status);

-- 현재고/과거수량 = '완료' 건만 합산.
create or replace function inventory_stock(asof date default null)
returns table (product_id uuid, qty bigint)
language sql stable as $$
  select t.product_id, coalesce(sum(t.qty), 0)::bigint
  from inventory_txns t
  where t.status = '완료' and (asof is null or t.txn_date <= asof)
  group by t.product_id
$$;

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 035_b2b_shipment_stock_out.sql
-- ======================================================================
-- 035_b2b_shipment_stock_out.sql
-- B2B 발송 일정 '등록 시점'에 재고를 즉시 출고(선점)하기 위한 컬럼.
--  소매 주문수집처럼 발송 잡는 순간 재고를 깎아 오버부킹을 막는다(발송완료 차감은 너무 늦음).
--
--  - shipments.stock_out : 이 차수 저장 시 재고원장에 '출고'를 즉시 기록할지. 기본 false(기존 발주엔 영향 없음).
--  - inventory_txns.shipment_id : 그 출고가 어느 발송 차수에서 나왔는지 연결.
--      발주 PUT 은 shipments 를 전부 삭제·재삽입하므로, on delete cascade 로 옛 출고가 자동 삭제(재고 원복)되고
--      재저장 시 다시 기록 → 편집/삭제해도 이중 차감이 생기지 않음.

alter table shipments add column if not exists stock_out boolean not null default false;

alter table inventory_txns add column if not exists shipment_id uuid references shipments(id) on delete cascade;
create index if not exists inv_txn_shipment_idx on inventory_txns(shipment_id);

-- PostgREST 스키마 캐시 갱신
NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 036_inventory_channel.sql
-- ======================================================================
-- 036_inventory_channel.sql
-- 재고를 '도매/소매' 채널로 분리. 같은 품목(SKU)이라도 채널별로 현재고를 따로 집계한다.
--  - inventory_txns.channel : 이 입·출고·조정이 어느 채널 재고를 움직였는지. 기존 원장은 전부 '소매'.
--  - inventory_stock(asof, chan) : chan 지정 시 그 채널만, null 이면 전체(도매+소매) 합산.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

-- 1) 채널 컬럼(기존 행은 default 로 전부 '소매'로 채워짐 = 사용자 선택: 기존은 소매로 시작)
alter table inventory_txns add column if not exists channel text not null default '소매';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'inventory_txns_channel_chk') then
    alter table inventory_txns add constraint inventory_txns_channel_chk check (channel in ('도매', '소매'));
  end if;
end $$;

create index if not exists inv_txn_channel_idx on inventory_txns (channel);

-- 2) 집계 함수에 채널 인자 추가. 기존 1-인자 함수는 제거하고 2-인자(둘 다 기본값)로 대체.
--    chan is null → 전체(도매+소매), chan='도매'/'소매' → 해당 채널만.
--    기존 호출부( .rpc('inventory_stock', {asof}) )는 chan 이 기본 null 이라 그대로 전체 합산으로 동작.
drop function if exists inventory_stock(date);
create or replace function inventory_stock(asof date default null, chan text default null)
returns table (product_id uuid, qty bigint)
language sql stable as $$
  select t.product_id, coalesce(sum(t.qty), 0)::bigint
  from inventory_txns t
  where (asof is null or t.txn_date <= asof)
    and (chan is null or t.channel = chan)
  group by t.product_id
$$;

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 037_product_bundles.sql
-- ======================================================================
-- 037_product_bundles.sql
-- 묶음(세트) 제품 — 특정 상품(부모 SKU)을 여러 구성품(자식 상품 × 수량)으로 분해 인식.
--  예) SET-DG-100 = DG-100-O-100 × n + AG-100-K-100 × m.
--  묶음 부모는 자체 재고를 갖지 않고, 판매/구매(출고/입고) 시 구성품으로 분해되어 기록된다.
--  묶음 가용재고 = min( 구성품 현재고 ÷ 구성수량 ) — 만들 수 있는 세트 수.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

create table if not exists product_bundles (
  parent_id uuid not null references products(id) on delete cascade,   -- 묶음(세트) 상품
  component_id uuid not null references products(id) on delete cascade, -- 구성품
  qty integer not null default 1 check (qty > 0),                       -- 세트 1개당 구성품 수량
  primary key (parent_id, component_id)
);
create index if not exists product_bundles_parent_idx on product_bundles (parent_id);
create index if not exists product_bundles_component_idx on product_bundles (component_id);

alter table product_bundles enable row level security;

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 038_qr_short_links.sql
-- ======================================================================
-- 038_qr_short_links.sql
-- QR/숏링크 — 동적 QR = 우리 도메인의 짧은 URL(/q/{code})을 인코딩하고, 접속 시 목적지로 리다이렉트.
--  목적지는 나중에 바꿔도 QR 이미지는 재사용 가능. 스캔(접속) 이벤트를 기록해 통계 제공.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

create table if not exists short_links (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,             -- 짧은 코드 (/q/{code})
  target_url text not null,              -- 리다이렉트 목적지
  title text,                            -- 라벨/메모
  active boolean not null default true,
  scan_count integer not null default 0, -- 누적 스캔(빠른 표시용 비정규화)
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists short_links_code_idx on short_links (code);

create table if not exists qr_scans (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references short_links(id) on delete cascade,
  scanned_at timestamptz not null default now(),
  referer text,
  user_agent text,
  country text                           -- 대략 국가(Vercel x-vercel-ip-country) — 개인식별정보 아님. IP 원본은 저장하지 않음.
);
create index if not exists qr_scans_link_idx on qr_scans (link_id, scanned_at desc);

alter table short_links enable row level security;
alter table qr_scans enable row level security;

-- 코드로 목적지 조회 + 스캔 기록 + 카운트 증가를 한 번에(리다이렉트 1회 왕복). 비활성/없음이면 null.
create or replace function qr_resolve(p_code text, p_referer text, p_ua text, p_country text)
returns text
language plpgsql
as $$
declare v_id uuid; v_url text; v_active boolean;
begin
  select id, target_url, active into v_id, v_url, v_active from short_links where code = p_code;
  if v_id is null or v_active is false then return null; end if;
  insert into qr_scans (link_id, referer, user_agent, country) values (v_id, left(p_referer, 500), left(p_ua, 500), left(p_country, 8));
  update short_links set scan_count = scan_count + 1 where id = v_id;
  return v_url;
end $$;

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 039_sales.sql
-- ======================================================================
-- 039_sales.sql
-- 매출 서브시스템: 분석 원장(PII 없음) + 고객 조회(PII 격리) + 리포트 발송 이력.
--  customer_key = HMAC-SHA256(SALES_PII_PEPPER, digits(phone)) — 백필=웹업로드=검색 동일 로직(app/lib/sales-normalize.ts).
--  멱등키 = row_hash(정규화 비즈니스컬럼 파이프조인 SHA-256) → 재업로드/백필 재실행 안전(중복 0).
--  적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등(IF NOT EXISTS)이라 재실행 안전.

-- ── (a) 분석 원장 : 넓게·자주 조회 → PII 없음(customer_key만). 루커 친화 플랫. ──
create table if not exists sales_orders (
  id              uuid primary key default gen_random_uuid(),
  channel         text    not null default '',
  order_date      date    not null,                  -- KST 기준일(정본). 루커/월·주 경계 집계용
  order_date_int  integer not null,                  -- yyyymmdd (파이썬 정규화 1:1, row_hash 재현)
  order_year      integer generated always as (extract(year  from order_date)::int) stored,
  order_month     integer generated always as (extract(month from order_date)::int) stored,
  order_id        text    not null default '',
  product_name    text    not null default '',
  option_name     text    not null default '',
  sku_code        text    not null default '',       -- Top10 집계축
  quantity        integer not null default 0,
  selling_price   bigint  not null default 0,
  option_price    bigint  not null default 0,
  subtotal_amount bigint  not null default 0,         -- 매출 합계축
  shipping_fee    bigint  not null default 0,
  customer_key    text    not null default '',        -- HMAC. 원본 전화 없음. 빈 전화=''
  row_hash        text    not null,                   -- 멱등 유니크키
  source          text    not null default 'web',     -- 'web' | 'backfill-YYYYMMDD'
  created_at      timestamptz not null default now()
);
create unique index if not exists sales_orders_row_hash_uk    on sales_orders (row_hash);
create index if not exists sales_orders_date_idx         on sales_orders (order_date);
create index if not exists sales_orders_ym_idx           on sales_orders (order_year, order_month);
create index if not exists sales_orders_channel_date_idx on sales_orders (channel, order_date);
create index if not exists sales_orders_sku_date_idx     on sales_orders (sku_code, order_date);
create index if not exists sales_orders_custkey_date_idx on sales_orders (customer_key, order_date);
create index if not exists sales_orders_orderid_idx      on sales_orders (order_id);

-- ── (b) 고객 조회 : 좁은 용도(주문검색 API 전용). 원본 전화 보유(우리 소유 사본). ──
create table if not exists sales_customers (
  customer_key    text primary key,                  -- HMAC(pepper, digits(phone))
  phone           text not null,                     -- 원본 정규화(하이픈 포맷)
  phone_digits    text not null,                     -- 숫자만(부분검색 폴백 인덱스)
  customer_name   text,
  first_seen_date date,
  last_seen_date  date,
  order_count     integer not null default 0,        -- 배치 종료 후 재집계로 세팅(멱등)
  updated_at      timestamptz not null default now()
);
create index if not exists sales_customers_digits_idx on sales_customers (phone_digits);

-- ── (c) 리포트 발송 이력 + stats 스냅샷. 발송 성공 시에만 insert(미리보기는 미기록). ──
create table if not exists sales_reports (
  id           uuid primary key default gen_random_uuid(),
  report_type  text not null check (report_type in ('daily','weekly')),
  base_date    date not null,
  period_start date,
  period_end   date,
  subject      text not null,
  html         text,                                 -- 발송 스냅샷(감사·재열람)
  stats        jsonb,                                 -- 계산값 원본(추세·재현)
  status       text not null default 'sent' check (status in ('sent','failed')),
  recipients   text[],
  sent_by      text,
  error        text,
  sent_at      timestamptz not null default now()
);
create index if not exists sales_reports_type_date_idx on sales_reports (report_type, base_date desc);

alter table sales_orders    enable row level security;
alter table sales_customers enable row level security;
alter table sales_reports   enable row level security;

-- ═════════════ 집계 RPC (지표별, service role stable). 200k+ DB 집계 ═════════════

-- 기간 요약(매출/주문수/객단가)
create or replace function sales_summary(p_from date, p_to date, p_channel text default null)
returns table (revenue bigint, orders bigint, aov bigint)
language sql stable as $$
  select coalesce(sum(subtotal_amount),0)::bigint,
         count(distinct order_id)::bigint,
         case when count(distinct order_id) > 0
              then round(sum(subtotal_amount)::numeric / count(distinct order_id))::bigint else 0 end
  from sales_orders
  where order_date between p_from and p_to
    and (p_channel is null or channel = p_channel)
$$;

-- 누적(연/전년/월/전월) 4버킷 단일 스캔 — 파이썬 line 491-501 1:1
create or replace function sales_cumulative(p_year int, p_month int)
returns table (this_year bigint, last_year bigint, this_month bigint, prev_month bigint)
language sql stable as $$
  select
    coalesce(sum(subtotal_amount) filter (where order_year = p_year),0)::bigint,
    coalesce(sum(subtotal_amount) filter (where order_year = p_year-1),0)::bigint,
    coalesce(sum(subtotal_amount) filter (where order_year = p_year and order_month = p_month),0)::bigint,
    coalesce(sum(subtotal_amount) filter (
      where order_year  = case when p_month = 1 then p_year-1 else p_year end
        and order_month = case when p_month = 1 then 12 else p_month-1 end),0)::bigint
  from sales_orders
$$;

-- 채널별 누적(연/전년/월/전월)
create or replace function sales_channel_cumulative(p_year int, p_month int)
returns table (channel text, this_year bigint, last_year bigint, this_month bigint, prev_month bigint)
language sql stable as $$
  select channel,
    coalesce(sum(subtotal_amount) filter (where order_year = p_year),0)::bigint,
    coalesce(sum(subtotal_amount) filter (where order_year = p_year-1),0)::bigint,
    coalesce(sum(subtotal_amount) filter (where order_year = p_year and order_month = p_month),0)::bigint,
    coalesce(sum(subtotal_amount) filter (
      where order_year  = case when p_month = 1 then p_year-1 else p_year end
        and order_month = case when p_month = 1 then 12 else p_month-1 end),0)::bigint
  from sales_orders group by channel order by 2 desc
$$;

-- 채널별 기간 매출(window)
create or replace function sales_channel_window(p_from date, p_to date)
returns table (channel text, revenue bigint)
language sql stable as $$
  select channel, coalesce(sum(subtotal_amount),0)::bigint from sales_orders
  where order_date between p_from and p_to group by channel order by 2 desc
$$;

-- Top SKU(기간)
create or replace function sales_top_sku(p_from date, p_to date, p_limit int default 10)
returns table (sku_code text, revenue bigint, qty bigint)
language sql stable as $$
  select sku_code, coalesce(sum(subtotal_amount),0)::bigint, coalesce(sum(quantity),0)::bigint
  from sales_orders where order_date between p_from and p_to and sku_code <> ''
  group by sku_code order by 2 desc limit p_limit
$$;

-- 신규:재구매 — window 고객이 window '이전'에도 등장했는지 (파이썬 line 544-553 1:1)
create or replace function sales_new_repeat(p_from date, p_to date)
returns table (total bigint, new_cust bigint, repeat_cust bigint)
language sql stable as $$
  with win as (
    select distinct customer_key from sales_orders
    where order_date between p_from and p_to and customer_key <> ''
  ), flagged as (
    select w.customer_key,
           exists(select 1 from sales_orders b
                    where b.customer_key = w.customer_key and b.order_date < p_from) as is_repeat
    from win w
  )
  select count(*)::bigint,
         count(*) filter (where not is_repeat)::bigint,
         count(*) filter (where is_repeat)::bigint
  from flagged
$$;

-- 객단가+최고/최저 주문건(주문단위 재구성 = 파이썬 line 564-573)
create or replace function sales_order_extremes(p_from date, p_to date)
returns table (aov bigint, order_count bigint, max_order bigint, min_order bigint,
               max_order_id text, min_order_id text)
language sql stable as $$
  with per_order as (
    select order_id, sum(subtotal_amount)::bigint amt from sales_orders
    where order_date between p_from and p_to group by order_id
  )
  select case when count(*) > 0 then (sum(amt)/count(*))::bigint else 0 end,
         count(*)::bigint, coalesce(max(amt),0), coalesce(min(amt),0),
         (select order_id from per_order order by amt desc, order_id limit 1),
         (select order_id from per_order order by amt asc,  order_id limit 1)
  from per_order
$$;

-- 일별 매출(일요일 금~일 3줄 / 주간 트렌드 공용)
create or replace function sales_daily_breakdown(p_from date, p_to date)
returns table (d date, revenue bigint)
language sql stable as $$
  select order_date, coalesce(sum(subtotal_amount),0)::bigint from sales_orders
  where order_date between p_from and p_to group by order_date order by order_date
$$;

-- 한 주문의 sku 목록(최고/최저 주문건 품목코드 재현)
create or replace function sales_order_skus(p_order_id text)
returns table (sku_code text)
language sql stable as $$
  select distinct sku_code from sales_orders where order_id = p_order_id and sku_code <> '' order by 1
$$;

-- 데이터 범위(최소/최대 주문일) — base 기본값·업로드 안내용
create or replace function sales_date_bounds()
returns table (min_date date, max_date date, total_rows bigint)
language sql stable as $$
  select min(order_date), max(order_date), count(*)::bigint from sales_orders
$$;

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 040_sales_upload_batch.sql
-- ======================================================================
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


-- ======================================================================
-- 041_sales_looker.sql
-- ======================================================================
-- 041 Looker Studio 연동용 읽기전용 접근.
--  · sales_looker: 매출 원장(sales_orders)에서 '분석에 필요한 컬럼만' 노출하는 뷰(내부컬럼 row_hash/id/source/upload_batch 제외).
--    sales_orders 자체가 PII(전화·이름) 없음 → Looker 노출 안전. sales_customers(PII)는 절대 노출 안 함.
--  · looker_ro: 읽기전용 로그인 역할. sales_looker 만 SELECT 가능(뷰는 소유자 권한으로 실행 = definer, security_invoker 미사용).
--    → looker_ro 는 다른 테이블/뷰를 볼 수 없음.
--  ⚠️ 비밀번호는 여기(깃)에 넣지 않습니다. 아래 [사용자 1회 설정] 참고.

create or replace view public.sales_looker as
  select
    order_date,                         -- 주문일자(정본 KST 기준일, 시계열 축)
    order_year,
    order_month,
    channel,                            -- 판매처
    order_id,                           -- 주문번호
    product_name,                       -- 상품명
    option_name,                        -- 옵션명
    sku_code,                           -- 관리코드(SKU, Top 집계축)
    quantity,                           -- 수량
    selling_price,                      -- 판매가
    option_price,                       -- 옵션가
    subtotal_amount,                    -- 결제금액(매출 합계축)
    shipping_fee,                       -- 배송비
    customer_key                        -- 고객 식별 해시(HMAC, PII 아님 · 재구매 분석용)
  from public.sales_orders;

-- 읽기전용 역할(없으면 생성). 비밀번호는 미설정 → 아래 사용자 설정 전엔 로그인 불가.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'looker_ro') then
    create role looker_ro login;
  end if;
end $$;

grant usage on schema public to looker_ro;
grant select on public.sales_looker to looker_ro;

-- [사용자 1회 설정 — SQL Editor에서 별도 실행, 깃에 커밋 금지]
--   alter role looker_ro with password '강한_무작위_비밀번호_16자이상';
-- 필요 시 회수: revoke select on public.sales_looker from looker_ro;

notify pgrst, 'reload schema';


-- ======================================================================
-- 042_voc_flow.sql
-- ======================================================================
-- 042 VOC → flow.team(플로우) 업무 등록 연동.
--  · 한 VOC를 flow 프로젝트의 업무(task)로 등록한 뒤, 중복 등록 방지 + '등록됨' 표시용 링크 컬럼.
alter table voc add column if not exists flow_task_id    text;         -- flow가 반환한 업무(post) 식별자(있으면)
alter table voc add column if not exists flow_project_id text;         -- 어느 프로젝트에 등록됐는지
alter table voc add column if not exists flow_task_at    timestamptz;  -- 등록 시각(값 있으면 '등록됨')

notify pgrst, 'reload schema';


-- ======================================================================
-- 043_sales_profit.sql
-- ======================================================================
-- 043 채널별 매출·이익 계산 (파이썬 채널별_매출이익 이식).
--  · sales_sku_cost: 관리코드(sku_code)별 원가·중량. 백데이터(이익률계산백데이터.xlsx 시트1) 시드/갱신.
--    products는 sku 체계가 달라 매칭 안 됨 → 별도 원장.
--  · 매출은 sales_orders(기간). 택배보냉비=중량→총액 계단(백데이터 택배포장, 계절 무관 고정), 주문당 1회(합배송).
--    수수료율·배송비매출(4,000/주문)은 API에서 적용(파이썬 값 그대로).

create table if not exists sales_sku_cost (
  sku_code     text primary key,
  product_name text,
  weight_kg    numeric(10,3) not null default 0,   -- 상품 1개 중량(kg)
  cost_price   bigint        not null default 0,   -- 상품 1개 원가(원)
  updated_at   timestamptz   not null default now()
);

-- 채널별 집계: 주문수·총결제금액·총상품원가·총택배보냉비. (원가/중량 미매칭은 0으로 계산 = 파이썬 fillna(0))
create or replace function sales_profit_summary(p_from date, p_to date)
returns table(channel text, orders bigint, pay_amount bigint, product_cost bigint, cooling bigint)
language sql stable as $$
  with ord as (
    select o.channel, o.order_id,
      sum(o.subtotal_amount)                                as revenue,
      sum(o.quantity * coalesce(c.cost_price, 0))           as pcost,
      round(sum(o.quantity * coalesce(c.weight_kg, 0)), 1)  as wt   -- 주문 총중량(0.1 그리드)
    from sales_orders o
    left join sales_sku_cost c on c.sku_code = o.sku_code
    where o.order_date between p_from and p_to
    group by o.channel, o.order_id
  )
  select channel,
    count(*)::bigint                     as orders,
    sum(revenue)::bigint                 as pay_amount,
    sum(pcost)::bigint                   as product_cost,
    sum(                                              -- 택배포장 총액 계단(중량→비용), 주문당 1회
      case
        when wt >= 12.1 then 7860
        when wt >= 10.1 then 7310
        when wt >= 5.1  then 6930
        when wt >= 4.1  then 6760
        when wt >= 3.1  then 5830
        when wt >= 2.1  then 5720
        when wt >= 1.6  then 4680
        else 4240
      end
    )::bigint                            as cooling
  from ord
  group by channel
  order by pay_amount desc;
$$;

-- 원가/중량 백데이터에 없는 관리코드(미매칭) 요약 — 파이썬 '미매칭_관리코드' 시트.
create or replace function sales_profit_unmatched(p_from date, p_to date)
returns table(sku_code text, line_count bigint, qty_sum bigint, amount_sum bigint, channels text)
language sql stable as $$
  select o.sku_code,
    count(*)::bigint             as line_count,
    sum(o.quantity)::bigint      as qty_sum,
    sum(o.subtotal_amount)::bigint as amount_sum,
    string_agg(distinct o.channel, ', ') as channels
  from sales_orders o
  left join sales_sku_cost c on c.sku_code = o.sku_code
  where o.order_date between p_from and p_to
    and c.sku_code is null
  group by o.sku_code
  order by amount_sum desc;
$$;

notify pgrst, 'reload schema';


-- ======================================================================
-- 044_sales_profit_products.sql
-- ======================================================================
-- 044 채널별 이익 원가·중량 소스를 '상품마스터(products)'로 전환.
--  · 원가 = products.cost_price(제조원가+포장재), 중량 = products.volume_kg. sku 매칭(products.sku = sales_orders.sku_code).
--  · products.sku 중복 가능(014에서 UNIQUE 제거) → distinct on 으로 최신(updated_at) 1건만.
--  · 미매칭 = products 없음 OR cost_price=0 OR volume_kg null (상품마스터에서 채워야 함). sales_sku_cost(백데이터)는 더 이상 사용 안 함.

drop function if exists sales_profit_summary(date, date);
create or replace function sales_profit_summary(p_from date, p_to date)
returns table(channel text, orders bigint, pay_amount bigint, product_cost bigint, cooling bigint)
language sql stable as $$
  with prod as (
    select distinct on (sku) sku, cost_price, volume_kg
    from products where sku is not null and sku <> ''
    order by sku, updated_at desc
  ),
  ord as (
    select o.channel, o.order_id,
      sum(o.subtotal_amount)                                 as revenue,
      sum(o.quantity * coalesce(pr.cost_price, 0))           as pcost,
      round(sum(o.quantity * coalesce(pr.volume_kg, 0)), 1)  as wt
    from sales_orders o
    left join prod pr on pr.sku = o.sku_code
    where o.order_date between p_from and p_to
    group by o.channel, o.order_id
  )
  select channel,
    count(*)::bigint       as orders,
    sum(revenue)::bigint   as pay_amount,
    sum(pcost)::bigint     as product_cost,
    sum(
      case
        when wt >= 12.1 then 7860
        when wt >= 10.1 then 7310
        when wt >= 5.1  then 6930
        when wt >= 4.1  then 6760
        when wt >= 3.1  then 5830
        when wt >= 2.1  then 5720
        when wt >= 1.6  then 4680
        else 4240
      end
    )::bigint              as cooling
  from ord
  group by channel
  order by pay_amount desc;
$$;

create or replace function sales_profit_unmatched(p_from date, p_to date)
returns table(sku_code text, line_count bigint, qty_sum bigint, amount_sum bigint, channels text)
language sql stable as $$
  with prod as (
    select distinct on (sku) sku, cost_price, volume_kg
    from products where sku is not null and sku <> ''
    order by sku, updated_at desc
  )
  select o.sku_code,
    count(*)::bigint               as line_count,
    sum(o.quantity)::bigint        as qty_sum,
    sum(o.subtotal_amount)::bigint as amount_sum,
    string_agg(distinct o.channel, ', ') as channels
  from sales_orders o
  left join prod pr on pr.sku = o.sku_code
  where o.order_date between p_from and p_to
    and (pr.sku is null or pr.cost_price is null or pr.cost_price = 0 or pr.volume_kg is null)
  group by o.sku_code
  order by amount_sum desc;
$$;

notify pgrst, 'reload schema';


-- ======================================================================
-- 045_sales_profit_bundles.sql
-- ======================================================================
-- 045 채널별 이익: 묶음(세트)상품 원가·중량을 '구성품 합'으로 산출.
--  · 판매 SKU가 product_bundles 부모면 → 원가=Σ(구성품 cost_price×qty), 중량=Σ(구성품 volume_kg×qty).
--    아니면(단품) → 자기 cost_price/volume_kg. (1단계 전개: 구성품은 단품 가정)
--  · 중량은 구성품 중 volume_kg null 이 하나라도 있으면 null(=결측 표시). 원가는 구성품 중 0 있으면 결측 플래그.
--  · 미매칭 = products 없음 OR (묶음/단품) 원가·부피 결측 → 상품마스터/구성품에서 채워야.

drop function if exists sales_profit_summary(date, date);
create or replace function sales_profit_summary(p_from date, p_to date)
returns table(channel text, orders bigint, pay_amount bigint, product_cost bigint, cooling bigint)
language sql stable as $$
  with prod as (
    select distinct on (sku) id, sku, cost_price, volume_kg
    from products where sku is not null and sku <> '' order by sku, updated_at desc
  ),
  comp as (   -- 묶음 부모 sku → 구성품 합
    select pp.sku as parent_sku,
      sum(c.cost_price * pb.qty)                                            as cost,
      case when bool_or(c.volume_kg is null) then null else sum(c.volume_kg * pb.qty) end as weight
    from product_bundles pb
    join products pp on pp.id = pb.parent_id
    join products c  on c.id  = pb.component_id
    group by pp.sku
  ),
  resolved as (   -- sku → 최종 원가·중량 (묶음이면 구성품합, 아니면 자기값)
    select p.sku,
      case when cm.parent_sku is not null then cm.cost   else p.cost_price end as cost,
      case when cm.parent_sku is not null then cm.weight else p.volume_kg  end as weight
    from prod p left join comp cm on cm.parent_sku = p.sku
  ),
  ord as (
    select o.channel, o.order_id,
      sum(o.subtotal_amount)                              as revenue,
      sum(o.quantity * coalesce(r.cost, 0))              as pcost,
      round(sum(o.quantity * coalesce(r.weight, 0)), 1)  as wt
    from sales_orders o
    left join resolved r on r.sku = o.sku_code
    where o.order_date between p_from and p_to
    group by o.channel, o.order_id
  )
  select channel,
    count(*)::bigint     as orders,
    sum(revenue)::bigint as pay_amount,
    sum(pcost)::bigint   as product_cost,
    sum(
      case
        when wt >= 12.1 then 7860
        when wt >= 10.1 then 7310
        when wt >= 5.1  then 6930
        when wt >= 4.1  then 6760
        when wt >= 3.1  then 5830
        when wt >= 2.1  then 5720
        when wt >= 1.6  then 4680
        else 4240
      end
    )::bigint            as cooling
  from ord
  group by channel
  order by pay_amount desc;
$$;

create or replace function sales_profit_unmatched(p_from date, p_to date)
returns table(sku_code text, line_count bigint, qty_sum bigint, amount_sum bigint, channels text)
language sql stable as $$
  with prod as (
    select distinct on (sku) id, sku, cost_price, volume_kg
    from products where sku is not null and sku <> '' order by sku, updated_at desc
  ),
  comp as (
    select pp.sku as parent_sku,
      bool_or(coalesce(c.cost_price, 0) = 0) as cost_missing,
      bool_or(c.volume_kg is null)           as wt_missing
    from product_bundles pb
    join products pp on pp.id = pb.parent_id
    join products c  on c.id  = pb.component_id
    group by pp.sku
  ),
  resolved as (
    select p.sku,
      case when cm.parent_sku is not null then (cm.cost_missing or cm.wt_missing)
           else (coalesce(p.cost_price, 0) = 0 or p.volume_kg is null) end as bad
    from prod p left join comp cm on cm.parent_sku = p.sku
  )
  select o.sku_code,
    count(*)::bigint               as line_count,
    sum(o.quantity)::bigint        as qty_sum,
    sum(o.subtotal_amount)::bigint as amount_sum,
    string_agg(distinct o.channel, ', ') as channels
  from sales_orders o
  left join resolved r on r.sku = o.sku_code
  where o.order_date between p_from and p_to
    and (r.sku is null or r.bad)
  group by o.sku_code
  order by amount_sum desc;
$$;

notify pgrst, 'reload schema';


-- ======================================================================
-- 046_sales_channel_config.sql
-- ======================================================================
-- 046 채널별 이익: 수수료율·배송비매출 정책을 커스텀(설정 테이블).
--  · sales_channel_config: 채널별 수수료율 + 배송비매출 정책(flat 정액 / free_over N원↑무료 / none 없음).
--  · 배송비매출은 '주문 금액' 기준으로 판정 → RPC에서 주문 단위 적용 후 채널 합산.
--  · 미설정 채널은 수수료 0·배송 정액 4,000(기존 동작)으로 처리.

create table if not exists sales_channel_config (
  channel        text primary key,
  fee_rate       numeric(6,4) not null default 0,     -- 0.10 = 10%
  ship_mode      text not null default 'flat' check (ship_mode in ('flat','free_over','none')),
  ship_fee       bigint not null default 4000,        -- 주문당 배송비매출(원)
  ship_free_over bigint not null default 0,           -- free_over: 주문금액 >= 이 값 이면 무료(0)
  updated_at     timestamptz not null default now()
);

-- 기존 동작 유지 seed(파이썬 요율 + 배송 정액 4,000). 이미 있으면 유지.
insert into sales_channel_config (channel, fee_rate, ship_mode, ship_fee, ship_free_over) values
  ('스마트스토어', 0.10, 'flat', 4000, 0),
  ('쿠팡',        0.12, 'flat', 4000, 0),
  ('카페24',      0.04, 'flat', 4000, 0),
  ('토스',        0.12, 'flat', 4000, 0),
  ('톡스토어',     0.12, 'flat', 4000, 0),
  ('도매',        0.00, 'flat', 4000, 0),
  ('팔도감',      0.00, 'flat', 4000, 0)
on conflict (channel) do nothing;

-- 반환 컬럼이 바뀌므로(ship_revenue·fee_rate 추가) create or replace 불가 → 먼저 DROP.
drop function if exists sales_profit_summary(date, date);
create or replace function sales_profit_summary(p_from date, p_to date)
returns table(channel text, orders bigint, pay_amount bigint, ship_revenue bigint, product_cost bigint, cooling bigint, fee_rate numeric)
language sql stable as $$
  with prod as (
    select distinct on (sku) id, sku, cost_price, volume_kg
    from products where sku is not null and sku <> '' order by sku, updated_at desc
  ),
  comp as (
    select pp.sku as parent_sku,
      sum(c.cost_price * pb.qty) as cost,
      case when bool_or(c.volume_kg is null) then null else sum(c.volume_kg * pb.qty) end as weight
    from product_bundles pb
    join products pp on pp.id = pb.parent_id
    join products c  on c.id  = pb.component_id
    group by pp.sku
  ),
  resolved as (
    select p.sku,
      case when cm.parent_sku is not null then cm.cost   else p.cost_price end as cost,
      case when cm.parent_sku is not null then cm.weight else p.volume_kg  end as weight
    from prod p left join comp cm on cm.parent_sku = p.sku
  ),
  ord as (
    select o.channel, o.order_id,
      sum(o.subtotal_amount)                              as revenue,
      sum(o.quantity * coalesce(r.cost, 0))              as pcost,
      round(sum(o.quantity * coalesce(r.weight, 0)), 1)  as wt
    from sales_orders o
    left join resolved r on r.sku = o.sku_code
    where o.order_date between p_from and p_to
    group by o.channel, o.order_id
  ),
  ord2 as (
    select ord.channel, ord.revenue, ord.pcost, ord.wt,
      coalesce(cfg.fee_rate, 0) as fee_rate,
      case
        when coalesce(cfg.ship_mode, 'flat') = 'none' then 0
        when cfg.ship_mode = 'free_over' and ord.revenue >= cfg.ship_free_over then 0
        else coalesce(cfg.ship_fee, 4000)
      end as ship_rev
    from ord left join sales_channel_config cfg on cfg.channel = ord.channel
  )
  select channel,
    count(*)::bigint      as orders,
    sum(revenue)::bigint  as pay_amount,
    sum(ship_rev)::bigint as ship_revenue,
    sum(pcost)::bigint    as product_cost,
    sum(
      case
        when wt >= 12.1 then 7860 when wt >= 10.1 then 7310 when wt >= 5.1 then 6930
        when wt >= 4.1 then 6760 when wt >= 3.1 then 5830 when wt >= 2.1 then 5720
        when wt >= 1.6 then 4680 else 4240
      end
    )::bigint             as cooling,
    max(fee_rate)         as fee_rate
  from ord2
  group by channel
  order by pay_amount desc;
$$;

notify pgrst, 'reload schema';


-- ======================================================================
-- 047_sales_channel_sub.sql
-- ======================================================================
-- 047 채널 배송비: '정기배송' 별도 무료기준 지원.
--  · 카페24 등: 정기배송(상품명에 '정기배송' 포함) 주문은 다른 무료기준(예 3만), 일반배송은 7만.
--  · sales_channel_config.ship_free_over_sub: 정기배송 무료기준(0이면 정기도 일반 기준 사용).
--  · 주문 단위 판정: 주문 라인 중 하나라도 상품명에 '정기배송' 포함 → 그 주문은 정기배송.

alter table sales_channel_config add column if not exists ship_free_over_sub bigint not null default 0;

drop function if exists sales_profit_summary(date, date);
create function sales_profit_summary(p_from date, p_to date)
returns table(channel text, orders bigint, pay_amount bigint, ship_revenue bigint, product_cost bigint, cooling bigint, fee_rate numeric)
language sql stable as $$
  with prod as (
    select distinct on (sku) id, sku, cost_price, volume_kg
    from products where sku is not null and sku <> '' order by sku, updated_at desc
  ),
  comp as (
    select pp.sku as parent_sku,
      sum(c.cost_price * pb.qty) as cost,
      case when bool_or(c.volume_kg is null) then null else sum(c.volume_kg * pb.qty) end as weight
    from product_bundles pb
    join products pp on pp.id = pb.parent_id
    join products c  on c.id  = pb.component_id
    group by pp.sku
  ),
  resolved as (
    select p.sku,
      case when cm.parent_sku is not null then cm.cost   else p.cost_price end as cost,
      case when cm.parent_sku is not null then cm.weight else p.volume_kg  end as weight
    from prod p left join comp cm on cm.parent_sku = p.sku
  ),
  ord as (
    select o.channel, o.order_id,
      sum(o.subtotal_amount)                              as revenue,
      sum(o.quantity * coalesce(r.cost, 0))              as pcost,
      round(sum(o.quantity * coalesce(r.weight, 0)), 1)  as wt,
      bool_or(o.product_name ilike '%정기배송%')          as is_sub   -- 정기배송 상품 포함 주문
    from sales_orders o
    left join resolved r on r.sku = o.sku_code
    where o.order_date between p_from and p_to
    group by o.channel, o.order_id
  ),
  ord2 as (
    select ord.channel, ord.revenue, ord.pcost, ord.wt,
      coalesce(cfg.fee_rate, 0) as fee_rate,
      case
        when coalesce(cfg.ship_mode, 'flat') = 'none' then 0
        when cfg.ship_mode = 'free_over' then
          case when ord.revenue >=
            (case when ord.is_sub and coalesce(cfg.ship_free_over_sub, 0) > 0
                  then cfg.ship_free_over_sub else cfg.ship_free_over end)
          then 0 else coalesce(cfg.ship_fee, 4000) end
        else coalesce(cfg.ship_fee, 4000)
      end as ship_rev
    from ord left join sales_channel_config cfg on cfg.channel = ord.channel
  )
  select channel,
    count(*)::bigint      as orders,
    sum(revenue)::bigint  as pay_amount,
    sum(ship_rev)::bigint as ship_revenue,
    sum(pcost)::bigint    as product_cost,
    sum(
      case
        when wt >= 12.1 then 7860 when wt >= 10.1 then 7310 when wt >= 5.1 then 6930
        when wt >= 4.1 then 6760 when wt >= 3.1 then 5830 when wt >= 2.1 then 5720
        when wt >= 1.6 then 4680 else 4240
      end
    )::bigint             as cooling,
    max(fee_rate)         as fee_rate
  from ord2
  group by channel
  order by pay_amount desc;
$$;

notify pgrst, 'reload schema';


-- ======================================================================
-- 048_sales_ship_actual.sql
-- ======================================================================
-- 048 배송비매출: '실제 배송비결제금액(shipping_fee)' 모드 추가 + 기본값으로 전환.
--  · sales_orders.shipping_fee = 원본 '배송비결제금액'(주문당 한 줄에만 저장 확인) → sum = 실제 배송비.
--    무료배송(임계·정기 등)이 이미 데이터에 반영돼 있어 모델링보다 정확.
--  · ship_mode 'actual' 추가. 기존 flat 채널을 actual 로 전환. 미설정 채널도 기본 actual.

alter table sales_channel_config drop constraint if exists sales_channel_config_ship_mode_check;
alter table sales_channel_config add constraint sales_channel_config_ship_mode_check
  check (ship_mode in ('flat','free_over','none','actual'));

update sales_channel_config set ship_mode = 'actual', updated_at = now() where ship_mode = 'flat';

drop function if exists sales_profit_summary(date, date);
create function sales_profit_summary(p_from date, p_to date)
returns table(channel text, orders bigint, pay_amount bigint, ship_revenue bigint, product_cost bigint, cooling bigint, fee_rate numeric)
language sql stable as $$
  with prod as (
    select distinct on (sku) id, sku, cost_price, volume_kg
    from products where sku is not null and sku <> '' order by sku, updated_at desc
  ),
  comp as (
    select pp.sku as parent_sku,
      sum(c.cost_price * pb.qty) as cost,
      case when bool_or(c.volume_kg is null) then null else sum(c.volume_kg * pb.qty) end as weight
    from product_bundles pb
    join products pp on pp.id = pb.parent_id
    join products c  on c.id  = pb.component_id
    group by pp.sku
  ),
  resolved as (
    select p.sku,
      case when cm.parent_sku is not null then cm.cost   else p.cost_price end as cost,
      case when cm.parent_sku is not null then cm.weight else p.volume_kg  end as weight
    from prod p left join comp cm on cm.parent_sku = p.sku
  ),
  ord as (
    select o.channel, o.order_id,
      sum(o.subtotal_amount)                              as revenue,
      sum(o.shipping_fee)                                 as actual_ship,   -- 실제 배송비결제금액(주문당 1줄)
      sum(o.quantity * coalesce(r.cost, 0))              as pcost,
      round(sum(o.quantity * coalesce(r.weight, 0)), 1)  as wt,
      bool_or(o.product_name ilike '%정기배송%')          as is_sub
    from sales_orders o
    left join resolved r on r.sku = o.sku_code
    where o.order_date between p_from and p_to
    group by o.channel, o.order_id
  ),
  ord2 as (
    select ord.channel, ord.revenue, ord.pcost, ord.wt,
      coalesce(cfg.fee_rate, 0) as fee_rate,
      case
        when coalesce(cfg.ship_mode, 'actual') = 'actual' then ord.actual_ship
        when cfg.ship_mode = 'none' then 0
        when cfg.ship_mode = 'free_over' then
          case when ord.revenue >=
            (case when ord.is_sub and coalesce(cfg.ship_free_over_sub, 0) > 0
                  then cfg.ship_free_over_sub else cfg.ship_free_over end)
          then 0 else coalesce(cfg.ship_fee, 4000) end
        else coalesce(cfg.ship_fee, 4000)   -- flat
      end as ship_rev
    from ord left join sales_channel_config cfg on cfg.channel = ord.channel
  )
  select channel,
    count(*)::bigint      as orders,
    sum(revenue)::bigint  as pay_amount,
    sum(ship_rev)::bigint as ship_revenue,
    sum(pcost)::bigint    as product_cost,
    sum(
      case
        when wt >= 12.1 then 7860 when wt >= 10.1 then 7310 when wt >= 5.1 then 6930
        when wt >= 4.1 then 6760 when wt >= 3.1 then 5830 when wt >= 2.1 then 5720
        when wt >= 1.6 then 4680 else 4240
      end
    )::bigint             as cooling,
    max(fee_rate)         as fee_rate
  from ord2
  group by channel
  order by pay_amount desc;
$$;

notify pgrst, 'reload schema';


-- ======================================================================
-- 049_sales_revenue_adjust.sql
-- ======================================================================
-- 049 채널 매출 보정율: 할인 미반영 채널(카페24 등) 매출을 일정 비율 차감 보정.
--  · sales_channel_config.revenue_adjust: 총결제금액 차감율(0.055 = 5.5% 차감). 0이면 보정 없음.
--  · 보정 총결제금액 = 원본 결제금액 × (1 - revenue_adjust). 배송비매출·원가·보냉비는 그대로.
--  · 카페24 기본 5.5%(보수적) seed. 웹 '채널 설정'에서 조정 가능.

alter table sales_channel_config add column if not exists revenue_adjust numeric(6,4) not null default 0;
update sales_channel_config set revenue_adjust = 0.055, updated_at = now()
  where channel = '카페24' and revenue_adjust = 0;

drop function if exists sales_profit_summary(date, date) cascade;
create function sales_profit_summary(p_from date, p_to date)
returns table(channel text, orders bigint, pay_amount bigint, ship_revenue bigint, product_cost bigint, cooling bigint, fee_rate numeric)
language sql stable as $$
  with prod as (
    select distinct on (sku) id, sku, cost_price, volume_kg
    from products where sku is not null and sku <> '' order by sku, updated_at desc
  ),
  comp as (
    select pp.sku as parent_sku,
      sum(c.cost_price * pb.qty) as cost,
      case when bool_or(c.volume_kg is null) then null else sum(c.volume_kg * pb.qty) end as weight
    from product_bundles pb
    join products pp on pp.id = pb.parent_id
    join products c  on c.id  = pb.component_id
    group by pp.sku
  ),
  resolved as (
    select p.sku,
      case when cm.parent_sku is not null then cm.cost   else p.cost_price end as cost,
      case when cm.parent_sku is not null then cm.weight else p.volume_kg  end as weight
    from prod p left join comp cm on cm.parent_sku = p.sku
  ),
  ord as (
    select o.channel, o.order_id,
      sum(o.subtotal_amount)                              as revenue,
      sum(o.shipping_fee)                                 as actual_ship,
      sum(o.quantity * coalesce(r.cost, 0))              as pcost,
      round(sum(o.quantity * coalesce(r.weight, 0)), 1)  as wt,
      bool_or(o.product_name ilike '%정기배송%')          as is_sub
    from sales_orders o
    left join resolved r on r.sku = o.sku_code
    where o.order_date between p_from and p_to
    group by o.channel, o.order_id
  ),
  ord2 as (
    select ord.channel, ord.revenue, ord.pcost, ord.wt,
      coalesce(cfg.fee_rate, 0)       as fee_rate,
      coalesce(cfg.revenue_adjust, 0) as adjust,
      case
        when coalesce(cfg.ship_mode, 'actual') = 'actual' then ord.actual_ship
        when cfg.ship_mode = 'none' then 0
        when cfg.ship_mode = 'free_over' then
          case when ord.revenue >=
            (case when ord.is_sub and coalesce(cfg.ship_free_over_sub, 0) > 0
                  then cfg.ship_free_over_sub else cfg.ship_free_over end)
          then 0 else coalesce(cfg.ship_fee, 4000) end
        else coalesce(cfg.ship_fee, 4000)
      end as ship_rev
    from ord left join sales_channel_config cfg on cfg.channel = ord.channel
  )
  select channel,
    count(*)::bigint                    as orders,
    sum(revenue * (1 - adjust))::bigint as pay_amount,   -- 매출 보정 반영
    sum(ship_rev)::bigint               as ship_revenue,
    sum(pcost)::bigint                  as product_cost,
    sum(
      case
        when wt >= 12.1 then 7860 when wt >= 10.1 then 7310 when wt >= 5.1 then 6930
        when wt >= 4.1 then 6760 when wt >= 3.1 then 5830 when wt >= 2.1 then 5720
        when wt >= 1.6 then 4680 else 4240
      end
    )::bigint                          as cooling,
    max(fee_rate)                      as fee_rate
  from ord2
  group by channel
  order by pay_amount desc;
$$;

notify pgrst, 'reload schema';


-- ======================================================================
-- 050_sales_profit_orderid_fix.sql
-- ======================================================================
-- 050 채널이익 RPC 수정: 빈 order_id 뭉침 방지.
--  · 원본에 주문번호 없는 라인(order_id='')이 채널당 1개 주문으로 뭉쳐 주문수·택배보냉비가 틀어지는 결함 방어.
--  · 그룹키 = coalesce(nullif(order_id,''), 'row:'||id) → 빈 order_id 행은 각각 별개 주문으로 취급.
--  (나머지 계산은 049와 동일)

drop function if exists sales_profit_summary(date, date) cascade;
create function sales_profit_summary(p_from date, p_to date)
returns table(channel text, orders bigint, pay_amount bigint, ship_revenue bigint, product_cost bigint, cooling bigint, fee_rate numeric)
language sql stable as $$
  with prod as (
    select distinct on (sku) id, sku, cost_price, volume_kg
    from products where sku is not null and sku <> '' order by sku, updated_at desc
  ),
  comp as (
    select pp.sku as parent_sku,
      sum(c.cost_price * pb.qty) as cost,
      case when bool_or(c.volume_kg is null) then null else sum(c.volume_kg * pb.qty) end as weight
    from product_bundles pb
    join products pp on pp.id = pb.parent_id
    join products c  on c.id  = pb.component_id
    group by pp.sku
  ),
  resolved as (
    select p.sku,
      case when cm.parent_sku is not null then cm.cost   else p.cost_price end as cost,
      case when cm.parent_sku is not null then cm.weight else p.volume_kg  end as weight
    from prod p left join comp cm on cm.parent_sku = p.sku
  ),
  ord as (
    select o.channel,
      coalesce(nullif(o.order_id, ''), 'row:' || o.id::text)  as order_key,   -- 빈 주문번호는 행별 분리
      sum(o.subtotal_amount)                              as revenue,
      sum(o.shipping_fee)                                 as actual_ship,
      sum(o.quantity * coalesce(r.cost, 0))              as pcost,
      round(sum(o.quantity * coalesce(r.weight, 0)), 1)  as wt,
      bool_or(o.product_name ilike '%정기배송%')          as is_sub
    from sales_orders o
    left join resolved r on r.sku = o.sku_code
    where o.order_date between p_from and p_to
    group by o.channel, coalesce(nullif(o.order_id, ''), 'row:' || o.id::text)
  ),
  ord2 as (
    select ord.channel, ord.revenue, ord.pcost, ord.wt,
      coalesce(cfg.fee_rate, 0)       as fee_rate,
      coalesce(cfg.revenue_adjust, 0) as adjust,
      case
        when coalesce(cfg.ship_mode, 'actual') = 'actual' then ord.actual_ship
        when cfg.ship_mode = 'none' then 0
        when cfg.ship_mode = 'free_over' then
          case when ord.revenue >=
            (case when ord.is_sub and coalesce(cfg.ship_free_over_sub, 0) > 0
                  then cfg.ship_free_over_sub else cfg.ship_free_over end)
          then 0 else coalesce(cfg.ship_fee, 4000) end
        else coalesce(cfg.ship_fee, 4000)
      end as ship_rev
    from ord left join sales_channel_config cfg on cfg.channel = ord.channel
  )
  select channel,
    count(*)::bigint                    as orders,
    sum(revenue * (1 - adjust))::bigint as pay_amount,
    sum(ship_rev)::bigint               as ship_revenue,
    sum(pcost)::bigint                  as product_cost,
    sum(
      case
        when wt >= 12.1 then 7860 when wt >= 10.1 then 7310 when wt >= 5.1 then 6930
        when wt >= 4.1 then 6760 when wt >= 3.1 then 5830 when wt >= 2.1 then 5720
        when wt >= 1.6 then 4680 else 4240
      end
    )::bigint                          as cooling,
    max(fee_rate)                      as fee_rate
  from ord2
  group by channel
  order by pay_amount desc;
$$;

notify pgrst, 'reload schema';


-- ======================================================================
-- 051_inventory_reconcile.sql
-- ======================================================================
-- 051 재고 정합성 대사 RPC
--  매출(sales_orders)의 실제 판매수량을 '실제 출고'로 보고, 재고 원장(inventory_txns)과 대조한다.
--  품목(product)별로 반환: 현재고 · 기간 원장흐름(입고/출고/조정) · 실제 판매수량.
--  판매 sku_code 가 번들(세트) 부모면 구성품 수량(qty)으로 전개해 재고(구성품 단위)와 맞춘다.
--  현재고는 inventory_stock(036)과 동일 규칙(상태 무필터)으로 계산 — 다른 재고 화면과 수치 일치.
--
-- 적용: Supabase SQL Editor 에 이 파일 하나만 붙여넣고 Run. 멱등(재실행 안전).

drop function if exists inventory_reconcile(date, date, text) cascade;
create function inventory_reconcile(p_from date, p_to date, p_channel text default null)
returns table(
  product_id uuid, sku text, name text,
  current_qty bigint,
  ledger_in bigint, ledger_out bigint, ledger_adj bigint,
  sold bigint
) language sql stable as $$
  with
  stock as ( -- 현재고(전체 기간 순합, 채널 옵션) = inventory_stock 규칙과 동일
    select t.product_id, coalesce(sum(t.qty), 0) as qty
    from inventory_txns t
    where (p_channel is null or t.channel = p_channel)
    group by t.product_id
  ),
  flow as ( -- 선택 기간의 원장 흐름
    select t.product_id,
      sum(case when t.type = '입고' then t.qty else 0 end)  as l_in,
      sum(case when t.type = '출고' then -t.qty else 0 end) as l_out,  -- 출고 qty 는 음수 저장 → 양수화
      sum(case when t.type = '조정' then t.qty else 0 end)  as l_adj
    from inventory_txns t
    where t.txn_date between p_from and p_to
      and (p_channel is null or t.channel = p_channel)
    group by t.product_id
  ),
  prod as ( -- sku → product (중복 sku 는 최신 1개)
    select distinct on (sku) id, sku
    from products where sku is not null and sku <> '' order by sku, updated_at desc
  ),
  bundle as ( -- 번들 부모 sku → 구성품 sku × 배수
    select pp.sku as parent_sku, c.sku as comp_sku, pb.qty as mult
    from product_bundles pb
    join products pp on pp.id = pb.parent_id
    join products c  on c.id  = pb.component_id
    where c.sku is not null and c.sku <> ''
  ),
  sold_raw as (
    select sku_code, sum(quantity) as q
    from sales_orders
    where order_date between p_from and p_to and sku_code is not null and sku_code <> ''
    group by sku_code
  ),
  sold_expanded as ( -- 번들이면 구성품으로 전개, 아니면 그대로
    select b.comp_sku as sku, (sr.q * b.mult) as q
    from sold_raw sr join bundle b on b.parent_sku = sr.sku_code
    union all
    select sr.sku_code as sku, sr.q
    from sold_raw sr
    where not exists (select 1 from bundle b where b.parent_sku = sr.sku_code)
  ),
  sold_by_prod as (
    select p.id as product_id, sum(se.q) as sold
    from sold_expanded se join prod p on p.sku = se.sku
    group by p.id
  )
  select
    pr.id, pr.sku, pr.name,
    coalesce(st.qty, 0)::bigint,
    coalesce(fl.l_in, 0)::bigint,
    coalesce(fl.l_out, 0)::bigint,
    coalesce(fl.l_adj, 0)::bigint,
    coalesce(sb.sold, 0)::bigint
  from products pr
  left join stock st        on st.product_id = pr.id
  left join flow  fl        on fl.product_id = pr.id
  left join sold_by_prod sb on sb.product_id = pr.id
  where coalesce(st.qty,0) <> 0 or coalesce(fl.l_in,0) <> 0 or coalesce(fl.l_out,0) <> 0
     or coalesce(fl.l_adj,0) <> 0 or coalesce(sb.sold,0) <> 0;
$$;

notify pgrst, 'reload schema';


-- ======================================================================
-- 052_inventory_reconcile_wholesale.sql
-- ======================================================================
-- 052 재고 정합성 대사 RPC — '팔린 수'를 채널별 소스로 분리.
--   · 소매(또는 전체의 소매분): sales_orders 판매수량(번들 구성품 전개)  ← 051과 동일
--   · 도매(또는 전체의 도매분): B2B 발송완료(shipments status='발송완료')의 shipment_items 수량
--   · 채널 미지정(전체) = 소매 + 도매
--  즉 도매 화면에서는 도매 재고를 도매 판매(B2B 발송)와 비교한다.
--  나머지(현재고·기간 원장흐름)는 051과 동일하게 채널 필터 적용.
--
-- 적용: Supabase SQL Editor 에 이 파일 하나만 붙여넣고 Run. 멱등(재실행 안전).

drop function if exists inventory_reconcile(date, date, text) cascade;
create function inventory_reconcile(p_from date, p_to date, p_channel text default null)
returns table(
  product_id uuid, sku text, name text,
  current_qty bigint,
  ledger_in bigint, ledger_out bigint, ledger_adj bigint,
  sold bigint
) language sql stable as $$
  with
  stock as (
    select t.product_id, coalesce(sum(t.qty), 0) as qty
    from inventory_txns t
    where (p_channel is null or t.channel = p_channel)
    group by t.product_id
  ),
  flow as (
    select t.product_id,
      sum(case when t.type = '입고' then t.qty else 0 end)  as l_in,
      sum(case when t.type = '출고' then -t.qty else 0 end) as l_out,
      sum(case when t.type = '조정' then t.qty else 0 end)  as l_adj
    from inventory_txns t
    where t.txn_date between p_from and p_to
      and (p_channel is null or t.channel = p_channel)
    group by t.product_id
  ),
  prod as (
    select distinct on (sku) id, sku
    from products where sku is not null and sku <> '' order by sku, updated_at desc
  ),
  bundle as (
    select pp.sku as parent_sku, c.sku as comp_sku, pb.qty as mult
    from product_bundles pb
    join products pp on pp.id = pb.parent_id
    join products c  on c.id  = pb.component_id
    where c.sku is not null and c.sku <> ''
  ),
  sold_raw as (
    select sku_code, sum(quantity) as q
    from sales_orders
    where order_date between p_from and p_to and sku_code is not null and sku_code <> ''
    group by sku_code
  ),
  sold_expanded as (
    select b.comp_sku as sku, (sr.q * b.mult) as q
    from sold_raw sr join bundle b on b.parent_sku = sr.sku_code
    union all
    select sr.sku_code as sku, sr.q
    from sold_raw sr
    where not exists (select 1 from bundle b where b.parent_sku = sr.sku_code)
  ),
  sold_retail as ( -- 소매 판매(품목별)
    select p.id as product_id, sum(se.q) as sold
    from sold_expanded se join prod p on p.sku = se.sku
    group by p.id
  ),
  sold_b2b as ( -- 도매 판매 = B2B 발송완료 수량(품목별)
    select oi.product_id, sum(si.qty) as sold
    from shipments sh
    join shipment_items si on si.shipment_id = sh.id
    join order_items   oi on oi.id = si.order_item_id
    where sh.status = '발송완료'
      and sh.ship_date between p_from and p_to
      and oi.product_id is not null
    group by oi.product_id
  )
  select
    pr.id, pr.sku, pr.name,
    coalesce(st.qty, 0)::bigint,
    coalesce(fl.l_in, 0)::bigint,
    coalesce(fl.l_out, 0)::bigint,
    coalesce(fl.l_adj, 0)::bigint,
    (case
       when p_channel = '도매' then coalesce(sb.sold, 0)
       when p_channel = '소매' then coalesce(sr.sold, 0)
       else coalesce(sr.sold, 0) + coalesce(sb.sold, 0)
     end)::bigint as sold
  from products pr
  left join stock st        on st.product_id = pr.id
  left join flow  fl        on fl.product_id = pr.id
  left join sold_retail sr  on sr.product_id = pr.id
  left join sold_b2b   sb   on sb.product_id = pr.id
  where coalesce(st.qty,0) <> 0 or coalesce(fl.l_in,0) <> 0 or coalesce(fl.l_out,0) <> 0 or coalesce(fl.l_adj,0) <> 0
     or (case
           when p_channel = '도매' then coalesce(sb.sold, 0)
           when p_channel = '소매' then coalesce(sr.sold, 0)
           else coalesce(sr.sold, 0) + coalesce(sb.sold, 0)
         end) <> 0;
$$;

notify pgrst, 'reload schema';


-- ======================================================================
-- 053_shipping_codes.sql
-- ======================================================================
-- 053 택배 발주처리용 코드표(shipping_codes)
--  단품코드(sku) → 택배 표기 상품명(courier_name) + 주문당 총중량(order_weight, kg).
--  발주처리에서 CNplus '품목명(N)'과 박스타입/운임 계산(주문 총중량)에 사용.
--  구글시트 'code' 탭을 대체 — 툴에서 업로드로 갱신.
-- 적용: Supabase SQL Editor 에 이 파일 하나만 붙여넣고 Run. 멱등.

create table if not exists shipping_codes (
  sku          text primary key,
  courier_name text not null default '',
  order_weight numeric not null default 0,
  updated_at   timestamptz not null default now()
);

alter table shipping_codes enable row level security;

notify pgrst, 'reload schema';


-- ======================================================================
-- 054_products_courier.sql
-- ======================================================================
-- 054 상품마스터에 택배(CNplus) 필드 추가 + 별도 코드표(053) 폐기.
--  택배 발주처리의 품목명·중량을 상품마스터(products)에서 관리한다.
--   · courier_name   : CNplus 품목명(N) — 예 "진공 씨몬스터 참돔순살 100g"
--   · courier_weight : 주문당 총중량(kg) — 박스타입/운임 구간 기준. 상품 부피(volume_kg)와 다른 값이라 별도 칸.
-- 적용: Supabase SQL Editor 에 이 파일 하나만 붙여넣고 Run. 멱등.
--  (053_shipping_codes 를 이미 적용했다면 이 파일이 그 테이블을 정리합니다. 안 했으면 053은 건너뛰세요.)

alter table products add column if not exists courier_name   text    not null default '';
alter table products add column if not exists courier_weight numeric not null default 0;

drop table if exists shipping_codes;

notify pgrst, 'reload schema';


-- ======================================================================
-- 055_delivery_log.sql
-- ======================================================================
-- 055 배송일지(delivery_log) — 구글시트 '택배일지/도착보장/드라이아이스'를 웹으로 이관.
--  날짜별 1행. 택배량·기본운임은 발주처리가 자동 기록, 추가운임·파도·드라이아이스·비고는 수동 편집.
-- 적용: Supabase SQL Editor 에 이 파일 하나만 붙여넣고 Run. 멱등.

create table if not exists delivery_log (
  log_date        date primary key,
  -- 자동(발주처리에서 기록): 박스종류별 개수 {"굴":n,...}
  boxes_normal    jsonb  not null default '{}'::jsonb,   -- 일반 택배량
  boxes_guar      jsonb  not null default '{}'::jsonb,   -- 도착보장 택배량
  base_fee_normal bigint not null default 0,             -- 씨몬 기본운임(일반) = 그날 기본운임 합
  base_fee_guar   bigint not null default 0,             -- 도착보장 기본운임 합
  -- 수동
  extra_fee       bigint not null default 0,             -- 씨몬 추가운임
  guar_extra_fee  bigint not null default 0,             -- 도착보장 추가운임
  pado_fee        bigint not null default 0,             -- 파도 운임
  pado_extra      bigint not null default 0,             -- 파도 추가운임
  pado_cod        bigint not null default 0,             -- 파도 착불
  dryice_full     numeric not null default 0,            -- 드라이아이스 풀박
  dryice_half     numeric not null default 0,            -- 드라이아이스 반박
  memo            text,
  updated_at      timestamptz not null default now()
);

create index if not exists delivery_log_date_idx on delivery_log (log_date desc);
alter table delivery_log enable row level security;

notify pgrst, 'reload schema';


-- ======================================================================
-- 056_sales_okr.sql
-- ======================================================================
-- 056 OKR 지표 뷰 (Looker Studio 스코어카드용). looker_ro(041) 가 읽는다.
--  OKR1) 2026년에 '첫 구매'한 고객 수                 (목표 30,000)
--  OKR2) 첫 구매 후 3개월 이내 재구매(2번째 주문) 비율     (목표 50%)
--  OKR3) 이유식 비중 / 도매 비중 / (이유식+도매) 합산 비중   (목표 각 10%)
--  · 고객 = customer_key(전화 해시). 전화 없는 주문(도매·마스킹번호)은 고객 집계 제외.
--  · '구매 횟수' = order_id 단위(같은 주문의 여러 상품행은 1건).
--  · 이유식 SKU 는 '부분일치(패턴)' — Looker 의 CONTAINS_TEXT 와 동일. sales_okr_babyfood_pattern 에 조각만 넣으면 됨.
--    예: 'DG-20-K-120','DAL-20-K-120','SH-20-K-120' (또는 공통 꼬리 '-20-K-120' 하나로도 가능).
--  적용: Supabase SQL Editor 에 붙여넣고 Run(멱등). 이후 [사용자 조치] 수행.

-- 이유식 SKU 패턴(부분일치). 관리자만 insert.
create table if not exists public.sales_okr_babyfood_pattern (
  pattern text primary key
);

-- OKR 스코어카드 뷰 — 2026 기준 지표를 1행으로. (연도 바뀌면 아래 날짜만 수정)
create or replace view public.sales_okr as
with
firsts as (   -- 첫 주문이 2026년인 고객
  select customer_key, min(order_date) as first_order
  from public.sales_orders
  where customer_key <> ''
  group by customer_key
  having min(order_date) >= date '2026-01-01' and min(order_date) < date '2027-01-01'
),
ord as (      -- 고객·주문 단위(상품 여러 행 → 주문 1건)
  select customer_key, order_id, min(order_date) as order_date
  from public.sales_orders
  where customer_key <> '' and order_id <> ''
  group by customer_key, order_id
),
rep as (      -- 그중 첫 주문 후 3개월 이내에 또 주문한 고객
  select distinct f.customer_key
  from firsts f
  join ord x on x.customer_key = f.customer_key
  where x.order_date > f.first_order
    and x.order_date <= (f.first_order + interval '3 months')::date
),
rows2026 as ( -- 2026 매출 행 + 이유식 여부(패턴 부분일치 = CONTAINS_TEXT)
  select
    subtotal_amount,
    channel,
    exists (select 1 from public.sales_okr_babyfood_pattern p
            where sku_code like '%' || p.pattern || '%') as is_babyfood
  from public.sales_orders
  where order_date >= date '2026-01-01' and order_date < date '2027-01-01'
),
rev as (
  select
    coalesce(sum(subtotal_amount), 0)::bigint                                              as total_rev,
    coalesce(sum(subtotal_amount) filter (where is_babyfood), 0)::bigint                   as babyfood_rev,
    coalesce(sum(subtotal_amount) filter (where channel = '도매'), 0)::bigint              as wholesale_rev,
    coalesce(sum(subtotal_amount) filter (where is_babyfood or channel = '도매'), 0)::bigint as combined_rev
  from rows2026
)
select
  -- OKR1
  (select count(*) from firsts)::bigint                                                  as okr1_first_buyers,
  30000::int                                                                             as okr1_target,
  -- OKR2
  (select count(*) from rep)::bigint                                                     as repeated_within_3m,
  round(100.0 * (select count(*) from rep) / nullif((select count(*) from firsts), 0), 1) as okr2_repeat_pct,
  50.0::numeric                                                                          as okr2_target,
  -- OKR3 (각각 + 합산)
  rev.total_rev,
  rev.babyfood_rev,  round(100.0 * rev.babyfood_rev  / nullif(rev.total_rev, 0), 1)       as okr3_babyfood_pct,
  rev.wholesale_rev, round(100.0 * rev.wholesale_rev / nullif(rev.total_rev, 0), 1)       as okr3_wholesale_pct,
  rev.combined_rev,  round(100.0 * rev.combined_rev  / nullif(rev.total_rev, 0), 1)       as okr3_combined_pct,
  10.0::numeric                                                                          as okr3_target
from rev;

grant select on public.sales_okr to looker_ro;

notify pgrst, 'reload schema';

-- [사용자 조치]
--  1) 이유식 SKU 패턴 등록(OKR3-이유식 활성화):
--       insert into public.sales_okr_babyfood_pattern(pattern)
--       values ('DG-20-K-120'),('DAL-20-K-120'),('SH-20-K-120') on conflict do nothing;
--       -- 공통 꼬리가 이유식 전용이면 한 줄로도: values ('-20-K-120')
--  2) (041 미완 시) looker_ro 비밀번호 설정:
--       alter role looker_ro with password '강한_무작위_비밀번호_16자이상';


-- ======================================================================
-- 057_fulfill_scan.sql
-- ======================================================================
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


-- ======================================================================
-- 058_sales_customer_summary.sql
-- ======================================================================
-- 058_sales_customer_summary.sql
-- 신규/재구매 고객 분류 — 기존 구글시트 앱스스크립트(신규재구매.txt, OKR_고객요약 시트)를 SQL 뷰로 이관.
--  루커스튜디오가 이 뷰를 데이터소스로 쓰면 예전과 동일하게 신규/재구매를 판단할 수 있다.
--
-- [앱스스크립트 → SQL 매핑]
--  · 고객 식별: customer_phone(정규화 digits) → sales_orders.customer_key (전화 HMAC). 동일 로직.
--  · 첫 주문: order_date 가장 이른 것, 동률이면 order_id 작은 것 (distinct on + order by).
--  · purchase_count: distinct order_id (전 기간 누적).
--  · first_purchase_flag(연도): first_purchase_year 로 판단 (루커에서 연도 필터).
--  · repurchase_flag: first_purchase_year = 대상연도 AND purchase_count >= 2 → 아래 is_repeat + 연도필터.
--  · 제외규칙:
--     - 무전화/더미(01000000000 등): 정규화 단계에서 customer_key='' 로 이미 제외(뒤 8자리 0 마스킹 규칙).
--     - 050 안심번호: sales_customers.phone_digits LIKE '050%' 인 고객 제외(앱스스크립트 other 시트 처리와 동일).
--  · first_order_sku_1..N: first_order_skus 로 콤마 결합.
--  ⚠️ 앱스스크립트는 첫주문 비교에 시각(시간)까지 썼으나, sales_orders 는 날짜(date)라 '날짜+order_id'로 동률 처리.
--
-- PII 안전: 뷰는 phone/phone_digits 를 '출력'하지 않고 050 판별 필터에만 사용. 뷰 소유자(postgres) 권한으로
--   sales_customers 를 읽으므로 looker_ro 는 원본 전화 접근 없이 파생 결과만 조회.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등(create or replace) — 재실행 안전.

create or replace view sales_customer_summary as
with base as (
  -- 전화 있는 고객(customer_key<>''), 050 안심번호 제외
  select o.customer_key, o.order_id, o.order_date, o.sku_code
  from sales_orders o
  left join sales_customers c on c.customer_key = o.customer_key
  where o.customer_key <> ''
    and coalesce(c.phone_digits, '') not like '050%'
),
firsts as (
  -- 첫 주문: 이른 날짜 → 동률이면 작은 order_id
  select distinct on (customer_key)
    customer_key, order_date as first_purchase_date, order_id as first_order_id
  from base
  order by customer_key, order_date asc, order_id asc
),
agg as (
  select customer_key, count(distinct order_id) as purchase_count
  from base group by customer_key
),
skus as (
  -- 첫 주문에 담긴 SKU들(콤마 결합)
  select b.customer_key, string_agg(distinct b.sku_code, ', ' order by b.sku_code) as first_order_skus
  from base b
  join firsts f on f.customer_key = b.customer_key and b.order_id = f.first_order_id
  where b.sku_code <> ''
  group by b.customer_key
)
select
  f.customer_key,
  f.first_purchase_date,
  extract(year from f.first_purchase_date)::int as first_purchase_year,
  a.purchase_count,
  (a.purchase_count >= 2)                        as is_repeat,          -- 재구매 고객(누적 2회+)
  case when a.purchase_count >= 2 then '재구매' else '신규' end as customer_type,  -- 첫구매연도 기준 세그먼트
  coalesce(s.first_order_skus, '')               as first_order_skus
from firsts f
join agg a  on a.customer_key = f.customer_key
left join skus s on s.customer_key = f.customer_key;

comment on view sales_customer_summary is '고객 1인당 요약(첫구매·누적주문·신규/재구매). 앱스스크립트 OKR_고객요약 이관. 050·무전화 제외.';

-- 루커 읽기전용 역할에 조회 권한(역할 있을 때만)
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'looker_ro') then
    grant select on sales_customer_summary to looker_ro;
  end if;
end $$;

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 059_products_scan_name.sql
-- ======================================================================
-- 059_products_scan_name.sql
-- 상품마스터에 '송장 스캔 표시명'(scan_name) 추가.
--  송장 스캔 피킹 리스트 출력에 나오는 상품명을 코드(SKU)별로 지정. 비어있으면 products.name 을 사용.
--  (택배 발주서 품목명 courier_name 과는 별개 — 창고 피킹용 짧은 이름을 따로 둘 수 있게.)
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table products add column if not exists scan_name text;

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 060_enable_rls_all_public.sql
-- ======================================================================
-- 060_enable_rls_all_public.sql
-- 목적: Supabase 보안 경고 "rls_disabled_in_public" (Table publicly accessible) 해소.
--   public 스키마에서 RLS 가 아직 꺼진 모든 일반 테이블에 RLS 를 켠다(정책 없음).
--
-- ▣ 왜 안전한가 (이 앱 구조 기준)
--   1) 앱은 전부 service_role 키(서버 API 라우트/스크립트)로만 접근 → RLS 우회. 동작 영향 0.
--      · 브라우저/anon 키로 Supabase 를 직접 읽는 코드 없음(정기배송 대시보드도 /api/subscription/* 경유).
--   2) Looker 는 sales_looker · sales_okr · sales_customer_summary '뷰'로만 읽는다(041).
--      뷰가 소유자 권한으로 실행(security_invoker 미사용)되고 뷰·기반테이블 소유자가 동일(postgres)
--      → 기반테이블 RLS 는 소유자에게 적용 안 됨. Looker 영향 0.
--      (근거: sales_orders/customers/reports 는 039부터 RLS 켜진 채 Looker 정상 동작 중)
--   정책(policy)을 안 붙이므로 anon/authenticated 역할은 이 테이블들에 '접근 불가'(= 원하는 잠금).
--   FORCE ROW LEVEL SECURITY 는 쓰지 않는다(소유자/서비스롤 우회 유지가 목적).
--
-- ▣ 이번에 실제로 RLS 가 빠져 있던 테이블(참고)
--   sales_uploads(040) · sales_sku_cost(043) · sales_channel_config(046) · sales_okr_babyfood_pattern(056)
--   아래 블록은 위 4개를 포함해 "아직 꺼진 모든 public 테이블"을 한 번에 켠다(멱등 — 반복 실행 안전).

do $$
declare r record;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'            -- 일반 테이블만 (뷰/시퀀스/파티션 상위 제외)
      and c.relrowsecurity = false   -- 아직 RLS 꺼진 것만
  loop
    execute format('alter table public.%I enable row level security;', r.relname);
    raise notice 'RLS enabled: public.%', r.relname;
  end loop;
end $$;

-- ▣ 확인용(선택): 아래를 실행하면 public 테이블별 RLS 상태를 볼 수 있다. 모두 true 여야 정상.
--   select c.relname as table_name, c.relrowsecurity as rls_enabled
--   from pg_class c join pg_namespace n on n.oid = c.relnamespace
--   where n.nspname = 'public' and c.relkind = 'r'
--   order by c.relrowsecurity, c.relname;


-- ======================================================================
-- 061_sales_daily_new_repeat.sql
-- ======================================================================
-- 061_sales_daily_new_repeat.sql
-- 일자별 '신규 vs 재구매' 고객 — 루커스튜디오 스코어카드/추세용.
--  · 신규(new)  = 그 날짜가 그 고객의 '첫 구매일'(전 채널 통틀어 최초). = 오늘 새로 유입된 고객.
--  · 재구매(repeat) = 그 날짜에 샀지만 그 이전에도 산 적 있는 고객.
--  ※ 058(sales_customer_summary)은 '고객 생애 세그먼트'(누적 2회+)라 질문이 다름. 061은 '일자별 획득/재방문'.
--
-- [집계 규칙 — 058과 동일한 base]
--  · 고객식별: sales_orders.customer_key (전화 HMAC). 빈 전화('') 제외.
--  · 050 안심번호 고객 제외(sales_customers.phone_digits LIKE '050%').
--  · 매출축 = subtotal_amount, 주문수 = distinct order_id.
--  · order_date 는 KST 기준일(정본) → 루커 타임존을 서울로 두면 'Today' 필터가 맞아떨어짐.
--
-- 사용: 루커에서 이 뷰를 데이터소스로 추가 → 날짜 컨트롤(또는 Today)로 order_date 필터.
--       '오늘'만 보려면 order_date 를 오늘로 필터. 추세로 보려면 order_date 를 축으로.
-- PII 안전: 뷰 소유자(postgres) 권한으로 sales_customers 를 읽어 050 판별에만 사용, 전화는 출력 안 함.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등(create or replace).

create or replace view sales_daily_new_repeat as
with base as (
  select o.customer_key, o.order_date, o.order_id, o.subtotal_amount
  from sales_orders o
  left join sales_customers c on c.customer_key = o.customer_key
  where o.customer_key <> ''
    and coalesce(c.phone_digits, '') not like '050%'
),
firsts as (                         -- 고객별 최초 구매일(전 기간)
  select customer_key, min(order_date) as first_purchase_date
  from base group by customer_key
),
per_cust_day as (                   -- 고객×일자 1행 (그날의 주문수·매출)
  select customer_key, order_date,
         count(distinct order_id) as orders,
         sum(subtotal_amount)     as revenue
  from base group by customer_key, order_date
),
labeled as (
  select d.order_date, d.customer_key, d.orders, d.revenue,
         (d.order_date = f.first_purchase_date) as is_new
  from per_cust_day d
  join firsts f on f.customer_key = d.customer_key
)
select
  order_date,
  count(*) filter (where is_new)               as new_customers,     -- 오늘 신규 고객 수
  count(*) filter (where not is_new)           as repeat_customers,  -- 오늘 재구매 고객 수
  count(*)                                     as total_customers,
  round(100.0 * count(*) filter (where not is_new) / nullif(count(*), 0), 1) as repeat_rate_pct, -- 재구매 비율(%)
  coalesce(sum(revenue) filter (where is_new), 0)     as new_revenue,
  coalesce(sum(revenue) filter (where not is_new), 0) as repeat_revenue,
  coalesce(sum(orders)  filter (where is_new), 0)     as new_orders,
  coalesce(sum(orders)  filter (where not is_new), 0) as repeat_orders
from labeled
group by order_date;

comment on view sales_daily_new_repeat is '일자별 신규(첫구매)·재구매 고객 수/매출/주문수. 루커 오늘·추세용. 050·무전화 제외.';

-- 루커 읽기전용 역할에 조회 권한(역할 있을 때만)
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'looker_ro') then
    grant select on sales_daily_new_repeat to looker_ro;
  end if;
end $$;

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 062_sales_daily_new_repeat_v2.sql
-- ======================================================================
-- 062_sales_daily_new_repeat_v2.sql
-- 061 뷰 재정의: '미분류(안심번호+무전화)' 버킷 추가 → 총주문과 정확히 맞아떨어짐.
--  신규주문 + 재구매주문 + 미분류주문 = 총주문(total_orders).
--  · 신규/재구매 '고객 수'는 식별 가능한 주문(전화 있고 050 아님)만으로 계산 → 예전과 동일하게 정확.
--  · 미분류 = customer_key='' (무전화) 또는 050 안심번호 고객. 같은 사람인지 판별 불가라
--             신규/재구매로 못 나눔 → 주문 수/매출만 별도 버킷으로 노출(총합 맞춤용).
--
-- [왜 필요했나] 하루 주문 167 vs total_customers 132 의 차이(35)는 재구매(1)가 아니라
--   050 안심번호(32)+무전화(2) 였음. 이 버킷을 드러내 "132는 어디서, 나머지는 뭔지" 한눈에.
--
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등.
-- 061에서 컬럼 순서가 바뀌므로 create-or-replace 불가 → drop 후 create(뷰는 참조 대상 없음, 안전).

drop view if exists sales_daily_new_repeat;
create view sales_daily_new_repeat as
with base as (
  select
    o.order_date, o.order_id, o.subtotal_amount, o.customer_key,
    (o.customer_key = '' or coalesce(c.phone_digits, '') like '050%') as unclassified
  from sales_orders o
  left join sales_customers c on c.customer_key = o.customer_key
),
firsts as (                          -- 식별 가능한 고객의 최초 구매일(전 기간)
  select customer_key, min(order_date) as first_purchase_date
  from base where not unclassified
  group by customer_key
),
ident_day as (                       -- 식별 가능: 고객×일자 1행
  select b.customer_key, b.order_date,
         count(distinct b.order_id) as orders,
         sum(b.subtotal_amount)     as revenue
  from base b where not b.unclassified
  group by b.customer_key, b.order_date
),
ident_labeled as (
  select d.order_date, d.orders, d.revenue,
         (d.order_date = f.first_purchase_date) as is_new
  from ident_day d join firsts f on f.customer_key = d.customer_key
),
ident_agg as (
  select order_date,
    count(*) filter (where is_new)                       as new_customers,
    count(*) filter (where not is_new)                   as repeat_customers,
    coalesce(sum(orders)  filter (where is_new), 0)      as new_orders,
    coalesce(sum(orders)  filter (where not is_new), 0)  as repeat_orders,
    coalesce(sum(revenue) filter (where is_new), 0)      as new_revenue,
    coalesce(sum(revenue) filter (where not is_new), 0)  as repeat_revenue
  from ident_labeled group by order_date
),
unclass_agg as (                     -- 미분류(무전화+050): 주문 grain
  select order_date,
         count(distinct order_id) as unclassified_orders,
         sum(subtotal_amount)     as unclassified_revenue
  from base where unclassified group by order_date
),
all_agg as (                         -- 전체 주문(검증축)
  select order_date, count(distinct order_id) as total_orders, sum(subtotal_amount) as total_revenue
  from base group by order_date
)
select
  a.order_date,
  -- 고객 수(식별 가능 기준)
  coalesce(i.new_customers, 0)                                as new_customers,     -- 오늘 신규 고객
  coalesce(i.repeat_customers, 0)                             as repeat_customers,  -- 오늘 재구매 고객
  coalesce(i.new_customers, 0) + coalesce(i.repeat_customers, 0) as total_customers, -- 식별 고객 합
  round(100.0 * coalesce(i.repeat_customers, 0)
        / nullif(coalesce(i.new_customers, 0) + coalesce(i.repeat_customers, 0), 0), 1) as repeat_rate_pct,
  -- 주문 수(합 = 총주문): 신규 + 재구매 + 미분류
  coalesce(i.new_orders, 0)                                   as new_orders,
  coalesce(i.repeat_orders, 0)                                as repeat_orders,
  coalesce(u.unclassified_orders, 0)                          as unclassified_orders, -- 안심번호+무전화(판별불가)
  a.total_orders,                                                                     -- = 위 3개 합
  -- 매출(합 = 총매출)
  coalesce(i.new_revenue, 0)                                  as new_revenue,
  coalesce(i.repeat_revenue, 0)                               as repeat_revenue,
  coalesce(u.unclassified_revenue, 0)                         as unclassified_revenue,
  a.total_revenue
from all_agg a
left join ident_agg   i on i.order_date = a.order_date
left join unclass_agg u on u.order_date = a.order_date;

comment on view sales_daily_new_repeat is
  '일자별 신규(첫구매)·재구매 고객수 + 미분류(안심번호·무전화) 버킷. 신규주문+재구매주문+미분류주문=총주문.';

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'looker_ro') then
    grant select on sales_daily_new_repeat to looker_ro;
  end if;
end $$;

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 063_crm_messages.sql
-- ======================================================================
-- 063_crm_messages.sql
-- CRM 메시지맵 — 카페24 crm_message_map.html(구글시트 CSV 구동)을 내부도구로 이관.
--  고객 여정 단계(stage)별 메시지 카드. 앱에서 표로 직접 편집(구글시트 의존 제거).
--  적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등(IF NOT EXISTS).

create table if not exists crm_messages (
  id          uuid primary key default gen_random_uuid(),
  stage_num   integer not null default 0,      -- 스테이지 순서(작을수록 앞)
  stage       text    not null default '',      -- 스테이지명(여정 단계)
  sub         text    not null default '',      -- 스테이지 부제(단계 내 첫 행 기준 표시)
  title       text    not null default '',      -- 메시지명
  status      text    not null default '',      -- active(활성)/auto(자동)/gap(공백/미완)/paused(중단) 등
  channel     text    not null default '',      -- kakao/manual/cafe24/custom/onsite/leaflet 등
  timing      text    not null default '',      -- 발송 시점
  detail      text    not null default '',      -- 상세 설명
  msg         text    not null default '',      -- 메시지 내용/초안
  img_url     text    not null default '',
  links       jsonb   not null default '{}'::jsonb,  -- {solapi,cafe24,meta,sheets,channel,blog,onsite}
  perf        jsonb   not null default '{}'::jsonb,  -- {sent,reached,opened,clicked,converted,revenue}
  tags        text    not null default '',      -- 콤마 구분
  sort_order  integer not null default 0,       -- 스테이지 내 순서
  active      boolean not null default true,    -- false=목록에서 숨김(삭제 아님)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists crm_messages_stage_idx on crm_messages (stage_num, sort_order);

alter table crm_messages enable row level security;  -- 서비스롤로만 접근(정책 없음)

NOTIFY pgrst, 'reload schema';


-- ======================================================================
-- 064_naver_conv_daily.sql
-- ======================================================================
-- 064: 네이버 검색광고 '구매 전환' 일별 캐시
-- AD_CONVERSION_DETAIL 리포트(하루 단위 비동기)를 파싱해 엔티티별 '구매(purchase)' 전환수/매출을 저장.
-- /stats 는 전환유형(구매/장바구니) 필터가 없어, 구매 기준 ROAS를 이 캐시로 계산한다.
-- 리포트 재생성이 무겁기 때문에 일자 단위로 캐시(최근 2일은 매번 갱신).

create table if not exists naver_conv_daily (
  stat_date      date    not null,
  entity_type    text    not null check (entity_type in ('keyword', 'adgroup')),
  entity_id      text    not null,
  purchase_conv  integer not null default 0,
  purchase_sales bigint  not null default 0,
  updated_at     timestamptz not null default now(),
  primary key (stat_date, entity_type, entity_id)
);

create index if not exists idx_naver_conv_daily_range on naver_conv_daily (entity_type, stat_date);

-- 서비스 롤(supabaseAdmin)만 접근. RLS 켜고 정책 없음 → 익명/공개 접근 차단(마이그레이션 060 정책과 동일 취지).
alter table naver_conv_daily enable row level security;


-- ======================================================================
-- 065_fulfill_dispatch.sql
-- ======================================================================
-- 065: 온라인발주 → 재고 출고 이력(중복 출고 방지 + 감사)
-- 발주엑셀 업로드로 상품출고 시, 같은 바스켓(SKU:수량)이 당일 재출고되는 것을 sig로 차단.
-- 실제 재고 차감은 inventory_txns(출고, 소매); 이 표는 배치 이력만.

create table if not exists fulfill_dispatch (
  id           uuid primary key default gen_random_uuid(),
  sig          text not null,                         -- 바스켓 서명(정렬된 sku:qty 해시)
  dispatch_date date not null default current_date,
  channel      text not null default '소매',
  sku_count    integer not null default 0,
  total_qty    integer not null default 0,
  group_id     uuid,                                  -- inventory_txns 배치 group_id(원복용)
  order_no     text,                                  -- OUT-000123
  created_by   text,
  created_at   timestamptz not null default now()
);

create index if not exists idx_fulfill_dispatch_sig on fulfill_dispatch (sig, dispatch_date);

-- 서비스 롤(supabaseAdmin)만 접근.
alter table fulfill_dispatch enable row level security;

