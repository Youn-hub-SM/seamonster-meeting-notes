-- 발송 차수(하위 발주)별 박스 수 — 송장 출력 행 수 + 송장번호 입력칸 수의 기준.
--   2박스면 송장 출력 시 2행(이름 넘버링 + '(N박스 중 n)'), 송장번호도 박스당 1개.
-- 발주 단위 box_count(orders.box_count, 이익률용)는 차수 박스 수의 합으로 자동 동기화.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table shipments
  add column if not exists box_count int not null default 1;

NOTIFY pgrst, 'reload schema';
