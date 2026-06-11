-- 발송 차수(하위 발주) 상태를 일반 발주와 동일한 5단계로 변경 ('발송중' 제거).
--   발주확인/생산대기 · 생산요청/생산중 · 생산완료/발송대기 · 발송완료 · 취소
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

-- 1) 기존 CHECK 제약 먼저 제거 (안 그러면 아래 update 가 구 제약에 막힘)
alter table shipments drop constraint if exists shipments_status_check;

-- 2) 기존 값 매핑 (발송대기·발송중 → 생산완료/발송대기)
update shipments set status = '생산완료/발송대기' where status in ('발송대기', '발송중');

-- 3) 새 CHECK 제약 추가 (5단계 + 구값 호환)
alter table shipments add constraint shipments_status_check
  check (status in (
    '발주확인/생산대기', '생산요청/생산중', '생산완료/발송대기', '발송완료', '취소',
    '발송대기', '발송중'   -- 구버전 호환 (UI 에선 더 이상 생성 안 함)
  ));

-- 4) 기본값
alter table shipments alter column status set default '발주확인/생산대기';

NOTIFY pgrst, 'reload schema';
