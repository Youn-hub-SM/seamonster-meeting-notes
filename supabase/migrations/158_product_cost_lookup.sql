-- 158 product_cost_lookup 뷰 — 관리코드(sales_orders.sku_code) 한 줄로 원가·중량·상품명을 찾는 단일 조회 지점(2026-10-30)
--
--  배경: 2026-10-30 비서가 "톡스토어 10월 주문·SKU별 원가" 파일을 만들며 products 를 손으로 조인했는데, TD_ 접두를 '떼고만' 조인해
--        TD_ 이름으로만 등록된 세트 6종(TD_P_*-100X1+100, 545행·매출 1,785만 원)의 원가가 비었다. 이익 함수(157)는
--        정확 일치 → TD_ 뗀 코드 순으로 찾고 세트는 구성품 합을 쓰는데, 그 규칙을 질문마다 다시 쓰게 하면 또 어긋난다.
--  해결: 그 규칙을 뷰 한 장에 담는다. 비서·화면·루커 어디서든 `join product_cost_lookup l on l.sku_code = o.sku_code` 한 줄이면 끝.
--        - 정확 일치 행: 상품마스터 sku 그대로. 세트(product_bundles)는 구성품 원가·중량 합. TD_ 로 시작하는 행이 원가·중량 0 이면
--          TD_ 뗀 코드 값으로 보충(157 과 같은 nullif 폴백).
--        - 별칭 행: 상품마스터에 'TD_'||sku 가 없을 때만 'TD_'||sku 를 한 줄 더 만든다(톡딜 주문이 기본 코드 앞에 TD_ 를 붙여 오므로).
--        sku_code 는 뷰 안에서 유일하다(정확 행은 sku 유니크(073), 별칭 행은 정확 행이 없을 때만 생성).
--  범위 밖: 상품마스터에 아예 없는 코드는 뷰에도 없다(조인하면 null) — 채널별 이익 화면의 '미매칭 SKU' 카드가 그 목록이다.
--  읽기 전용 뷰라 호출·CPU 부담 없음. 멱등 — 재실행 안전.

create or replace view product_cost_lookup as
with prod as (
  select distinct on (sku) id, sku, name, cost_price, volume_kg
  from products where sku is not null and sku <> '' order by sku, updated_at desc
),
comp as (
  select pp.sku as parent_sku,
    sum(c.cost_price * pb.qty) as cost,
    case when bool_or(c.volume_kg is null) then null else sum(c.volume_kg * pb.qty) end as weight,
    count(*) as n
  from product_bundles pb
  join products pp on pp.id = pb.parent_id
  join products c  on c.id  = pb.component_id
  group by pp.sku
),
resolved as (
  select p.sku, p.name,
    cm.parent_sku is not null as is_bundle,
    case when cm.parent_sku is not null then cm.cost   else p.cost_price end as cost,
    case when cm.parent_sku is not null then cm.weight else p.volume_kg  end as weight
  from prod p left join comp cm on cm.parent_sku = p.sku
),
exact as (
  select r.sku as sku_code, r.sku as product_sku, r.name, r.is_bundle,
    coalesce(nullif(r.cost, 0),   nullif(b.cost, 0))   as cost,
    coalesce(nullif(r.weight, 0), nullif(b.weight, 0)) as weight,
    case when coalesce(r.cost, 0) = 0 and coalesce(b.cost, 0) > 0 then 'TD_ 뗀 코드 원가로 보충' else '정확 일치' end as matched_by
  from resolved r
  left join resolved b on r.sku like 'TD\_%' and b.sku = substr(r.sku, 4)
),
alias as (
  select 'TD_' || r.sku as sku_code, r.sku as product_sku, r.name, r.is_bundle,
    nullif(r.cost, 0) as cost, nullif(r.weight, 0) as weight, 'TD_ 접두 제거' as matched_by
  from resolved r
  where r.sku not like 'TD\_%'
    and not exists (select 1 from resolved x where x.sku = 'TD_' || r.sku)
)
select * from exact
union all
select * from alias;

comment on view product_cost_lookup is '관리코드(매출 sku_code) → 상품마스터 원가·중량·상품명. 세트는 구성품 합, 톡딜 TD_ 접두는 정확 일치 우선·없으면 뗀 코드(157 과 같은 규칙). 행 단위 원가는 products 를 손으로 조인하지 말고 이 뷰를 sku_code 로 조인한다(158).';
comment on column product_cost_lookup.sku_code    is '매출 관리코드(sales_orders.sku_code)와 그대로 조인하는 키. 뷰 안에서 유일.';
comment on column product_cost_lookup.product_sku is '실제 상품마스터 sku(별칭 행은 TD_ 뗀 코드).';
comment on column product_cost_lookup.name        is '상품마스터 품목명.';
comment on column product_cost_lookup.is_bundle   is '세트(묶음) 여부 — true 면 cost·weight 는 구성품 합.';
comment on column product_cost_lookup.cost        is '단위 원가(원). 세트는 구성품 원가 합. 0 은 null 로 둔다(미입력).';
comment on column product_cost_lookup.weight      is '단위 중량(kg). 세트는 구성품 합. 구성품 하나라도 중량이 없으면 null.';
comment on column product_cost_lookup.matched_by  is '정확 일치 / TD_ 접두 제거 / TD_ 뗀 코드 원가로 보충.';

notify pgrst, 'reload schema';
