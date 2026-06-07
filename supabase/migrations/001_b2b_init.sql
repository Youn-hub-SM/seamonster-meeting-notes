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
