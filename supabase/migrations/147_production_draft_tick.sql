-- 147: 주간 생산 요청서 AI 초안 — 작성 시각·자동 작성 켜기를 설정 화면에서 (2026-10-21 대표 지시)
--
-- 짜임: 092(아침 일정 알림)와 같다. pg_cron 은 수요일(KST)에 5분마다 초안 API 를 노크만 하고({tick:true}),
--  실제로 만들지는 앱이 설정(관리자 › 설정 › 생산·재고 — b2b_settings production_draft_schedule)을 보고 정한다.
--  → 작성 시각을 바꿔도 SQL 을 다시 만질 필요가 없다. 작성 시각이 아니면 즉시 건너뛴다.
--  중계 서버 crontab(수 13:50)은 예비로 그대로 둔다 — 꺼져 있거나 작성 시각 전이면 앱이 건너뛰고, 이미 만들었으면 다시 만들지 않는다.
--
-- KST 수요일 = UTC 화요일 15:00 ~ 수요일 15:00 → 잡은 UTC 화·수(2,3)에 돌고 요일·시각 판정은 앱이 KST 로 한다.
--
-- ★ 운영 배포(이 기능이 든 코드가 main 에 나간 뒤)에 적용할 것 — 옛 코드는 이 키를 몰라 401 로 거절만 한다(피해는 없음).
-- ★ 적용 전에 <<DIGEST_CRON_KEY>> 를 실제 값으로 바꿀 것 (Vercel 환경변수 DIGEST_CRON_KEY — 092 와 같은 값).
--    바꾸지 않고 실행해도 앱이 401 로 거절할 뿐 다른 피해는 없다(중계 서버가 지금처럼 수 13:50 에 만든다).
--
-- 실행 확인: select jobname, schedule, active from cron.job;
--            select status, (response).status_code, start_time from cron.job_run_details order by start_time desc limit 10;

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$ begin perform cron.unschedule('production-draft-tick'); exception when others then null; end $$;

select cron.schedule(
  'production-draft-tick',
  '*/5 * * * 2,3',
  $$
  select net.http_post(
    url := 'https://meeting-notes-beryl.vercel.app/api/production/requests/draft',
    body := jsonb_build_object('tick', true),
    headers := jsonb_build_object('Authorization', 'Bearer <<DIGEST_CRON_KEY>>', 'Content-Type', 'application/json'),
    timeout_milliseconds := 60000
  ) as request_id;
  $$
);
