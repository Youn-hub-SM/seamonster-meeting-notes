-- 107: 채널 등록 카탈로그 — 판매 채널 API 로 당겨온 '등록 상품 전체'(매출에 안 잡힌 리스팅 포함).
--  적용: Supabase SQL Editor 에 전체 붙여넣고 Run. 멱등 — 재실행 안전.
--
-- 1차 대상은 네이버 스마트스토어(커머스API): 원상품(어미상품) 아래 옵션·추가상품이 붙는 구조를
-- 행으로 펼쳐 저장한다 — 추가상품의 어미상품이 추정이 아니라 사실로 잡힌다.
-- 동기화는 /api/naver/catalog/sync (화면 버튼·크론). 채널 확장(쿠팡 등)을 위해 channel 컬럼 일반화.

create table if not exists channel_catalog (
  id bigserial primary key,
  channel text not null default '스마트스토어',
  item_key text not null,               -- 채널 내 유일키 (원상품:구분:항목ID)
  origin_no text not null,              -- 원상품 번호(네이버 originProductNo)
  listing_name text not null,           -- 채널 등록 상품명(= 어미상품명)
  item_kind text not null,              -- 'product'(단일) | 'option'(옵션) | 'supplement'(추가상품)
  item_name text,                       -- 옵션명/추가상품명 (단일 상품이면 null)
  sku_code text not null default '',    -- 판매자 관리코드(SKU)
  sale_status text,                     -- 판매상태 원문 (SALE/OUTOFSTOCK/SUSPENSION 등)
  stock_qty integer,
  synced_at timestamptz not null default now(),
  unique (channel, item_key)
);

create index if not exists channel_catalog_sku_idx on channel_catalog (channel, upper(sku_code));

alter table channel_catalog enable row level security; -- service key 전용(정책 없음)

NOTIFY pgrst, 'reload schema';
