-- 168: 신청자 문자 예약 신호를 5분마다로 (2026-11-14 대표: "보내는 시각을 커스텀 할 수 있게, 즉시도 포함")
--
-- ■ 왜
--   167 은 매일 13:00(KST)에 한 번만 신호를 보냈다 — 보내는 시각이 13시로 고정이었다.
--   이제 화면(마케팅 › 신청자 문자)에서 '매일 hh:mm' 또는 '즉시'를 고른다. 보낼 차례인지는 앱이 설정을 보고 정하므로
--   pg_cron 은 5분마다 /api/form-sms/tick 을 두드리기만 한다 — 시각을 바꿔도 SQL 을 다시 만질 필요가 없다.
--     매일 hh:mm = 그 시각이 지난 뒤 첫 신호에 하루 한 번.
--     즉시       = 신호마다 새 신청을 가져와 보낸다(신청 뒤 5분 안).
--   호출 수: 하루 288번(월 약 8,640번). 미들웨어 밖이라 미들웨어 호출은 늘지 않는다. 꺼져 있거나 차례가 아니면 앱이 즉시 끝낸다.
--
-- ★ 적용 전에 <<DIGEST_CRON_KEY>> 를 실제 값으로 바꿀 것 (167 에 넣은 값과 같다 — Vercel 환경변수 DIGEST_CRON_KEY).
-- ★ 이 기능이 든 코드가 운영(main)에 나간 뒤에야 신호가 받아들여진다(그 전에는 404 — 피해 없음).
--   적용하지 않으면 167 의 신호(매일 13:00 한 번)만 온다 — '즉시'와 13:00 이후 시각은 동작하지 않는다(화면에 경고가 보인다).
--
-- 실행 확인: select jobname, schedule, active from cron.job where jobname = 'form-sms-tick';
--            select status, return_message, start_time from cron.job_run_details order by start_time desc limit 10;
-- 끄기:      select cron.unschedule('form-sms-tick');
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$ begin perform cron.unschedule('form-sms-tick'); exception when others then null; end $$;

select cron.schedule(
  'form-sms-tick',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://meeting-notes-beryl.vercel.app/api/form-sms/tick',
    body := jsonb_build_object('tick', true),
    headers := jsonb_build_object('Authorization', 'Bearer <<DIGEST_CRON_KEY>>', 'Content-Type', 'application/json'),
    timeout_milliseconds := 60000
  ) as request_id;
  $$
);
