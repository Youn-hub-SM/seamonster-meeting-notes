-- 131 재고 원장 '정확히 한 번' · 출처 칸 · 세트 구성 한 번에 교체 · 품목 삭제 보호 (2026-10-11, docs/ledger-standard.md S2·S3·S4·S11)
--
-- ■ 왜
--   ① 입출고 단건·엑셀/구매 일괄 반영·재고 이동은 원장 insert 를 먼저 커밋하고 요청서 연결·알림을 기다린다.
--      그 사이 응답이 끊기면(시간 초과·네트워크) 화면은 '실패'를 띄우고 입력을 남겨 두어, 다시 누르면 같은 기록이
--      새 주문번호로 한 벌 더 들어갔다(재고 2배·요청서 이행 2배·자동 마감). inventory_txns 에는 이를 막는 유니크가 없었다(S2).
--      → 화면이 제출마다 요청 키를 만들고 재시도에도 같은 키를 보낸다. 서버는 행마다 request_key='<키>:<순번>' 을 넣고,
--        두 번째 insert 는 아래 유니크로 23505 가 나 아무 행도 안 들어간다(다행 insert 는 한 문장 = 전부 또는 전무).
--        서버는 그때 기존 행을 읽어 '이미 반영됨'으로 같은 결과를 돌려준다.
--   ② 행의 출처를 partner '채널이동'·memo 문구·created_by 로 판정해 왔다(사람이 같은 글자를 적으면 판정이 틀어진다, S11).
--      → source(어디서 생긴 행인가)·source_ref(그 출처의 참조 id) 칸을 두고 서버만 채운다.
--        값: manual(입고·출고·조정 단건) · import(엑셀·구매 및 판매 일괄) · move(재고 이동) · promo_close(프로모션 마감·취소 합류)
--            · b2b_ship / b2b_cancel_kept(B2B 발송 선점 / 발송 뒤 취소했지만 안 돌아온 출고) · fulfill(온라인 출고) 등
--            — 각 경로가 자기 값을 쓴다. null = 이 마이그레이션 전 기록(백필 대상이 아닌 것).
--   ③ 세트 구성 교체가 '전부 삭제 → 다시 넣기' 두 문장이라, 넣기가 실패하면(같은 구성품 두 줄 = PK 위반 등) 세트가
--      구성 0개 = 일반 품목이 되어 이후 세트 출고가 세트 id 로 기록되고 구성품은 안 빠졌다(S3).
--      → replace_bundle() 한 함수(= 한 트랜잭션)에서 검증·순환 검사·삭제·넣기를 끝낸다. 실패하면 기존 구성이 그대로 남는다.
--   ④ inventory_txns.product_id 가 on delete cascade(031)라 품목을 지우면 입출고 이력 전체가 조용히 사라졌다.
--      삭제 API 의 사전 검사는 조회 실패 시 통과했다(S4). 제조사 반품(087)도 같은 cascade.
--      → restrict — 원장·반품 기록이 있는 품목은 DB 가 삭제를 거부한다(화면은 '미사용 처리'를 안내).
--
-- ■ 바뀌는 것
--   inventory_txns: request_key·source·source_ref 칸 추가, request_key 부분 유니크 인덱스(null 은 제한 없음 — 옛 기록·다른 경로 그대로)
--   source 백필(판정이 확실한 것만): partner='채널이동' → move / promo_close(메모가 '프로모션 마감|취소' 또는 옛 크론 '행사 종료 자동 합류'),
--     shipment_id 있음 → b2b_ship(source_ref=발주 id). 그 밖의 옛 행은 null 로 둔다(코드는 null 이면 종전 판정으로 폴백).
--   replace_bundle(p_parent uuid, p_rows jsonb) → integer(넣은 구성 수). 서비스 키만 실행.
--   FK inventory_txns.product_id · purchase_returns.product_id: cascade → restrict
--
-- ■ 적용
--   Supabase Dashboard > SQL Editor 에 이 파일 하나만 붙여넣고 Run. 멱등(재실행 안전 — 백필은 source 가 빈 행만, FK 는 지우고 다시 건다).
--   미적용이어도 앱은 동작한다: 새 칸이 없으면 빼고 다시 넣고(중복 방지 없이 종전 동작), 세트 교체는 upsert → 빠진 구성 삭제 순서로 폴백.

-- ① 요청 키 · ② 출처 ------------------------------------------------------------
alter table public.inventory_txns add column if not exists request_key text;
alter table public.inventory_txns add column if not exists source text;
alter table public.inventory_txns add column if not exists source_ref text;
comment on column public.inventory_txns.request_key is '중복 방지 키 — <화면 제출 키>:<순번>. 같은 키의 두 번째 기록은 유니크로 거부된다(재시도·더블클릭).';
comment on column public.inventory_txns.source is '행 출처(서버만 기록): manual·import·move·promo_close·b2b_ship·b2b_cancel_kept·fulfill 등. null = 131 이전 기록';
comment on column public.inventory_txns.source_ref is '출처 참조 id — move=group_id, promo_close=요청서 id, b2b_ship=발주 id, manual/import=주문번호, fulfill=출고 서명 등';

create unique index if not exists inv_txn_request_key_uniq
  on public.inventory_txns (request_key) where request_key is not null;
create index if not exists inv_txn_source_idx
  on public.inventory_txns (source) where source is not null;

-- 백필 — 판정이 확실한 것만(재실행 시 이미 채운 행은 건드리지 않는다). 값·참조는 각 경로가 새로 쓰는 것과 같게:
--   재고 이동 = move · group_id / 프로모션 마감·취소 합류 = promo_close · 요청서 id(메모의 요청번호로 찾음, 못 찾으면 null)
--   B2B 발송 선점 = b2b_ship · 발주 id(b2b-shipments B2B_SHIP_SOURCE)
update public.inventory_txns t
   set source = 'promo_close',
       source_ref = coalesce(t.source_ref, (
         select r.id::text from public.production_requests r
          where r.req_no = substring(t.memo from '^프로모션 (?:마감|취소) · (.+)$')
          limit 1))
 where t.source is null and t.partner = '채널이동' and t.order_no is null
   and (t.memo ~ '^프로모션 (마감|취소)' or t.memo = '행사 종료 자동 합류');

--  주문번호가 있는 '채널이동' 행은 사람이 거래처 칸에 그 글자를 적은 입출고다(이동·합류에는 주문번호가 없다) — 이동으로 백필하지 않는다
update public.inventory_txns
   set source = 'move', source_ref = coalesce(source_ref, group_id::text)
 where source is null and partner = '채널이동' and order_no is null;

update public.inventory_txns t
   set source = 'b2b_ship', source_ref = coalesce(t.source_ref, s.order_id::text)
  from public.shipments s
 where t.source is null and t.shipment_id = s.id;

-- ③ 세트 구성 한 번에 교체 --------------------------------------------------------
--  p_rows = [{"component_id": uuid, "qty": 양의 정수}, ...]. 빈 배열이면 구성 전체 삭제(세트 해제).
--  오류 코드(메시지 앞머리 — 앱이 안내문으로 바꾼다):
--    BUNDLE_PARENT_REQUIRED · BUNDLE_COMPONENT_REQUIRED · BUNDLE_SELF · BUNDLE_DUPLICATE · BUNDLE_CYCLE
--  동시 교체 두 건이 각자 순환 검사를 통과하고 합치면 순환이 되는 경합을 막으려 트랜잭션 잠금으로 직렬화한다.
create or replace function public.replace_bundle(p_parent uuid, p_rows jsonb)
returns integer
language plpgsql
as $$
declare
  v_rows jsonb := coalesce(p_rows, '[]'::jsonb);
  v_dup  uuid;
  n      integer := 0;
begin
  if p_parent is null then raise exception 'BUNDLE_PARENT_REQUIRED'; end if;
  if jsonb_typeof(v_rows) <> 'array' then raise exception 'BUNDLE_COMPONENT_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtext('public.product_bundles:replace'));

  if exists (select 1 from jsonb_array_elements(v_rows) e where coalesce(e->>'component_id', '') = '') then
    raise exception 'BUNDLE_COMPONENT_REQUIRED';
  end if;
  if exists (select 1 from jsonb_array_elements(v_rows) e where (e->>'component_id')::uuid = p_parent) then
    raise exception 'BUNDLE_SELF';
  end if;
  select (e->>'component_id')::uuid into v_dup
    from jsonb_array_elements(v_rows) e
   group by (e->>'component_id')::uuid having count(*) > 1 limit 1;
  if v_dup is not null then raise exception 'BUNDLE_DUPLICATE %', v_dup; end if;

  -- 순환: 새 구성품에서 출발해 (이 세트의 옛 구성을 뺀) 기존 간선을 따라가다 이 세트에 닿으면 순환.
  --  union(중복 제거)이라 다른 곳에 이미 있는 순환에서도 끝난다.
  if exists (
    with recursive reach(id) as (
      select (e->>'component_id')::uuid from jsonb_array_elements(v_rows) e
      union
      select pb.component_id
        from public.product_bundles pb
        join reach r on pb.parent_id = r.id
       where pb.parent_id <> p_parent
    )
    select 1 from reach where id = p_parent
  ) then
    raise exception 'BUNDLE_CYCLE';
  end if;

  delete from public.product_bundles where parent_id = p_parent;
  insert into public.product_bundles (parent_id, component_id, qty)
  select p_parent, (e->>'component_id')::uuid, greatest(1, round(coalesce(nullif(e->>'qty', '')::numeric, 1)))::integer
    from jsonb_array_elements(v_rows) e;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.replace_bundle(uuid, jsonb) from public;
revoke all on function public.replace_bundle(uuid, jsonb) from anon;
revoke all on function public.replace_bundle(uuid, jsonb) from authenticated;
grant execute on function public.replace_bundle(uuid, jsonb) to service_role;

-- ④ 품목 삭제가 원장·반품을 지우지 못하게 ------------------------------------------
do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.inventory_txns'::regclass and contype = 'f' and confrelid = 'public.products'::regclass
  loop
    execute format('alter table public.inventory_txns drop constraint %I', c);
  end loop;
  alter table public.inventory_txns
    add constraint inventory_txns_product_id_fkey foreign key (product_id) references public.products(id) on delete restrict;

  if to_regclass('public.purchase_returns') is not null then
    for c in
      select conname from pg_constraint
       where conrelid = 'public.purchase_returns'::regclass and contype = 'f' and confrelid = 'public.products'::regclass
    loop
      execute format('alter table public.purchase_returns drop constraint %I', c);
    end loop;
    alter table public.purchase_returns
      add constraint purchase_returns_product_id_fkey foreign key (product_id) references public.products(id) on delete restrict;
  end if;
end $$;

notify pgrst, 'reload schema';
