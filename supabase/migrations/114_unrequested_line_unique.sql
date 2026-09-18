-- 114_unrequested_line_unique.sql
-- 생산 요청서의 '[요청서에 없음]' 자동 줄(요청수량 0) — 같은 요청서·같은 품목에 하나만 (2026-09-18 창 규칙).
--  입고 매칭(production-allocate)이 요청서에 없던 품목의 입고를 그 주간 요청서에 붙일 때 이 줄을 만든다.
--  동시 입고 2건이 같은 줄을 두 번 만들면 입고가 두 줄로 갈라지므로 부분 유니크로 막고, 코드는 충돌(23505) 시 기존 줄을 재조회해 쓴다.
--  부분 인덱스라 사용자가 같은 품목을 정식 요청 줄(수량>0)로 추가하는 정상 케이스는 막지 않는다.
--  코드는 미적용 환경에서도 동작(충돌이 안 나면 종전대로 새 줄) — 적용하면 경합 방어만 추가된다.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등.

create unique index if not exists prod_req_item_unrequested_uniq
  on production_request_items (request_id, product_id)
  where requested_qty = 0 and memo = '[요청서에 없음]';

notify pgrst, 'reload schema';
