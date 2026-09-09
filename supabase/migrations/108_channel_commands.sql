-- 108: 채널 재고 명령 큐 — SKU 리스팅 찾기에서 누른 '수량 적용(품절=0)'을 중계 서버가 실행.
--  적용: Supabase SQL Editor 에 전체 붙여넣고 Run. 멱등 — 재실행 안전. (107 다음에 적용)
--
-- 네이버·쿠팡 쓰기 API 는 등록 IP 에서만 호출돼 Vercel 이 직접 실행할 수 없다.
-- 화면 → 명령 행 생성(대기) → 중계 서버 크론(2분)이 대기 명령을 실행하고 결과를 기록 → 화면에 상태 표시.
-- 자동 판정은 없다 — 사람이 누른 명령만 실행한다(대표 결정).

create table if not exists channel_commands (
  id bigserial primary key,
  channel text not null,               -- 스마트스토어 | 쿠팡 | 카페24
  item_key text not null,              -- channel_catalog.item_key (채널 아이템 식별자 포함)
  origin_no text not null,
  listing_name text not null,          -- 스냅샷(표시용)
  item_name text,
  sku_code text not null default '',
  command text not null default 'set_stock',
  qty integer not null,                -- 0 = 품절
  status text not null default '대기', -- 대기 | 실행중(실행기 선점) | 완료 | 실패
  error text,
  requested_by text,                   -- 로그인 사용자명
  created_at timestamptz not null default now(),
  claimed_at timestamptz,              -- 실행기 선점 시각 — 10분 지난 '실행중'은 고아로 보고 재선점
  executed_at timestamptz
);

create index if not exists channel_commands_status_idx on channel_commands (status, created_at);

alter table channel_commands enable row level security; -- service key 전용(정책 없음)

NOTIFY pgrst, 'reload schema';
