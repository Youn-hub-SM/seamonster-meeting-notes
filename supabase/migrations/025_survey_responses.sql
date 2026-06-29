-- 설문 응답 수집(Tally 등) — VOC 클레임과 분리된 별도 수집란.
-- 폼이 제각각이므로 답변을 통째로 jsonb 로 보존. 적용: SQL Editor 에 붙여넣고 Run. 멱등.

create table if not exists survey_responses (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'tally',          -- 수집 출처
  form_id text,                                  -- 폼 식별자
  form_name text,                                -- 폼 이름
  submission_id text unique,                     -- 제출 고유 id (중복 방지)
  respondent text,                               -- 응답자(이름/이메일 등, 추출 시)
  submitted_at timestamptz,                      -- 제출 시각
  answers jsonb not null default '[]'::jsonb,    -- [{label, value}] 질문·답변 전체
  summary text,                                  -- 미리보기/검색용 합친 텍스트
  photos jsonb not null default '[]'::jsonb,     -- 첨부 파일 URL 배열
  created_at timestamptz not null default now()
);

create index if not exists survey_responses_submitted_idx on survey_responses (submitted_at desc);
create index if not exists survey_responses_form_idx on survey_responses (form_id);

alter table survey_responses enable row level security;  -- 서비스롤로만 접근(정책 없음)

NOTIFY pgrst, 'reload schema';
