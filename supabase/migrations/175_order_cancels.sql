-- 175: 취소·반품 처리 — 취소 장부 + 매출 원장 반영 함수 (2026-11-20 대표 지시)
--
-- ■ 왜
--   소매 주문의 취소·반품이 매출 원장(sales_orders)에 반영되지 않았다 — 취소가 반영된 파일을 '기간 교체'로 다시 올려야만 빠졌다.
--   그래서 주문 횟수·누적 구매 금액(오디언스 추출·리포트)에 취소한 주문이 섞였다.
--   온라인 발주 › 취소·반품 화면에서 주문 줄을 수량 단위로 취소하면 이 함수가 매출 원장을 바로 고친다. (앞으로의 취소만 — 과거분은 손대지 않는다.)
--
-- ■ 방식
--   취소 = 매출 행의 수량·금액을 줄인다(남은 수량이 0이면 행을 지운다). 행 해시(row_hash)는 그대로 둔다.
--     · 리포트·루커·AI 비서·오디언스는 sales_orders 만 읽으므로 따로 고치지 않아도 모두 맞는다.
--     · 취소 전 파일을 다시 올려도 같은 해시라 줄어든 행이 그대로 남고, 지운 행은 업로드가 취소 장부를 보고 다시 넣지 않는다
--       (app/lib/order-cancel.ts applyCancelsToRows — 매출 업로드 미리보기·적용이 함께 쓴다).
--   취소 장부(order_cancels + order_cancel_lines)에 처음 취소하기 전의 행(snapshot)과 원래 수량·금액을 남긴다 → 되돌리기가 그 값으로 복구한다.
--   한 번의 취소(여러 줄)는 함수 하나 = 한 트랜잭션(S3). request_key 가 unique 라 같은 요청은 한 번만 반영된다(S2).
--   도매·B2B 매출은 발주에서 다시 만들어지는 행이라 여기서 취소하지 못한다(S10).
--
-- ■ 배송일지 박스 빼기·재고 돌려놓기
--   이 함수는 매출만 고친다. 박스(배송일지 직접수정)와 재고(입고 사유 '고객 반품')는 화면이 기존 저장 경로로 이어서 기록하고,
--   그 계획과 결과를 order_cancels.box / stock 에 남긴다 — 끝나지 않은 단계가 화면에 보인다(S12).
--
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.
-- 적용 전에는 취소·반품 화면이 'migration 175 를 적용하세요'를 보이고 아무것도 바꾸지 않는다. 매출 업로드는 종전대로 동작한다.

create table if not exists public.order_cancels (
  id           bigint generated always as identity primary key,
  request_key  uuid not null unique,                -- 화면이 만든 요청 키(같은 요청은 한 번만)
  kind         text not null,                       -- 취소 | 반품
  channel      text not null,                       -- 판매 채널
  order_id     text not null,                       -- 채널 주문번호
  order_date   date,                                -- 주문일
  note         text,                                -- 메모
  cancel_qty   integer not null default 0,          -- 이번에 취소한 수량 합
  cancel_amount bigint not null default 0,          -- 이번에 취소한 금액 합
  box          jsonb,                               -- 배송일지에서 뺄 박스 {date, side n|g, category, qty, entry_id, done}
  stock        jsonb,                               -- 재고에 돌려놓을 품목 [{product_id, name, qty, request_key, txn_ids, done}]
  status       text not null default 'active',      -- active 반영됨 / reverted 되돌림
  created_by   text,
  created_at   timestamptz not null default now(),
  reverted_by  text,
  reverted_at  timestamptz
);
create index if not exists order_cancels_created_idx on public.order_cancels (created_at desc);
create index if not exists order_cancels_order_idx on public.order_cancels (order_id);

create table if not exists public.order_cancel_lines (
  id            bigint generated always as identity primary key,
  cancel_id     bigint not null references public.order_cancels(id) on delete cascade,
  row_hash      text not null,                      -- sales_orders.row_hash (취소한 매출 행)
  product_name  text,
  option_name   text,
  sku_code      text,
  orig_quantity integer not null,                   -- 처음 취소하기 전의 수량
  orig_subtotal bigint not null,                    -- 처음 취소하기 전의 금액
  cancel_qty    integer not null check (cancel_qty > 0),
  cancel_amount bigint not null check (cancel_amount >= 0),
  snapshot      jsonb not null,                     -- 처음 취소하기 전의 매출 행 전체(되살릴 때 쓴다)
  active        boolean not null default true,      -- false = 되돌린 줄
  unique (cancel_id, row_hash)
);
create index if not exists order_cancel_lines_hash_idx on public.order_cancel_lines (row_hash);

alter table public.order_cancels enable row level security;
alter table public.order_cancel_lines enable row level security;

comment on table public.order_cancels is '소매 주문 취소·반품 처리 기록(처리 한 번에 한 줄). 매출 원장 반영은 order_cancel_lines, 배송일지 박스·재고 입고는 box·stock 칸에 계획과 결과';
comment on column public.order_cancels.kind is '취소 = 보내기 전·보낸 뒤 취소 / 반품 = 받은 뒤 돌려보냄';
comment on column public.order_cancels.cancel_amount is '이번 처리로 매출에서 뺀 금액 합(원)';
comment on column public.order_cancels.box is '배송일지에서 뺀 박스: date 날짜, side n 일반·g 도착보장, category 박스 종류, qty 개수, entry_id 배송일지 직접수정 내역 id, done 기록했는가';
comment on column public.order_cancels.stock is '재고에 돌려놓은 품목 목록: product_id, name, qty, request_key(재고 기록 요청 키), txn_ids(재고 기록 id), done 기록했는가';
comment on column public.order_cancels.status is 'active 반영됨 / reverted 되돌림(매출 복구)';
comment on table public.order_cancel_lines is '취소·반품으로 매출 행에서 뺀 수량·금액(주문 상품 줄 하나에 한 줄). active = false 는 되돌린 줄';
comment on column public.order_cancel_lines.row_hash is 'sales_orders.row_hash — 줄어든 뒤에도 해시는 그대로다';
comment on column public.order_cancel_lines.orig_quantity is '처음 취소하기 전의 주문 수량. 남은 수량 = 이 값 − 같은 행의 active 취소 수량 합';
comment on column public.order_cancel_lines.snapshot is '처음 취소하기 전의 sales_orders 행 전체(jsonb)';

-- ── 취소 반영 ──
--   p_lines = [{ "row_hash": "...", "qty": 1, "amount": 12900 }, ...]  (qty = 취소 수량, amount = 뺄 금액. 남은 수량을 모두 취소하면 남은 금액 전부)
create or replace function public.order_cancel_apply(
  p_key uuid, p_kind text, p_channel text, p_order_id text, p_note text, p_by text, p_lines jsonb, p_box jsonb, p_stock jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  cid bigint; ln jsonb; r public.sales_orders%rowtype;
  q integer; amt bigint; o_qty integer; o_amt bigint; snap jsonb;
  tot_q integer := 0; tot_a bigint := 0; d date;
begin
  select id into cid from order_cancels where request_key = p_key;
  if found then return jsonb_build_object('id', cid, 'replay', true); end if;
  if p_kind is null or p_kind not in ('취소', '반품') then raise exception '구분(취소·반품)을 고르세요.'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then raise exception '취소할 상품과 수량을 넣으세요.'; end if;

  insert into order_cancels (request_key, kind, channel, order_id, note, box, stock, created_by)
  values (p_key, p_kind, p_channel, p_order_id, nullif(btrim(coalesce(p_note, '')), ''), p_box, p_stock, p_by)
  returning id into cid;

  for ln in select * from jsonb_array_elements(p_lines) loop
    select * into r from sales_orders where row_hash = ln->>'row_hash' for update;
    if not found then raise exception '매출 원장에서 그 주문 줄을 찾지 못했습니다 — 주문을 다시 찾으세요.'; end if;
    if r.channel = '도매' or r.source = 'b2b' then raise exception '도매·B2B 매출은 발주 화면에서 취소하세요.'; end if;
    if r.channel is distinct from p_channel or r.order_id is distinct from p_order_id then raise exception '다른 주문의 줄이 섞여 있습니다 — 주문을 다시 찾으세요.'; end if;
    q := (ln->>'qty')::integer;
    amt := (ln->>'amount')::bigint;
    if q is null or q <= 0 or q > r.quantity then
      raise exception '취소 수량이 올바르지 않습니다 — % (남은 수량 %)', r.product_name, r.quantity;
    end if;
    if q = r.quantity then
      amt := r.subtotal_amount;                      -- 남은 수량을 모두 취소 = 남은 금액 전부
    elsif amt is null or amt < 0 or amt > r.subtotal_amount then
      raise exception '취소 금액이 올바르지 않습니다 — % (남은 금액 %)', r.product_name, r.subtotal_amount;
    end if;
    -- 원래 값·스냅샷 = 이 행을 처음 취소할 때의 것(이미 취소 줄이 있으면 그 값을 잇는다)
    select orig_quantity, orig_subtotal, snapshot into o_qty, o_amt, snap
      from order_cancel_lines where row_hash = r.row_hash order by id limit 1;
    if not found then o_qty := r.quantity; o_amt := r.subtotal_amount; snap := to_jsonb(r); end if;

    insert into order_cancel_lines (cancel_id, row_hash, product_name, option_name, sku_code, orig_quantity, orig_subtotal, cancel_qty, cancel_amount, snapshot)
    values (cid, r.row_hash, r.product_name, r.option_name, r.sku_code, o_qty, o_amt, q, amt, snap);

    if q = r.quantity then delete from sales_orders where id = r.id;
    else update sales_orders set quantity = r.quantity - q, subtotal_amount = r.subtotal_amount - amt where id = r.id;
    end if;
    tot_q := tot_q + q; tot_a := tot_a + amt; d := r.order_date;
  end loop;

  update order_cancels set cancel_qty = tot_q, cancel_amount = tot_a, order_date = d where id = cid;
  return jsonb_build_object('id', cid, 'replay', false, 'cancel_qty', tot_q, 'cancel_amount', tot_a);
end $$;

-- ── 되돌리기 — 이 처리로 뺀 수량·금액을 매출 원장에 되돌린다 ──
--   지웠던 행은 스냅샷으로 되살린다. 우리가 지운 것이 아닌데 행이 없으면(업로드 되돌리기·기간 교체로 사라짐) 되살리지 않고 missing 으로 센다.
create or replace function public.order_cancel_revert(p_id bigint, p_by text) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.order_cancels%rowtype; l record;
  o_qty integer; o_amt bigint; snap jsonb; s_qty integer; s_amt bigint;
  before_qty integer; net_qty integer; net_amt bigint; cols text;
  restored integer := 0; missing integer := 0;
begin
  select * into c from order_cancels where id = p_id for update;
  if not found then raise exception '취소 기록을 찾지 못했습니다.'; end if;
  if c.status = 'reverted' then return jsonb_build_object('id', p_id, 'replay', true); end if;

  for l in select * from order_cancel_lines where cancel_id = p_id and active order by id loop
    select orig_quantity, orig_subtotal, snapshot into o_qty, o_amt, snap
      from order_cancel_lines where row_hash = l.row_hash order by id limit 1;
    select coalesce(sum(cancel_qty), 0), coalesce(sum(cancel_amount), 0) into s_qty, s_amt
      from order_cancel_lines where row_hash = l.row_hash and active;
    before_qty := o_qty - s_qty;                                 -- 되돌리기 전에 남아 있던 수량
    net_qty := before_qty + l.cancel_qty;                        -- 되돌린 뒤 수량
    net_amt := greatest(o_amt - (s_amt - l.cancel_amount), 0);   -- 되돌린 뒤 금액
    update order_cancel_lines set active = false where id = l.id;

    perform 1 from sales_orders where row_hash = l.row_hash for update;
    if found then
      update sales_orders set quantity = net_qty, subtotal_amount = net_amt where row_hash = l.row_hash;
      restored := restored + 1;
    elsif before_qty <= 0 then
      -- 취소로 지웠던 행 — 스냅샷으로 되살린다(id·생성 칸 제외)
      select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into cols
        from information_schema.columns
        where table_schema = 'public' and table_name = 'sales_orders' and is_generated = 'NEVER' and column_name <> 'id';
      execute format('insert into public.sales_orders (%s) select %s from jsonb_populate_record(null::public.sales_orders, $1)', cols, cols)
        using snap || jsonb_build_object('quantity', net_qty, 'subtotal_amount', net_amt);
      restored := restored + 1;
    else
      missing := missing + 1;
    end if;
  end loop;

  update order_cancels set status = 'reverted', reverted_by = p_by, reverted_at = now() where id = p_id;
  return jsonb_build_object('id', p_id, 'replay', false, 'restored', restored, 'missing', missing);
end $$;

revoke all on function public.order_cancel_apply(uuid, text, text, text, text, text, jsonb, jsonb, jsonb) from public;
revoke all on function public.order_cancel_apply(uuid, text, text, text, text, text, jsonb, jsonb, jsonb) from anon;
revoke all on function public.order_cancel_apply(uuid, text, text, text, text, text, jsonb, jsonb, jsonb) from authenticated;
grant execute on function public.order_cancel_apply(uuid, text, text, text, text, text, jsonb, jsonb, jsonb) to service_role;
revoke all on function public.order_cancel_revert(bigint, text) from public;
revoke all on function public.order_cancel_revert(bigint, text) from anon;
revoke all on function public.order_cancel_revert(bigint, text) from authenticated;
grant execute on function public.order_cancel_revert(bigint, text) to service_role;

notify pgrst, 'reload schema';
