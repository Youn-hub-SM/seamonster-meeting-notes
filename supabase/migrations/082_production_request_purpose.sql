-- 082_production_request_purpose.sql
-- 생산 요청 '용도' 구분 — 재고 보충(소매 판매 대비) vs 도매 납품(MD가 B2B 수요를 직접 판단해 요청).
--  · '생산'(/production/inventory) 화면의 자동 생성 버튼 = '재고 보충'
--  · 생산 일정 하단 '+ 새 생산 요청'(MD 직접 작성) = 기본 '도매 납품' (선택 가능)
--  목록·수정 화면에 배지로 표시돼 "이 생산이 왜 잡혔는지"가 기록으로 남는다.
--
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등.
-- 코드는 미적용 환경에서도 동작(컬럼 없으면 빼고 재시도 + 기본값 표시).

alter table production_requests
  add column if not exists purpose text not null default '재고 보충'
    check (purpose in ('재고 보충', '도매 납품'));

comment on column production_requests.purpose is
  '생산 용도: 재고 보충(생산 화면 자동 생성) | 도매 납품(MD 직접 요청). 기존 행은 재고 보충으로 소급.';

NOTIFY pgrst, 'reload schema';
