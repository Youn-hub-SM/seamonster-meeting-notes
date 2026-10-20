-- 143 AI 데이터 비서 — 새로 보이게 된 표·jsonb 컬럼의 주석 (2026-10-20, 점검 대화에서 비서가 '설명이 없어 가정'한 곳)
--
-- ■ 왜
--   141 로 차단 목록 방식이 되면서 정기배송 신청·클레임·채널 카탈로그·운임 코드·원가·견적·발주 키 표가 비서에게 열렸지만
--   주석이 없어 상태 코드(U/P/C 등)를 비서가 가정으로 때웠다. jsonb 컬럼(CRM perf·스냅샷 키·변경 이력 meta 등)도 키 이름이 없으면 풀어 보지 못한다.
--   표·컬럼 주석 = 비서의 설명. 코드 수정 없이 여기서만 고치면 된다.
--
-- 적용: Supabase Dashboard > SQL Editor 에 전체 붙여넣고 Run. 멱등 — 재실행 안전. 표·컬럼이 없으면 그 줄만 건너뛴다.

create or replace function pg_temp.c(p_rel text, p_col text, p_text text) returns void language plpgsql as $$
begin
  if to_regclass('public.' || p_rel) is null then return; end if;
  if p_col is null then
    execute format('comment on %s public.%I is %L', case when (select relkind from pg_class where oid = to_regclass('public.' || p_rel)) in ('v','m') then 'view' else 'table' end, p_rel, p_text);
  elsif exists (select 1 from pg_attribute where attrelid = to_regclass('public.' || p_rel) and attname = p_col and attnum > 0 and not attisdropped) then
    execute format('comment on column public.%I.%I is %L', p_rel, p_col, p_text);
  end if;
end $$;

-- ── 정기배송 신청(카페24 자동 수집, 127·129) ──
select pg_temp.c('cafe24_subscriptions', null, '카페24 정기배송 신청(신청 단위, 매일 새벽 자동 수집). 이름·주소는 HMAC·시도만. 품목은 cafe24_subscription_items, 결제는 cafe24_subscription_payments, 상태 변화는 cafe24_subscription_state_log');
select pg_temp.c('cafe24_subscriptions', 'subscription_id', '신청번호 S-YYYYMMDD-NNNNNNN(PK)');
select pg_temp.c('cafe24_subscriptions', 'created_date', '신청일');
select pg_temp.c('cafe24_subscriptions', 'state', '신청 단위 상태: U 이용중 / P 일시정지 / C 해지');
select pg_temp.c('cafe24_subscriptions', 'member_hash', '회원 아이디 HMAC(고객 묶기용, 되돌릴 수 없음)');
select pg_temp.c('cafe24_subscriptions', 'region', '수령지 주소 첫 낱말(시·도)');
select pg_temp.c('cafe24_subscription_items', null, '정기배송 신청의 품목(신청 1건에 여러 줄). 회차·주기·상태·결제예정일');
select pg_temp.c('cafe24_subscription_items', 'state', '품목 상태: U 이용중 / B·Q 일시정지(B 구매자·Q 관리자) / M·A·O 해지(M 고객·A 자동·O 관리자)');
select pg_temp.c('cafe24_subscription_items', 'cycle_unit', '배송 주기 단위: W 주 / M 개월 / Y 년 (cycle_count 와 함께, 2W = W·2)');
select pg_temp.c('cafe24_subscription_items', 'cycle_count', '주기 숫자(cycle_unit 과 함께)');
select pg_temp.c('cafe24_subscription_items', 'sequence', '정기배송 회차(1 = 첫 결제)');
select pg_temp.c('cafe24_subscription_items', 'expected_pay_date', '다음 결제 예정일');
select pg_temp.c('cafe24_subscription_items', 'terminated_date', '해지일(해지된 품목만)');
select pg_temp.c('cafe24_subscription_payments', null, '정기배송 결제(신청번호 × 주문번호). 주문번호는 sales_orders.order_id(카페24 채널)와 같은 형식이라 조인해 정기배송 매출을 구한다');
select pg_temp.c('cafe24_subscription_payments', 'status', 'paid 결제완료 / failed 결제실패');
select pg_temp.c('cafe24_subscription_state_log', null, '정기배송 신청 상태 변화 로그(수집 때 직전 상태와 달라진 신청만 1줄). 신규 유입 = prev_state null');
select pg_temp.c('cafe24_subscription_state_log', 'prev_state', '직전 상태 U/P/C. null = 최초 관측(신규 유입)');
select pg_temp.c('cafe24_subscription_state_log', 'new_state', '바뀐 상태: U 이용중 / P 일시정지 / C 해지. 해지 건수 = new_state = ''C'' 수, 재개 = P→U, 재활성 = C→U');
select pg_temp.c('cafe24_subscription_state_log', 'round', '변화 시점 대표 회차(품목 최대 sequence) — "n회차에서 해지" 집계용');
select pg_temp.c('cafe24_subscription_state_log', 'cycle', '변화 시점 배송주기 라벨(2주·1개월 등)');
select pg_temp.c('cafe24_subscription_state_log', 'changed_on', '변화를 관측한 기준일(수집일) — 실제 해지일은 items.terminated_date');

-- ── 채널 클레임·카탈로그·운임 코드 ──
select pg_temp.c('channel_claims', null, '채널 클레임(취소·반품·교환 등, 채널 API 감지). 기간 기준은 detected_at(감지 시각); requested_at 은 채널 원문 텍스트');
select pg_temp.c('channel_claims', 'channel', '스마트스토어 | 쿠팡 | 카페24');
select pg_temp.c('channel_claims', 'claim_type', '취소 | 반품 | 교환 | 상품문의 | 고객문의 등(채널 분류 그대로)');
select pg_temp.c('channel_claims', 'detected_at', '감지 시각(timestamptz) — 월별·주별 집계 기준');
select pg_temp.c('channel_claims', 'requested_at', '채널이 준 요청 시각 원문(text, 비어 있을 수 있음)');
select pg_temp.c('channel_claims', 'notified_at', 'Teams 발송 시각(null = 미발송)');
select pg_temp.c('channel_catalog', null, '채널(스마트스토어) 등록 상품 카탈로그 스냅샷. 한 줄 = 단일 상품/옵션/추가상품 1개. products 와는 sku_code 로 대조');
select pg_temp.c('channel_catalog', 'item_kind', 'product 단일 | option 옵션 | supplement 추가상품');
select pg_temp.c('channel_catalog', 'sale_status', '채널 판매상태 원문(SALE / OUTOFSTOCK / SUSPENSION 등)');
select pg_temp.c('channel_catalog', 'sku_code', '판매자 관리코드(SKU, 빈 값 가능)');
select pg_temp.c('shipping_codes', null, 'CNplus 택배 발주 코드표: SKU 별 택배사 이름과 주문 중량(박스타입·운임은 주문 총중량 구간으로 정해진다)');
select pg_temp.c('shipping_codes', 'order_weight', '상품 1개 주문 중량(kg) — 주문 총중량 합산용');

-- ── 원가·견적·발주 키 ──
select pg_temp.c('sales_sku_cost', null, 'SKU 별 원가·중량(채널별 이익 계산용). sales_orders.sku_code 와 조인');
select pg_temp.c('sales_sku_cost', 'cost_price', '상품 1개 원가(원)');
select pg_temp.c('sales_sku_cost', 'weight_kg', '상품 1개 중량(kg)');
select pg_temp.c('quote_snapshots', null, '제조사 월 견적 확정 스냅샷(월 1건). summary = 총 입금액·품목수·수량·금액·반품, items = 확정 당시 품목표, params = 임대료·면세기타·과세기타');
select pg_temp.c('quote_snapshots', 'summary', 'jsonb {총 입금액, 품목수, 수량, 금액, 반품 …}(QuoteSummary)');
select pg_temp.c('quote_snapshots', 'items', 'jsonb 배열 QuoteItem[] — 확정 당시 품목표(품목·수량·단가·금액)');
select pg_temp.c('fulfill_order_keys', null, '택배 발주처리에서 이미 처리한 주문번호 해시(중복 발주 방지). key = sha1(주문번호) 16자, order_no = 출고번호 OUT-…');
select pg_temp.c('fulfill_pending_keys', null, '출고 배치 서명별 대기 주문 키 목록(keys jsonb = [sha1(주문번호)…])');

-- ── 이미 보이던 표의 jsonb 키 ──
select pg_temp.c('crm_messages', 'perf', 'jsonb {sent 발송, clicked 클릭, converted 전환, revenue 매출(원)} — 누적값(월 구분 없음). 2026-10 현재 대부분 빈 {}(미적재)');
select pg_temp.c('subscription_snapshots', 'snapshot', 'jsonb KPI: activeMembers 이용중 회원, pauseMembers 일시정지, totalMembers 전체, lostMembers 이탈 누적, totalCancels 해지 누적, firstPayRate 첫결제 전환(%), reach3Rate·reach4Rate 3·4회차 도달(%), avgWeightKg, cycleMix 주기 믹스, filteredOrders·totalOrders, auto 자동수집 여부, complete. 날짜 = data_date(text YYYY-MM-DD)');
select pg_temp.c('activity_log', 'meta', 'jsonb 이벤트별 상세(event_type 마다 다름 — 예: 발주 금액·수량·이전값·바뀐값). 키를 모르면 먼저 몇 줄을 보고 쓴다');
select pg_temp.c('sales_reports', 'stats', 'jsonb 매출 리포트 수치(발송 당시 스냅샷). html 은 대용량이라 SELECT 하지 않는다');
select pg_temp.c('fulfill_dispatch', 'keys', 'jsonb [sha1(주문번호)…] 배치에 든 주문 키');
select pg_temp.c('voc', 'photos', 'jsonb 사진 경로 배열(개수만 쓴다)');
select pg_temp.c('delivery_log', 'boxes_normal_manual', 'jsonb {박스종류:개수} 일반 택배 수동 보정분');
select pg_temp.c('delivery_log', 'boxes_guar_manual', 'jsonb {박스종류:개수} 도착보장 수동 보정분');

-- ── 재고 계산 규칙(비서가 가정하던 곳) ──
select pg_temp.c('products', 'stock_tracked', 'false = 재고 관리 사용 안함(드라이아이스 등). 현재고·세트 가능 수량·자동 차감에서 제외한다(재고가 음수로 보여도 무시)');
select pg_temp.c('inventory_txns', 'status', '현재고는 status = ''완료'' 행의 qty 합만. 대기·취소 행은 세지 않는다');
select pg_temp.c('product_bundles', null, '세트 구성(parent_id 세트 × component_id 구성품 × qty 세트당 수량). 세트 자체 재고는 없고 "가능 수량 = min(구성품 현재고 ÷ qty)" — stock_tracked = false 구성품은 빼고 계산');

drop function pg_temp.c(text, text, text);
notify pgrst, 'reload schema';
