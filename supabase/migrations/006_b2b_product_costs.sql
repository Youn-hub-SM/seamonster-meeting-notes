-- 이익률 계산용 원가 상세: 제품원가 + 포장재(내/라벨/외) + 제품부피
-- 적용: Supabase Dashboard > SQL Editor 에 전체 붙여넣고 Run.
-- 멱등 — 재실행 안전.
--
-- 포장비(부피별 아이스박스·운반비)와 보냉비(계절별)는 거의 바뀌지 않는
-- 정적 참조표라 앱 코드 상수(app/lib/b2b-margin.ts)로 관리한다.

alter table products
  add column if not exists cost_material numeric(12,2) not null default 0,  -- 제품원가(제조)
  add column if not exists pkg_inner    numeric(12,2) not null default 0,  -- 내포장지
  add column if not exists pkg_label    numeric(12,2) not null default 0,  -- 라벨
  add column if not exists pkg_outer    numeric(12,2) not null default 0,  -- 외포장지
  add column if not exists volume_kg    numeric(8,3);                       -- 제품부피(kg), null=배송비 계산 제외

NOTIFY pgrst, 'reload schema';
