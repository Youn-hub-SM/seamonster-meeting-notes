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
