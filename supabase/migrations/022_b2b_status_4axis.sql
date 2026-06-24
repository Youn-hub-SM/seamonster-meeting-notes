-- 발주 상태 4축 재설계: 생산(발주 단위) · 발송(차수) · 입금 · 발행 분리.
--   생산: 생산대기/생산중/생산완료  (orders.production_status 신설, 발주 단위)
--   발송: 발송대기/발송완료/취소     (orders.status = 차수 롤업, shipments.status = 차수별)
--   입금: 입금전/일부입금/입금완료/불필요
--   발행: 미발행/발행완료/불필요
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

-- 1) 기존/신규 CHECK 제약 제거 (재실행 안전)
alter table orders drop constraint if exists orders_status_check;
alter table orders drop constraint if exists orders_production_status_check;
alter table orders drop constraint if exists orders_payment_status_check;
alter table orders drop constraint if exists orders_tax_invoice_status_check;
alter table shipments drop constraint if exists shipments_status_check;

-- 2) 생산 상태 컬럼 신설 (발주 단위)
alter table orders add column if not exists production_status text not null default '생산대기';

-- 3) 데이터 매핑
--   3a) 생산상태 = 기존 status 로부터 도출 (status 가 아직 옛 값일 때만 — 재실행 안전)
update orders set production_status = case
    when status in ('생산완료/발송대기','발송완료') then '생산완료'
    when status = '생산요청/생산중' then '생산중'
    else '생산대기' end
  where status in ('발주확인/생산대기','생산요청/생산중','생산완료/발송대기','발송완료','취소');
--   3b) orders.status → 발송 축
update orders set status = case
    when status = '발송완료' then '발송완료'
    when status = '취소' then '취소'
    else '발송대기' end;
--   3c) shipments.status → 발송 축
update shipments set status = case
    when status = '발송완료' then '발송완료'
    when status = '취소' then '취소'
    else '발송대기' end;
--   3d) 입금 라벨
update orders set payment_status = case
    when payment_status = '미입금' then '입금전'
    when payment_status = '부분입금' then '일부입금'
    when payment_status = '확인불필요' then '불필요'
    else payment_status end;
--   3e) 발행 라벨
update orders set tax_invoice_status = case
    when tax_invoice_status = '면제' then '불필요'
    when tax_invoice_status = '발행대기' then '미발행'
    else tax_invoice_status end;

-- 4) 기본값 + 새 CHECK 제약
alter table orders alter column status set default '발송대기';
alter table orders alter column production_status set default '생산대기';
alter table orders alter column payment_status set default '입금전';
alter table orders alter column tax_invoice_status set default '미발행';
alter table shipments alter column status set default '발송대기';

-- CHECK 는 신·구 값을 모두 허용(permissive) — 마이그레이션을 배포 전에 먼저 적용해도
-- 구 코드(옛 라벨로 insert)가 깨지지 않도록. 배포 후엔 신 코드가 신 값만 기록함.
alter table orders add constraint orders_status_check
  check (status in ('발송대기','발송완료','취소','발주확인/생산대기','생산요청/생산중','생산완료/발송대기'));
alter table orders add constraint orders_production_status_check
  check (production_status in ('생산대기','생산중','생산완료'));
alter table orders add constraint orders_payment_status_check
  check (payment_status in ('입금전','일부입금','입금완료','불필요','미입금','부분입금','확인불필요'));
alter table orders add constraint orders_tax_invoice_status_check
  check (tax_invoice_status in ('미발행','발행완료','불필요','발행대기','면제'));
alter table shipments add constraint shipments_status_check
  check (status in ('발송대기','발송완료','취소','발주확인/생산대기','생산요청/생산중','생산완료/발송대기'));

create index if not exists orders_production_status_idx on orders (production_status);

NOTIFY pgrst, 'reload schema';
