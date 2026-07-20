-- 079 온라인 발주 '이미 처리된 주문' 필터
--  발주 파일에 이미 출고 완료된 주문(누적 다운로드 등)이 섞여 오면 자동 제외하기 위한 키 저장소.
--  개인정보 없이 주문번호 해시만 저장. 흐름:
--   ① 발주처리 파일 분석 시: 파일의 주문번호 해시 목록을 배치 서명(sig)으로 임시 보관(fulfill_pending_keys)
--   ② 4단계 '출고 완료' 시: 그 배치의 해시를 확정 등록(fulfill_order_keys)
--   ③ 이후 업로드 파일에서 확정 키와 겹치는 주문 행은 CN파일·택배량·배송일지·출고 전부에서 자동 제외
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

create table if not exists fulfill_order_keys (
  key text primary key,                          -- sha1(주문번호) 16자
  order_no text,                                 -- 등록시킨 출고번호(OUT-...) 참조용
  processed_at timestamptz not null default now()
);
create index if not exists fulfill_order_keys_at_idx on fulfill_order_keys (processed_at);

create table if not exists fulfill_pending_keys (
  sig text primary key,                          -- 출고 배치 서명(SKU·수량 합 기준 — dispatch 와 동일 산식)
  keys jsonb not null,                           -- [sha1(주문번호)...]
  created_at timestamptz not null default now()
);

alter table fulfill_order_keys enable row level security;
alter table fulfill_pending_keys enable row level security;

NOTIFY pgrst, 'reload schema';
