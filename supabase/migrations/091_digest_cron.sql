-- 091: B2B 일정 알림을 정시에 — Supabase pg_cron 이 06:00 · 16:00 KST 정각에 앱 API 를 호출한다.
--
-- 배경: Vercel Hobby 크론은 공식적으로 '시간 단위(±59분)' 정밀도라 06:09, 16:23 처럼 흔들린다.
--  정분 발화는 Pro 전용. 대신 이미 쓰는 Supabase 의 pg_cron(전 플랜 무료)은 매 분 정각에 돌므로
--  여기서 HTTP 로 호출하면 정시(수 초 이내)에 온다.
--
-- 역할 분담:
--  · pg_cron(이 파일)      = 주 발송 — 정각 호출
--  · vercel.json 크론 2개  = 예비 — 그 시간대 안 임의 분에 호출되지만, 슬롯별 dedup
--    (digest_last_sent / digest_last_sent_pm) 때문에 pg_cron 이 이미 보냈으면 조용히 건너뛴다.
--    pg_cron 이 실패한 날에만 예비가 (늦게라도) 보낸다.
--
-- ★ 적용 전에 아래 두 곳의 <<DIGEST_CRON_KEY>> 를 실제 값으로 바꿀 것 (Vercel 환경변수 DIGEST_CRON_KEY —
--    기존 CRON_SECRET 은 '민감' 변수라 값을 다시 꺼낼 수 없어 pg_cron 전용 보조 키를 따로 둔다).
--    바꾸지 않고 실행해도 앱이 401 로 거절할 뿐 다른 피해는 없다(예비 크론이 지금처럼 발송).
--
-- 시간대: pg_cron 스케줄은 UTC 다. 21시 UTC = 06시 KST, 07시 UTC = 16시 KST.
-- 실행 확인: select jobname, schedule, active from cron.job;
--            select * from cron.job_run_details order by start_time desc limit 10;

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 같은 이름으로 다시 schedule 하면 갱신(upsert)되지만, 이름 정리 겸 있으면 지우고 다시 만든다.
do $$ begin perform cron.unschedule('b2b-digest-am'); exception when others then null; end $$;
do $$ begin perform cron.unschedule('b2b-digest-pm'); exception when others then null; end $$;

select cron.schedule(
  'b2b-digest-am',
  '0 21 * * *',  -- 06:00 KST
  $$
  select net.http_get(
    url := 'https://meeting-notes-beryl.vercel.app/api/b2b/schedule-digest',
    params := jsonb_build_object('slot', 'am'),
    headers := jsonb_build_object('Authorization', 'Bearer <<DIGEST_CRON_KEY>>'),
    timeout_milliseconds := 20000
  ) as request_id;
  $$
);

select cron.schedule(
  'b2b-digest-pm',
  '0 7 * * *',  -- 16:00 KST
  $$
  select net.http_get(
    url := 'https://meeting-notes-beryl.vercel.app/api/b2b/schedule-digest',
    params := jsonb_build_object('slot', 'pm'),
    headers := jsonb_build_object('Authorization', 'Bearer <<DIGEST_CRON_KEY>>'),
    timeout_milliseconds := 20000
  ) as request_id;
  $$
);
