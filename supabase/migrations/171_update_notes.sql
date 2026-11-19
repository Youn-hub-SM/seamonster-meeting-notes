-- 171: 업데이트 노트를 표로 — 지피티·AI 비서가 읽게 (2026-11-19 대표 지시)
--
-- ■ 왜
--   업데이트 노트(/updates)는 코드 파일(app/lib/changelog.ts)에만 있어서 화면 밖에서는 읽을 수 없었다.
--   대표: "슈파베이스에 쌓이도록 하자. 이걸 지피티도 읽을 거야."
--
-- ■ 어떻게 채워지나
--   쓰는 곳은 그대로 코드 파일이다(기능을 고치는 커밋에 한 항목씩 넣는다). 이 표는 그 파일의 사본이다.
--   운영 서버가 한 시간에 한 번(일정 알림 크론의 정각 칸) 파일과 이 표를 견줘 다른 줄만 넣고·고치고·지운다(app/lib/update-notes.ts).
--   그래서 이 표에 직접 쓴 내용은 다음 맞추기 때 사라진다 — 이 표에는 손으로 쓰지 않는다.
--   베타(dev)는 이 표에 쓰지 않는다 — 운영에 나간 소식만 들어간다.
--
-- ■ 누가 읽나
--   AI 비서(run_report — 차단 목록에 없으니 그대로 조회), 지피티(MCP 도구 update_notes). 화면(/updates)은 지금처럼 코드 파일을 읽는다.
--   개인정보·비밀은 들어가지 않는다(직원에게 보여 주는 안내 글 그대로).
--
-- ★ 이 SQL 을 적용하지 않아도 화면은 그대로 동작한다. 지피티 도구도 표가 없으면 코드 파일에서 읽어 답한다.
-- 적용 뒤 바로 채우기: 운영 주소에 관리자로 로그인한 브라우저에서 /api/updates/sync 를 연다(기다리면 한 시간 안에 저절로 채워진다).
-- 확인: select count(*), max(note_date) from public.update_notes;
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

create table if not exists public.update_notes (
  id         text primary key,                    -- 날짜·도구·제목으로 만든 고정 값(같은 항목은 늘 같은 id)
  note_date  date not null,                       -- 그 변경이 나간 날
  tag        text not null,                       -- 신규 / 개선 / 수정
  tool       text not null,                       -- 어느 도구(화면)의 변경인지
  menu       text not null,                       -- 업데이트 노트 화면의 메뉴 묶음(B2B·매출·생산 및 재고 등)
  title      text not null,                       -- 한 줄 제목
  body       text not null,                       -- 직원용 설명
  href       text,                                -- 그 화면의 경로(/board?tab=sales 등)
  seq        integer not null,                    -- 쓴 순서(클수록 나중). 같은 날 안의 순서를 가린다
  hash       text not null,                       -- 내용 지문 — 코드 파일과 견줄 때 쓴다
  created_at timestamptz not null default now(),  -- 이 표에 처음 들어온 시각
  updated_at timestamptz not null default now()   -- 내용이 마지막으로 바뀐 시각
);
create index if not exists update_notes_date_idx on public.update_notes (note_date desc, seq desc);

-- 서버(service role)만 읽고 쓴다 — 공개 키로는 접근 불가
alter table public.update_notes enable row level security;

comment on table public.update_notes is '업무도우미 업데이트 노트 — 기능이 새로 생기거나(신규) 나아지거나(개선) 고쳐진(수정) 기록. 한 줄 = 변경 한 건. 코드 파일의 사본이라 운영에 나간 소식만 있다. 최신순은 note_date desc, seq desc';
comment on column public.update_notes.note_date is '그 변경이 운영에 나간 날(한국 날짜)';
comment on column public.update_notes.tag is '신규 = 새 기능 / 개선 = 있던 기능이 나아짐 / 수정 = 잘못된 동작을 고침';
comment on column public.update_notes.tool is '어느 도구(화면)의 변경인지 — 예: B2B 발주, 주요 지표, AI 비서';
comment on column public.update_notes.menu is '업데이트 노트 화면의 메뉴 묶음 — 도구를 큰 갈래로 묶은 이름(B2B·매출·생산 및 재고·AI 비서·공통 등)';
comment on column public.update_notes.title is '한 줄 제목';
comment on column public.update_notes.body is '직원용 설명 — 무엇이 어떻게 바뀌었는지';
comment on column public.update_notes.href is '그 화면의 경로. 없으면 null';
comment on column public.update_notes.seq is '쓴 순서(클수록 나중에 쓴 것) — 같은 날 여러 건의 앞뒤를 가릴 때';
comment on column public.update_notes.hash is '내용 지문(자동 맞추기용) — 분석에 쓰지 않는다';
comment on column public.update_notes.created_at is '이 표에 처음 들어온 시각. 2026-11-19 이전 기록은 표를 만든 날 한꺼번에 들어왔으니 변경일은 note_date 로 본다';
