-- 172: 생산 요청서 품목의 우선순위 (2026-11-19 대표 지시 — "생산 목록에 우선순위 넣는 칸")
--
-- 제조사(소매) 요청서의 품목마다 숫자 순번을 넣는다. 1 이 가장 먼저 생산할 품목이다.
-- 표시·정렬·우선순위표 출력에만 쓴다 — 입고 연결·재고·권장 계산은 이 값을 보지 않는다.
-- 이 SQL 을 적용하기 전에는 우선순위를 넣어도 저장되지 않고, 다른 기능은 그대로 동작한다.
--
-- 확인: select count(*) from public.production_request_items where priority is not null;
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table public.production_request_items
  add column if not exists priority integer;

comment on column public.production_request_items.priority is '생산 우선순위 — 숫자 순번, 1 이 가장 먼저. 제조사(재고 보충) 요청서에서 사람이 넣는다. 비어 있으면(null) 순번 없음';
