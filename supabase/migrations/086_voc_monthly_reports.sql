-- 086 월간 VOC 리포트 자동 저장 — 생성/편집한 초안을 (월, 수신 제조사) 단위로 보관해
--  화면을 다시 열어도 바로 볼 수 있게 한다. AI 재생성 없이 이어서 편집 가능.
--
-- 적용: Supabase SQL Editor 에 이 파일 하나만 붙여넣고 Run. 멱등(재실행 안전).
-- 미적용이어도 화면은 동작한다(저장만 비활성 — 안내 문구 표시).

create table if not exists voc_monthly_reports (
  id         uuid primary key default gen_random_uuid(),
  month      text not null,                 -- YYYY-MM
  recipient  text not null default '',      -- 수신 제조사명(빈 값 = 미지정)
  draft      text not null default '',      -- AI 초안 + 사용자의 편집 결과
  counts     jsonb,                         -- { claims, surveys } 생성 당시 반영 건수
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (month, recipient)
);

create index if not exists voc_monthly_reports_month_idx on voc_monthly_reports (month);

notify pgrst, 'reload schema';
