-- 076 배송일지 직접수정을 '사유가 있는 건별 내역'으로
--  보정 하나하나를 {구분(일반/도착보장)·박스종류·수량(±)·내용·시각·작업자} 로 기록해
--  왜 고쳤는지 히스토리가 남는다. 보정 합계 = 내역 합(+ 075 의 구컬럼 잔여값).
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table delivery_log add column if not exists manual_entries jsonb not null default '[]'::jsonb;

NOTIFY pgrst, 'reload schema';
