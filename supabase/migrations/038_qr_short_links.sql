-- 038_qr_short_links.sql
-- QR/숏링크 — 동적 QR = 우리 도메인의 짧은 URL(/q/{code})을 인코딩하고, 접속 시 목적지로 리다이렉트.
--  목적지는 나중에 바꿔도 QR 이미지는 재사용 가능. 스캔(접속) 이벤트를 기록해 통계 제공.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

create table if not exists short_links (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,             -- 짧은 코드 (/q/{code})
  target_url text not null,              -- 리다이렉트 목적지
  title text,                            -- 라벨/메모
  active boolean not null default true,
  scan_count integer not null default 0, -- 누적 스캔(빠른 표시용 비정규화)
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists short_links_code_idx on short_links (code);

create table if not exists qr_scans (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references short_links(id) on delete cascade,
  scanned_at timestamptz not null default now(),
  referer text,
  user_agent text,
  country text                           -- 대략 국가(Vercel x-vercel-ip-country) — 개인식별정보 아님. IP 원본은 저장하지 않음.
);
create index if not exists qr_scans_link_idx on qr_scans (link_id, scanned_at desc);

alter table short_links enable row level security;
alter table qr_scans enable row level security;

-- 코드로 목적지 조회 + 스캔 기록 + 카운트 증가를 한 번에(리다이렉트 1회 왕복). 비활성/없음이면 null.
create or replace function qr_resolve(p_code text, p_referer text, p_ua text, p_country text)
returns text
language plpgsql
as $$
declare v_id uuid; v_url text; v_active boolean;
begin
  select id, target_url, active into v_id, v_url, v_active from short_links where code = p_code;
  if v_id is null or v_active is false then return null; end if;
  insert into qr_scans (link_id, referer, user_agent, country) values (v_id, left(p_referer, 500), left(p_ua, 500), left(p_country, 8));
  update short_links set scan_count = scan_count + 1 where id = v_id;
  return v_url;
end $$;

NOTIFY pgrst, 'reload schema';
