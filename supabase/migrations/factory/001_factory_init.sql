-- factory/001 파도소리(제조사) 재고 원장 — 로트 단위
--
-- ■ 구조는 현재 쓰고 있는 주간 재고장 엑셀(구평재고 / 대한외기타창고)에서 따왔다.
--   엑셀의 한 행 = 로트 1개다. 같은 품명이라도 규격·테잎색·원산지·입고일이 다르면 별도 행으로
--   관리한다(삼치순살 16행·고등어순살 13행). 그래서 품목이 아니라 **로트**가 재고의 단위다.
--
--   달라지는 것: 현재수량을 저장하지 않고 거래 합계로 도출한다.
--   → 매주 새 파일을 만들어 '현재수량'을 다음 주 '전수량'으로 옮기는 작업이 사라진다.
--   → 출고 칸이 월~금 5개로 고정된 제약도 사라진다(같은 날 같은 로트에서 여러 건 가능).
--
-- ■ 이 번호열(supabase/migrations/factory/*)은 본 번호열과 별개로 001부터 센다.
--   **factory 번호열은 factory 스키마 밖(public)을 만들거나 바꾸지 않는다.** (CLAUDE.md §3a)
--
-- ■ 사전 작업(최초 1회, SQL 아님):
--   Supabase Dashboard > Settings > API > Exposed schemas 에 factory 를 추가한다.
--   PostgREST(supabase-js)는 노출된 스키마만 접근하므로, 안 하면 모든 factory API 가 실패한다.
--
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

create schema if not exists factory;

-- ── 창고 ────────────────────────────────────────────────────────────
-- is_own = 파도소리 내부창고(구평). 나머지는 외부 위탁창고 — 엑셀의 시트 2개 구분과 같다.
create table if not exists factory.warehouses (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  is_own boolean not null default false,
  sort integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into factory.warehouses (name, is_own, sort) values
  ('구평1', true, 1), ('현이냉동', false, 10), ('원항수산', false, 11),
  ('여수수협', false, 12), ('㈜동남', false, 13)
on conflict (name) do nothing;

-- ── 로트 ────────────────────────────────────────────────────────────
-- 수량 컬럼이 없다. 현재고는 lot_txns 합계다(아래 lot_stock 뷰) — 저장하면 반드시 어긋난다.
create table if not exists factory.lots (
  id uuid primary key default gen_random_uuid(),
  warehouse_id uuid not null references factory.warehouses(id),
  item_name text not null,                 -- 품명
  spec text,                               -- 규격 (블록·원료·150/200·IQF·탈피 …)
  tape_color text,                         -- 테잎색 — 내부창고(구평)의 로트 식별자. 외부창고는 안 씀
  origin text,                             -- 원산지
  note text,                               -- 적요
  supplier text,                           -- 매입처 (품명 앞 '새벽)' · 적요의 '세원매입' 등)
  box_kg numeric(10,2),                    -- 박스당 중량(kg)
  unit text not null default 'B',          -- 단위 — 현재 전량 박스(B)
  first_in_date date,                      -- 최초 입고일
  prod_date date,                          -- 생산일(외부창고 재고장에만 있는 칸)
  -- 엑셀에서 옮겨올 때만 채운다. 이관 시점의 시작 잔량은 '전수량'이라 Σ입고 가 엑셀의
  -- '최초입고수량'과 다르다(이전 주들의 출고가 이 파일에 없다). 종이 원장과 대조할 때 필요해 남긴다.
  init_qty numeric(14,3),
  memo text,
  origin_lot_id uuid references factory.lots(id),  -- 창고 이동으로 생겨난 로트의 출처
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists factory_lots_wh_idx on factory.lots (warehouse_id);
create index if not exists factory_lots_name_idx on factory.lots (item_name);
create index if not exists factory_lots_date_idx on factory.lots (first_in_date desc);

-- ── 입출고 거래 ─────────────────────────────────────────────────────
-- qty 는 **부호 있는 수량**이다: 입고 +, 출고·생산투입 −, 조정 ±.
--  이렇게 두면 현재고가 그냥 sum(qty) 라 부호 규칙이 코드 여기저기로 퍼지지 않는다.
--  '생산투입' = 원물을 현장 생산에 넣는 것(엑셀 출고처 '현장'). 거래처 납품과 성격이 달라 유형을 나눈다.
--  '이동' = 창고 간 이동(외부창고 → 구평). 한 번의 입력이 move_id 로 묶인 2행을 만든다
--          (보내는 로트 −, 받는 로트 +). 전체 재고 총량은 변하지 않는다.
create table if not exists factory.lot_txns (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references factory.lots(id) on delete cascade,
  txn_date date not null default current_date,
  type text not null check (type in ('입고', '출고', '생산투입', '이동', '조정')),
  qty numeric(14,3) not null check (qty <> 0),
  dest text,                               -- 행선지: 거래처명 · 현장 · (이동이면) 상대 창고명
  move_id uuid,                            -- 이동 한 쌍을 묶는 키
  memo text,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists factory_txns_lot_idx on factory.lot_txns (lot_id);
create index if not exists factory_txns_date_idx on factory.lot_txns (txn_date desc);
create index if not exists factory_txns_move_idx on factory.lot_txns (move_id);

-- ── 현재고 뷰 ───────────────────────────────────────────────────────
-- 로트 1행 + 현재수량(qty) + 최초입고수량(first_qty). 화면·API 는 이 뷰만 읽는다.
create or replace view factory.lot_stock as
select
  l.id, l.warehouse_id, w.name as warehouse, w.is_own,
  l.item_name, l.spec, l.tape_color, l.origin, l.note, l.supplier,
  l.box_kg, l.unit, l.first_in_date, l.prod_date, l.memo, l.origin_lot_id,
  coalesce(sum(t.qty), 0) as qty,
  coalesce(l.init_qty, sum(t.qty) filter (where t.type = '입고'), 0) as first_qty,
  max(t.txn_date) filter (where t.qty < 0) as last_out_date,
  l.created_at, l.updated_at
from factory.lots l
join factory.warehouses w on w.id = l.warehouse_id
left join factory.lot_txns t on t.lot_id = l.id
group by l.id, w.name, w.is_own, l.init_qty;

-- 앱은 service_role 로만 접근하므로 정책 없이 RLS 만 켠다(다른 테이블과 동일).
alter table factory.warehouses enable row level security;
alter table factory.lots enable row level security;
alter table factory.lot_txns enable row level security;

-- ── 권한 ────────────────────────────────────────────────────────────
-- public 과 달리 직접 만든 스키마는 기본 grant 가 없다 — 안 주면 서비스 키도
-- "permission denied for schema factory [42501]" 를 맞는다(003 에서 뒤늦게 발견).
-- anon/authenticated 는 주지 않는다(파도소리 앱은 service_role 전용, 최소 권한).
grant usage on schema factory to service_role;
grant all on all tables in schema factory to service_role;   -- 뷰(lot_stock) 포함
alter default privileges for role postgres in schema factory grant all on tables to service_role;

notify pgrst, 'reload schema';
