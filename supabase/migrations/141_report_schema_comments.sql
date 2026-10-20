-- 141 AI 데이터 비서 — 허용 목록 → 차단 목록, 표 설명을 DB 주석으로 (2026-10-20 대표 결정)
--
-- ■ 왜
--   비서가 볼 수 있는 표를 코드의 허용 목록(47개)과 손 카탈로그로 관리하니 새 표가 생길 때마다 두 곳을 손봐야 했고,
--   설명이 빠진 컬럼(배송일지 jsonb 내역)은 데이터가 있어도 비서가 "없다"고 답했다.
--   이제 public 의 표·뷰는 차단 목록에 없으면 전부 보이고, 설명은 DB 의 표·컬럼 주석을 비서가 직접 읽는다(information_schema + obj_description/col_description).
--   새 표·새 컬럼은 마이그레이션에 주석 한 줄(comment on …)만 달면 된다. 개인정보가 드는 표만 차단 목록(코드 BLOCKED_RELATIONS + 아래 run_report 정규식)에 넣는다.
--
-- ■ 이 파일
--   ① 지금까지의 손 카탈로그(app/lib/report-schema.ts SCHEMA_CATALOG)를 표 주석으로 그대로 옮긴다(comment on table/view).
--   ② delivery_log 의 jsonb 두 컬럼에 컬럼 주석.
--   ③ run_report 차단 정규식 확장(100 의 9개 + utm_settings·channel_commands·tax_invoices·report_*·briefings) + pg_catalog/information_schema/factory 등 다른 스키마 참조 차단.
--      (비서의 스키마 조회는 information_schema 를 쓰므로, 그 조회문만 예외 — 서버 코드가 보내는 고정문이며 접두 '/*schema*/' 로 식별)
--
-- 적용: Supabase Dashboard > SQL Editor 에 전체 붙여넣고 Run. 멱등 — 재실행 안전. 표가 없으면 그 줄만 건너뛴다(do 블록).


do $$
begin
  if to_regclass('public.sales_orders') is not null then execute 'comment on table public.sales_orders is ''매출 원장(줄 단위, PII 없음). [루커 못 봄 → 루커엔 sales_looker 사용] order_date(date, KST 기준일), order_year(int), order_month(int), channel(text 판매처 예 ''''도매''''), order_id(text 주문번호), product_name(text), option_name(text), sku_code(text 관리코드), quantity(int), selling_price(bigint), option_price(bigint), subtotal_amount(bigint 결제금액=매출축), shipping_fee(bigint), customer_key(text 전화해시 ''''''''=전화없음), source(text), upload_batch(text), order_date_int(int yyyymmdd)'''; end if;
  if to_regclass('public.sales_looker') is not null then execute 'comment on view public.sales_looker is ''sales_orders 의 분석용 투영(내부컬럼 제외). 루커 노출용. 컬럼은 sales_orders 와 동일(id/row_hash/source 등 제외) + customer_key(해시).'''; end if;
  if to_regclass('public.sales_group_repeat') is not null then execute 'comment on view public.sales_group_repeat is ''구매차수 코호트(첫/재/재재구매)를 4축으로. 줄 단위. 전화있고 050아닌 고객만. order_date, channel, order_id, order_key(=customer_key|order_id, 주문수는 이걸 COUNT DISTINCT), product_name, sku_code, quantity, subtotal_amount, customer_key, product_group(text SKU코어코드 예 ''''DG''''), group_name(text 친화명 예 ''''대구살''''), group_purchase_seq/label, sku_purchase_seq/label, name_purchase_seq/label, cust_order_seq/label (label 형식: ''''1_첫구매'''',''''2_재구매'''',''''3_재재구매'''',''''4_4회이상'''')'''; end if;
  if to_regclass('public.sales_buyer_repeat') is not null then execute 'comment on view public.sales_buyer_repeat is ''특정 상품 구매고객의 (상품무관) 재구매 리텐션. 그레인=(axis,axis_value,customer_key). 반드시 axis_value 하나로 필터. axis(text ''''sku''''|''''name''''), axis_value(text), display_name(text 대표상품명), customer_key, anchor_orders(bigint), first_anchor_date(date), total_orders(bigint 생애총주문), total_repeat_label(text A기준), orders_since_first_anchor(bigint), repeat_since_label(text B기준·권장), first_order_date, last_order_date, lifetime_revenue(numeric)'''; end if;
  if to_regclass('public.sales_daily_new_repeat') is not null then execute 'comment on view public.sales_daily_new_repeat is ''일자별 신규 vs 재구매 고객/매출(집계, customer_key 없음). order_date, new_customers, repeat_customers, total_customers, repeat_rate_pct(numeric), new_orders, repeat_orders, unclassified_orders(050/무전화), total_orders, new_revenue, repeat_revenue, unclassified_revenue, total_revenue'''; end if;
  if to_regclass('public.sales_customer_summary') is not null then execute 'comment on view public.sales_customer_summary is ''고객 1인당 요약(050·무전화 제외). customer_key, first_purchase_date, first_purchase_year(int), purchase_count(bigint 생애주문수), is_repeat(bool ≥2), customer_type(text ''''신규''''|''''재구매''''), first_order_skus(text 콤마)'''; end if;
  if to_regclass('public.sales_okr') is not null then execute 'comment on view public.sales_okr is ''2026 OKR 스코어카드(단일행, 집계). 컬럼: okr1_first_buyers, okr1_target, repeated_within_3m, okr2_repeat_pct, total_rev, babyfood_rev, okr3_babyfood_pct, wholesale_rev(채널=''''도매''''), okr3_wholesale_pct, combined_rev, okr3_combined_pct 등.'''; end if;
  if to_regclass('public.products') is not null then execute 'comment on table public.products is ''상품/원가 마스터. sku_code 매칭은 products.sku = sales_orders.sku_code. id(uuid), sku(text 내부코드·유일(upper 기준)·null가능), name(text), spec(text 규격), unit(text 개/kg/박스), cost_price(numeric 현재원가=제조+포장), cost_material, pkg_inner, pkg_label, pkg_outer, sale_price(도매가), retail_price(소비자가), purchase_price(매입가), volume_kg(numeric null가능), tax_type(text ''''taxable''''|''''exempt''''), origin(text 원산지), attrs(text 분류·자유텍스트), active(bool), notes(text), updated_at'''; end if;
  if to_regclass('public.inventory_txns') is not null then execute 'comment on table public.inventory_txns is ''재고 원장(입고+/출고−/조정±). 현재고 = SUM(qty) WHERE status=''''완료''''. products(id) 로 조인. id(uuid), product_id(uuid FK→products.id), type(text ''''입고''''|''''출고''''|''''조정''''), qty(int 부호있음), unit_amount(numeric 단가), txn_date(date), partner(text 거래처), memo(text), status(text ''''대기''''|''''완료'''' 재고는 완료만), channel(text ''''도매''''|''''소매''''|''''프로모션''''|''''도매 대량'''' — 프로모션·도매 대량은 확보분 칸), reason(text 출고사유 null=판매·''''협찬''''|''''폐기''''|''''기타''''), order_no(text), group_id(uuid), created_by(text — B2B 발송 선점 행은 ''''B2B 자동출고''''), shipment_id(uuid B2B 선점 행의 발송 차수 = shipments_report.id), created_at, source(text 행 출처 131 — manual|import|move|promo_close|b2b_ship|b2b_cancel_kept(발송 뒤 취소했지만 반품 안 된 출고, shipment_id 없음)|fulfill|fulfill_unmatched, null=131 이전), source_ref(text 출처 참조 — b2b_*=발주 id, move=group_id, promo_close=요청서 id), request_key(text 중복 방지 키) ※ 오늘 재고는 txn_date <= 오늘(KST) 인 완료 행만 — 미래 날짜 완료 행(B2B 선점)은 ''''출고 예정'''' ※ 현재고 예: select p.name, sum(t.qty) 재고 from inventory_txns t join products p on p.id=t.product_id where t.status=''''완료'''' group by p.name'''; end if;
  if to_regclass('public.inventory_items') is not null then execute 'comment on table public.inventory_items is ''품목별 재고설정(PK=product_id). product_id, min_qty(int 안전재고), barcode(text), location(text 보관위치), memo(text)'''; end if;
  if to_regclass('public.orders') is not null then execute 'comment on table public.orders is ''B2B 발주 헤더. 업체명은 companies_report 로 조인(company_id=companies_report.id). id(uuid), order_no(text yyyymmdd-NNN), company_id(uuid), order_date(date 발주일), production_date(date 생산예정일), ship_date(date 발송예정일), production_status(text 생산대기|생산중|생산완료), status(text 발송대기|발송완료|취소), payment_status(text 입금전|일부입금|입금완료|불필요), tax_invoice_status(text 미발행|발행완료|불필요), subtotal·vat·total(numeric), discount_amount(numeric 할인/추가금 — 양수=할인 차감, 음수=추가금 가산. 할인 총액은 sum(greatest(discount_amount,0))), discount_reason(text), box_count(int), notes(text), is_bulk(bool 대량 발주(선결제) 표식 — 앞으로 잡는 선점의 칸을 정함. 이미 나간 발주의 실제 차감 칸은 inventory_txns.channel where created_by=''''B2B 자동출고'''' (shipment_id → shipments_report.id → order_id)), created_at'''; end if;
  if to_regclass('public.order_items') is not null then execute 'comment on table public.order_items is ''발주 라인(스냅샷). order_id, product_id, product_name(text), option_label(text), spec(text), qty(numeric), unit_price(numeric), line_total(numeric=qty×unit_price), cost_at_order(numeric 발주시점 원가), tax_type(text), sort_order'''; end if;
  if to_regclass('public.companies_report') is not null then execute 'comment on view public.companies_report is ''거래처(비민감 투영): id(uuid), name(text 업체명). 연락처·주소 등은 없음.'''; end if;
  if to_regclass('public.shipments_report') is not null then execute 'comment on view public.shipments_report is ''발송 차수(비민감 투영): id, order_id, courier(text 택배사), tracking_no(text), shipped_at(timestamptz), created_at'''; end if;
  if to_regclass('public.shipment_items') is not null then execute 'comment on table public.shipment_items is ''발송 차수별 품목: shipment_id(=shipments_report.id), order_item_id, product_name(text), spec(text), qty(numeric)'''; end if;
  if to_regclass('public.payments') is not null then execute 'comment on table public.payments is ''발주 입금: order_id, amount(numeric), paid_at(date), method(text), reference(text), notes'''; end if;
  if to_regclass('public.company_product_prices') is not null then execute 'comment on table public.company_product_prices is ''거래처별 단가: company_id, product_id, unit_price(numeric), memo, updated_at'''; end if;
  if to_regclass('public.cost_history') is not null then execute 'comment on table public.cost_history is ''원가 변경 이력(트리거 자동): product_id, cost_price(numeric), reason(text), changed_at'''; end if;
  if to_regclass('public.activity_log') is not null then execute 'comment on table public.activity_log is ''업무도우미 변경 이력: event_type(text 예 order.created), summary(text 한 줄), order_no(text), actor(text 작업자), meta(jsonb), created_at'''; end if;
  if to_regclass('public.production_requests') is not null then execute 'comment on table public.production_requests is ''생산 요청서 헤더: id, req_no(text PR-000001), title, requested_by, request_date(date), due_date(date 마감), status(text 요청|진행중|완료|취소), purpose(text 재고 보충|도매 납품|프로모션|도매 대량), assignee(text), memo'''; end if;
  if to_regclass('public.production_request_items') is not null then execute 'comment on table public.production_request_items is ''요청 품목: request_id, product_id, requested_qty(int), memo, sort. 입고수량은 production_receipts 합.'''; end if;
  if to_regclass('public.production_receipts') is not null then execute 'comment on table public.production_receipts is ''생산 입고 기록: request_id, item_id, qty(numeric +입고/−수정), receipt_date(date), memo, received_by'''; end if;
  if to_regclass('public.product_bundles') is not null then execute 'comment on table public.product_bundles is ''세트 구성(PK=parent_id,component_id): parent_id(세트 product), component_id(구성품), qty(int 세트당 수량)'''; end if;
  if to_regclass('public.product_cost_schedules') is not null then execute 'comment on table public.product_cost_schedules is ''원가 변경 예약: product_id, effective_date(date), cost_material·pkg_inner·pkg_label·pkg_outer·cost_price(numeric), applied_at(null=대기)'''; end if;
  if to_regclass('public.purchase_returns') is not null then execute 'comment on table public.purchase_returns is ''제조사 반품(매입 차감): product_id, return_date(date), qty(numeric), unit_amount(numeric null=그달 평균매입가), partner(text), memo'''; end if;
  if to_regclass('public.delivery_log') is not null then execute 'comment on table public.delivery_log is ''날짜별 배송일지(PK=log_date date): boxes_normal·boxes_guar(jsonb {박스종류:개수}), base_fee_normal·base_fee_guar·extra_fee·guar_extra_fee·pado_fee·pado_extra·pado_cod(bigint 운임원), dryice_full·dryice_half(numeric), memo. 건별 입력 내역도 이 표 안에 jsonb 배열로 있다(2026-10-20 명시): · manual_entries(jsonb[]) = 직접수정 내역 {id, side(''''n'''' 일반|''''g'''' 도착보장), category(박스종류), qty(±수량), note(사유), at(ISO 시각), by(입력자)} · record_entries(jsonb[]) = 자동칸 기록(발주처리 배치) {id, at, by, mode(''''add''''|''''replace''''|''''baseline''''), boxes_normal, boxes_guar, base_fee_normal, base_fee_guar} 풀어 보려면: select d.log_date, e->>''''at'''' as "시각", e->>''''side'''' as "구분", e->>''''category'''' as "품목", (e->>''''qty'''')::int as "증감", e->>''''note'''' as "사유", e->>''''by'''' as "입력자" from delivery_log d, jsonb_array_elements(d.manual_entries) e where d.log_date between … order by 1, 2'''; end if;
  if to_regclass('public.fulfill_dispatch') is not null then execute 'comment on table public.fulfill_dispatch is ''소매 출고 배치 이력: dispatch_date(date), channel(text), sku_count(int), total_qty(int), order_no(text OUT-...), created_at, unmatched(jsonb 135 — 재고가 빠지지 않은 코드 [{sku,qty,kind unmatched|ambiguous}]), unmatched_done_at(timestamptz 그 목록 처리 시각, null=미처리) ※ sku_count=0 = 재고 행 없이 처리완료된 배치(재고 관리 안 함·미등록 코드뿐이거나, 한 줄 취소로 마지막 재고 행까지 지운 배치) — 품목 수 집계에서 뺀다'''; end if;
  if to_regclass('public.fulfill_scan_uploads') is not null then execute 'comment on table public.fulfill_scan_uploads is ''송장 업로드 이력: id, title, invoice_count(int), item_count(int), created_at'''; end if;
  if to_regclass('public.fulfill_scan_items') is not null then execute 'comment on table public.fulfill_scan_items is ''송장 라인: upload_id, invoice_no(text 정규화), sku_code(text), qty(int)'''; end if;
  if to_regclass('public.fulfill_scan_events') is not null then execute 'comment on table public.fulfill_scan_events is ''스캔 완료 송장(PK=invoice_no): invoice_no, scanned_at, scanned_by, cleared_at(스캔 초기화 시각, null=현재 스캔 중인 라운드, 초기화 후 30일 보관)'''; end if;
  if to_regclass('public.voc') is not null then execute 'comment on table public.voc is ''고객의 소리 원장: id, received_at(date 접수일), source(text 직접입력|설문|리뷰|기타), customer(text 고객명), purchase_date(date), purchase_place(text 구매처), product(text), category(text 유형), content(text 내용), resolution(text 처리), cause(text), status(text 접수|응대·개선중|개선완료), assignee, sentiment(text 긍정|부정|중립), loss_amount(numeric 손해액), fault(text 제조사|물류|자사|고객|미분류), buyer_type(text 첫구매|재구매), comp_type(text 보상유형), comp_qty(int), production_date(date), created_at'''; end if;
  if to_regclass('public.voc_categories') is not null then execute 'comment on table public.voc_categories is ''VOC 유형 관리: name(text), fault(text 기본 귀책), status(text 관찰|개선중|개선완료), resolved_at, active(bool), memo'''; end if;
  if to_regclass('public.cs_manual') is not null then execute 'comment on table public.cs_manual is ''CS 매뉴얼: title, content, category, sort_order'''; end if;
  if to_regclass('public.crm_messages') is not null then execute 'comment on table public.crm_messages is ''CRM 메시지맵: stage_num(int), stage(text), title(text 메시지명), status(text active|auto|gap|paused), channel(text kakao|manual|cafe24 등), timing(text), customer(text naver|mall|etc), msg_type(text alimtalk|friendtalk), start_date·end_date(date 캠페인 기간, 둘다 null=상시), perf(jsonb {sent,clicked,converted,revenue...}), active(bool)'''; end if;
  if to_regclass('public.short_links') is not null then execute 'comment on table public.short_links is ''QR/숏링크: code(text), target_url(text), title(text), active(bool), scan_count(int 누적), created_at'''; end if;
  if to_regclass('public.qr_scans') is not null then execute 'comment on table public.qr_scans is ''스캔 이벤트: link_id(=short_links.id), scanned_at, referer(text), user_agent(text), country(text)'''; end if;
  if to_regclass('public.utm_links') is not null then execute 'comment on table public.utm_links is ''UTM 생성 기록: base_url, source, medium, campaign, content, term, note, full_url, created_at'''; end if;
  if to_regclass('public.ig_dm_rules') is not null then execute 'comment on table public.ig_dm_rules is ''인스타 자동 DM 규칙: ig_user_id, media_id, keyword(text 쉼표), message, active(bool), start_at·end_at'''; end if;
  if to_regclass('public.ig_dm_logs') is not null then execute 'comment on table public.ig_dm_logs is ''DM 발송 로그: rule_id, comment_id(unique), commenter_username(text), comment_text(text), status(text sent|failed), created_at'''; end if;
  if to_regclass('public.sales_reports') is not null then execute 'comment on table public.sales_reports is ''매출 리포트 발송 이력: report_type(text daily|weekly), base_date(date), subject(text), stats(jsonb), status(text sent|failed), sent_at. html 컬럼은 대용량 — SELECT 에 포함하지 말 것.'''; end if;
  if to_regclass('public.sales_uploads') is not null then execute 'comment on table public.sales_uploads is ''매출 업로드 배치: id(text), filename, total_rows(int), inserted(int), skipped(int), status(text active|reverted), created_at'''; end if;
  if to_regclass('public.sales_channel_config') is not null then execute 'comment on table public.sales_channel_config is ''채널 수수료·배송비 정책: channel(text PK), fee_rate(numeric 0.10=10%), ship_mode(text), revenue_adjust(numeric)'''; end if;
  if to_regclass('public.subscription_snapshots') is not null then execute 'comment on table public.subscription_snapshots is ''정기배송 KPI 스냅샷: data_date(text YYYY-MM-DD), snapshot(jsonb KPI 14종), created_at'''; end if;
  if to_regclass('public.naver_conv_daily') is not null then execute 'comment on table public.naver_conv_daily is ''네이버 광고 구매전환 캐시(PK=stat_date,entity_type,entity_id): stat_date(date), entity_type(text keyword|adgroup), entity_id(text), purchase_conv(int), purchase_sales(bigint)'''; end if;
  if to_regclass('public.delivery_log') is not null then
    execute 'comment on column public.delivery_log.manual_entries is ''직접수정 내역 jsonb 배열 [{id, side(n 일반|g 도착보장), category(박스종류), qty(±수량), note(사유), at(ISO 시각), by(입력자)}] — jsonb_array_elements 로 풀어 본다''';
    execute 'comment on column public.delivery_log.record_entries is ''자동칸 기록 jsonb 배열 [{id, at, by, mode(add|replace|baseline), boxes_normal, boxes_guar, base_fee_normal, base_fee_guar}]''';
  end if;
end $$;

-- ③ run_report — 차단 정규식 확장 + 다른 스키마 참조 차단(100 의 본문 그대로, 조건만 넓힘)
create or replace function public.run_report(q text, p_limit int default 5000)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  r json;
  cap int := least(greatest(coalesce(p_limit, 5000), 1), 100000);
begin
  if q ~* '\m(sales_customers|b2b_settings|app_users|okr_checkins|bank_deposits|bank_deposit_names|shipments|companies|survey_responses|utm_settings|channel_commands|tax_invoices|report_threads|report_messages|report_tables|report_glossary|report_feedback|briefings)\M' then
    raise exception '비공개 테이블(개인정보·계정·설정·면담·입금)은 조회할 수 없습니다. 업체명은 companies_report, 발송은 shipments_report 를 사용하세요.';
  end if;
  -- 다른 스키마·카탈로그 참조 차단(비서의 스키마 조회문 '/*schema*/' 만 예외)
  if q !~ '^\s*/\*schema\*/' and q ~* '\m(pg_catalog|pg_[a-z_]+|information_schema|factory|auth|storage|extensions)\s*\.' then
    raise exception 'public 스키마의 표·뷰만 조회할 수 있습니다.';
  end if;
  perform set_config('statement_timeout', case when cap > 5000 then '60000' else '15000' end, true);
  execute format(
    'select coalesce(json_agg(t), ''[]''::json) from (select * from (%s) _sub limit %s) t',
    q, cap
  ) into r;
  return r;
end $$;

revoke all on function public.run_report(text, int) from public;
revoke all on function public.run_report(text, int) from anon;
revoke all on function public.run_report(text, int) from authenticated;
grant execute on function public.run_report(text, int) to service_role;

notify pgrst, 'reload schema';
