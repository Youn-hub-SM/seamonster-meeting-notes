// 주문 1건 키(2026-10-21 대표 결정) — 주문 건수는 주문번호가 아니라 이 키로 센다.
//  톡스토어(톡딜)는 한 사람이 한 번에 여러 상품을 사도 주문번호가 상품마다 갈린다(줄 수 = 주문번호 수).
//  실제로는 합배송 1박스라 '같은 주문자 + 같은 주문일 = 1건'. 다른 채널은 주문번호 그대로(빈 주문번호는 세지 않음).
//  DB 생성 칸 sales_orders.order_unit(migration 146)과 같은 식 — 146 미적용이어도 돌게 앱 SQL 은 식을 직접 쓴다.
//  sales_orders 를 별칭 없이 읽는 SQL 에만 쓴다.
export const ORDER_UNIT_SQL =
  "(case when channel = '톡스토어' and coalesce(customer_key, '') <> '' then 'tk:' || customer_key || '|' || order_date_int::text else nullif(order_id, '') end)";
