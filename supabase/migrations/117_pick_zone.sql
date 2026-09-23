-- 117: 창고 위치(픽업 구역) — 송장 스캔 피킹 리스트를 걷는 순서대로 (2026-09-23 대표 지시)
--  · 피킹 리스트가 가나다순이라 픽업자가 창고를 오락가락하던 문제. 품목에 구역을 달고,
--    구역의 순서(= 걷는 경로)는 b2b_settings 'pick_zones' 에 배열로 둔다(별도 테이블 불필요).
--  · 리스트 = 구역 순 → 구역 안은 가나다. 미지정은 맨 뒤 '위치 미지정' 묶음.
-- 적용: Supabase SQL Editor 에 붙여넣고 Run. 멱등(재실행 안전).

alter table products add column if not exists pick_zone text;
comment on column products.pick_zone is
  '창고 픽업 구역(선반) 라벨. 순서는 b2b_settings pick_zones 배열이 정한다(걷는 경로 순). null = 위치 미지정';
