-- 148 VOC: 주문번호·접수 유형 (2026-10-26 대표 결정)
--  · 고객 칸은 '이름'만 받는다(연락처 X). 재구매 확인은 주문번호 → sales_orders.customer_key 로 한다.
--  · 구매자 구분(buyer_type)·구매일(purchase_date)은 더 이상 손으로 넣지 않고, 주문번호가 있으면 서버가 채운다
--    (첫구매/재구매 = 그 고객(customer_key)의 주문 건수, 구매일 = 주문일). 칸은 그대로 둔다(옛 데이터·통계).
--  · 접수 유형(intake_type): 문의·상담·리뷰·기타 — 리뷰에서 가져온 내용(직접 응대 안 함)을 구분한다. 수집 방식(source)과 별개.

alter table voc add column if not exists order_no text;                                   -- 주문번호(채널 주문번호 그대로)
alter table voc add column if not exists intake_type text not null default '문의'
  check (intake_type in ('문의', '상담', '리뷰', '기타'));                                  -- 접수 유형

create index if not exists voc_order_no_idx on voc (order_no) where order_no is not null;

comment on column voc.order_no    is 'VOC 주문번호(채널 주문번호). sales_orders.order_id 와 맞춰 재구매 여부·구매일을 자동으로 채운다';
comment on column voc.intake_type is 'VOC 접수 유형: 문의(고객이 물어옴)·상담(응대하며 접수)·리뷰(리뷰에서 가져옴, 직접 응대 없음)·기타';
comment on column voc.buyer_type  is '구매자 구분(첫구매/재구매) — 2026-10-26 부터 주문번호로 자동 판정(고객의 주문 건수 2건 이상 = 재구매)';
comment on column voc.purchase_date is '구매일 — 2026-10-26 부터 주문번호의 주문일로 자동';
