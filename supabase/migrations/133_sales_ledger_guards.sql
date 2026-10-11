-- 133 매출 원장 안전장치 — 도매 매출 재동기화 한 번에 처리 · 최신일에서 미래 날짜 제외 · 업로드 이력 메모 (2026-10-11 원장 기준 점검)
--
-- ■ 왜
--   1) 도매 발주 매출 재동기화(app/lib/b2b-sales-sync.ts)는 '새 행 넣기 → 다른 배치 행 지우기 → 옛 행 지우기'를 따로따로 보냈다.
--      중간에 실패하면 옛 행과 새 행이 같이 남아 이중집계되고, 두 저장이 겹치면 서로의 행을 지워 매출이 0행이 될 수 있었다.
--      또 '다른 배치 행 지우기'가 upload_batch <> 'b2b-…' 조건이라 upload_batch 가 비어 있는 백필 행(07-05 이전 구글시트분)은
--      지워지지 않아, 옛 발주를 다시 저장하면 백필 행 + 새 행으로 이중집계됐다.
--   2) sales_date_bounds 의 max_date 가 미래 날짜 행(발송 예정일로 미리 발송완료한 도매 행, 업로드 연도 오타)을 그대로 써서
--      일일 리포트 기본 기준일·이익 화면 기본 기간이 미래가 됐다.
--   3) 매출 업로드의 '기간 교체'·'동일 라인 따로 넣기' 선택을 업로드 이력에 남길 칸이 없었다.
--
-- ■ 바뀌는 것
--   1) sync_b2b_sales(p_order_id, p_order_no, p_status, p_rows) 함수 — 발주 단위 잠금(pg_advisory_xact_lock) 안에서
--      ① 이 발주 배치(b2b-<id>) 중 이번 행에 없는 해시 삭제 ② 발송완료·취소일 때만 같은 주문번호의 도매 행 중
--      다른 배치·배치 없음(백필) 행 삭제 ③ 이번 행 넣기(같은 해시는 그대로)를 한 트랜잭션으로 처리한다.
--      발송대기 발주는 ②를 하지 않는다(대체 행 없이 백필 매출이 사라지는 것을 막는 기존 규칙 유지).
--   2) sales_date_bounds() — max_date 는 오늘(KST) 이하 행만, future_rows·future_max(오늘 이후 행 수·최대 날짜)를 함께 돌려준다.
--      반환 칸이 바뀌어 drop 후 다시 만든다. min_date·total_rows 는 그대로(전체 기준).
--   3) sales_uploads.note — 업로드 방식 메모(예: '기간 교체 스마트스토어 10-01~10-31 · 기존 3행 삭제').
--
-- ■ 미적용이면
--   코드가 알아서 예전 방식으로 동작한다 — 재동기화는 단계별 처리(백필 행 삭제 조건은 코드에서 고침), 최신일은 미래 포함,
--   업로드 메모는 저장하지 않는다.
--
-- ■ 적용 전 확인(선택) — 백필 행과 b2b 행이 같이 있는 도매 주문(적용 후 그 발주를 다시 저장하면 백필 행이 지워진다)
--   select order_id,
--          count(*) filter (where upload_batch is null)      as backfill_rows,
--          sum(subtotal_amount) filter (where upload_batch is null) as backfill_amt,
--          count(*) filter (where upload_batch like 'b2b-%') as b2b_rows,
--          sum(subtotal_amount) filter (where upload_batch like 'b2b-%') as b2b_amt
--     from public.sales_orders where channel = '도매'
--    group by 1
--   having count(*) filter (where upload_batch is null) > 0 and count(*) filter (where upload_batch like 'b2b-%') > 0;
--
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

-- 1) 도매 매출 재동기화
create or replace function public.sync_b2b_sales(p_order_id text, p_order_no text, p_status text, p_rows jsonb)
returns table (inserted integer, deleted integer)
language plpgsql
as $$
declare
  v_batch  text := 'b2b-' || p_order_id;
  v_rows   jsonb := coalesce(p_rows, '[]'::jsonb);
  v_hashes text[];
  v_del    integer := 0;
  v_del2   integer := 0;
  v_ins    integer := 0;
begin
  -- 같은 발주의 동기화는 한 번에 하나씩(발주 수정 저장과 차수 상태 변경이 겹쳐도 서로의 행을 지우지 않게)
  perform pg_advisory_xact_lock(hashtext('sync_b2b_sales:' || p_order_id));

  select coalesce(array_agg(e->>'row_hash'), '{}') into v_hashes from jsonb_array_elements(v_rows) e;

  -- ① 이 발주 배치의 옛 행 중 이번 구성에 없는 것
  delete from public.sales_orders s
   where s.upload_batch = v_batch
     and not (s.row_hash = any(v_hashes));
  get diagnostics v_del = row_count;

  -- ② 발송완료·취소 — 같은 주문번호의 도매 행 중 다른 배치·배치 없음(백필) 행. 넣기 전에 지워 같은 해시도 새 배치로 다시 들어간다.
  if p_status in ('발송완료', '취소') and coalesce(p_order_no, '') <> '' then
    delete from public.sales_orders s
     where s.channel = '도매'
       and s.order_id = p_order_no
       and (s.upload_batch is null or s.upload_batch <> v_batch);
    get diagnostics v_del2 = row_count;
  end if;

  -- ③ 이번 행(같은 해시는 그대로 둔다)
  insert into public.sales_orders (
    channel, order_date, order_date_int, order_id, product_name, option_name, sku_code,
    quantity, selling_price, option_price, subtotal_amount, shipping_fee, customer_key, row_hash, source, upload_batch)
  select r.channel, r.order_date, r.order_date_int, r.order_id, r.product_name, r.option_name, r.sku_code,
         r.quantity, r.selling_price, r.option_price, r.subtotal_amount, r.shipping_fee, coalesce(r.customer_key, ''),
         r.row_hash, 'b2b', v_batch
    from jsonb_to_recordset(v_rows) as r(
      channel text, order_date date, order_date_int integer, order_id text, product_name text, option_name text,
      sku_code text, quantity integer, selling_price bigint, option_price bigint, subtotal_amount bigint,
      shipping_fee bigint, customer_key text, row_hash text)
  on conflict (row_hash) do nothing;
  get diagnostics v_ins = row_count;

  return query select v_ins, v_del + v_del2;
end
$$;

revoke all on function public.sync_b2b_sales(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.sync_b2b_sales(text, text, text, jsonb) to service_role;

-- 2) 데이터 범위 — 최신일은 오늘(KST) 이하만, 미래 행은 따로 센다
drop function if exists public.sales_date_bounds();
create function public.sales_date_bounds()
returns table (min_date date, max_date date, total_rows bigint, future_rows bigint, future_max date)
language sql stable as $$
  select min(order_date),
         max(order_date) filter (where order_date <= (now() at time zone 'Asia/Seoul')::date),
         count(*)::bigint,
         count(*) filter (where order_date > (now() at time zone 'Asia/Seoul')::date)::bigint,
         max(order_date) filter (where order_date > (now() at time zone 'Asia/Seoul')::date)
    from public.sales_orders
$$;

-- 3) 업로드 이력 메모
alter table public.sales_uploads add column if not exists note text;

notify pgrst, 'reload schema';
