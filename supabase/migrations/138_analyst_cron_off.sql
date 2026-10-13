-- 138 종합 리포트 14:30 자동 생성·발송 예약 해제 (2026-10-13 대표 결정: "자동발송도 빼줘. 발송은 수동으로만 — 매출 리포트와 동일")
--
-- ■ 왜
--   122(daily-analyst, 매일 14:30) · 124(weekly-analyst 월~수 14:35, monthly-analyst 1~5일 14:40) 예약이 /api/analyst/cron 을 불러
--   리포트를 자동 생성(AI 호출)·발송했다. 이제 발송은 /briefing [보내기](메일)로만 한다.
--   코드 쪽은 이미 /api/analyst/cron 이 아무것도 하지 않게 바뀌었다(적용 전에 예약이 돌아도 AI 호출·메일 없음) — 이 파일은 예약 자체를 지운다.
--
-- ■ 바뀌는 것
--   cron.job 에서 daily-analyst · weekly-analyst · monthly-analyst 세 줄 삭제. 표·데이터는 그대로(analyst_reports·analyst_period_reports).
--
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 이미 없으면 조용히 넘어간다.
-- 확인: select jobname, schedule, active from cron.job order by jobname;  → 위 세 이름이 없어야 한다(다른 작업은 그대로).

do $$ begin perform cron.unschedule('daily-analyst');   exception when others then null; end $$;
do $$ begin perform cron.unschedule('weekly-analyst');  exception when others then null; end $$;
do $$ begin perform cron.unschedule('monthly-analyst'); exception when others then null; end $$;
