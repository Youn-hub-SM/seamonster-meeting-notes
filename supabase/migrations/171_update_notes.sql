-- 171: 업데이트 노트 기록 표 (2026-11-19 대표 지시 — "업데이트 노트를 슈파베이스에 기록만")
--
-- 업데이트 노트는 코드 파일(app/lib/changelog.ts)에 쓴다. 운영 서버가 한 시간에 한 번,
-- 그 파일에 있는데 이 표에 없는 항목만 추가한다(app/lib/update-notes.ts). 한 번 들어간 줄은 고치거나 지우지 않는다.
-- 화면(/updates)은 이 표를 읽지 않는다. 이 SQL 을 적용하지 않아도 다른 기능은 그대로 동작한다.
--
-- 확인: select count(*), max(note_date) from public.update_notes;
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

create table if not exists public.update_notes (
  id         text primary key,                    -- 날짜·도구·제목으로 만든 고정 값(같은 항목이 두 번 들어가지 않게)
  note_date  date not null,                       -- 그 변경이 나간 날
  tag        text not null,                       -- 신규 / 개선 / 수정
  tool       text not null,                       -- 어느 도구(화면)의 변경인지
  title      text not null,                       -- 한 줄 제목
  body       text not null,                       -- 설명
  href       text,                                -- 그 화면의 경로
  created_at timestamptz not null default now()   -- 이 표에 들어온 시각
);
create index if not exists update_notes_date_idx on public.update_notes (note_date desc);

-- 서버(service role)만 읽고 쓴다 — 공개 키로는 접근 불가
alter table public.update_notes enable row level security;

comment on table public.update_notes is '업무도우미 업데이트 노트 기록 — 기능이 새로 생기거나(신규) 나아지거나(개선) 고쳐진(수정) 내역. 한 줄 = 변경 한 건. 추가만 된다';
comment on column public.update_notes.note_date is '그 변경이 운영에 나간 날(한국 날짜)';
comment on column public.update_notes.tag is '신규 = 새 기능 / 개선 = 있던 기능이 나아짐 / 수정 = 잘못된 동작을 고침';
comment on column public.update_notes.tool is '어느 도구(화면)의 변경인지 — 예: B2B 발주, 주요 지표, AI 비서';
comment on column public.update_notes.body is '직원용 설명 — 무엇이 어떻게 바뀌었는지';
comment on column public.update_notes.href is '그 화면의 경로. 없으면 null';
comment on column public.update_notes.created_at is '이 표에 들어온 시각. 2026-11-19 이전 기록은 한꺼번에 들어왔으니 변경일은 note_date 로 본다';
