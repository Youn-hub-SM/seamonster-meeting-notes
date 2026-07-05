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
