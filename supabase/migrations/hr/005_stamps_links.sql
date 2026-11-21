-- hr/005 직인 · 직원 확인 링크 (2026-11-21, docs/payroll-leave-plan.md 16·17장)
--
-- ■ 직인(workplace_stamps)
--   사업장마다 직인 이미지 하나. 증명서(재직·경력·원천징수)를 인쇄할 때 대표자 이름 옆에 찍힌다.
--   이미지는 data URL(image/png 또는 image/jpeg, base64) 글자로 둔다 — 작은 그림 한 장이라 따로 저장소를 두지 않는다.
--   증명서의 내용은 인사대장·사업장·확정한 월 급여에서 읽고, 발급 이력은 hr.audit_log 에 남긴다(새 표 없음).
-- ■ 직원 확인 링크(employee_links · link_attempts)
--   직원 한 명에 링크 하나. 직원은 그 링크(/me/<토큰>)를 열고 주민등록번호를 넣어 본인 것(급여명세서·연차·근태)만 본다.
--   · 토큰은 두 가지로 둔다: token_hash(sha-256 — 링크로 찾을 때)와 token_enc(HR_DATA_KEY 로 암호화 — 급여 창의 [링크 복사]용).
--     평문 토큰은 저장하지 않는다.
--   · [링크 다시 만들기]는 토큰과 version 을 바꾼다 — 옛 링크와 옛 기기의 확인 상태가 함께 무효가 된다. [링크 끊기]는 active = false.
--   · 본인 확인을 5번 틀리면 15분 잠근다(link_attempts 로 센다). 주민등록번호 자체는 어디에도 남기지 않는다.
--   급여 창(/hr)의 로그인과는 별개의 길이다 — 이 링크로는 그 직원 한 명의 자료만 읽을 수 있고, 고치는 기능은 없다.
-- ■ 미적용이면
--   직인 칸과 직원 링크 구역이 'DB 준비 전(hr/005 적용)'을 보인다. 증명서는 직인 없이 인쇄되고 나머지 화면은 그대로다.
--
-- 이 번호열은 hr 스키마 밖을 건드리지 않는다. 적용: Supabase SQL Editor 에 이 파일 하나를 붙여넣고 Run. 멱등 — 재실행 안전. hr/004 다음.

create table if not exists hr.workplace_stamps (
  workplace_id  uuid primary key references hr.workplaces(id) on delete cascade,
  image         text not null check (image ~ '^data:image/(png|jpeg);base64,' and length(image) <= 700000),  -- 약 500KB 그림까지
  updated_by    text,
  updated_at    timestamptz not null default now()
);
comment on table hr.workplace_stamps is '사업장 직인 이미지(data URL). 증명서 인쇄에 쓴다';

create table if not exists hr.employee_links (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid not null unique references hr.employees(id) on delete cascade,   -- 직원 한 명에 링크 하나
  token_hash      text not null unique,                    -- sha-256(토큰) 16진수 — 링크로 찾는다
  token_enc       text not null,                           -- 토큰 암호문(v1:iv:tag:ct) — 급여 창의 [링크 복사]
  version         integer not null default 1,              -- 다시 만들 때마다 +1(옛 확인 상태 무효)
  active          boolean not null default true,           -- false = 끊은 링크
  created_by      text,
  created_at      timestamptz not null default now(),
  updated_by      text,
  updated_at      timestamptz not null default now(),
  last_opened_at  timestamptz                              -- 직원이 마지막으로 본인 확인을 통과한 때
);
comment on table hr.employee_links is '직원 확인 링크(직원 한 명에 하나). 직원이 본인의 급여명세서·연차·근태를 보는 길';

create table if not exists hr.link_attempts (
  id       bigint generated always as identity primary key,
  at       timestamptz not null default now(),
  link_id  uuid not null references hr.employee_links(id) on delete cascade,
  ip       text not null default '',
  ok       boolean not null
);
create index if not exists link_attempts_link_idx on hr.link_attempts (link_id, at desc);
comment on table hr.link_attempts is '직원 확인 링크의 본인 확인 시도(15분 안에 5번 틀리면 잠금). 입력한 번호는 남기지 않는다';

alter table hr.workplace_stamps enable row level security;
alter table hr.employee_links   enable row level security;
alter table hr.link_attempts    enable row level security;
grant all on hr.workplace_stamps, hr.employee_links, hr.link_attempts to service_role;
grant all on all sequences in schema hr to service_role;
revoke all on hr.workplace_stamps, hr.employee_links, hr.link_attempts from anon;
revoke all on hr.workplace_stamps, hr.employee_links, hr.link_attempts from authenticated;

notify pgrst, 'reload schema';
