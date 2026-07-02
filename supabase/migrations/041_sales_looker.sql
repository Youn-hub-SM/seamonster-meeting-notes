-- 041 Looker Studio 연동용 읽기전용 접근.
--  · sales_looker: 매출 원장(sales_orders)에서 '분석에 필요한 컬럼만' 노출하는 뷰(내부컬럼 row_hash/id/source/upload_batch 제외).
--    sales_orders 자체가 PII(전화·이름) 없음 → Looker 노출 안전. sales_customers(PII)는 절대 노출 안 함.
--  · looker_ro: 읽기전용 로그인 역할. sales_looker 만 SELECT 가능(뷰는 소유자 권한으로 실행 = definer, security_invoker 미사용).
--    → looker_ro 는 다른 테이블/뷰를 볼 수 없음.
--  ⚠️ 비밀번호는 여기(깃)에 넣지 않습니다. 아래 [사용자 1회 설정] 참고.

create or replace view public.sales_looker as
  select
    order_date,                         -- 주문일자(정본 KST 기준일, 시계열 축)
    order_year,
    order_month,
    channel,                            -- 판매처
    order_id,                           -- 주문번호
    product_name,                       -- 상품명
    option_name,                        -- 옵션명
    sku_code,                           -- 관리코드(SKU, Top 집계축)
    quantity,                           -- 수량
    selling_price,                      -- 판매가
    option_price,                       -- 옵션가
    subtotal_amount,                    -- 결제금액(매출 합계축)
    shipping_fee,                       -- 배송비
    customer_key                        -- 고객 식별 해시(HMAC, PII 아님 · 재구매 분석용)
  from public.sales_orders;

-- 읽기전용 역할(없으면 생성). 비밀번호는 미설정 → 아래 사용자 설정 전엔 로그인 불가.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'looker_ro') then
    create role looker_ro login;
  end if;
end $$;

grant usage on schema public to looker_ro;
grant select on public.sales_looker to looker_ro;

-- [사용자 1회 설정 — SQL Editor에서 별도 실행, 깃에 커밋 금지]
--   alter role looker_ro with password '강한_무작위_비밀번호_16자이상';
-- 필요 시 회수: revoke select on public.sales_looker from looker_ro;

notify pgrst, 'reload schema';
