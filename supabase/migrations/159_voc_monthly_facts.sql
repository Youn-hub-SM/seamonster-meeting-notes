-- 159 월간 VOC 리포트 업그레이드 — 판매·배송 대비 VOC율(2026-11-02 대표 결정, 기획안 docs/voc-monthly-report-plan.md)
--
--  ① voc_monthly_reports.facts — 생성 당시 코드가 계산한 숫자(JSON: 요약·6개월 추이·어종별·채널별·유형·귀책·문의·미매칭).
--     다시 열 때 재계산·AI 재호출 없이 KPI 띠·차트를 그린다. generated_at = 그 facts 를 만든 시각.
--  ② voc_sales_by_sku / voc_sales_parcels — 매출 원장(sales_orders)을 월·채널(·관리코드)로 미리 묶어 주는 읽기 함수.
--     한 달 원장을 줄 단위로 읽지 않고 집계만 받는다(6개월 + 전년 같은 달). 배송 건수 = order_unit(146 — 톡스토어 같은 주문자·주문일 = 1건,
--     빈 주문번호는 행별 분리 050). 어종(SKU 어종 코드)·세트 전개는 코드(app/lib/voc-monthly-facts.ts)가 한다.
--  미적용이어도 리포트는 돌아간다 — 율 칸을 숨기고 건수만(코드 폴백). 멱등 — 재실행 안전.

alter table voc_monthly_reports add column if not exists facts jsonb;
alter table voc_monthly_reports add column if not exists generated_at timestamptz;
comment on column voc_monthly_reports.facts is '월간 VOC 리포트 생성 당시 코드 집계(159): summary·trend[6]·by_species·by_channel·by_category·by_fault·inquiries·wholesale·unmatched. 글(draft)의 모든 수치는 여기서만 인용.';
comment on column voc_monthly_reports.generated_at is 'facts·draft 를 AI 로 생성한 시각(편집 자동 저장과 구분).';

-- 월·채널·관리코드별 판매 수량 — 어종별 분모용(코드가 sku → 어종·세트 전개)
create or replace function voc_sales_by_sku(p_from date, p_to date)
returns table(ym text, channel text, sku_code text, qty bigint)
language sql stable as $$
  select to_char(o.order_date, 'YYYY-MM') as ym, o.channel, o.sku_code, sum(o.quantity)::bigint as qty
  from sales_orders o
  where o.order_date between p_from and p_to
  group by 1, 2, 3
  order by 1, 2, 3
$$;
comment on function voc_sales_by_sku(date, date) is '월(YYYY-MM)·채널·관리코드별 판매 수량 합(sales_orders.quantity). 월간 VOC 리포트 어종별 VOC율 분모(159).';

-- 월·채널별 배송 건수(order_unit 기준)·판매 수량 — 채널별 분모용
create or replace function voc_sales_parcels(p_from date, p_to date)
returns table(ym text, channel text, parcels bigint, qty bigint)
language sql stable as $$
  select s.ym, s.channel, count(*)::bigint as parcels, sum(s.q)::bigint as qty
  from (
    select to_char(o.order_date, 'YYYY-MM') as ym, o.channel,
           coalesce(o.order_unit, 'row:' || o.id::text) as ou, sum(o.quantity) as q
    from sales_orders o
    where o.order_date between p_from and p_to
    group by 1, 2, 3
  ) s
  group by 1, 2
  order by 1, 2
$$;
comment on function voc_sales_parcels(date, date) is '월(YYYY-MM)·채널별 배송 건수(주문 1건 = order_unit, 146)와 판매 수량. 월간 VOC 리포트 채널별 VOC율·택배 1,000건당 분모(159).';

notify pgrst, 'reload schema';
