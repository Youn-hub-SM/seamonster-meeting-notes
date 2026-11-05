-- 161: 상세페이지 전송 — 소스 조합(여러 소스를 순서대로 묶어 한 번에 쏘기) + 적용 기록에 조합 정보.
--  적용: Supabase SQL Editor 에 전체 붙여넣고 Run. 멱등 — 재실행 안전. (160 다음에 적용)
--
-- 조합은 HTML 을 갖지 않고 구성 소스와 순서만 갖는다. 조합을 쏘면 실행기가 구성 소스를 각각 마커 블록으로
--  펼쳐 넣는다(abcd 한 덩어리가 아니라 a·b·c·d 블록 넷). 그래서 나중에 a 소스만 고쳐 다시 쏘면 a 구간만 바뀐다.
-- 조합을 다시 쏘면 구성 블록을 전부 걷어내고 조합 순서대로 다시 넣는다(= 블록 순서 재정렬).

create table if not exists detail_sets (
  id bigserial primary key,
  name text not null,
  members bigint[] not null default '{}',     -- 구성 소스 id, 배열 순서 = 블록 순서
  position text not null default 'append',   -- replace | prepend | append (조합 블록 묶음을 어디에)
  created_by text,
  created_at timestamptz not null default now(),
  updated_by text,
  updated_at timestamptz not null default now()
);

comment on table detail_sets is '상세페이지 소스 조합 — 소스 여러 개를 순서대로 묶은 것. 쏘면 소스마다 마커 블록으로 펼쳐 들어간다';
comment on column detail_sets.members is '구성 소스 id 배열(detail_sources.id). 배열 순서가 상세설명 안 블록 순서';
comment on column detail_sets.position is '조합 블록 묶음의 자리: replace=전체 교체, prepend=기존 맨 앞, append=맨 뒤';

alter table detail_applies add column if not exists command text not null default 'source';  -- source | set
alter table detail_applies add column if not exists set_id bigint references detail_sets(id) on delete set null;
alter table detail_applies add column if not exists set_name text;                             -- 요청 시점 조합명(표시용)
alter table detail_applies add column if not exists members jsonb;                             -- set 명령: [{source_id, version, html}] 순서대로

comment on column detail_applies.command is 'source=소스 하나(source_id·html), set=조합(set_id·members 를 순서대로 블록으로)';
comment on column detail_applies.members is 'set 명령의 구성 스냅샷 [{source_id, version, html}] — 쏜 시점 기준';

-- set 명령은 source_id 가 없을 수 있다
alter table detail_applies alter column source_id drop not null;
alter table detail_applies alter column source_version drop not null;
alter table detail_applies alter column html drop not null;

create index if not exists detail_applies_set_idx on detail_applies (set_id, created_at desc);
create index if not exists detail_applies_members_idx on detail_applies using gin (members);

alter table detail_sets enable row level security;  -- service key 전용(정책 없음)

NOTIFY pgrst, 'reload schema';
