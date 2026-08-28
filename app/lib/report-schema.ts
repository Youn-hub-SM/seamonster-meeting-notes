// AI 커스텀 리포트가 SQL을 만들 때 참고하는 '스키마 카탈로그'.
//  · 전부 public 스키마. 금액=원(KRW) 정수. customer_key=전화 HMAC 해시(PII 아님, 고객 식별용).
//  · order_date=KST 기준일. 재고 현재수량=inventory_txns 에서 status='완료' 의 qty 합.
//  PII(전화·이름) 테이블 sales_customers 는 화이트리스트에서 제외 → 사용 금지.

// 여기서(run_report) 조회 가능한 관계 — 2026-08-28 전면 개방(대표 지시).
//  비공개(고객 PII·토큰 설정·계정·면담·입금·설문 원문·shipments/companies 원본)만 제외 — migration 100 이 RPC 단에서도 차단.
export const RUN_HERE_RELATIONS = [
  // 매출
  "sales_orders", "sales_looker", "sales_group_repeat", "sales_buyer_repeat",
  "sales_daily_new_repeat", "sales_customer_summary", "sales_okr",
  "sales_reports", "sales_uploads", "sales_channel_config", "subscription_snapshots", "naver_conv_daily",
  // 상품·재고
  "products", "inventory_txns", "inventory_items", "product_bundles",
  // B2B 발주(개인정보 없는 투영 뷰 포함)
  "orders", "order_items", "companies_report", "shipments_report", "shipment_items",
  "payments", "company_product_prices", "cost_history", "activity_log",
  // 생산·매입
  "production_requests", "production_request_items", "production_receipts",
  "product_cost_schedules", "purchase_returns",
  // 물류·발주처리
  "delivery_log", "fulfill_dispatch", "fulfill_scan_uploads", "fulfill_scan_items", "fulfill_scan_events",
  // VOC·CS
  "voc", "voc_categories", "cs_manual",
  // 마케팅·링크
  "crm_messages", "short_links", "qr_scans", "utm_links", "ig_dm_rules", "ig_dm_logs",
];

// 루커스튜디오(looker_ro)가 볼 수 있는 뷰(원장·재고·products 는 못 봄)
export const LOOKER_RELATIONS = [
  "sales_looker", "sales_group_repeat", "sales_buyer_repeat",
  "sales_daily_new_repeat", "sales_customer_summary", "sales_okr",
];

export const SCHEMA_CATALOG = `## 매출(SALES)

TABLE sales_orders — 매출 원장(줄 단위, PII 없음). [루커 못 봄 → 루커엔 sales_looker 사용]
  order_date(date, KST 기준일), order_year(int), order_month(int), channel(text 판매처 예 '도매'),
  order_id(text 주문번호), product_name(text), option_name(text), sku_code(text 관리코드),
  quantity(int), selling_price(bigint), option_price(bigint), subtotal_amount(bigint 결제금액=매출축),
  shipping_fee(bigint), customer_key(text 전화해시 ''=전화없음), source(text), upload_batch(text), order_date_int(int yyyymmdd)

VIEW sales_looker — sales_orders 의 분석용 투영(내부컬럼 제외). 루커 노출용. 컬럼은 sales_orders 와 동일(id/row_hash/source 등 제외) + customer_key(해시).

VIEW sales_group_repeat — 구매차수 코호트(첫/재/재재구매)를 4축으로. 줄 단위. 전화있고 050아닌 고객만.
  order_date, channel, order_id, order_key(=customer_key|order_id, 주문수는 이걸 COUNT DISTINCT), product_name, sku_code, quantity, subtotal_amount, customer_key,
  product_group(text SKU코어코드 예 'DG'), group_name(text 친화명 예 '대구살'),
  group_purchase_seq/label, sku_purchase_seq/label, name_purchase_seq/label, cust_order_seq/label
  (label 형식: '1_첫구매','2_재구매','3_재재구매','4_4회이상')

VIEW sales_buyer_repeat — 특정 상품 구매고객의 (상품무관) 재구매 리텐션. 그레인=(axis,axis_value,customer_key). 반드시 axis_value 하나로 필터.
  axis(text 'sku'|'name'), axis_value(text), display_name(text 대표상품명), customer_key,
  anchor_orders(bigint), first_anchor_date(date), total_orders(bigint 생애총주문), total_repeat_label(text A기준),
  orders_since_first_anchor(bigint), repeat_since_label(text B기준·권장), first_order_date, last_order_date, lifetime_revenue(numeric)

VIEW sales_daily_new_repeat — 일자별 신규 vs 재구매 고객/매출(집계, customer_key 없음).
  order_date, new_customers, repeat_customers, total_customers, repeat_rate_pct(numeric),
  new_orders, repeat_orders, unclassified_orders(050/무전화), total_orders, new_revenue, repeat_revenue, unclassified_revenue, total_revenue

VIEW sales_customer_summary — 고객 1인당 요약(050·무전화 제외).
  customer_key, first_purchase_date, first_purchase_year(int), purchase_count(bigint 생애주문수),
  is_repeat(bool ≥2), customer_type(text '신규'|'재구매'), first_order_skus(text 콤마)

VIEW sales_okr — 2026 OKR 스코어카드(단일행, 집계). 컬럼: okr1_first_buyers, okr1_target, repeated_within_3m, okr2_repeat_pct, total_rev, babyfood_rev, okr3_babyfood_pct, wholesale_rev(채널='도매'), okr3_wholesale_pct, combined_rev, okr3_combined_pct 등.

## 재고(INVENTORY)  [루커 못 봄]

TABLE products — 상품/원가 마스터. sku_code 매칭은 products.sku = sales_orders.sku_code.
  id(uuid), sku(text 내부코드·유일(upper 기준)·null가능), name(text), spec(text 규격), unit(text 개/kg/박스),
  cost_price(numeric 현재원가=제조+포장), cost_material, pkg_inner, pkg_label, pkg_outer, sale_price(도매가), retail_price(소비자가), purchase_price(매입가),
  volume_kg(numeric null가능), tax_type(text 'taxable'|'exempt'), origin(text 원산지), attrs(text 분류·자유텍스트), active(bool), notes(text), updated_at

TABLE inventory_txns — 재고 원장(입고+/출고−/조정±). 현재고 = SUM(qty) WHERE status='완료'. products(id) 로 조인.
  id(uuid), product_id(uuid FK→products.id), type(text '입고'|'출고'|'조정'), qty(int 부호있음),
  unit_amount(numeric 단가), txn_date(date), partner(text 거래처), memo(text), status(text '대기'|'완료' 재고는 완료만),
  channel(text '도매'|'소매'), reason(text 출고사유 null=판매·'협찬'|'폐기'|'기타'), order_no(text), group_id(uuid), created_at
  ※ 현재고 예: select p.name, sum(t.qty) 재고 from inventory_txns t join products p on p.id=t.product_id where t.status='완료' group by p.name

TABLE inventory_items — 품목별 재고설정(PK=product_id). product_id, min_qty(int 안전재고), barcode(text), location(text 보관위치), memo(text)

## B2B 발주(ORDERS)  [루커 못 봄]

TABLE orders — B2B 발주 헤더. 업체명은 companies_report 로 조인(company_id=companies_report.id).
  id(uuid), order_no(text yyyymmdd-NNN), company_id(uuid), order_date(date 발주일), production_date(date 생산예정일),
  ship_date(date 발송예정일), production_status(text 생산대기|생산중|생산완료), status(text 발송대기|발송완료|취소),
  payment_status(text 입금전|일부입금|입금완료|불필요), tax_invoice_status(text 미발행|발행완료|불필요),
  subtotal·vat·total(numeric), discount_amount(numeric 할인), discount_reason(text), box_count(int), notes(text), created_at

TABLE order_items — 발주 라인(스냅샷). order_id, product_id, product_name(text), option_label(text), spec(text),
  qty(numeric), unit_price(numeric), line_total(numeric=qty×unit_price), cost_at_order(numeric 발주시점 원가), tax_type(text), sort_order

VIEW companies_report — 거래처(비민감 투영): id(uuid), name(text 업체명). 연락처·주소 등은 없음.
VIEW shipments_report — 발송 차수(비민감 투영): id, order_id, courier(text 택배사), tracking_no(text), shipped_at(timestamptz), created_at
TABLE shipment_items — 발송 차수별 품목: shipment_id(=shipments_report.id), order_item_id, product_name(text), spec(text), qty(numeric)
TABLE payments — 발주 입금: order_id, amount(numeric), paid_at(date), method(text), reference(text), notes
TABLE company_product_prices — 거래처별 단가: company_id, product_id, unit_price(numeric), memo, updated_at
TABLE cost_history — 원가 변경 이력(트리거 자동): product_id, cost_price(numeric), reason(text), changed_at
TABLE activity_log — 업무도우미 변경 이력: event_type(text 예 order.created), summary(text 한 줄), order_no(text), actor(text 작업자), meta(jsonb), created_at

## 생산·매입(PRODUCTION)  [루커 못 봄]

TABLE production_requests — 생산 요청서 헤더: id, req_no(text PR-000001), title, requested_by, request_date(date),
  due_date(date 마감), status(text 요청|진행중|완료|취소), purpose(text 재고 보충|도매 납품), assignee(text), memo
TABLE production_request_items — 요청 품목: request_id, product_id, requested_qty(int), memo, sort. 입고수량은 production_receipts 합.
TABLE production_receipts — 생산 입고 기록: request_id, item_id, qty(numeric +입고/−수정), receipt_date(date), memo, received_by
TABLE product_bundles — 세트 구성(PK=parent_id,component_id): parent_id(세트 product), component_id(구성품), qty(int 세트당 수량)
TABLE product_cost_schedules — 원가 변경 예약: product_id, effective_date(date), cost_material·pkg_inner·pkg_label·pkg_outer·cost_price(numeric), applied_at(null=대기)
TABLE purchase_returns — 제조사 반품(매입 차감): product_id, return_date(date), qty(numeric), unit_amount(numeric null=그달 평균매입가), partner(text), memo

## 물류·발주처리(FULFILL)  [루커 못 봄]

TABLE delivery_log — 날짜별 배송일지(PK=log_date date): boxes_normal·boxes_guar(jsonb {박스종류:개수}),
  base_fee_normal·base_fee_guar·extra_fee·guar_extra_fee·pado_fee·pado_extra·pado_cod(bigint 운임원),
  dryice_full·dryice_half(numeric), memo
TABLE fulfill_dispatch — 소매 출고 배치 이력: dispatch_date(date), channel(text), sku_count(int), total_qty(int), order_no(text OUT-...), created_at
TABLE fulfill_scan_uploads — 송장 업로드 이력: id, title, invoice_count(int), item_count(int), created_at
TABLE fulfill_scan_items — 송장 라인: upload_id, invoice_no(text 정규화), sku_code(text), qty(int)
TABLE fulfill_scan_events — 스캔 완료 송장(PK=invoice_no): invoice_no, scanned_at, scanned_by

## VOC·CS  [루커 못 봄]

TABLE voc — 고객의 소리 원장: id, received_at(date 접수일), source(text 직접입력|설문|리뷰|기타), customer(text 고객명),
  purchase_date(date), purchase_place(text 구매처), product(text), category(text 유형), content(text 내용), resolution(text 처리),
  cause(text), status(text 접수|응대·개선중|개선완료), assignee, sentiment(text 긍정|부정|중립), loss_amount(numeric 손해액),
  fault(text 제조사|물류|자사|고객|미분류), buyer_type(text 첫구매|재구매), comp_type(text 보상유형), comp_qty(int), production_date(date), created_at
TABLE voc_categories — VOC 유형 관리: name(text), fault(text 기본 귀책), status(text 관찰|개선중|개선완료), resolved_at, active(bool), memo
TABLE cs_manual — CS 매뉴얼: title, content, category, sort_order

## 마케팅·링크(MARKETING)  [루커 못 봄]

TABLE crm_messages — CRM 메시지맵: stage_num(int), stage(text), title(text 메시지명), status(text active|auto|gap|paused),
  channel(text kakao|manual|cafe24 등), timing(text), customer(text naver|mall|etc), msg_type(text alimtalk|friendtalk),
  start_date·end_date(date 캠페인 기간, 둘다 null=상시), perf(jsonb {sent,clicked,converted,revenue...}), active(bool)
TABLE short_links — QR/숏링크: code(text), target_url(text), title(text), active(bool), scan_count(int 누적), created_at
TABLE qr_scans — 스캔 이벤트: link_id(=short_links.id), scanned_at, referer(text), user_agent(text), country(text)
TABLE utm_links — UTM 생성 기록: base_url, source, medium, campaign, content, term, note, full_url, created_at
TABLE ig_dm_rules — 인스타 자동 DM 규칙: ig_user_id, media_id, keyword(text 쉼표), message, active(bool), start_at·end_at
TABLE ig_dm_logs — DM 발송 로그: rule_id, comment_id(unique), commenter_username(text), comment_text(text), status(text sent|failed), created_at

## 분석 보조(MISC)  [루커 못 봄]

TABLE sales_reports — 매출 리포트 발송 이력: report_type(text daily|weekly), base_date(date), subject(text), stats(jsonb), status(text sent|failed), sent_at. html 컬럼은 대용량 — SELECT 에 포함하지 말 것.
TABLE sales_uploads — 매출 업로드 배치: id(text), filename, total_rows(int), inserted(int), skipped(int), status(text active|reverted), created_at
TABLE sales_channel_config — 채널 수수료·배송비 정책: channel(text PK), fee_rate(numeric 0.10=10%), ship_mode(text), revenue_adjust(numeric)
TABLE subscription_snapshots — 정기배송 KPI 스냅샷: data_date(text YYYY-MM-DD), snapshot(jsonb KPI 14종), created_at
TABLE naver_conv_daily — 네이버 광고 구매전환 캐시(PK=stat_date,entity_type,entity_id): stat_date(date), entity_type(text keyword|adgroup), entity_id(text), purchase_conv(int), purchase_sales(bigint)

## 조회 불가(비공개 — 시도 금지)
sales_customers(고객 전화·이름), b2b_settings(토큰·설정), app_users(계정), okr_checkins(면담 비공개),
bank_deposits·bank_deposit_names(입금 내역), shipments·companies(원본 — 위 *_report 뷰 사용), survey_responses(설문 원문)`;
