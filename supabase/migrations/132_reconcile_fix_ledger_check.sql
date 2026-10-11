-- 132: 대사 RPC 정정 + 원장 점검 RPC (2026-10-11 원장 기준 점검 — docs/ledger-standard.md S1·S5·S12, 대표 결정 D4d)
--
-- ■ 왜
--   1) inventory_reconcile(120)의 소매 판매(sold_raw)가 sales_orders 를 판매처 구분 없이 합쳤다. B2B 매출 동기화가 넣는
--      도매 행(channel='도매', source='b2b', 관리코드=상품 SKU)이 소매 탭 '팔린 수'에 섞여 도매 물량만큼 '안 빠진 판매'가
--      거짓으로 떴고, 전체 탭은 그 행에 sold_b2b 를 또 더해 B2B 판매를 두 번 셌다.
--   2) 도매 판매(sold_b2b)가 '발송완료 차수에 배정된 수량 · 차수별 발송일 · 세트 그대로'라 원장 차감 규칙
--      (app/lib/b2b-shipments.ts saveOrderShipments — 발주 전량 − 취소 차수 배정, 가장 이른 발송일 하루, 세트는 구성품으로 전개)과
--      달랐다. 나눠 보내는 발주·세트 발주는 정상이어도 늘 '차이'로 떠서 진짜 어긋남이 묻혔다.
--   3) 세트 전개가 1단계뿐이라 중첩 세트를 못 펼쳤다(앱 expandBundleQty 는 깊이 8 재귀·순환 가드).
--   4) 장부 자체의 이상(취소에 남은 선점, 짝 없는 이동, 세트 id 행, 오래된 대기 …)을 모아 보는 곳이 없었다.
--
-- ■ 바뀌는 것
--   1) inventory_reconcile — 시그니처·반환 칸 그대로(호출 코드 무변경).
--      · 소매 판매 = 도매 행(channel '도매' · source 'b2b')을 뺀 매출.
--      · 도매 판매 = 발송완료 발주의 발주 전량(취소 차수 배정 뺌)을 원장 차감일에 — 차감일 = 취소 아닌·재고 차감 대상 차수 중
--        가장 이른 발송일(2026-08-05 이후 발주는 모든 차수가 대상 — 앱 stockOn 규칙. 없으면 취소 아닌 차수 중 가장 이른 발송일
--        → 발주 발송예정일 → 발주일).
--        칸은 120 과 같이 그 발주의 'B2B 자동출고' 선점 행 칸, 선점이 없으면 is_bulk.
--        발송 뒤 취소했지만 안 돌아온 '출고 유지' 행(D3, reason '기타')은 종전 규칙대로 비판매 출고(out_nonsale)로 잡힌다.
--      · 세트 전개는 소매·도매 모두 같은 재귀 전개(깊이 8 · 순환 가지는 버림 — expandBundleQty 와 같은 규칙).
--      · 남은 재고 = 끝일까지의 완료 합(종전: 날짜 무관 전체 합 — 미래 날짜 B2B 선점까지 빠져 '재고 마이너스'가 거짓으로 떴다).
--      · '재고 관리 사용 안함'(121) 품목 제외는 종전대로 API(app/api/inventory/reconcile)가 한다.
--   2) inventory_ledger_check(p_today, p_kinds, p_untracked) 신설 — 읽기 전용, 아무것도 고치지 않는다.
--      원장 점검 화면(/inventory/ledger-check)이 부른다. 종류(kind)별 이상 행을 돌려준다(rn 순 페이징).
--      p_untracked = 재고 관리 안 함 품목 id(앱이 넘긴다 — 121 컬럼을 SQL 에서 직접 읽지 않아 121 적용 순서와 무관).
--      반환 칸 tags = 화면이 처리 안내를 고르는 표식(아래 2) 주석). 이 파일을 먼저 적용한 DB 에 다시 붙여넣어도 된다(drop 후 생성).
--   3) (10-11 2차) 재고 이동 판정 = 출처 칸(131 source 'move'·'promo_close') 우선, 출처가 빈 옛 행만 종전 표식
--      (partner '채널이동' + 주문번호 없음 — 131 백필·입출고 취소와 같은 규칙, S11). 대사의 '협찬·기타'(비판매)와 짝 점검이 쓴다.
--      원장 점검 항목 추가: B2B(미연동 라인·배분 초과·차수 두 벌·주인 없는 출고 유지·선점 차수 여럿 표식),
--      온라인 출고(중단된 출고·연결 끊긴 늦은 출고·재고가 빠지지 않은 코드·CN 받고 출고 안 한 배치),
--      생산·반품(합류 미확인 프로모션·연결 안 된 제조사 입고·출고 없는 제조사 반품·실사 뒤 소급 반품 출고),
--      매출(오늘 이후 날짜 매출·발주가 지워진 B2B 매출).
--
-- ■ 131·135·136 과 적용 순서
--   이 함수는 131(inventory_txns.source·source_ref)·135(fulfill_* 새 칸)·136(promo_released_at) 칸을 이름으로 쓰지 않는다 —
--   to_jsonb(행)->>'칸' 으로 읽어, 그 마이그레이션 전에 적용해도 만들어지고 돈다. 칸이 없는 항목은 kind '_unavailable'
--   행(ref_id = 그 항목, detail = 필요한 마이그레이션 번호)으로 알려 화면이 '0건'이 아니라 '확인 못 함'을 보인다.
--   kind '_meta'(ref_id 'v5') 한 행은 이 판의 함수라는 표시다(옛 132 함수와 구분 — 화면이 '다시 적용'을 안내).
--   v3(10-11 3차) = 처리 안내 표식 정정: CN 받고 출고 안 한 배치 'covered'(다른 배치로 출고됨) ·
--   선점 차수 여럿 'multi'는 이중 선점 증거가 있을 때만 · 선점 수량 다름 'dup'(차수 두 벌·배분 초과).
--   v4(10-11 4차) = 중단된 출고의 'old'(출고일 7일 지남) 표식·'7일 지남' 문구 폐지 — ④ 출고가 중단 배치를 출고일과 무관하게
--   이어서 차감한다(dispatch route 1단계). 'old' 안내('직접 기록')를 따르고 나중에 파일을 다시 올리면 두 번 빠졌다.
--   v5(10-11 5차) = 중단된 출고 'finished' 표식 — 대기 키(fulfill_pending_keys)가 없고 그 배치의 처리완료 키가 있는 배치.
--   대기 키는 ④가 끝까지 갔을 때만 지워진다 → '출고는 끝났고 재고만 나중에 지워진 배치'(옛 화면 묶음 취소 등).
--   다시 올려도 이어받지 못한다(generate 는 중단 이력 서명의 대기 키로만 이어받기를 판정 — 없으면 처리된 주문으로 뺀다).
--
-- ■ 미적용이면
--   대사는 120 그대로 동작하고(같은 시그니처), 원장 점검 화면만 '132 적용 필요' 오류를 보인다.
--
-- 적용: Supabase SQL Editor 에 이 파일 하나만 붙여넣고 Run. 멱등(재실행 안전). 120 다음.
--       (10-11 2차·3차·4차·5차 수정 — 이 파일을 이미 적용했으면 한 번 더 Run. 함수만 바뀐다.)

-- 1) 대사 ─────────────────────────────────────────────────────────────
drop function if exists inventory_reconcile(date, date, text) cascade;
create function inventory_reconcile(p_from date, p_to date, p_channel text default null)
returns table(
  product_id uuid, sku text, name text,
  current_qty numeric,
  ledger_in numeric, ledger_out numeric, ledger_adj numeric,
  sold numeric,
  out_nonsale numeric
) language sql stable as $$
  with recursive
  stock as ( -- 남은 재고 = 끝일까지(완료만) — inventory_stock(asof) 규칙. 끝일 뒤 날짜 행(B2B 선점 = 출고 예정)은 넣지 않는다(S6·D1)
    select t.product_id, coalesce(sum(t.qty), 0) as qty
    from inventory_txns t
    where t.status = '완료' and t.txn_date <= p_to
      and (p_channel is null or t.channel = p_channel)
    group by t.product_id
  ),
  flow as ( -- 선택 기간의 원장 흐름(완료만). 비판매 = 사유 있는 출고(협찬·폐기·제조사 반품·출고 유지) + 재고 이동
    --  재고 이동 = 출처 칸(131) 'move'·'promo_close', 출처가 빈 옛 행은 partner '채널이동' + 주문번호 없음(사람이 거래처에
    --  그 글자를 적은 입출고는 이동이 아니다 — 131 백필과 같은 규칙, S11). 131 칸은 to_jsonb 로 읽는다(미적용이면 null).
    select t.product_id,
      sum(case when t.type = '입고' then t.qty else 0 end)  as l_in,
      sum(case when t.type = '출고' then -t.qty else 0 end) as l_out,
      sum(case when t.type = '조정' then t.qty else 0 end)  as l_adj,
      sum(case when t.type = '출고'
                and ((t.reason is not null and t.reason <> '판매')
                     or x.src in ('move', 'promo_close')
                     or (x.src is null and t.partner = '채널이동' and t.order_no is null))
               then -t.qty else 0 end)                      as l_out_nonsale
    from inventory_txns t
    cross join lateral (select to_jsonb(t)->>'source' as src) x
    where t.status = '완료'
      and t.txn_date between p_from and p_to
      and (p_channel is null or t.channel = p_channel)
    group by t.product_id
  ),
  prod as (
    select distinct on (sku) id, sku
    from products where sku is not null and sku <> '' order by sku, updated_at desc
  ),
  -- 세트 → 말단 구성품 배수. expandBundleQty 와 같은 규칙: 깊이 8 까지, 순환 가지는 버린다(세트 id 로 세지 않는다).
  --  자기 자신을 구성품으로 가진 옛 행(A⊃A)은 앱처럼 그 가지만 버린다 — 시작 행에 두면 다른 구성품이 한 번 더 펼쳐진다.
  bundle_tree as (
    select pb.parent_id as root, pb.component_id as node, pb.qty::numeric as mult, 1 as depth,
           array[pb.parent_id, pb.component_id] as path
    from product_bundles pb
    where pb.component_id <> pb.parent_id
    union all
    select bt.root, pb.component_id, bt.mult * pb.qty, bt.depth + 1, bt.path || pb.component_id
    from bundle_tree bt
    join product_bundles pb on pb.parent_id = bt.node
    where bt.depth < 8 and not (pb.component_id = any(bt.path))
  ),
  is_bundle as (select distinct pb.parent_id as id from product_bundles pb),
  bundle_leaf as (
    select bt.root, bt.node as leaf, sum(bt.mult) as mult
    from bundle_tree bt
    where not exists (select 1 from is_bundle ib where ib.id = bt.node)
    group by bt.root, bt.node
  ),
  sold_raw as ( -- 소매 매출 — 도매 행(B2B 동기화·백필)은 sold_b2b 한 곳에서만 센다
    select s.sku_code, sum(s.quantity) as q
    from sales_orders s
    where s.order_date between p_from and p_to and s.sku_code is not null and s.sku_code <> ''
      and s.channel <> '도매' and s.source <> 'b2b'
    group by s.sku_code
  ),
  sold_retail as (
    select coalesce(bl.leaf, p.id) as product_id, sum(sr.q * coalesce(bl.mult, 1)) as sold
    from sold_raw sr
    join prod p on p.sku = sr.sku_code
    left join bundle_leaf bl on bl.root = p.id
    where bl.root is not null or not exists (select 1 from is_bundle ib where ib.id = p.id)
    group by coalesce(bl.leaf, p.id)
  ),
  ord_ch as ( -- 발주별 실제 차감 칸 = 'B2B 자동출고' 선점 행의 칸(발송 후 대량 체크를 바꿔도 유지된다)
    select sh2.order_id, max(t.channel) as ch
    from inventory_txns t
    join shipments sh2 on sh2.id = t.shipment_id
    where t.created_by = 'B2B 자동출고'
      and t.channel in ('도매', '도매 대량')
    group by sh2.order_id
  ),
  b2b_cx as ( -- 라인별 취소 차수 배정 수량(원장·매출 모두 이만큼 뺀다)
    select si.order_item_id, sum(si.qty) as q
    from shipment_items si
    join shipments sh on sh.id = si.shipment_id
    where sh.status = '취소' and si.order_item_id is not null
    group by si.order_item_id
  ),
  b2b_ord as ( -- 발송완료 발주 + 원장 차감일 + 차감 칸
    --  차감 대상 차수 = 취소 아님 + 재고 차감 켬. 2026-08-05(created_at UTC 날짜 — 앱 STOCK_OUT_SINCE 와 같은 비교) 이후 발주는
    --  저장 때 차감이 항상 켜지므로(b2b-shipments stockOn) stock_out 값과 무관하게 대상이다.
    select o.id as order_id,
      coalesce(oc.ch, case when coalesce(o.is_bulk, false) then '도매 대량' else '도매' end) as ch,
      coalesce(
        (select min(s.ship_date) from shipments s
          where s.order_id = o.id and s.status <> '취소' and s.ship_date is not null
            and (s.stock_out or (o.created_at at time zone 'UTC')::date >= date '2026-08-05')),
        (select min(s.ship_date) from shipments s
          where s.order_id = o.id and s.status <> '취소' and s.ship_date is not null),
        o.ship_date, o.order_date) as d
    from orders o
    left join ord_ch oc on oc.order_id = o.id
    where o.status = '발송완료'
  ),
  b2b_line as (
    select bo.ch, oi.product_id, greatest(0, oi.qty - coalesce(cx.q, 0)) as q
    from b2b_ord bo
    join order_items oi on oi.order_id = bo.order_id
    left join b2b_cx cx on cx.order_item_id = oi.id
    where bo.d between p_from and p_to and oi.product_id is not null
  ),
  sold_b2b as ( -- 도매 = 일반 발주, 도매 대량 = 대량 발주. 전체 탭에는 둘 다 넣는다
    select coalesce(bl.leaf, x.product_id) as product_id,
      coalesce(sum(x.q * coalesce(bl.mult, 1)) filter (where x.ch = '도매'), 0)      as sold,
      coalesce(sum(x.q * coalesce(bl.mult, 1)) filter (where x.ch = '도매 대량'), 0) as sold_bulk
    from b2b_line x
    left join bundle_leaf bl on bl.root = x.product_id
    where x.q > 0
      and (bl.root is not null or not exists (select 1 from is_bundle ib where ib.id = x.product_id))
    group by coalesce(bl.leaf, x.product_id)
  )
  select
    pr.id, pr.sku, pr.name,
    coalesce(st.qty, 0)::numeric(14,2),
    coalesce(fl.l_in, 0)::numeric(14,2),
    coalesce(fl.l_out, 0)::numeric(14,2),
    coalesce(fl.l_adj, 0)::numeric(14,2),
    (case
       when p_channel = '도매'      then coalesce(sb.sold, 0)
       when p_channel = '도매 대량' then coalesce(sb.sold_bulk, 0)
       when p_channel = '소매'      then coalesce(sr.sold, 0)
       when p_channel = '프로모션'  then 0
       else coalesce(sr.sold, 0) + coalesce(sb.sold, 0) + coalesce(sb.sold_bulk, 0)
     end)::numeric(14,2) as sold,
    coalesce(fl.l_out_nonsale, 0)::numeric(14,2)
  from products pr
  left join stock st        on st.product_id = pr.id
  left join flow  fl        on fl.product_id = pr.id
  left join sold_retail sr  on sr.product_id = pr.id
  left join sold_b2b   sb   on sb.product_id = pr.id
  where coalesce(st.qty,0) <> 0 or coalesce(fl.l_in,0) <> 0 or coalesce(fl.l_out,0) <> 0
     or coalesce(fl.l_adj,0) <> 0
     or (case
           when p_channel = '도매'      then coalesce(sb.sold, 0)
           when p_channel = '도매 대량' then coalesce(sb.sold_bulk, 0)
           when p_channel = '소매'      then coalesce(sr.sold, 0)
           when p_channel = '프로모션'  then 0
           else coalesce(sr.sold, 0) + coalesce(sb.sold, 0) + coalesce(sb.sold_bulk, 0)
         end) <> 0;
$$;

-- 2) 원장 점검 ─────────────────────────────────────────────────────────
--  kind 별 이상 행. 숫자는 고치지 않고 보여 주기만 한다(S12). '오늘' 은 앱이 KST 로 넘긴다(S6).
--  [B2B]
--   b2b_cancelled      취소된 차수·발주에 남은 B2B 선점(발주 단위 — 발주 취소인데 차수가 살아 있으면 tags 'live')
--   b2b_stock_off      재고 차감이 꺼진 채 남은 차수(취소 아님·발송일 있음)가 있는 발주(2026-08-05 이후 생성)
--   b2b_no_deduct      선점이 있어야 하는데 없는 발주(발송완료 또는 차감 대상 발송일 있는 차수, 2026-08-05 이후 생성, 위 항목 제외)
--   b2b_qty_mismatch   선점 수량이 기대(발주 전량 − 취소 차수 배정, 세트 전개)와 다르거나 칸이 어긋난 발주(위 b2b_cancelled 발주 제외).
--                      차수 두 벌·배분 초과 발주면 tags 'dup'([수정] 재저장은 겹친 차수를 그대로 다시 저장한다 — 발송일 칸에서 정리)
--   b2b_date_mismatch  선점이 첫 발송일 하루·한 차수에 있지 않은 발주. 여러 차수에 붙었고 이중 선점 증거(같은 차수 번호 두 벌,
--                      또는 품목 선점이 기대보다 많음)가 있으면 tags 'multi'. 증거 없는 여러 차수(2026-07-31 37a55d1 전 차수별 차감한
--                      옛 분할 발주 등)는 태그 없이 — [수정] 재저장이 첫 발송일 하루로 합친다(재고 총량 그대로)
--   b2b_overdue        발송일이 지났는데 발송완료·취소가 아닌 차수
--   b2b_unlinked_line  재고와 연결 안 된 발주 라인(상품을 고르지 않은 줄 — 재고가 안 빠진다, S9). 2026-08-05 이후·최근 60일 발주
--   b2b_over_alloc     차수 배분 합이 발주 수량보다 많은 라인이 있는 발주(취소 발주 제외 — 이 발주는 저장이 막힌다)
--   b2b_dup_shipment   같은 차수 번호가 두 벌인 발주(동시 저장)
--   b2b_kept_orphan    주인이 없는 '출고 유지' 행(131 source b2b_cancel_kept) — 발주가 없거나 발송 시각이 남은 취소 차수가 없다
--  [온라인 출고]
--   fulfill_interrupted     중단된 출고 — 출고 이력은 있는데 재고 행이 없는 배치(차감할 품목이 있었고 2분 지남, fulfill-db maybeInterrupted).
--                           대기 키(fulfill_pending_keys)가 남은 중단만 원래 파일을 다시 올리면 ④ 출고가 출고일과 무관하게
--                           이어서 차감한다(기간 표식 없음 — v4). 대기 키가 없고 그 배치의 처리완료 키(135 group_id, 없으면
--                           출고번호 · 135 fulfill_dispatch.keys)가 있으면 tags 'finished' = 출고 완료 뒤 재고만 취소된 배치 —
--                           다시 올리면 대조 기간(발주처리 설정, 기본 45일) 안에는 처리된 주문으로 빠지고, 그 뒤에는 이어서 차감돼 두 번 빠진다(v5).
--                           ④ '차감 없이 닫기'(품목 수 0)로 닫은 배치는 빠진다(sku_count > 0 만 본다).
--                           옛 화면의 묶음 취소·1품목 배치의 한 줄 취소가 'finished' 의 대부분이다(일부러 취소한 것 — 화면이 먼저 안내)
--   fulfill_late_orphan     연결 끊긴 늦은 출고 — [재고 차감 기록](131 source fulfill_unmatched)인데 그 출고 이력이 없다
--   fulfill_unmatched       ④ 출고 때 재고가 빠지지 않은 코드가 미처리로 남은 배치(135). 60일 지나 [발주처리]에 안 보이면 tags 'old'
--   fulfill_not_dispatched  CN 파일을 받았는데 ④ 출고를 안 한 배치(135, [발송 안 함] 제외). 14일 지나 [발주처리]에 안 보이면 tags 'old'.
--                           그 배치 주문 키(135 match_keys, 없으면 keys)가 모두 처리완료(fulfill_order_keys)면 다른 배치로 나간 것 —
--                           tags 'covered'([발송 안 함]으로 정리), 14일 지났으면 정리할 길도 장부 영향도 없어 뺀다. 일부만이면 내용에 표시
--  [재고 일반]
--   move_unpaired      짝(출고+입고, 합 0)이 안 맞는 재고 이동 — 이동 판정은 대사와 같은 규칙(출처 칸 우선)
--   bundle_row         세트(묶음) id 에 기록된 원장 행
--   old_pending        7일 넘은 '대기' 행
--   future_done        오늘 이후 날짜로 '완료'된 행(B2B 선점 = 출고 예정이라 제외)
--   promo_stranded     열린 프로모션 요청서가 없는 품목의 프로모션 재고
--   promo_unreleased   닫힌(완료·취소) 프로모션 요청서 중 소매 합류가 끝났다는 표시(136 promo_released_at)가 없는 것
--   negative_balance   오늘 기준 칸별 마이너스 재고(세트 id·재고 관리 안 함 품목 제외)
--   inactive_balance   미사용 품목에 남은 칸별 재고
--   untracked_balance  재고 관리 안 함 품목에 남은 칸별 재고
--  [입고·반품]
--   receipt_unlinked    최근 21일 요청서에 연결 안 된 소매 입고 중 같은 품목에 열린 제조사 요청서 잔여가 있는 것(S9 — 입고 예정에 이중으로 잡힘)
--   return_no_out       사유 '제조사 반품' 출고가 같은 날 없는 제조사 반품(2026-09-01 이후·최근 90일 — 매입 결산만 깎이고 재고는 그대로)
--   return_after_count  제조사 반품 출고보다 먼저 입력된, 반품일(그날 포함) 뒤 실사가 있는 건(이중 차감 의심, 최근 90일)
--  [매출]
--   shipped_no_sales   매출 행이 없는 발송완료 발주
--   sales_not_shipped  발송완료가 아닌데 매출 행이 있는 발주 + 발주가 지워진 B2B 매출 배치(tags 'deleted')
--   sales_future       오늘 이후 날짜의 매출 행(채널·날짜별, 도매면 tags 'b2b')
--  tags = 화면 처리 안내를 고르는 표식. 'live'(위), 'counted' = 차감일(취소 선점은 선점일) 뒤 같은 품목·칸 실사(조정)가 있음 —
--   그 실사가 이미 차감·복구를 대신했을 수 있어 [수정] 재저장이 두 번 반영할 수 있다(S12: 사람이 판단). b2b_cancelled·
--   b2b_stock_off·b2b_no_deduct·b2b_qty_mismatch 에만 붙는다. 'multi'·'dup'·'old'·'covered'·'finished'·'deleted'·'b2b' 는 위 항목 설명.
--  특수 행: '_unavailable'(ref_id = 칸이 없어 확인 못 한 항목, detail = 필요한 마이그레이션 번호), '_meta'(ref_id 'v5' — 이 판의 함수. 'v4'·'v3'·'v2' = 4차·3차·2차 판).
--  rn 은 정렬 키 끝에 항목별 고유 키(tie)를 붙여 매 호출 같은 순서다(앱이 함수를 페이지마다 다시 불러 rn 범위로 읽는다 — S4).
drop function if exists inventory_ledger_check(date, text[], uuid[]);
create function inventory_ledger_check(p_today date, p_kinds text[] default null, p_untracked uuid[] default '{}')
returns table(
  rn bigint, kind text, ref_id text, ref_no text, partner text,
  product_id uuid, product_name text, sku text, channel text,
  qty numeric, txn_date date, detail text, tags text[]
) language sql stable as $$
  with recursive
  bundle_tree as ( -- 대사와 같은 전개(깊이 8 · 순환 가지 버림 · 자기 자신 구성 행 버림)
    select pb.parent_id as root, pb.component_id as node, pb.qty::numeric as mult, 1 as depth,
           array[pb.parent_id, pb.component_id] as path
    from product_bundles pb
    where pb.component_id <> pb.parent_id
    union all
    select bt.root, pb.component_id, bt.mult * pb.qty, bt.depth + 1, bt.path || pb.component_id
    from bundle_tree bt
    join product_bundles pb on pb.parent_id = bt.node
    where bt.depth < 8 and not (pb.component_id = any(bt.path))
  ),
  is_bundle as (select distinct pb.parent_id as id from product_bundles pb),
  bundle_leaf as (
    select bt.root, bt.node as leaf, sum(bt.mult) as mult
    from bundle_tree bt
    where not exists (select 1 from is_bundle ib where ib.id = bt.node)
    group by bt.root, bt.node
  ),
  untracked as (select unnest(coalesce(p_untracked, '{}'::uuid[])) as id),
  has as ( -- 새 칸 유무(131·135·136) — 칸 이름을 직접 쓰지 않아 적용 순서와 무관하게 함수가 만들어진다
    select
      exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.inventory_txns')
                and a.attname = 'source' and not a.attisdropped) as c131,
      exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.fulfill_dispatch')
                and a.attname = 'unmatched_done_at' and not a.attisdropped) as c135d,
      exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.fulfill_pending_keys')
                and a.attname = 'discarded_at' and not a.attisdropped) as c135k,
      exists (select 1 from pg_attribute a where a.attrelid = to_regclass('public.production_requests')
                and a.attname = 'promo_released_at' and not a.attisdropped) as c136
  ),
  tsrc as ( -- 출처가 적힌 원장 행(131 source·source_ref). 칸이 없으면 빈 집합 = 모든 행이 '출처 없음'(종전 표식으로 판정)
    select t.id, x.j->>'source' as src, x.j->>'source_ref' as src_ref
    from inventory_txns t
    cross join lateral (select to_jsonb(t) as j) x
    where x.j->>'source' is not null
  ),
  ord_info as ( -- era = 차수 재고 차감이 항상 켜지는 발주(created_at UTC 날짜 ≥ 2026-08-05, 앱 STOCK_OUT_SINCE 와 같은 비교)
    select o.id, o.order_no, o.status, o.ship_date, o.order_date,
           ((o.created_at at time zone 'UTC')::date >= date '2026-08-05') as era, c.name as company,
           coalesce(o.is_bulk, false) as is_bulk
    from orders o
    left join companies c on c.id = o.company_id
  ),
  b2b_txn as ( -- B2B 선점 행 + 붙은 차수·발주('출고 유지' 행은 차수가 없어 여기 안 들어온다)
    select t.id, t.product_id, t.qty, t.txn_date, t.channel, t.shipment_id,
           sh.order_id, sh.status as sh_status, sh.shipped_at, o.status as o_status
    from inventory_txns t
    join shipments sh on sh.id = t.shipment_id
    join orders o on o.id = sh.order_id
    where t.created_by = 'B2B 자동출고'
  ),
  ord_has_ded as (select distinct bt.order_id from b2b_txn bt),
  ord_cx_ded as ( -- 취소된 차수·발주에 선점이 남은 발주(b2b_cancelled)
    select distinct bt.order_id from b2b_txn bt where bt.sh_status = '취소' or bt.o_status = '취소'
  ),
  real_ship as ( -- 취소 아닌 실제 차수(발송일 또는 배정 수량이 있는 것 — 앱 willInsert. 배송정보 전용 행은 차수가 아니다)
    select s.order_id, s.stock_out
    from shipments s
    where s.status <> '취소'
      and (s.ship_date is not null
           or exists (select 1 from shipment_items si where si.shipment_id = s.id and si.qty > 0))
  ),
  ord_live as (select distinct r.order_id from real_ship r),
  ord_elig as ( -- 재저장하면 선점이 생기는 발주 = 차감 대상 차수(취소 아님 + 차감 켬, era 발주는 전부)가 있다
    select distinct r.order_id from real_ship r join ord_info oi on oi.id = r.order_id where r.stock_out or oi.era
  ),
  adj_last as ( -- 품목·칸별 마지막 실사(조정) 날짜 — 차감일 뒤 실사가 있으면 그 실사가 이미 차감을 대신했을 수 있다
    select t.product_id, t.channel, max(t.txn_date) as d
    from inventory_txns t
    where t.type = '조정' and t.status = '완료'
    group by t.product_id, t.channel
  ),
  b2b_cx as (
    select si.order_item_id, sum(si.qty) as q
    from shipment_items si
    join shipments sh on sh.id = si.shipment_id
    where sh.status = '취소' and si.order_item_id is not null
    group by si.order_item_id
  ),
  ord_eff as ( -- 발주별 차감돼야 할 구성품·수량(발주 전량 − 취소 차수 배정, 세트 전개)
    select oi.order_id, coalesce(bl.leaf, oi.product_id) as product_id,
           sum(greatest(0, oi.qty - coalesce(cx.q, 0)) * coalesce(bl.mult, 1)) as q
    from order_items oi
    left join b2b_cx cx on cx.order_item_id = oi.id
    left join bundle_leaf bl on bl.root = oi.product_id
    where oi.product_id is not null
      and (bl.root is not null or not exists (select 1 from is_bundle ib where ib.id = oi.product_id))
    group by oi.order_id, coalesce(bl.leaf, oi.product_id)
  ),
  ord_eff_t as ( -- 재고 관리 대상 품목만(121)
    select e.order_id, count(*) as n, sum(e.q) as q,
           left(string_agg(coalesce(p.name, '품목'), ', ' order by e.q desc), 80) as names
    from ord_eff e
    left join products p on p.id = e.product_id
    where e.q > 0 and not exists (select 1 from untracked ux where ux.id = e.product_id)
    group by e.order_id
  ),
  stock_off_ord as ( -- 재고 차감이 꺼진 채 남은 차수(취소 아님·발송일 있음)
    select s.order_id, min(s.ship_date) as d, count(*) as n
    from shipments s
    where s.ship_date is not null and s.status <> '취소' and not s.stock_out
    group by s.order_id
  ),
  exp_ded as ( -- 원장 규칙의 차감일 = 차감 대상 차수(취소 아님 + 차감 켬, era 발주는 전부) 중 가장 이른 발송일
    select s.order_id, min(s.ship_date) as d
    from shipments s
    join ord_info oi on oi.id = s.order_id
    where s.status <> '취소' and s.ship_date is not null and (s.stock_out or oi.era)
    group by s.order_id
  ),
  ded_sum as (
    select bt.order_id, count(distinct bt.shipment_id) as n_ship,
           min(bt.txn_date) as d_min, max(bt.txn_date) as d_max, max(bt.channel) as ch
    from b2b_txn bt
    where bt.sh_status <> '취소' and bt.o_status <> '취소'
    group by bt.order_id
  ),
  ord_cnt as ( -- 차감일 뒤에 그 발주 품목을 차감 칸(살아 있는 선점 칸, 없으면 대량 표식 칸)에서 실사한 발주
    select distinct e.order_id
    from ord_eff e
    join ord_info oi on oi.id = e.order_id
    left join ded_sum ds on ds.order_id = e.order_id
    left join exp_ded ed on ed.order_id = e.order_id
    join adj_last a on a.product_id = e.product_id
                   and a.channel = coalesce(ds.ch, case when oi.is_bulk then '도매 대량' else '도매' end)
    where e.q > 0 and not exists (select 1 from untracked ux where ux.id = e.product_id)
      and a.d >= coalesce(ed.d, oi.ship_date, oi.order_date)
  ),
  -- 선점 수량 대조 — 기대 = 앱 saveOrderShipments 규칙(발주 전량 − 취소 차수 배정, 세트 전개, 재고 관리 안 함 품목은 빼되
  --  이 발주에 이미 선점된 품목은 계속 차감). 차감 대상 차수가 없는 발주는 기대 0.
  ded_prod as ( -- 살아 있는 선점(취소 아닌 차수·발주)의 품목별 합
    select bt.order_id, bt.product_id, sum(-bt.qty) as q
    from b2b_txn bt
    where bt.sh_status <> '취소' and bt.o_status <> '취소'
    group by bt.order_id, bt.product_id
  ),
  exp_prod as (
    select e.order_id, e.product_id, e.q
    from ord_eff e
    join ord_elig el on el.order_id = e.order_id
    where e.q > 0
      and (not exists (select 1 from untracked ux where ux.id = e.product_id)
           or exists (select 1 from b2b_txn bt where bt.order_id = e.order_id and bt.product_id = e.product_id))
  ),
  qty_cmp as ( -- 살아 있는 선점이 있는 발주만(없는 발주는 b2b_no_deduct·b2b_stock_off 가 본다), 다른 품목만
    select p.order_id, p.product_id, sum(p.exp_q) as exp_q, sum(p.ded_q) as ded_q
    from (
      select x.order_id, x.product_id, x.q as exp_q, 0::numeric as ded_q
      from exp_prod x where exists (select 1 from ded_sum ds where ds.order_id = x.order_id)
      union all
      select d.order_id, d.product_id, 0::numeric, d.q::numeric from ded_prod d
    ) p
    group by p.order_id, p.product_id
    having abs(sum(p.exp_q) - sum(p.ded_q)) > 0.001
  ),
  qty_mm as (
    select q.order_id, sum(q.exp_q) as exp_q, sum(q.ded_q) as ded_q,
           left(string_agg(coalesce(p.name, '품목') || ' ' || trim_scale(round(q.exp_q::numeric, 2))::text
                             || '/' || trim_scale(round(q.ded_q::numeric, 2))::text,
                           ', ' order by abs(q.exp_q - q.ded_q) desc), 120) as names,
           coalesce(bool_or(a.d >= coalesce(ed.d, ds.d_min)), false) as counted
    from qty_cmp q
    join ded_sum ds on ds.order_id = q.order_id
    left join exp_ded ed on ed.order_id = q.order_id
    left join products p on p.id = q.product_id
    left join adj_last a on a.product_id = q.product_id and a.channel = ds.ch
    group by q.order_id
  ),
  -- 동시 저장 사고의 흔적 — 이중 선점 판정('multi')과 [수정] 대신 발송일 칸으로 정리할 발주('dup')에 쓴다
  dup_ord as ( -- 같은 차수 번호가 두 벌(b2b_dup_shipment 와 같은 조건)
    select distinct s.order_id from shipments s group by s.order_id, s.seq having count(*) > 1
  ),
  over_ord as ( -- 차수 배분 합이 발주 수량보다 많은 라인이 있다(b2b_over_alloc 과 같은 조건)
    select distinct x.order_id
    from order_items x
    join shipment_items si on si.order_item_id = x.id
    group by x.order_id, x.id, x.qty
    having sum(si.qty) > x.qty + 0.0005
  ),
  over_ded as ( -- 살아 있는 선점이 기대보다 많은 품목이 있다
    select distinct q.order_id from qty_cmp q where q.ded_q > q.exp_q + 0.001
  ),
  chan_mm as ( -- 선점이 두 칸에 나뉘었거나, 아직 안 나간 선점(앱 prevOut 아님)이 대량 표식 칸과 다른 발주 — 재저장하면 한 칸으로 다시 기록된다
    select bt.order_id, string_agg(distinct bt.channel, '·') as chs, count(distinct bt.channel) as n_ch,
           max(case when oi.is_bulk then '도매 대량' else '도매' end) as want
    from b2b_txn bt
    join ord_info oi on oi.id = bt.order_id
    left join exp_ded ed on ed.order_id = bt.order_id
    where bt.sh_status <> '취소' and bt.o_status <> '취소'
    group by bt.order_id
    having count(distinct bt.channel) > 1
        or (max(bt.channel) <> max(case when oi.is_bulk then '도매 대량' else '도매' end)
            and not coalesce(bool_or(bt.sh_status = '발송완료' or bt.shipped_at is not null
                                     or (bt.txn_date < p_today and coalesce(ed.d, p_today) < p_today)), false))
  ),
  kept as ( -- '출고 유지' 행(131 source b2b_cancel_kept · source_ref = 발주 id, shipment_id 없음) — 131 미적용이면 빈 집합
    select t.id, t.product_id, t.qty, t.txn_date, t.channel, s.src_ref
    from inventory_txns t
    join tsrc s on s.id = t.id
    where s.src = 'b2b_cancel_kept'
  ),
  mv as ( -- 재고 이동 — group_id·품목 단위로 출고 1 + 입고 1, 완료 합 0 이어야 한다.
    --  이동 판정 = 출처 칸(131) 'move'·'promo_close'(마감 합류도 같은 짝), 출처 없는 옛 행은 partner '채널이동' + 주문번호 없음
    select coalesce(t.group_id::text, 'row:' || t.id::text) as g, t.product_id,
           coalesce(sum(t.qty) filter (where t.status = '완료'), 0) as net_done,
           count(*) filter (where t.type = '출고') as n_out,
           count(*) filter (where t.type = '입고') as n_in,
           count(*) filter (where t.status <> '완료') as n_wait,
           min(t.txn_date) as d,
           string_agg(distinct t.channel, '·') as chs,
           max(t.created_by) as by_name
    from inventory_txns t
    left join tsrc s on s.id = t.id
    where s.src in ('move', 'promo_close')
       or (s.src is null and t.partner = '채널이동' and t.order_no is null)
    group by 1, 2
  ),
  bal as ( -- 오늘 기준 칸별 재고(완료만)
    select t.product_id, t.channel, sum(t.qty) as q
    from inventory_txns t
    where t.status = '완료' and t.txn_date <= p_today
    group by t.product_id, t.channel
  ),
  ns as ( -- 발송완료가 아닌 발주에 남은 매출 행
    select oi.id as order_id, so.id as sid, so.quantity, so.order_date
    from ord_info oi
    join sales_orders so on so.upload_batch = 'b2b-' || oi.id::text
    where oi.status <> '발송완료'
    union
    select oi.id, so.id, so.quantity, so.order_date
    from ord_info oi
    join sales_orders so on so.channel = '도매' and so.order_id = oi.order_no
    where oi.status = '취소'
  ),
  fd_um as ( -- ④ 출고 때 재고가 빠지지 않은 코드(135 fulfill_dispatch.unmatched [{sku, qty, kind}]) — 135 미적용이면 빈 집합
    select d.id, d.order_no, d.channel, d.dispatch_date, x.j->'unmatched' as um
    from fulfill_dispatch d
    cross join lateral (select to_jsonb(d) as j) x
    where (case when jsonb_typeof(x.j->'unmatched') = 'array' then jsonb_array_length(x.j->'unmatched') else 0 end) > 0
      and x.j->>'unmatched_done_at' is null
  ),
  pk as ( -- CN 파일을 받았지만 아직 출고 완료(행 삭제)·[발송 안 함]이 아닌 배치(135 fulfill_pending_keys 칸) — 135 미적용이면 빈 집합
    select k.sig, x.j->>'file_name' as file_name, x.j->>'order_count' as order_count, x.j->>'total_qty' as total_qty,
           (x.j->>'downloaded_at')::timestamptz as downloaded_at,
           -- 대조할 주문 키 = 현재 판정 기준 키(135 match_keys, 주문당 1개), 없으면 두 산식 키(079 keys) — ④ 출고는 둘 다 등록한다
           (case when jsonb_typeof(x.j->'match_keys') = 'array' and jsonb_array_length(x.j->'match_keys') > 0 then x.j->'match_keys'
                 when jsonb_typeof(x.j->'keys') = 'array' then x.j->'keys'
                 else '[]'::jsonb end) as ks
    from fulfill_pending_keys k
    cross join lateral (select to_jsonb(k) as j) x
    where x.j->>'downloaded_at' is not null and x.j->>'discarded_at' is null
  ),
  pk_cov as ( -- 그 배치 주문 중 처리완료 키(fulfill_order_keys)가 이미 있는 것 = 다른 배치로 ④ 출고된 주문(누적 파일 등)
    --  키는 fulfill_order_keys 의 기본 키라 조인해도 행이 늘지 않는다. 같은 키가 배열에 두 번 있어도 양쪽에 같이 센다.
    select k.sig, count(*) as n_keys, count(o.key) as n_cov
    from pk k
    cross join lateral jsonb_array_elements_text(k.ks) e(key)
    left join fulfill_order_keys o on o.key = e.key
    group by k.sig
  ),
  fok as ( -- 처리완료 키를 등록한 출고 배치(135 group_id — 칸이 없거나 그 전 키면 null, 그때는 출고번호 order_no 로 본다).
    --  중단된 출고의 'finished' 판정(fulfill_interrupted)이 쓴다. 135 칸은 to_jsonb 로 읽는다
    select distinct x.j->>'group_id' as gid, k.order_no
    from fulfill_order_keys k
    cross join lateral (select to_jsonb(k) as j) x
  ),
  pr_rel as ( -- 닫힌 프로모션 요청서 중 합류 완료 표시(136)가 없는 것 — 실행 중(70초 안 클레임)은 뺀다. 136 미적용이면 has 가 막는다
    select r.id, r.req_no, r.status, r.updated_at
    from production_requests r
    cross join lateral (select to_jsonb(r) as j) x
    where r.purpose = '프로모션' and r.status in ('완료', '취소')
      and x.j->>'promo_released_at' is null
      and coalesce((x.j->>'promo_release_started_at')::timestamptz < now() - interval '70 seconds', true)
  ),
  open_rem as ( -- 열린 제조사(재고 보충) 요청서의 품목별 잔여(요청 − 이행) — 입고 예정(production-inbound)과 같은 규칙
    select i.product_id, sum(i.requested_qty - coalesce(rc.q, 0)) as rem,
           left(string_agg(distinct coalesce(r.req_no, '요청서'), ', '), 60) as reqs
    from production_request_items i
    join production_requests r on r.id = i.request_id
    left join (select pr.item_id, sum(pr.qty) as q from production_receipts pr group by pr.item_id) rc on rc.item_id = i.id
    where r.status in ('요청', '진행중') and coalesce(r.purpose, '재고 보충') = '재고 보충'
      and i.requested_qty - coalesce(rc.q, 0) > 0.001
    group by i.product_id
  ),
  u as (
    -- 취소에 남은 B2B 선점 — 세 경우(화면 처리 안내가 다르다):
    --  live    발주는 취소인데 실제 차수가 살아 있음(옛 취소는 헤더만 바꿨다) — [수정] 재저장은 선점을 다시 쓰고 복수 발송이면 발주를 되살린다
    --  (없음)  발주 취소 · 차수도 취소 / 취소 차수 — [수정] 재저장이 선점을 지운다
    --  counted 선점일 뒤 그 품목·칸을 실사함 — 지우면 실사가 이미 되살린 수량이 두 번 되살아날 수 있다
    select 'b2b_cancelled'::text as kind, bt.order_id::text as ref_id, oi.order_no::text as ref_no, oi.company::text as partner,
           null::uuid as product_id, null::text as product_name, null::text as sku, max(bt.channel)::text as channel,
           sum(-bt.qty)::numeric as qty, min(bt.txn_date)::date as txn_date,
           (case when bool_or(bt.o_status = '취소') and exists (select 1 from ord_live l where l.order_id = bt.order_id)
                   then '발주 취소 · 살아 있는 차수'
                 when bool_or(bt.o_status = '취소') then '발주 취소'
                 else '취소 차수' end
              || ' · ' || count(distinct bt.product_id)::text || '품목'
              || case when coalesce(bool_or(a.d >= bt.txn_date), false) then ' · 발송일 뒤 실사 있음' else '' end)::text as detail,
           array_remove(array[
             case when bool_or(bt.o_status = '취소') and exists (select 1 from ord_live l where l.order_id = bt.order_id) then 'live' end,
             case when coalesce(bool_or(a.d >= bt.txn_date), false) then 'counted' end
           ], null)::text[] as tags,
           bt.order_id::text as tie
    from b2b_txn bt
    join ord_info oi on oi.id = bt.order_id
    left join adj_last a on a.product_id = bt.product_id and a.channel = bt.channel
    where (p_kinds is null or 'b2b_cancelled' = any(p_kinds))
      and (bt.sh_status = '취소' or bt.o_status = '취소')
    group by bt.order_id, oi.order_no, oi.company

    union all
    -- 재고 차감이 꺼진 채 남은 차수가 있는 발주(era — 다시 저장하면 켜진다. 그 전 발주는 일부러 끈 것일 수 있어 뺀다)
    select 'b2b_stock_off'::text, oi.id::text, oi.order_no::text, oi.company::text,
           null::uuid, null::text, null::text, null::text,
           et.q::numeric, so.d::date,
           (oi.status || ' · 차감 꺼진 차수 ' || so.n::text || '건'
              || case when exists (select 1 from ord_has_ded d where d.order_id = so.order_id) then ' · 선점 있음' else ' · 선점 없음' end
              || case when cnt.order_id is not null then ' · 발송일 뒤 실사 있음' else '' end
              || ' · ' || et.names)::text,
           (case when cnt.order_id is not null then array['counted'] else '{}' end)::text[],
           oi.id::text
    from stock_off_ord so
    -- 실사 표식은 살아 있는 선점이 없을 때만 — 있으면 재저장은 날짜만 옮기고, 수량 차이는 b2b_qty_mismatch 가 따로 본다
    left join ord_cnt cnt on cnt.order_id = so.order_id
                         and not exists (select 1 from ded_sum ds where ds.order_id = so.order_id)
    join ord_info oi on oi.id = so.order_id
    join ord_eff_t et on et.order_id = so.order_id
    where (p_kinds is null or 'b2b_stock_off' = any(p_kinds))
      and oi.status <> '취소' and oi.era

    union all
    -- 선점이 있어야 하는데 없는 발주
    select 'b2b_no_deduct'::text, oi.id::text, oi.order_no::text, oi.company::text,
           null::uuid, null::text, null::text, null::text,
           et.q::numeric, coalesce(ed.d, oi.ship_date, oi.order_date)::date,
           (oi.status
              || case when exists (select 1 from ord_cnt c where c.order_id = oi.id) then ' · 발송일 뒤 실사 있음' else '' end
              || ' · ' || et.names)::text,
           (case when exists (select 1 from ord_cnt c where c.order_id = oi.id) then array['counted'] else '{}' end)::text[],
           oi.id::text
    from ord_info oi
    join ord_eff_t et on et.order_id = oi.id
    left join exp_ded ed on ed.order_id = oi.id
    where (p_kinds is null or 'b2b_no_deduct' = any(p_kinds))
      and oi.status <> '취소' and oi.era
      and (oi.status = '발송완료' or ed.d is not null)
      and not exists (select 1 from ord_has_ded d where d.order_id = oi.id)
      and not exists (select 1 from stock_off_ord so where so.order_id = oi.id)

    union all
    -- 선점 수량·칸이 원장 규칙과 다른 발주(취소에 선점이 남은 발주는 b2b_cancelled 에서 본다 — 그 재저장이 수량도 다시 맞춘다)
    --  수량 = 기대 − 선점(양수 = 덜 빠짐). 칸 = 두 칸에 나뉨, 또는 아직 안 나간 선점이 대량 표식 칸과 다름
    select 'b2b_qty_mismatch'::text, oi.id::text, oi.order_no::text, oi.company::text,
           null::uuid, null::text, null::text, ds.ch::text,
           (qm.exp_q - qm.ded_q)::numeric, coalesce(ed.d, ds.d_min)::date,
           concat_ws(' · ',
             case when qm.order_id is not null then '기대/선점 ' || qm.names end,
             case when cm.order_id is null then null
                  when cm.n_ch > 1 then '선점 칸 ' || cm.n_ch::text || '개(' || cm.chs || ')'
                  else '칸 ' || cm.chs || ' → ' || cm.want || '(아직 안 나감)' end,
             case when qm.counted then '발송일 뒤 실사 있음' end,
             case when dp.order_id is not null then '차수 두 벌' end,
             case when ov.order_id is not null then '배분 초과' end)::text,
           array_remove(array[
             case when qm.counted then 'counted' end,
             case when dp.order_id is not null or ov.order_id is not null then 'dup' end
           ], null)::text[],
           ds.order_id::text
    from ded_sum ds
    join ord_info oi on oi.id = ds.order_id
    left join exp_ded ed on ed.order_id = ds.order_id
    left join qty_mm qm on qm.order_id = ds.order_id
    left join chan_mm cm on cm.order_id = ds.order_id
    left join dup_ord dp on dp.order_id = ds.order_id
    left join over_ord ov on ov.order_id = ds.order_id
    where (p_kinds is null or 'b2b_qty_mismatch' = any(p_kinds))
      and not exists (select 1 from ord_cx_ded x where x.order_id = ds.order_id)
      and (qm.order_id is not null or cm.order_id is not null)

    union all
    -- 선점이 첫 발송일 하루·한 차수에 있지 않은 발주. 여러 차수에 붙었고 이중 선점 증거(차수 두 벌 · 선점이 기대보다 많음)가
    --  있으면 'multi'(동시 저장 — 겹친 차수를 지운다). 증거가 없으면 옛 분할 발주(2026-07-31 전 차수별 차감)처럼 정상 기록일 수 있어
    --  태그 없이 둔다 — [수정] 재저장이 첫 발송일 하루로 합친다(재고 총량 그대로). 안 나간 정상 차수를 지우게 안내하지 않는다.
    select 'b2b_date_mismatch'::text, ds.order_id::text, oi.order_no::text, oi.company::text,
           null::uuid, null::text, null::text, ds.ch::text,
           null::numeric, ds.d_min::date,
           (case when ds.n_ship > 1 then '선점 차수 ' || ds.n_ship::text || '개'
                   || case when dp.order_id is not null then ' · 차수 두 벌'
                           when ov.order_id is not null then ' · 선점이 기대보다 많음'
                           else ' · 첫 발송일 ' || ed.d::text end
                 else '선점일 ' || ds.d_min::text || ' · 첫 발송일 ' || ed.d::text end)::text,
           (case when ds.n_ship > 1 and (dp.order_id is not null or ov.order_id is not null) then array['multi'] else '{}' end)::text[],
           ds.order_id::text
    from ded_sum ds
    join ord_info oi on oi.id = ds.order_id
    join exp_ded ed on ed.order_id = ds.order_id
    left join dup_ord dp on dp.order_id = ds.order_id
    left join over_ded ov on ov.order_id = ds.order_id
    where (p_kinds is null or 'b2b_date_mismatch' = any(p_kinds))
      and (ds.n_ship > 1 or ds.d_min <> ed.d or ds.d_max <> ed.d)

    union all
    -- 발송일이 지났는데 발송 처리 안 된 차수(단일 발송인데 발주가 이미 발송완료인 옛 데이터는 뺀다)
    select 'b2b_overdue'::text, oi.id::text, oi.order_no::text, oi.company::text,
           null::uuid, null::text, null::text, null::text,
           (select coalesce(sum(si.qty), 0) from shipment_items si where si.shipment_id = s.id)::numeric,
           s.ship_date::date,
           (s.seq::text || '차 · ' || s.status
              || case when exists (select 1 from b2b_txn bt where bt.order_id = s.order_id) then ' · 선점 있음' else '' end)::text,
           '{}'::text[],
           s.id::text
    from shipments s
    join ord_info oi on oi.id = s.order_id
    where (p_kinds is null or 'b2b_overdue' = any(p_kinds))
      and s.ship_date is not null and s.ship_date < p_today
      and s.status not in ('발송완료', '취소')
      and oi.status <> '취소'
      and not (oi.status = '발송완료'
               and (select count(*) from shipments s2 where s2.order_id = s.order_id and s2.ship_date is not null) < 2)

    union all
    -- 재고와 연결 안 된 발주 라인(상품을 고르지 않고 이름만 친 줄 — 재고가 빠지지 않는다, S9). 배송비 같은 비재고 줄은 60일 뒤 빠진다
    select 'b2b_unlinked_line'::text, oi.id::text, oi.order_no::text, oi.company::text,
           null::uuid, null::text, null::text, null::text,
           sum(x.qty)::numeric, coalesce(oi.ship_date, oi.order_date)::date,
           (oi.status || ' · 미연동 ' || count(*)::text || '줄 · '
              || left(string_agg(coalesce(nullif(trim(x.product_name), ''), '(이름 없음)'), ', ' order by x.sort_order), 80))::text,
           '{}'::text[],
           oi.id::text
    from order_items x
    join ord_info oi on oi.id = x.order_id
    where (p_kinds is null or 'b2b_unlinked_line' = any(p_kinds))
      and x.product_id is null and x.qty > 0
      and oi.status <> '취소' and oi.era
      and coalesce(oi.ship_date, oi.order_date) >= p_today - 60
    group by oi.id, oi.order_no, oi.company, oi.status, oi.ship_date, oi.order_date

    union all
    -- 차수 배분 합이 발주 수량보다 많은 라인(동시 저장·옛 데이터) — 이 발주는 발송일 창 저장이 막힌다. 수량 = 넘친 합
    select 'b2b_over_alloc'::text, oi.id::text, oi.order_no::text, oi.company::text,
           null::uuid, null::text, null::text, null::text,
           sum(al.alloc - al.qty)::numeric, coalesce(oi.ship_date, oi.order_date)::date,
           left(string_agg(coalesce(nullif(trim(al.product_name), ''), '품목') || ' 발주 ' || trim_scale(al.qty)::text
                             || ' · 배분 ' || trim_scale(al.alloc)::text, ', '), 120)::text,
           '{}'::text[],
           oi.id::text
    from (
      select x.order_id, x.id, x.product_name, x.qty::numeric as qty, sum(si.qty)::numeric as alloc
      from order_items x
      join shipment_items si on si.order_item_id = x.id
      group by x.order_id, x.id, x.product_name, x.qty
      having sum(si.qty) > x.qty + 0.0005
    ) al
    join ord_info oi on oi.id = al.order_id
    where (p_kinds is null or 'b2b_over_alloc' = any(p_kinds))
      and oi.status <> '취소'
    group by oi.id, oi.order_no, oi.company, oi.ship_date, oi.order_date

    union all
    -- 같은 차수 번호가 두 벌인 발주(두 저장이 겹쳐 차수·배분·선점이 두 번 생겼을 수 있다)
    select 'b2b_dup_shipment'::text, oi.id::text, oi.order_no::text, oi.company::text,
           null::uuid, null::text, null::text, null::text,
           null::numeric, coalesce(oi.ship_date, oi.order_date)::date,
           (oi.status || ' · ' || string_agg(d.seq::text || '차 ' || d.n::text || '개', ', ' order by d.seq))::text,
           '{}'::text[],
           oi.id::text
    from (select s.order_id, s.seq, count(*) as n from shipments s group by s.order_id, s.seq having count(*) > 1) d
    join ord_info oi on oi.id = d.order_id
    where (p_kinds is null or 'b2b_dup_shipment' = any(p_kinds))
    group by oi.id, oi.order_no, oi.company, oi.status, oi.ship_date, oi.order_date

    union all
    -- 주인이 없는 '출고 유지' 행 — 발주가 없거나, 그 발주에 발송 시각이 남은 취소 차수가 없다(복구해도 정리되지 않는다)
    select 'b2b_kept_orphan'::text, oi.id::text, coalesce(oi.order_no, '(지워진 발주)')::text, oi.company::text,
           null::uuid, null::text, null::text, max(k.channel)::text,
           sum(-k.qty)::numeric, min(k.txn_date)::date,
           ((case when oi.id is null then '발주 없음' else oi.status || ' · 발송한 취소 차수 없음' end)
              || ' · ' || count(distinct k.product_id)::text || '품목')::text,
           '{}'::text[],
           coalesce(k.src_ref, '')
    from kept k
    left join ord_info oi on oi.id::text = k.src_ref
    where (p_kinds is null or 'b2b_kept_orphan' = any(p_kinds))
      and (oi.id is null
           or not exists (select 1 from shipments s where s.order_id = oi.id and s.status = '취소' and s.shipped_at is not null))
    group by k.src_ref, oi.id, oi.order_no, oi.company, oi.status

    union all
    -- 중단된 출고 — 출고 이력은 있는데 재고 행이 하나도 없는 배치(fulfill-db maybeInterrupted 와 같은 판정).
    --  대기 키(fulfill_pending_keys)가 남은 중단만 원래 파일을 다시 올리면 이어서 차감된다 — generate 는 중단 이력 서명의
    --  대기 키로 이어받기를 판정하고(같은 키 집합이면 그 주문을 빼지 않는다), ④는 같은 서명의 중단 이력을 출고일과 무관하게
    --  찾는다(dispatch route 1단계 — '이미 출고됨'만 최근 7일). 그래서 기간 표식이 없다(v3 'old' 폐지 — v4).
    --  그 사이 실사·직접 기록이 있으면 ④가 이어서 차감 전에 묻고, 이미 맞췄으면 '차감 없이 닫기'(sku_count 0)로 닫아 여기서 빠진다.
    --  'finished'(v5) = 대기 키가 없고 그 배치의 처리완료 키가 있다. 대기 키는 ④가 끝까지 갔을 때만 지워지므로(재고 기록 뒤)
    --  출고는 끝났고 재고만 나중에 지워진 배치다(옛 화면 묶음 취소 · 1품목 배치의 한 줄 취소 — 대개 일부러 취소).
    --  다시 올리면 대조 기간(기본 45일) 안에는 generate 가 그 주문을 처리된 주문으로 빼고(대기 키 저장 전에 400), 그 뒤에는 키가
    --  창 밖이라 통과해 ④가 같은 서명으로 이어서 차감한다(고친 파일로 다시 낸 출고가 있으면 두 번 빠진다).
    --  처리완료 키 = 그 배치가 등록한 키(135 group_id, 칸이 없거나 옛 키면 출고번호 order_no) 또는 그 배치 주문 키(135
    --  fulfill_dispatch.keys) 중 처리완료로 남은 것. 일부러 취소했는지는 여기서 가리지 못한다(화면이 안내).
    select 'fulfill_interrupted'::text, d.id::text, d.order_no::text, null::text,
           null::uuid, null::text, null::text, d.channel::text,
           d.total_qty::numeric, d.dispatch_date::date,
           ('품목 ' || d.sku_count::text || '개 · 재고 기록 없음'
              || (case when fin.v then ' · 출고 완료 뒤 재고만 취소됨' else '' end)
              || ' · 출고 ' || to_char(d.created_at at time zone 'Asia/Seoul', 'MM-DD HH24:MI'))::text,
           (case when fin.v then array['finished'] else '{}' end)::text[],
           d.id::text
    from fulfill_dispatch d
    cross join lateral (select to_jsonb(d) as j) dx
    cross join lateral (select (
        not exists (select 1 from fulfill_pending_keys p where p.sig = d.sig)
        and (exists (select 1 from fok o
                     where o.gid = d.group_id::text
                        or (o.gid is null and d.order_no is not null and o.order_no = d.order_no))
             or exists (select 1
                        from jsonb_array_elements_text(case when jsonb_typeof(dx.j->'keys') = 'array' then dx.j->'keys' else '[]'::jsonb end) e(key)
                        join fulfill_order_keys k on k.key = e.key))
      ) as v) fin
    where (p_kinds is null or 'fulfill_interrupted' = any(p_kinds))
      and d.sku_count > 0 and d.group_id is not null and d.created_at < now() - interval '2 minutes'
      and not exists (select 1 from inventory_txns t where t.group_id = d.group_id)

    union all
    -- 연결 끊긴 늦은 출고 — [재고 차감 기록] 행인데 그 출고 이력이 없다(배치를 옛 방식으로 취소 — 고친 파일로 다시 출고하면 이중 차감)
    select 'fulfill_late_orphan'::text, t.id::text, t.order_no::text, t.partner::text,
           t.product_id, p.name::text, p.sku::text, t.channel::text,
           t.qty::numeric, t.txn_date::date,
           '출고 이력 없음(배치 취소됨)'::text,
           '{}'::text[],
           t.id::text
    from inventory_txns t
    join tsrc s on s.id = t.id
    left join products p on p.id = t.product_id
    where (p_kinds is null or 'fulfill_late_orphan' = any(p_kinds))
      and s.src = 'fulfill_unmatched'
      and not exists (select 1 from fulfill_dispatch d where d.id::text = s.src_ref)

    union all
    -- ④ 출고 때 재고가 빠지지 않은 코드가 미처리로 남은 배치. 수량 = 그 코드 수량 합
    select 'fulfill_unmatched'::text, f.id::text, f.order_no::text, null::text,
           null::uuid, null::text, null::text, f.channel::text,
           (select coalesce(sum(case when e->>'qty' ~ '^[0-9]+(\.[0-9]+)?$' then (e->>'qty')::numeric else 0 end), 0)
              from jsonb_array_elements(f.um) e)::numeric,
           f.dispatch_date::date,
           ('코드 ' || jsonb_array_length(f.um)::text || '개 · '
              || coalesce(left((select string_agg(coalesce(e->>'sku', '?') || ' ' || coalesce(e->>'qty', '?')
                                                  || case when e->>'kind' = 'ambiguous' then '(중복 코드)' else '' end, ', ')
                                  from jsonb_array_elements(f.um) e), 100), ''))::text,
           (case when f.dispatch_date < p_today - 60 then array['old'] else '{}' end)::text[],
           f.id::text
    from fd_um f
    where (p_kinds is null or 'fulfill_unmatched' = any(p_kinds))

    union all
    -- CN 파일을 받았는데 ④ 출고를 안 한 배치(실물은 나갔을 수 있는데 재고가 안 빠짐).
    --  주문이 모두 다른 배치로 나갔으면(누적 파일을 다시 받아 그쪽으로 ④) 'covered' — 재고는 그 배치로 빠졌다. 다시 기록하면 이중 차감.
    --  14일 지난 'covered' 는 [발주처리] 목록에도 없고 장부 영향도 없어 뺀다(남겨 두면 매주 손으로 기록하라는 안내만 남는다).
    select 'fulfill_not_dispatched'::text, k.sig::text, coalesce(nullif(k.file_name, ''), '(파일명 없음)')::text, null::text,
           null::uuid, null::text, null::text, null::text,
           (case when k.total_qty ~ '^[0-9]+(\.[0-9]+)?$' then k.total_qty::numeric end)::numeric,
           (k.downloaded_at at time zone 'Asia/Seoul')::date,
           ('CN 파일 받음 · ④ 출고 안 함'
              || case when k.order_count ~ '^[0-9]+$' then ' · 주문 ' || k.order_count || '건' else '' end
              || case when c.n_keys > 0 and c.n_cov >= c.n_keys then ' · 주문 모두 다른 배치로 출고됨'
                      when c.n_cov > 0 then ' · 일부 주문 다른 배치로 출고됨'
                      else '' end
              || case when k.downloaded_at < now() - interval '14 days' then ' · 14일 지남' else '' end)::text,
           array_remove(array[
             case when k.downloaded_at < now() - interval '14 days' then 'old' end,
             case when c.n_keys > 0 and c.n_cov >= c.n_keys then 'covered' end
           ], null)::text[],
           k.sig::text
    from pk k
    left join pk_cov c on c.sig = k.sig
    where (p_kinds is null or 'fulfill_not_dispatched' = any(p_kinds))
      and not exists (select 1 from fulfill_dispatch d where d.sig = k.sig)
      and not (coalesce(c.n_keys, 0) > 0 and c.n_cov >= c.n_keys and k.downloaded_at < now() - interval '14 days')

    union all
    -- 짝이 안 맞는 재고 이동
    select 'move_unpaired'::text, (case when mv.g like 'row:%' then null else mv.g end)::text, null::text, mv.by_name::text,
           mv.product_id, p.name::text, p.sku::text, mv.chs::text,
           mv.net_done::numeric, mv.d::date,
           (case when mv.n_out = 0 then '들어온 쪽만 있음'
                 when mv.n_in = 0 then '나간 쪽만 있음'
                 when mv.n_wait > 0 then '대기 섞임'
                 else '수량 합이 0 이 아님' end)::text,
           '{}'::text[],
           mv.g || ':' || coalesce(mv.product_id::text, '')
    from mv
    left join products p on p.id = mv.product_id
    where (p_kinds is null or 'move_unpaired' = any(p_kinds))
      and (mv.n_out = 0 or mv.n_in = 0 or mv.n_wait > 0 or mv.net_done <> 0)

    union all
    -- 세트 id 에 남은 원장 행
    select 'bundle_row'::text, null::text, null::text, null::text,
           t.product_id, p.name::text, p.sku::text, string_agg(distinct t.channel, '·')::text,
           coalesce(sum(t.qty) filter (where t.status = '완료'), 0)::numeric, max(t.txn_date)::date,
           (count(*)::text || '행')::text,
           '{}'::text[],
           t.product_id::text
    from inventory_txns t
    join is_bundle ib on ib.id = t.product_id
    left join products p on p.id = t.product_id
    where (p_kinds is null or 'bundle_row' = any(p_kinds))
    group by t.product_id, p.name, p.sku

    union all
    -- 7일 넘은 대기
    select 'old_pending'::text, t.id::text, null::text, t.partner::text,
           t.product_id, p.name::text, p.sku::text, t.channel::text,
           t.qty::numeric, t.txn_date::date,
           (t.type || case when exists (select 1 from production_receipts r where r.inv_txn_id = t.id)
                           then ' · 요청서 연결' else '' end)::text,
           '{}'::text[],
           t.id::text
    from inventory_txns t
    left join products p on p.id = t.product_id
    where (p_kinds is null or 'old_pending' = any(p_kinds))
      and t.status = '대기' and t.txn_date < p_today - 7

    union all
    -- 오늘 이후 날짜로 완료된 행(B2B 선점 제외)
    select 'future_done'::text, t.id::text, null::text, t.partner::text,
           t.product_id, p.name::text, p.sku::text, t.channel::text,
           t.qty::numeric, t.txn_date::date,
           (t.type || coalesce(' · ' || t.created_by, ''))::text,
           '{}'::text[],
           t.id::text
    from inventory_txns t
    left join products p on p.id = t.product_id
    where (p_kinds is null or 'future_done' = any(p_kinds))
      and t.status = '완료' and t.txn_date > p_today
      and coalesce(t.created_by, '') <> 'B2B 자동출고'

    union all
    -- 열린 프로모션 요청서가 없는 품목의 프로모션 재고
    select 'promo_stranded'::text, null::text, null::text, null::text,
           b.product_id, p.name::text, p.sku::text, b.channel::text,
           b.q::numeric, null::date,
           '열린 프로모션 요청서 없음'::text,
           '{}'::text[],
           b.product_id::text || ':' || coalesce(b.channel, '')
    from bal b
    left join products p on p.id = b.product_id
    where (p_kinds is null or 'promo_stranded' = any(p_kinds))
      and b.channel = '프로모션' and b.q > 0
      and not exists (
        select 1 from production_request_items i
        join production_requests r on r.id = i.request_id
        where i.product_id = b.product_id and r.purpose = '프로모션' and r.status in ('요청', '진행중'))

    union all
    -- 닫힌 프로모션 요청서인데 소매 합류가 끝났다는 표시가 없다(마감 도중 끊김 — 확보분이 프로모션 칸에 남았을 수 있다)
    select 'promo_unreleased'::text, r.id::text, r.req_no::text, null::text,
           null::uuid, null::text, null::text, '프로모션'::text,
           null::numeric, (r.updated_at at time zone 'Asia/Seoul')::date,
           (r.status || ' · 소매 합류 확인 안 됨')::text,
           '{}'::text[],
           r.id::text
    from pr_rel r
    where (p_kinds is null or 'promo_unreleased' = any(p_kinds))
      and (select h.c136 from has h)

    union all
    -- 오늘 기준 마이너스 재고
    select 'negative_balance'::text, null::text, null::text, null::text,
           b.product_id, p.name::text, p.sku::text, b.channel::text,
           b.q::numeric, null::date,
           (case when coalesce(p.active, true) then '' else '미사용 품목' end)::text,
           '{}'::text[],
           b.product_id::text || ':' || coalesce(b.channel, '')
    from bal b
    left join products p on p.id = b.product_id
    where (p_kinds is null or 'negative_balance' = any(p_kinds))
      and b.q < 0
      and not exists (select 1 from is_bundle ib where ib.id = b.product_id)
      and not exists (select 1 from untracked x where x.id = b.product_id)

    union all
    -- 미사용 품목에 남은 재고
    select 'inactive_balance'::text, null::text, null::text, null::text,
           b.product_id, p.name::text, p.sku::text, b.channel::text,
           b.q::numeric, null::date,
           '미사용'::text,
           '{}'::text[],
           b.product_id::text || ':' || coalesce(b.channel, '')
    from bal b
    join products p on p.id = b.product_id
    where (p_kinds is null or 'inactive_balance' = any(p_kinds))
      and p.active = false and b.q <> 0

    union all
    -- 재고 관리 안 함 품목에 남은 재고(미사용이면 위에서 이미 보인다)
    select 'untracked_balance'::text, null::text, null::text, null::text,
           b.product_id, p.name::text, p.sku::text, b.channel::text,
           b.q::numeric, null::date,
           '재고 관리 사용 안함'::text,
           '{}'::text[],
           b.product_id::text || ':' || coalesce(b.channel, '')
    from bal b
    join untracked x on x.id = b.product_id
    left join products p on p.id = b.product_id
    where (p_kinds is null or 'untracked_balance' = any(p_kinds))
      and b.q <> 0 and coalesce(p.active, true)

    union all
    -- 최근 21일 요청서에 연결 안 된 소매 입고(이동·고객 반품·B2B 제외) 중 같은 품목에 열린 제조사 요청서 잔여가 있는 것
    --  — 조기 납품을 연결 없이 넣으면 현재고와 입고 예정에 이중으로 잡혀 권장이 과소해진다(S9). 협의 생산분이면 그대로 둔다.
    select 'receipt_unlinked'::text, t.id::text, t.order_no::text, t.partner::text,
           t.product_id, p.name::text, p.sku::text, coalesce(t.channel, '소매')::text,
           t.qty::numeric, t.txn_date::date,
           ('열린 요청서 잔여 ' || trim_scale(round(o.rem::numeric, 2))::text || coalesce(' · ' || o.reqs, ''))::text,
           '{}'::text[],
           t.id::text
    from inventory_txns t
    join open_rem o on o.product_id = t.product_id
    left join tsrc s on s.id = t.id
    left join products p on p.id = t.product_id
    where (p_kinds is null or 'receipt_unlinked' = any(p_kinds))
      and t.type = '입고' and t.status = '완료' and coalesce(t.channel, '소매') = '소매'
      and t.shipment_id is null and t.reason is null
      and t.txn_date between p_today - 21 and p_today
      and coalesce(s.src, '') not in ('move', 'promo_close', 'customer_return')
      and (s.src is null and t.partner = '채널이동' and t.order_no is null) is not true
      and not exists (select 1 from production_receipts r where r.inv_txn_id = t.id)

    union all
    -- 같은 날 사유 '제조사 반품' 출고가 없는 제조사 반품(매입 결산만 깎이고 재고는 그대로 — 세트는 구성품 출고를 본다)
    select 'return_no_out'::text, r.id::text, null::text, r.partner::text,
           r.product_id, p.name::text, p.sku::text, '소매'::text,
           r.qty::numeric, r.return_date::date,
           '재고 출고 기록 없음'::text,
           '{}'::text[],
           r.id::text
    from purchase_returns r
    left join products p on p.id = r.product_id
    where (p_kinds is null or 'return_no_out' = any(p_kinds))
      and r.return_date >= greatest(date '2026-09-01', p_today - 90)
      and not exists (
        select 1 from inventory_txns t
        where t.type = '출고' and t.txn_date = r.return_date
          and (t.reason = '제조사 반품' or t.memo like '%제조사 반품%')
          and (t.product_id = r.product_id
               or exists (select 1 from bundle_leaf bl where bl.root = r.product_id and bl.leaf = t.product_id)))

    union all
    -- 제조사 반품 출고보다 먼저 입력된, 반품일(그날 포함) 뒤 같은 칸 실사가 있는 건 — 실사가 이미 반품을 반영했으면 이중 차감
    select 'return_after_count'::text, t.id::text, t.order_no::text, t.partner::text,
           t.product_id, p.name::text, p.sku::text, t.channel::text,
           t.qty::numeric, t.txn_date::date,
           ('반품일 ' || t.txn_date::text || ' · 그 뒤 실사 ' || a.d::text || '(반품 출고보다 먼저 입력)')::text,
           '{}'::text[],
           t.id::text
    from inventory_txns t
    join lateral (
      select max(x.txn_date) as d
      from inventory_txns x
      where x.product_id = t.product_id and x.type = '조정' and x.status = '완료'
        and x.channel is not distinct from t.channel
        and x.txn_date >= t.txn_date and x.created_at < t.created_at
    ) a on a.d is not null
    left join products p on p.id = t.product_id
    where (p_kinds is null or 'return_after_count' = any(p_kinds))
      and t.type = '출고' and t.status = '완료' and t.reason = '제조사 반품'
      and t.txn_date >= p_today - 90

    union all
    -- 매출 행이 없는 발송완료 발주
    select 'shipped_no_sales'::text, oi.id::text, oi.order_no::text, oi.company::text,
           null::uuid, null::text, null::text, null::text,
           (select coalesce(sum(greatest(0, x.qty - coalesce(cx.q, 0))), 0)
              from order_items x left join b2b_cx cx on cx.order_item_id = x.id where x.order_id = oi.id)::numeric,
           coalesce(oi.ship_date, oi.order_date)::date,
           '발송완료 · 매출 없음'::text,
           '{}'::text[],
           oi.id::text
    from ord_info oi
    where (p_kinds is null or 'shipped_no_sales' = any(p_kinds))
      and oi.status = '발송완료'
      and exists (select 1 from order_items x left join b2b_cx cx on cx.order_item_id = x.id
                   where x.order_id = oi.id and x.qty - coalesce(cx.q, 0) > 0)
      and not exists (select 1 from sales_orders so where so.upload_batch = 'b2b-' || oi.id::text)
      and not exists (select 1 from sales_orders so where so.channel = '도매' and so.order_id = oi.order_no)

    union all
    -- 발송완료가 아닌데 매출 행이 있는 발주
    select 'sales_not_shipped'::text, oi.id::text, oi.order_no::text, oi.company::text,
           null::uuid, null::text, null::text, null::text,
           sum(n.quantity)::numeric, min(n.order_date)::date,
           (oi.status || ' · 매출 ' || count(*)::text || '행')::text,
           '{}'::text[],
           oi.id::text
    from ns n
    join ord_info oi on oi.id = n.order_id
    where (p_kinds is null or 'sales_not_shipped' = any(p_kinds))
    group by oi.id, oi.order_no, oi.company, oi.status

    union all
    -- 발주가 지워졌는데 남은 B2B 매출 배치(b2b-<발주 id>) — 발주 링크가 없다
    select 'sales_not_shipped'::text, null::text, min(so.order_id)::text, null::text,
           null::uuid, null::text, null::text, null::text,
           sum(so.quantity)::numeric, min(so.order_date)::date,
           ('발주 삭제됨 · 매출 ' || count(*)::text || '행')::text,
           array['deleted']::text[],
           so.upload_batch::text
    from sales_orders so
    where (p_kinds is null or 'sales_not_shipped' = any(p_kinds))
      and so.upload_batch like 'b2b-%'
      and not exists (select 1 from orders o where 'b2b-' || o.id::text = so.upload_batch)
    group by so.upload_batch

    union all
    -- 오늘 이후 날짜의 매출 행(발송 예정일로 미리 발송완료한 도매 행, 업로드 연도 오타 등) — 채널·날짜별
    select 'sales_future'::text, null::text, null::text, so.channel::text,
           null::uuid, null::text, null::text, null::text,
           sum(so.quantity)::numeric, so.order_date::date,
           (count(*)::text || '행 · ' || to_char(coalesce(sum(so.subtotal_amount), 0), 'FM999,999,999,990') || '원')::text,
           (case when so.channel = '도매' then array['b2b'] else '{}' end)::text[],
           coalesce(so.channel, '') || ':' || so.order_date::text
    from sales_orders so
    where (p_kinds is null or 'sales_future' = any(p_kinds))
      and so.order_date > p_today
    group by so.channel, so.order_date

    union all
    -- 칸이 없어(마이그레이션 미적용) 확인하지 못한 항목 — 화면이 '0건' 대신 '확인 못 함'을 보인다
    select '_unavailable'::text, v.k::text, null::text, null::text,
           null::uuid, null::text, null::text, null::text,
           null::numeric, null::date, v.mig::text, '{}'::text[], v.k::text
    from has h
    cross join lateral (values
      ('b2b_kept_orphan', h.c131, '131'),
      ('fulfill_late_orphan', h.c131, '131'),
      ('fulfill_unmatched', h.c135d, '135'),
      ('fulfill_not_dispatched', h.c135k, '135'),
      ('promo_unreleased', h.c136, '136')
    ) as v(k, ok, mig)
    where not v.ok and (p_kinds is null or v.k = any(p_kinds))

    union all
    -- 이 판의 함수라는 표시(앱이 옛 132 함수와 구분 — 새 항목을 '0건'으로 보이지 않게)
    select '_meta'::text, 'v5'::text, null::text, null::text,
           null::uuid, null::text, null::text, null::text,
           null::numeric, null::date, null::text, '{}'::text[], 'v5'::text
  )
  select row_number() over (order by u.kind, u.txn_date desc nulls last, u.ref_id nulls last, u.product_id nulls last,
                                     u.channel nulls last, u.tie nulls last)::bigint,
         u.kind, u.ref_id, u.ref_no, u.partner, u.product_id, u.product_name, u.sku, u.channel, u.qty, u.txn_date, u.detail, u.tags
  from u;
$$;

-- 서버(서비스 롤)만 부른다 — 거래처·주문번호가 담겨 있다
revoke all on function inventory_ledger_check(date, text[], uuid[]) from public, anon, authenticated;
grant execute on function inventory_ledger_check(date, text[], uuid[]) to service_role;

notify pgrst, 'reload schema';
