-- 118: 생산 요청서 '생산시작일' — 입고 자동 매칭 창을 생산기간으로 (2026-09-23 대표 지시, 긴급)
--  · 사고: 요청서를 만들자마자 신청일~마감일 창의 입고가 전량 그 요청서에 잡힘.
--    창 시작이 '신청일'이라, 이전 생산분·일반 입고가 새 요청서에 붙는 구조.
--  · 새 규칙: 매칭 창 = 생산시작일(prod_start, 없으면 신청일) ~ 생산종료일(due_date).
--    종료일 없는 요청서는 자동 매칭 제외. 창 밖 입고를 잔여 FIFO 로 붙이던 규칙(②)은 폐지.
--  · 코드는 118 미적용이어도 동작(prod_start 없으면 신청일 폴백).
-- 적용: Supabase SQL Editor 에 붙여넣고 Run. 멱등(재실행 안전).

alter table production_requests add column if not exists prod_start date;
comment on column production_requests.prod_start is
  '생산시작일 — 입고 자동 매칭 창의 시작(끝은 due_date=생산종료일). null 이면 request_date 를 창 시작으로 사용';
