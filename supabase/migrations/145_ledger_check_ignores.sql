-- 145 원장 점검 [무시] — 사람이 보고 문제없다고 판단한 점검 행을 목록에서 뺀다 (2026-10-21 대표 지시)
--
-- ■ 왜
--   원장 점검(/inventory/ledger-check)은 판정만 하고 고치지 않는다(S12). 옛 데이터처럼 이미 맞거나 손댈 필요가 없는 행이
--   매번 같은 건수로 남아 정작 새 문제가 묻힌다 → 행마다 [무시], 무시한 목록에서 [되살리기].
-- ■ 키
--   item_key = 점검 행 고유 값(ref_id·ref_no·product_id·channel·txn_date·qty 를 | 로 이음, 앱 ledgerItemKey).
--   수량이 들어 있어, 마이너스 재고처럼 값이 바뀌면 키가 달라져 다시 보인다(새 문제는 숨지 않는다).
-- ■ 재고·매출 원장은 건드리지 않는다 — 점검 화면 표시만 바뀐다.
--
-- 적용: Supabase Dashboard > SQL Editor 에 전체 붙여넣고 Run. 멱등.

create table if not exists public.ledger_check_ignores (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  item_key text not null,
  summary text,
  ignored_by text,
  created_at timestamptz not null default now(),
  unique (kind, item_key)
);

alter table public.ledger_check_ignores enable row level security;

comment on table public.ledger_check_ignores is '원장 점검에서 사람이 [무시]한 행. kind = 점검 항목(예: return_no_out), item_key = 점검 행 고유 값, summary = 무시할 때 보인 내용, ignored_by = 누른 사람. 여기 있는 행은 점검 건수에서 빠진다(원장은 그대로).';
comment on column public.ledger_check_ignores.kind is '원장 점검 항목 코드(inventory_ledger_check kind 또는 b2b_sales_ledger)';
comment on column public.ledger_check_ignores.item_key is '점검 행 고유 값 — ref_id|ref_no|product_id|channel|txn_date|qty. 수량이 바뀌면 다른 행으로 보아 다시 점검된다';
comment on column public.ledger_check_ignores.summary is '무시할 때 화면에 보인 품목·발주·내용 한 줄(무시 목록 표시용)';

notify pgrst, 'reload schema';
