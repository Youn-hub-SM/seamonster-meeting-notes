-- 134 B2B 발주 취소·복구 표식 + 발주 등록 멱등 키(2026-10-11 원장 기준 점검 G1)
--
-- ■ 왜
--   ① 발주 단위로 '취소'하면 모든 차수가 취소로 덮여, 그 전에 거래처 요청으로 따로 취소해 둔 차수(예: 2차 40개)와
--      구분이 사라졌다. 발주를 다시 '발송대기'로 되돌리면 그 2차까지 되살아나 재고 차감·매출·청구가 40개분 다시 늘었다(점검 확정).
--      → shipments.cancelled_with_order: 발주 취소로 '같이' 취소된 차수 표식. 복구는 이 표식이 있는 차수만 되살린다.
--   ② 발주 등록 응답이 끊기거나 늦어 [등록]을 다시 누르면 같은 발주가 새 번호로 한 건 더 생겼다(S2 정확히 한 번).
--      → orders.client_request_id: 등록 화면을 열 때 만든 요청 키. 같은 키로 다시 오면 처음 만든 발주를 그대로 돌려준다.
--
-- ■ 바뀌는 것
--   - shipments 에 cancelled_with_order boolean(기본 false) 칸 추가. 기존 행은 모두 false —
--     표식이 하나도 없는 옛 취소 발주는 복구 때 예전처럼 취소 차수를 전부 되살린다(코드 폴백).
--   - orders 에 client_request_id text 칸 + 값이 있을 때만 유일한 인덱스 추가. 기존 발주는 null(영향 없음).
--   데이터는 바꾸지 않는다.
--
-- ■ 미적용이어도
--   코드가 칸 유무를 확인해 없으면 넣지 않는다 — 발주 복구는 예전처럼 전 차수를 되살리고, 등록 재시도는 중복을 막지 못한다(종전 동작).
--
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table public.shipments add column if not exists cancelled_with_order boolean not null default false;
comment on column public.shipments.cancelled_with_order is
  '발주 단위 취소로 같이 취소된 차수(true). 발주 복구는 이것만 되살린다 — 먼저 따로 취소한 차수는 취소 유지';

alter table public.orders add column if not exists client_request_id text;
create unique index if not exists orders_client_request_id_uidx
  on public.orders (client_request_id) where client_request_id is not null;
comment on column public.orders.client_request_id is
  '발주 등록 요청 키(등록 화면이 만든 값) — 같은 키의 재요청은 처음 만든 발주를 돌려준다';

notify pgrst, 'reload schema';
