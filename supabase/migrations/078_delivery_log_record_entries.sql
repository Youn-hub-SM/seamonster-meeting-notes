-- 078 배송일지 자동입력을 '배치별 기록 이력'으로
--  발주처리의 '배송일지에 기록' 1회 = 이력 1건 {시각·모드·박스수·운임·서명}.
--  자동입력 합계 = 이력 합으로 재계산 → 건별 되돌리기 가능.
--  같은 날짜에 같은 내용(박스종류별 수량+운임) 기록이 이미 있으면 중복으로 차단(강행 가능).
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table delivery_log add column if not exists record_entries jsonb not null default '[]'::jsonb;

NOTIFY pgrst, 'reload schema';
