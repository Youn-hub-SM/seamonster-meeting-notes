-- 127 카페24 정기배송 신청 자동 수집(2026-10-07 대표 결정)
--
-- ■ 왜
--   정기배송 분석은 카페24 관리자에서 CSV 를 내려받아 올려야만 볼 수 있었다. 카페24 Admin API
--   (GET /api/v2/admin/subscription/shipments)가 같은 신청 목록을 주는 것을 시험 조회로 확인(CSV 467건 전부 일치)해,
--   중계 서버가 매일 새벽 수집해 여기에 저장하고 분석 화면이 열 때 자동으로 불러온다.
--
-- ■ 개인정보 — 저장하지 않는다
--   이름·연락처·주소·이메일은 받지도 저장하지도 않는다. 회원 아이디와 신청자·수령자 이름은 서버가 받는 즉시
--   HMAC(되돌릴 수 없는 암호화 값)으로 바꿔 저장한다(이름으로 제외·검색할 때 입력값도 같은 방식으로 바꿔 비교).
--   주소는 첫 낱말(시·도)만 받는다.
--
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.
--   미적용이어도 분석 화면은 예전처럼 CSV 업로드로 동작한다.

create table if not exists public.cafe24_subscriptions (
  subscription_id    text primary key,          -- 신청번호(S-YYYYMMDD-NNNNNNN)
  created_date       date,                      -- 신청일
  state              text,                      -- 신청 단위 상태 U 이용중 / P 일시정지 / C 해지
  member_hash        text,                      -- 회원 아이디 HMAC
  buyer_name_hash    text,                      -- 신청자 이름 HMAC
  receiver_name_hash text,                      -- 수령자 이름 HMAC
  region             text,                      -- 수령지 주소 첫 낱말(시·도)
  synced_at          timestamptz not null default now()
);

create table if not exists public.cafe24_subscription_items (
  subscription_item_id   text primary key,
  subscription_id        text not null references public.cafe24_subscriptions(subscription_id) on delete cascade,
  sort                   integer,               -- 카페24 응답 순서
  product_no             integer,
  product_code           text,
  variant_code           text,
  product_name           text,
  option_value           text,
  quantity               numeric,
  cycle_unit             text,                  -- W 주 / M 개월 / Y 년
  cycle_count            integer,               -- 주기 숫자(2W = W·2)
  sequence               integer,               -- 정기배송 회차
  state                  text,                  -- U 이용중 / B·Q 일시정지(구매자·관리자) / M·A·O 해지(고객·자동·관리자)
  expected_pay_date      date,
  expected_delivery_date date,
  terminated_date        date,
  max_delivery_limit     integer,
  synced_at              timestamptz not null default now()
);
create index if not exists cafe24_subscription_items_sub_idx on public.cafe24_subscription_items (subscription_id);

create table if not exists public.cafe24_subscription_payments (
  subscription_id text not null,
  order_id        text not null,
  status          text,                         -- paid 결제완료 / failed 결제실패
  payment_date    timestamptz,
  synced_at       timestamptz not null default now(),
  primary key (subscription_id, order_id)
);

-- 서버(service role)만 읽고 쓴다 — 공개 키로는 접근 불가
alter table public.cafe24_subscriptions enable row level security;
alter table public.cafe24_subscription_items enable row level security;
alter table public.cafe24_subscription_payments enable row level security;

notify pgrst, 'reload schema';
