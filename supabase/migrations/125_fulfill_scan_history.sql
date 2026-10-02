-- 125 송장 스캔 기록 30일 보관 (2026-10-02 대표 결정)
--
-- ■ 왜
--   지금 '초기화'(F4)·'풀 비우기'는 스캔 기록(fulfill_scan_events)을 지워서, 앞 라운드에서 찍은 송장을
--   다음 라운드에 다시 찍어도 처음처럼 집계됐다(CJ 재출력으로 같은 송장이 두 장 나오면 이중 출고 위험).
--
-- ■ 바뀌는 것
--   초기화 = 지우지 않고 cleared_at(마감 시각)을 찍는다. 집계·대상은 cleared_at 이 비어 있는 '이번 라운드'만.
--   마감된 송장을 다시 찍으면 '이전 라운드에서 스캔됨'으로 경고하고 집계에서 뺀다(송장번호가 PK 라 행은 하나).
--   마감 후 30일 지난 기록은 다음 초기화 때 지운다. 직전 초기화는 되돌릴 수 있다(같은 cleared_at 묶음).
--
-- 미적용이어도 앱은 예전처럼(초기화 = 삭제) 동작한다.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table public.fulfill_scan_events add column if not exists cleared_at timestamptz;
comment on column public.fulfill_scan_events.cleared_at is '초기화(라운드 마감) 시각 — null = 이번 라운드. 30일 지나면 삭제';
create index if not exists fulfill_scan_events_cleared_idx on public.fulfill_scan_events (cleared_at);

notify pgrst, 'reload schema';
