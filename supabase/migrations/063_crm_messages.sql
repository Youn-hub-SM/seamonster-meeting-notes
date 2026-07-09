-- 063_crm_messages.sql
-- CRM 메시지맵 — 카페24 crm_message_map.html(구글시트 CSV 구동)을 내부도구로 이관.
--  고객 여정 단계(stage)별 메시지 카드. 앱에서 표로 직접 편집(구글시트 의존 제거).
--  적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등(IF NOT EXISTS).

create table if not exists crm_messages (
  id          uuid primary key default gen_random_uuid(),
  stage_num   integer not null default 0,      -- 스테이지 순서(작을수록 앞)
  stage       text    not null default '',      -- 스테이지명(여정 단계)
  sub         text    not null default '',      -- 스테이지 부제(단계 내 첫 행 기준 표시)
  title       text    not null default '',      -- 메시지명
  status      text    not null default '',      -- active(활성)/auto(자동)/gap(공백/미완)/paused(중단) 등
  channel     text    not null default '',      -- kakao/manual/cafe24/custom/onsite/leaflet 등
  timing      text    not null default '',      -- 발송 시점
  detail      text    not null default '',      -- 상세 설명
  msg         text    not null default '',      -- 메시지 내용/초안
  img_url     text    not null default '',
  links       jsonb   not null default '{}'::jsonb,  -- {solapi,cafe24,meta,sheets,channel,blog,onsite}
  perf        jsonb   not null default '{}'::jsonb,  -- {sent,reached,opened,clicked,converted,revenue}
  tags        text    not null default '',      -- 콤마 구분
  sort_order  integer not null default 0,       -- 스테이지 내 순서
  active      boolean not null default true,    -- false=목록에서 숨김(삭제 아님)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists crm_messages_stage_idx on crm_messages (stage_num, sort_order);

alter table crm_messages enable row level security;  -- 서비스롤로만 접근(정책 없음)

NOTIFY pgrst, 'reload schema';
