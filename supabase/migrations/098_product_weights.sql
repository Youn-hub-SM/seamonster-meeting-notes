-- 098 상품 중량 3단 (2026-08-27) — 생산 요청서의 총중량·소포장 개수를 상품명 문자열 추측 없이 계산하기 위함.
--  옵션중량(조각 1개) ⊂ 포장중량(소포장 1개) ⊂ SKU중량(판매 단위 1개)
--   예) 옵션 200g 조각 · 포장 1kg → 소포장 1개에 조각 5개 · SKU 2kg → 한 SKU 에 1kg 소포장 2개
--  단위는 전부 g — 화면·엑셀 모두 g 로 직접 입력한다.
--  비워 두면(0/null) 기존처럼 상품명·규격 문자열에서 읽는 폴백이 동작한다.
alter table products
  add column if not exists option_weight_g numeric(12,2),  -- 옵션중량: 조각 1개 중량(표시용)
  add column if not exists pack_weight_g   numeric(12,2),  -- 포장중량: 소포장(진공팩) 1개 중량(집계 단위)
  add column if not exists sku_weight_g    numeric(12,2);  -- SKU중량: 판매 단위 1개의 총중량

comment on column products.option_weight_g is '옵션중량(g) — 조각 1개';
comment on column products.pack_weight_g   is '포장중량(g) — 소포장 1개';
comment on column products.sku_weight_g    is 'SKU중량(g) — 판매 단위 1개 총중량';

notify pgrst, 'reload schema';
