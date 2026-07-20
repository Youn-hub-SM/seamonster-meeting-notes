-- 075 배송일지 자동입력/직접수정 분리
--  기존 boxes_normal/boxes_guar = 발주처리가 기록하는 '자동입력'(화면에서 수정 불가로 변경).
--  직접수정은 별도 보정(±) 컬럼에 기록하고, 최종 택배량 = 자동 + 보정(0 미만 방지)으로 파생.
--  기본운임도 자동값 + 보정분(박스종류 대표단가) 파생 — 발주처리의 주문 단위 정밀 운임이 보존된다.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table delivery_log add column if not exists boxes_normal_manual jsonb;  -- 직접수정 보정(± 박스종류별)
alter table delivery_log add column if not exists boxes_guar_manual jsonb;
alter table delivery_log add column if not exists manual_updated_at timestamptz; -- 직접수정 최종 시각

NOTIFY pgrst, 'reload schema';
