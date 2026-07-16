-- SKU 유일화: products.sku 에 대소문자 무시(upper) 기준 유니크 인덱스.
--   014 가 UNIQUE 를 제거했던 이유(업체별 단가용 제품 복제)는 070 company_product_prices 가 대체 완료.
--   현재 중복은 대부분 '같은 제품의 재등록 쌍'(신명칭+실가격 / 구명칭+0원 스텁)으로 확인됨.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.
--   ※ 코드(중복 시 안내 메시지·복사하기 SKU 비우기)가 먼저 배포된 뒤 적용할 것.
--   ※ 이 스크립트는 위험한 형상(대소문자 변형 중복·묶음 정의행 강등·-DUP 충돌)을 만나면
--      RAISE EXCEPTION 으로 '조용한 손상 대신 즉시 중단'한다. 중단되면 담당자에게 문의.

-- ── 사전 점검(선택) — 실행 전 현황을 보고 싶으면 이 쿼리만 따로 돌려보세요.
-- select upper(sku) as sku_u, count(*) n,
--        array_agg(sku)  as skus,       -- 대소문자 변형 여부 확인용
--        array_agg(name) as names,
--        array_agg(id)   as ids
--   from products where sku is not null and sku <> ''
--  group by 1 having count(*) > 1 order by 1;

do $$
declare
  bad_case   int;
  bad_bundle int;
  bad_dup    int;
begin
  -- (1) 같은 upper(sku) 그룹 안에서 sku 표기(대소문자)가 서로 다른 경우.
  --     매출이익 RPC(044~052)의 조인 pr.sku = o.sku_code 는 대소문자 구분이라
  --     한쪽을 개명하면 그 표기로 들어온 판매행의 원가 매칭이 끊긴다 → 수동 정리 필요.
  select count(*) into bad_case from (
    select 1 from products
     where sku is not null and sku <> ''
     group by upper(sku)
    having count(*) > 1 and count(distinct sku) > 1
  ) t;
  if bad_case > 0 then
    raise exception '중단: 대소문자만 다른 중복 SKU 그룹 %건이 있습니다. 개명 시 매출 원가 매칭이 끊깁니다. 먼저 표기를 통일하세요.', bad_case;
  end if;

  -- (2) 강등 예정(대표 아님) 행이 묶음(product_bundles) 부모/구성품으로 쓰이는 경우.
  --     개명하면 세트 전개가 끊긴다 → 대표행으로 재지정 후 수동 진행 필요.
  with ranked as (
    select id,
           row_number() over (
             partition by upper(sku)
             order by active desc, (sale_price > 0) desc, updated_at desc nulls last, id
           ) as rn
    from products
    where sku is not null and sku <> ''
  )
  select count(*) into bad_bundle
    from ranked r
   where r.rn > 1
     and (
       exists (select 1 from product_bundles b where b.parent_id = r.id)
       or exists (select 1 from product_bundles b where b.component_id = r.id)
     );
  if bad_bundle > 0 then
    raise exception '중단: 강등 예정 행 %건이 묶음(세트) 정의에 쓰이고 있습니다. 묶음을 대표행으로 옮긴 뒤 다시 실행하세요.', bad_bundle;
  end if;

  -- (3) 개명 결과 '-DUP{n}' 가 기존 SKU 와 2차 충돌하는 경우(upper 기준).
  with ranked as (
    select id, sku,
           row_number() over (
             partition by upper(sku)
             order by active desc, (sale_price > 0) desc, updated_at desc nulls last, id
           ) as rn
    from products
    where sku is not null and sku <> ''
  ),
  renamed as (
    select upper(sku || '-DUP' || (rn - 1)) as new_u
    from ranked where rn > 1
  )
  select count(*) into bad_dup
    from renamed rn2
   where exists (select 1 from products p where p.sku is not null and p.sku <> '' and upper(p.sku) = rn2.new_u)
      or (select count(*) from renamed x where x.new_u = rn2.new_u) > 1;
  if bad_dup > 0 then
    raise exception '중단: 개명 결과(-DUP)가 기존 SKU 와 충돌합니다(%건). 해당 행을 수동 개명 후 다시 실행하세요.', bad_dup;
  end if;
end $$;

-- 1) 기존 중복 정리 — upper(sku) 그룹마다 대표 1행만 남기고, 잉여 행은 SKU 에 '-DUP{n}' 을
--    붙여 충돌만 해소하고 비활성 처리(삭제 금지 — inventory_txns FK 가 cascade 라 이력 소실 위험).
--    대표 선정: 사용중 > 도매가 있음 > 최근 수정. (위 가드가 통과했으므로 안전.)
with ranked as (
  select id, sku,
         row_number() over (
           partition by upper(sku)
           order by active desc, (sale_price > 0) desc, updated_at desc nulls last, id
         ) as rn
  from products
  where sku is not null and sku <> ''
)
update products p
set sku = p.sku || '-DUP' || (r.rn - 1), active = false
from ranked r
where r.id = p.id and r.rn > 1;

-- 2) upper(sku) 유니크 인덱스 (앱의 toUpperCase 병합 로직과 같은 축).
--    null·빈문자 SKU 는 여러 행 허용(partial). 위반 시 에러코드 23505 — API 가 409 로 안내.
create unique index if not exists products_sku_upper_key
  on products (upper(sku))
  where sku is not null and sku <> '';

-- 3) 기존 비유일 인덱스 products_sku_idx(014)는 유지 — 매출이익 RPC(044~052)의
--    대소문자 구분 조인(pr.sku = o.sku_code)이 사용.

NOTIFY pgrst, 'reload schema';
