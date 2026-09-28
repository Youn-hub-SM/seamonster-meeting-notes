-- 121: 재고 관리 사용 안함 — 드라이아이스·이벤트 상품처럼 입고·재고 관리가 필요 없는 품목 (2026-09-29 대표 요청)
--  false = 재고 목록·입·출·조정·양식·재고 이동·재고 대사·생산 권장·일일 리포트 품절 경보에서 빠지고,
--          온라인 출고·B2B 발송 때 재고 원장에 차감 행을 남기지 않는다.
--  판매·B2B 발주·택배·송장 스캔·매출은 그대로(products.active '미사용'과 다른 축). 필터는 앱 코드에서 한다 — 재고 RPC 는 안 바꾼다.
-- 적용: Supabase SQL Editor 에 붙여넣고 Run. 멱등(재실행 안전).

alter table products add column if not exists stock_tracked boolean not null default true;

comment on column products.stock_tracked is
  '재고 관리 사용 여부. false = 재고 관리 사용 안함 — 재고 화면·원장 자동 기록에서 제외, 판매·B2B 는 그대로';

notify pgrst, 'reload schema';
