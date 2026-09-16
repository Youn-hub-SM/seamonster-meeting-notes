-- 113: 프로모션 재고 풀 — 대량 행사용 소매 재고를 셋째 풀('프로모션')로 분리(2026-09-17 대표 확정).
--  · 자동 차감 경로(택배 출고·판매 기록·업로드=소매, B2B 발송=도매)가 프로모션 풀을 건드리지 않아
--    "행사일까지 못 빠져나감"이 구조로 보장된다. 넣고 빼는 길 = 재고 옮기기(사람) + 행사 종료 자동 합류.
--  · 생산 요청 용도에 '프로모션' 추가 — 요청서(행사명·목표일=마감일) 단위로 확보 목표·이행률 추적.
-- 적용: Supabase SQL Editor 에 붙여넣고 Run. 멱등(재실행 안전).
-- ★ 주의: 적용 후에도 '풀 사용(소매→프로모션 이동)'은 운영에 프로모션 코드가 배포된 뒤 시작할 것 —
--   운영 구코드의 소매 생산 수식은 풀을 몰라, 그 전에 옮기면 운영 화면 권장이 풀 수량만큼 부풀어
--   이중 생산을 유발한다(베타·운영 같은 DB). 요청서 작성·조회는 배포 전에도 무해.

-- 1) 재고 원장 채널 확장: 도매/소매 → +프로모션
alter table inventory_txns drop constraint if exists inventory_txns_channel_chk;
alter table inventory_txns add constraint inventory_txns_channel_chk
  check (channel in ('도매', '소매', '프로모션'));

-- 2) 생산 요청 용도 확장: 재고 보충/도매 납품 → +프로모션
alter table production_requests drop constraint if exists production_requests_purpose_check;
alter table production_requests add constraint production_requests_purpose_check
  check (purpose in ('재고 보충', '도매 납품', '프로모션'));

comment on column inventory_txns.channel is
  '재고 풀: 도매(B2B) | 소매(온라인몰) | 프로모션(행사 확보분 — 이동으로만 입고, 행사 종료 시 소매로 자동 합류)';
comment on column production_requests.purpose is
  '생산 용도: 재고 보충(제조사) | 도매 납품(MD) | 프로모션(행사 확보 — 소매→프로모션 이동 배정으로 이행)';

NOTIFY pgrst, 'reload schema';
