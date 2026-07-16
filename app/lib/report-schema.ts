// AI 커스텀 리포트가 SQL을 만들 때 참고하는 '스키마 카탈로그'.
//  · 전부 public 스키마. 금액=원(KRW) 정수. customer_key=전화 HMAC 해시(PII 아님, 고객 식별용).
//  · order_date=KST 기준일. 재고 현재수량=inventory_txns 에서 status='완료' 의 qty 합.
//  PII(전화·이름) 테이블 sales_customers 는 화이트리스트에서 제외 → 사용 금지.

// 여기서(run_report=report_ro) 조회 가능한 관계
export const RUN_HERE_RELATIONS = [
  "sales_orders", "sales_looker", "sales_group_repeat", "sales_buyer_repeat",
  "sales_daily_new_repeat", "sales_customer_summary", "sales_okr",
  "products", "inventory_txns", "inventory_items",
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
  channel(text '도매'|'소매'), order_no(text), group_id(uuid), created_at
  ※ 현재고 예: select p.name, sum(t.qty) 재고 from inventory_txns t join products p on p.id=t.product_id where t.status='완료' group by p.name

TABLE inventory_items — 품목별 재고설정(PK=product_id). product_id, min_qty(int 안전재고), barcode(text), location(text 보관위치), memo(text)`;
