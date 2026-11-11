-- 165: AI 에이전트 예약 신호 — '초안을 매주 n요일 n시까지 작성' (2026-11-11 대표 지시)
--
-- 짜임: 092(아침 일정 알림)와 같다. pg_cron 은 매시 45분에 /api/agents/tick 을 노크만 하고,
--  실제로 작성할지는 앱이 예약 설정(AI 에이전트 화면 — b2b_settings agent_schedule:<에이전트>)을 보고 정한다.
--  → 요일·시각을 바꾸거나 예약을 꺼도 SQL 을 다시 만질 필요가 없다. 차례가 아니면 앱이 즉시 건너뛴다.
--  'n시까지' = n시 15분 전(45분 신호)에 시작해 1~4분 안에 초안이 올라온다. 같은 목표 시각은 한 번만 작성한다.
--  호출 수: 하루 24번(월 약 720번). 미들웨어 밖이라 미들웨어 호출은 늘지 않는다.
--
-- ★ 운영 배포(이 기능이 든 코드가 main 에 나간 뒤)에 적용할 것 — 옛 코드는 이 주소가 없어 404 만 돌려준다(피해는 없음).
-- ★ 적용 전에 <<DIGEST_CRON_KEY>> 를 실제 값으로 바꿀 것 (Vercel 환경변수 DIGEST_CRON_KEY — 092 와 같은 값).
--    바꾸지 않고 실행해도 앱이 401 로 거절할 뿐 다른 피해는 없다(예약 작성만 안 된다 — 화면이 '예약 신호가 오지 않습니다'를 보인다).
--
-- 실행 확인: select jobname, schedule, active from cron.job;
--            select status, return_message, start_time from cron.job_run_details order by start_time desc limit 10;
-- 끄기:      select cron.unschedule('agent-tick');

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$ begin perform cron.unschedule('agent-tick'); exception when others then null; end $$;

select cron.schedule(
  'agent-tick',
  '45 * * * *',
  $$
  select net.http_post(
    url := 'https://meeting-notes-beryl.vercel.app/api/agents/tick',
    body := jsonb_build_object('tick', true),
    headers := jsonb_build_object('Authorization', 'Bearer <<DIGEST_CRON_KEY>>', 'Content-Type', 'application/json'),
    timeout_milliseconds := 60000
  ) as request_id;
  $$
);
