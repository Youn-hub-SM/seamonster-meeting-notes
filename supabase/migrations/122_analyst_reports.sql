-- 122: 어제 분석 에이전트 보관 + 14:30 KST 예약 실행 (2026-09-30)
--  적용: Supabase SQL Editor 에 붙여넣고 Run. 멱등.
--  ※ 아래 cron 블록의 <<DIGEST_CRON_KEY>> 를 Vercel 환경변수 DIGEST_CRON_KEY 값으로 바꾼 뒤 실행하세요(103 일일 리포트와 같은 키).
--  확인: select jobname, schedule, active from cron.job;
--        select status, (response).status_code, start_time from cron.job_run_details order by start_time desc limit 10;

create table if not exists analyst_reports (
  report_date date primary key,          -- 분석 대상일(어제, KST)
  status text not null default 'ok',     -- ok | error | running(실행 중 점유 — 6분 지나면 죽은 실행으로 보고 다시 점유)
  sales_ready boolean not null default false, -- 소매 매출(엑셀) 반영 여부 — false 면 광고만 본 보고
  sales_fp text,                         -- 분석 때 본 소매 매출 지문(건수:합계) — 바뀌었을 때만 다시 분석
  facts jsonb not null default '{}'::jsonb,   -- 코드가 계산한 사실·flags·도구 호출 기록
  report_md text,                        -- AI 보고서(마크다운)
  model text,
  usage jsonb,                           -- 토큰·반복·추정 비용(USD)
  trigger text,                          -- upload | cron | manual
  error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table analyst_reports add column if not exists sales_fp text;

-- 서비스롤 전용(앱 서버만 접근) — 정책을 두지 않는 기존 관행 그대로
alter table analyst_reports enable row level security;

-- 예약 실행: 매일 05:30 UTC = 14:30 KST (매출 업로드 직후 실행을 놓친 날의 보험. 매출이 없으면 광고만 먼저)
create extension if not exists pg_cron;
create extension if not exists pg_net;
do $$ begin perform cron.unschedule('daily-analyst'); exception when others then null; end $$;
select cron.schedule(
  'daily-analyst',
  '30 5 * * *',
  $$
  select net.http_get(
    url := 'https://meeting-notes-beryl.vercel.app/api/analyst/cron',
    headers := jsonb_build_object('Authorization', 'Bearer <<DIGEST_CRON_KEY>>'),
    timeout_milliseconds := 20000
  ) as request_id;
  $$
);

notify pgrst, 'reload schema';
