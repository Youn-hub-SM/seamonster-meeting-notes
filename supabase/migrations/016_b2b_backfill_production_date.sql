-- 016: 생산일 백필
-- 발주 등록 시 보통 생산일을 비워두고 발송일만 지정한다.
-- 기존 발주 중 생산일이 비어 있고 발송일이 있는 건은 생산일을 발송일과 동일하게 채운다.
-- (앞으로는 발주 저장(POST/PUT) 시점에 API 가 자동으로 채움 — 이건 기존 데이터용 1회성 백필)

UPDATE orders
SET production_date = ship_date
WHERE production_date IS NULL
  AND ship_date IS NOT NULL;
