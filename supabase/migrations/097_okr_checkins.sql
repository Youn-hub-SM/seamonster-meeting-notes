-- 097 OKR 1:1 체크인 기록 (2026-08-24) — 회의 정리에서 업로드한 요약·할 일의 원장.
--  · 각 팀원이 본인 녹취를 정리·편집해 업로드하면 한 행이 쌓인다.
--  · todos jsonb: [{text, scope('personal'|'okr'), gid, project_gid}] — gid 는 아사나 태스크.
--    다음 회의 때 gid 로 완료 여부를 조회해 이행률을 자동 계산한다.
--  · 요약 본문은 아사나에도 올라가지만 여기 함께 보관(아사나에서 지워져도 기록 유지).
create table if not exists okr_checkins (
  id              uuid primary key default gen_random_uuid(),
  member          text not null,                 -- 로그인 사용자명(app_users)
  meeting_date    date not null,
  due_date        date,                          -- 다음 회의일(할 일 마감)
  public_summary  text,
  private_summary text,
  todos           jsonb not null default '[]'::jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists okr_checkins_member_idx on okr_checkins (member, created_at desc);

notify pgrst, 'reload schema';
