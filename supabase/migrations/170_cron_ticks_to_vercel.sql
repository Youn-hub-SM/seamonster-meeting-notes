-- 170: 예약 신호를 Supabase pg_cron → Vercel 크론으로 옮긴 뒤, 옛 pg_cron HTTP 틱 세 개를 끈다 (2026-11-18, Vercel Pro)
--
-- ■ 왜
--   Hobby 요금제에서는 Vercel 크론이 하루 1회뿐이라, pg_cron 이 5분마다(또는 매시) 앱을 두드리는 우회를 썼다.
--   Pro 에서는 분 단위 크론이 되므로 예약을 vercel.json 한 곳으로 모았다:
--     /api/b2b/schedule-digest  5분마다   (일정 알림 — 옛 092 b2b-digest-tick)
--     /api/agents/tick          매시 45분 (AI 에이전트 예약 — 옛 165 agent-tick)
--     /api/form-sms/tick        5분마다   (신청자 문자 — 옛 167 form-sms-tick, 168 은 적용하지 않는다)
--   앱은 이미 옛 신호를 받기만 하고 아무 일도 하지 않는다(코드가 운영에 나간 뒤부터). 이 파일은 쓸모없어진 호출을 멈춘다.
--
-- ★ 적용 시점: 이 변경이 든 코드가 운영(main)에 나가고, 일정 알림이 정한 시각에 한 번 정상으로 온 것을 확인한 뒤.
--   (먼저 적용하면 옛 코드에서는 일정 알림·에이전트 예약·신청자 문자의 신호가 끊긴다.)
--   적용하지 않아도 피해는 없다 — 옛 신호가 계속 와서 호출 수만 조금 든다(하루 약 300번).
--
-- 건드리지 않는 것: 093 의 product-cost-schedule-apply(DB 안에서만 도는 잡 — HTTP 를 쏘지 않는다).
--
-- 실행 확인: select jobname, schedule, active from cron.job;   -- 아래 세 이름이 없어야 한다
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전(없는 잡은 조용히 넘어간다).

do $$ begin perform cron.unschedule('b2b-digest-tick'); exception when others then null; end $$;
do $$ begin perform cron.unschedule('agent-tick');      exception when others then null; end $$;
do $$ begin perform cron.unschedule('form-sms-tick');   exception when others then null; end $$;
