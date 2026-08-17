-- 094_instagram_dm.sql
-- 인스타그램 댓글 → 자동 DM(Private Reply) — 마케팅 /instagram.
--  특정 게시물에 댓글이 달리면(선택: 키워드 포함 시) 설정한 메시지를 그 댓글 작성자에게 1회 DM.
--  계정 3개 운영: 규칙·로그 모두 ig_user_id 로 어느 계정 것인지 구분(계정 토큰은 b2b_settings KV).
--  적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등(IF NOT EXISTS).

create table if not exists ig_dm_rules (
  id              uuid primary key default gen_random_uuid(),
  ig_user_id      text not null,                 -- 어느 인스타 계정의 규칙인지
  media_id        text not null,                 -- 대상 게시물
  media_permalink text not null default '',      -- 표시·바로가기용
  media_caption   text not null default '',      -- 표시용 캡션 스니펫
  keyword         text not null default '',      -- 쉼표 구분, 비우면 모든 댓글
  message         text not null,                 -- 보낼 DM({닉네임} 치환 지원)
  link            text not null default '',      -- 안내용 링크(브랜드링크면 클릭 집계)
  active          boolean not null default true, -- 끄면 일정과 무관하게 정지
  start_at        timestamptz,                   -- 켜는 시각(NULL=즉시)
  end_at          timestamptz,                   -- 끄는 시각(NULL=계속)
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists ig_dm_rules_media_idx on ig_dm_rules (ig_user_id, media_id);

create table if not exists ig_dm_logs (
  id                 uuid primary key default gen_random_uuid(),
  rule_id            uuid references ig_dm_rules (id) on delete set null,
  ig_user_id         text not null,
  comment_id         text not null unique,       -- 멱등 키(웹훅 중복 배달·재시도 대비, API 도 댓글당 1회)
  commenter_id       text not null default '',
  commenter_username text not null default '',
  comment_text       text not null default '',
  status             text not null default 'sent',  -- sent | failed
  error              text not null default '',
  created_at         timestamptz not null default now()
);
create index if not exists ig_dm_logs_rule_idx on ig_dm_logs (rule_id, created_at desc);
create index if not exists ig_dm_logs_time_idx on ig_dm_logs (created_at desc);

alter table ig_dm_rules enable row level security;  -- 서비스롤로만 접근(정책 없음)
alter table ig_dm_logs  enable row level security;

NOTIFY pgrst, 'reload schema';
