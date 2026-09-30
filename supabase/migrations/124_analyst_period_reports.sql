-- 124: 종합 리포트 — 주간·월간 보관 + 14:30 자동 발송 예약 (2026-09-30 대표 결정)
--  주간 = 월~일(전주·최근 4주 평균과 비교), 월간 = 달력 한 달(전월·작년 같은 달과 비교). 일일은 기존 analyst_reports(122) 그대로.
--  적용: 주간·월간 코드가 운영에 배포된 뒤 Supabase SQL Editor 에 붙여넣고 Run(먼저 적용하면 옛 운영 코드가 ?period 를 몰라 14:35·14:40 에 일일을 한 번 더 돈다).
--   멱등. 키 치환 없음 — 122 의 daily-analyst 예약 명령을 복사해 주소만 바꾼다(122 가 먼저 적용돼 있어야 한다).
--  확인: select jobname, schedule, active from cron.job;  → weekly-analyst(35 5 * * 1-3), monthly-analyst(40 5 1-5 * *) 가 새로 보여야 한다(다른 작업은 그대로).

create table if not exists analyst_period_reports (
  period text not null check (period in ('weekly', 'monthly')),
  report_date date not null,                 -- 기간 시작일(주간 = 월요일, 월간 = 1일)
  period_end date not null,                  -- 기간 마지막 날(주간 = 일요일, 월간 = 말일)
  status text not null default 'ok',         -- ok | error | running(실행 중 점유 — 6분 지나면 죽은 실행으로 보고 다시 점유)
  sales_ready boolean not null default false, -- 마지막 날 소매 매출까지 반영됐는가
  sales_fp text,                             -- 분석 때 본 소매 매출 지문(건수:합계:e|p — e = 마지막 날까지 들어옴)
  facts jsonb not null default '{}'::jsonb,  -- 코드가 계산한 사실·flags·도구 호출 기록
  report_md text,                            -- AI 리포트(마크다운, 광고 캠페인 표 포함)
  model text,
  usage jsonb,                               -- 토큰·반복·추정 비용(USD)
  trigger text,                              -- manual | cron
  error text,
  sent_at timestamptz,                       -- 마지막 팀즈 발송 시각(다시 분석해도 지우지 않는다)
  sent_fp text,                              -- 보낸 버전의 매출 지문
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (period, report_date)
);

-- 서비스롤 전용(앱 서버만 접근) — 정책을 두지 않는 기존 관행 그대로
alter table analyst_period_reports enable row level security;

-- 14:30 자동 발송 예약 — 일일(daily-analyst) 명령을 복사해 주소에 ?period= 만 붙인다
--  주간: 월~수 05:35 UTC = 14:35 KST(지난주 일요일 매출이 들어온 뒤), 월간: 매월 1~5일 05:40 UTC = 14:40 KST
do $$
declare cmd text; wk text; mo text;
begin
  select command into cmd from cron.job where jobname = 'daily-analyst';
  if cmd is null then raise exception 'daily-analyst 예약이 없습니다 — 122_analyst_reports.sql 을 먼저 적용하세요'; end if;
  wk := replace(cmd, '/api/analyst/cron''', '/api/analyst/cron?period=weekly''');
  mo := replace(cmd, '/api/analyst/cron''', '/api/analyst/cron?period=monthly''');
  if wk = cmd or mo = cmd then raise exception 'daily-analyst 명령에서 주소를 찾지 못했습니다 — 명령을 확인하세요'; end if;
  begin perform cron.unschedule('weekly-analyst'); exception when others then null; end;
  begin perform cron.unschedule('monthly-analyst'); exception when others then null; end;
  perform cron.schedule('weekly-analyst', '35 5 * * 1-3', wk);
  perform cron.schedule('monthly-analyst', '40 5 1-5 * *', mo);
end $$;

notify pgrst, 'reload schema';
