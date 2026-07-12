-- 065: 온라인발주 → 재고 출고 이력(중복 출고 방지 + 감사)
-- 발주엑셀 업로드로 상품출고 시, 같은 바스켓(SKU:수량)이 당일 재출고되는 것을 sig로 차단.
-- 실제 재고 차감은 inventory_txns(출고, 소매); 이 표는 배치 이력만.

create table if not exists fulfill_dispatch (
  id           uuid primary key default gen_random_uuid(),
  sig          text not null,                         -- 바스켓 서명(정렬된 sku:qty 해시)
  dispatch_date date not null default current_date,
  channel      text not null default '소매',
  sku_count    integer not null default 0,
  total_qty    integer not null default 0,
  group_id     uuid,                                  -- inventory_txns 배치 group_id(원복용)
  order_no     text,                                  -- OUT-000123
  created_by   text,
  created_at   timestamptz not null default now()
);

create index if not exists idx_fulfill_dispatch_sig on fulfill_dispatch (sig, dispatch_date);

-- 서비스 롤(supabaseAdmin)만 접근.
alter table fulfill_dispatch enable row level security;
