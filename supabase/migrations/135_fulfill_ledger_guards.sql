-- 135 온라인 발주(택배 출고) 원장 안전장치 (2026-10-11 원장 기준 점검 — docs/ledger-standard.md S2·S3·S7·S9·S12)
--
-- ■ 왜
--   ① ④ 상품 출고 때 상품마스터에 없는(또는 중복) 코드는 재고를 빼지 않은 채 '완료'됐고, 그 목록이 어디에도 남지 않았다(S9).
--   ② '이미 처리된 주문' 확인이 파일 분석 때만 있어, 두 탭·두 담당자가 겹치는 파일을 차례로 출고하면 같은 주문이
--      두 번 차감됐다(S2). 출고 커밋 때 '현재 판정 기준 키'로 다시 확인하려면 그 키를 따로 보관해야 한다.
--   ③ CN 파일을 받고 ④ 출고를 누르지 않으면 흔적이 없어 실사 때까지 장부가 부풀었다(S12).
--   ④ 출고 배치를 [입고 및 출고]에서 취소해도 처리완료 주문 키·출고 이력이 남아, 고친 파일을 다시 올리면
--      그 주문이 '이미 처리된 주문'으로 빠졌다(S7). 재고 행·키·이력을 한 번에 지워야 한다(S3).
--
-- ■ 바뀌는 것
--   fulfill_dispatch.unmatched          재고가 빠지지 않은 코드·수량 [{sku, qty, kind}] (kind = unmatched 미등록 / ambiguous 중복)
--   fulfill_dispatch.unmatched_done_at  그 목록을 처리한 시각(나중에 [재고 차감 기록] 또는 [확인 완료])
--   fulfill_pending_keys.match_keys     현재 판정 기준 주문 키(주문당 1개) — ④ 출고 커밋 때 재확인용
--   fulfill_pending_keys.file_name / order_count / total_qty / downloaded_at / discarded_at
--                                       'CN 파일을 받았지만 출고 완료 안 한 배치' 표시용
--   fulfill_order_keys.group_id         그 키를 등록한 출고 배치(inventory_txns.group_id) — 배치 취소 때 함께 지운다
--   fulfill_dispatch.keys               그 배치가 출고한 주문 키(두 산식, 겹침 허용으로 다른 배치가 먼저 등록한 키 포함)
--   cancel_fulfill_dispatch(p_group)    출고 배치 취소 = 재고 행 + 그 배치의 [재고 차감 기록](미반영분 늦은 출고) +
--                                       그 배치가 등록한 처리완료 키 + 출고 이력을 한 트랜잭션으로 삭제
--     (늦은 출고 = inventory_txns.source 'fulfill_unmatched' · source_ref = 출고 이력 id, 131. 남기면 고친 파일을 다시
--      출고할 때 그 코드가 또 차감된다. 131 미적용이면 그 칸이 없어 건너뛴다 — 화면은 131 전엔 늦은 출고를 기록하지 않는다.)
--     키 중 아직 살아 있는 다른 배치도 출고한 주문의 것은 지우지 않고 그 배치로 넘긴다(아래 함수 설명). 지우면 그 배치가
--     실제로 보내고 차감한 주문이 다음 누적 파일에 '새 주문'으로 실려 다시 발송·차감된다(경고 없음).
--
-- 미적용이어도 앱은 동작한다(칸 없이 저장 · 커밋 재확인 생략 · 취소는 순서대로 지움).
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.
--       (10-11 수정: 늦은 출고도 함께 취소 — 이 파일을 이미 적용했으면 한 번 더 Run. 함수만 바뀐다.)
--       (10-11 2차 수정: fulfill_dispatch.keys 칸 + 취소 때 다른 배치가 출고한 주문 키 넘김 — 이미 적용했으면 한 번 더 Run.
--        칸·색인 추가와 함수 교체뿐, 기존 데이터는 바뀌지 않는다. 다시 Run 한 뒤의 출고부터 keys 가 쌓인다.)

alter table public.fulfill_dispatch add column if not exists unmatched jsonb;
alter table public.fulfill_dispatch add column if not exists unmatched_done_at timestamptz;
comment on column public.fulfill_dispatch.unmatched is '④ 출고 때 재고를 빼지 못한 코드 [{sku, qty, kind}] — 미등록(unmatched)·중복(ambiguous)';
comment on column public.fulfill_dispatch.unmatched_done_at is 'unmatched 목록 처리 시각(차감 기록 또는 확인 완료) — null = 미처리';
create index if not exists fulfill_dispatch_group_idx on public.fulfill_dispatch (group_id);
alter table public.fulfill_dispatch add column if not exists keys jsonb;
comment on column public.fulfill_dispatch.keys is '이 배치가 출고한 주문 키(두 산식) — 배치 취소 때 다른 배치도 출고한 주문의 처리완료 키를 그 배치로 넘기는 근거';
create index if not exists fulfill_dispatch_keys_gin on public.fulfill_dispatch using gin (keys);

alter table public.fulfill_pending_keys add column if not exists match_keys jsonb;
alter table public.fulfill_pending_keys add column if not exists file_name text;
alter table public.fulfill_pending_keys add column if not exists order_count integer;
alter table public.fulfill_pending_keys add column if not exists total_qty numeric;
alter table public.fulfill_pending_keys add column if not exists downloaded_at timestamptz;
alter table public.fulfill_pending_keys add column if not exists discarded_at timestamptz;
comment on column public.fulfill_pending_keys.match_keys is '현재 판정 기준 주문 키(주문당 1개) — 출고 커밋 때 이미 처리된 주문과 겹치는지 재확인';
comment on column public.fulfill_pending_keys.downloaded_at is 'CN 파일 다운로드 시각 — 출고 완료(행 삭제)나 폐기 전까지 미출고 배치로 표시';
comment on column public.fulfill_pending_keys.discarded_at is '[발송 안 함] 처리 시각 — 미출고 배치 목록에서 뺀다';

alter table public.fulfill_order_keys add column if not exists group_id uuid;
comment on column public.fulfill_order_keys.group_id is '이 키를 등록한 출고 배치(inventory_txns.group_id) — 배치 취소 때 함께 삭제';
create index if not exists fulfill_order_keys_group_idx on public.fulfill_order_keys (group_id);

-- 출고 배치 취소 — 재고 행이 하나도 없으면(이미 취소됨) 아무것도 지우지 않고 0. 반환 = 지운 재고 행 수(늦은 출고 포함).
--  키는 이 배치가 등록한 것만(group_id). 135 전에 등록된 키는 group_id 가 비어 있어 출고번호(order_no)로 찾는다.
--  다른 배치가 먼저 등록한 키(ignoreDuplicates 로 소유가 안 바뀐 것)는 남는다 — 그 주문은 그 배치로 처리된 것이 맞다.
--  이 배치 키라도 다른 배치가 같은 주문을 출고했으면 지우지 않고 그 배치로 넘긴다(소유 이전):
--   ① 같은 서명(배치 서명에 주문 키 집합이 섞여 있어 같은 서명 = 같은 주문)의 다른 배치 — 키 전부를 그 배치로.
--      출고 이력이 남은 배치(재고 행이 있거나 품목 0 = 처리완료로 둔 배치)를 먼저, 없으면 출고 이력 행 없이 재고 행만 있는
--      배치(같은 날 다시 출고 — 이력 유니크(sig, 날짜)에 막혀 행이 없다, 131 source_ref = 서명), 그다음 중단된 출고.
--      출고 이력이 없는 배치를 취소할 때는 재고 행의 source_ref(131)로 서명을 찾는다.
--   ② 서명이 다른 배치(겹침 확인 뒤 출고) — 그 배치 출고 이력의 keys 에 있는 키만 그 배치로(가장 최근, 살아 있는 배치 먼저).
--      keys 칸이 생기기 전 출고는 근거가 없어 종전대로 지운다.
--  넘길 곳이 없는 키만 지운다.
create or replace function public.cancel_fulfill_dispatch(p_group uuid)
returns integer
language plpgsql
as $$
declare
  v_order text;
  v_sig text;
  v_n integer;
  v_late integer := 0;
  v_src boolean;
  v_keys text[];
  v_heir uuid;
  v_heir_order text;
  v_heir_live boolean;
  v_alt uuid;
  v_alt_order text;
begin
  -- 취소 두 건이 동시에 돌면 서로를 '넘길 배치'로 보고 키를 넘긴 채 둘 다 지워질 수 있다 — 취소는 한 번에 하나씩
  perform pg_advisory_xact_lock(hashtext('public.cancel_fulfill_dispatch'));
  v_src := exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = 'inventory_txns' and column_name = 'source_ref');
  select order_no, sig into v_order, v_sig from public.fulfill_dispatch where group_id = p_group order by created_at limit 1;
  if v_sig is null and v_src then
    execute 'select source_ref from public.inventory_txns where group_id = $1 and source = $2 and source_ref is not null limit 1'
      into v_sig using p_group, 'fulfill';
  end if;
  delete from public.inventory_txns where group_id = p_group;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return 0;
  end if;
  -- 이 배치의 늦은 출고([재고 차감 기록]) — 출고 이력 행을 지우기 전에(참조가 그 id). source 칸(131)이 있을 때만.
  if v_src then
    execute 'delete from public.inventory_txns
              where source = $1
                and source_ref in (select d.id::text from public.fulfill_dispatch d where d.group_id = $2)'
      using 'fulfill_unmatched', p_group;
    get diagnostics v_late = row_count;
  end if;

  select coalesce(array_agg(k.key), '{}'::text[]) into v_keys
    from public.fulfill_order_keys k
   where k.group_id = p_group
      or (k.group_id is null and v_order is not null and k.order_no = v_order);

  if cardinality(v_keys) > 0 then
    -- ① 같은 서명의 다른 배치
    if v_sig is not null then
      select h.group_id, h.order_no, h.live into v_heir, v_heir_order, v_heir_live
        from (select d.group_id, d.order_no, d.created_at,
                     (d.sku_count = 0 or exists (select 1 from public.inventory_txns t where t.group_id = d.group_id)) as live
                from public.fulfill_dispatch d
               where d.sig = v_sig and d.group_id is not null and d.group_id <> p_group) h
       order by h.live desc, h.created_at desc
       limit 1;
      if (v_heir is null or not v_heir_live) and v_src then
        execute 'select group_id, order_no from public.inventory_txns
                  where source = $1 and source_ref = $2 and group_id is not null and group_id <> $3
                  order by created_at desc limit 1'
          into v_alt, v_alt_order using 'fulfill', v_sig, p_group;
        if v_alt is not null then
          v_heir := v_alt;
          v_heir_order := v_alt_order;
        end if;
      end if;
    end if;
    if v_heir is not null then
      update public.fulfill_order_keys
         set group_id = v_heir, order_no = coalesce(v_heir_order, order_no)
       where key = any(v_keys);
    else
      -- ② 서명이 다른 배치 — 그 출고 이력 keys 에 있는 키만
      update public.fulfill_order_keys k
         set group_id = h.group_id,
             order_no = coalesce(h.order_no, k.order_no),
             processed_at = greatest(k.processed_at, h.created_at)
        from (select distinct on (e.key) e.key, d.group_id, d.order_no, d.created_at
                from public.fulfill_dispatch d
                cross join lateral jsonb_array_elements_text(
                       case when jsonb_typeof(d.keys) = 'array' then d.keys else '[]'::jsonb end) as e(key)
               where d.keys ?| v_keys
                 and d.group_id is not null and d.group_id <> p_group
                 and e.key = any(v_keys)
               order by e.key,
                        (d.sku_count = 0 or exists (select 1 from public.inventory_txns t where t.group_id = d.group_id)) desc,
                        d.created_at desc) h
       where k.key = h.key;
    end if;
    -- 넘기지 못한(이 배치만 출고한) 키
    delete from public.fulfill_order_keys
     where key = any(v_keys)
       and (group_id = p_group or (group_id is null and v_order is not null and order_no = v_order));
  end if;
  delete from public.fulfill_dispatch where group_id = p_group;
  return v_n + v_late;
end;
$$;

revoke all on function public.cancel_fulfill_dispatch(uuid) from public;
revoke all on function public.cancel_fulfill_dispatch(uuid) from anon;
revoke all on function public.cancel_fulfill_dispatch(uuid) from authenticated;
grant execute on function public.cancel_fulfill_dispatch(uuid) to service_role;  -- 서버(서비스키)만 호출

notify pgrst, 'reload schema';
