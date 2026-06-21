-- UTM 빌더 백엔드: Google Sheet/Apps Script → Supabase 전환.
--   utm_links     : 생성 히스토리 (행 단위 추가/조회/삭제)
--   utm_settings  : 즐겨찾기(랜딩 URL 프리셋) + 소스·매체 맵 (키-값 설정)
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

-- 생성 히스토리 ---------------------------------------------------------------
create table if not exists utm_links (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  base_url   text not null default '',
  source     text not null default '',
  medium     text not null default '',
  campaign   text not null default '',
  content    text not null default '',
  term       text not null default '',
  note       text not null default '',
  full_url   text not null default ''
);

create index if not exists utm_links_created_at_idx on utm_links (created_at desc);

alter table utm_links enable row level security;

-- 설정(즐겨찾기 + 소스·매체 맵) -------------------------------------------------
--   key='url_presets'        → [{label, value}] 배열 (랜딩페이지 즐겨찾기)
--   key='source_medium_map'  → { source: [medium, ...] } 객체 (소스별 추천 매체)
create table if not exists utm_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

alter table utm_settings enable row level security;

NOTIFY pgrst, 'reload schema';
