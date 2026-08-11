-- 092: 일정 알림 발송 시각을 설정에서 바꾸는 구조 — 091(06:00·16:00 고정 잡 2개)을 대체한다.
--
-- 짜임: pg_cron 은 5분마다 앱 API 를 가볍게 노크만 하고(?gate=times), 실제로 보낼지는
--  앱이 설정(digest_config.times — B2B 설정 화면에서 편집)을 보고 정한다.
--  → 발송 시각을 바꿔도 SQL 을 다시 만질 필요가 없다. 호출은 하루 288번이지만
--  발송 시각이 아니면 즉시 스킵이라 부하는 무시할 수준이다.
--
-- 091 을 적용했든 안 했든 이 파일 하나만 실행하면 된다(옛 잡을 지우고 틱 잡을 만든다).
--
-- ★ 적용 전에 <<DIGEST_CRON_KEY>> 를 실제 값으로 바꿀 것 (Vercel 환경변수 DIGEST_CRON_KEY).
--    바꾸지 않고 실행해도 앱이 401 로 거절할 뿐 다른 피해는 없다(예비 Vercel 크론이 지금처럼 발송).
--
-- 실행 확인: select jobname, schedule, active from cron.job;
--            select status, (response).status_code, start_time from cron.job_run_details order by start_time desc limit 10;

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 091 의 고정 시각 잡 + 이전 틱 잡 정리 (없으면 조용히 넘어감)
do $$ begin perform cron.unschedule('b2b-digest-am'); exception when others then null; end $$;
do $$ begin perform cron.unschedule('b2b-digest-pm'); exception when others then null; end $$;
do $$ begin perform cron.unschedule('b2b-digest-tick'); exception when others then null; end $$;

select cron.schedule(
  'b2b-digest-tick',
  '*/5 * * * *',
  $$
  select net.http_get(
    url := 'https://meeting-notes-beryl.vercel.app/api/b2b/schedule-digest',
    params := jsonb_build_object('gate', 'times'),
    headers := jsonb_build_object('Authorization', 'Bearer <<DIGEST_CRON_KEY>>'),
    timeout_milliseconds := 20000
  ) as request_id;
  $$
);
