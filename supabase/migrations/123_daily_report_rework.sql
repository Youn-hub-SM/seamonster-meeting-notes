-- 123: 일일 리포트 개편 (2026-09-30 대표 결정)
--  1) 06:30 업무 브리핑 자동 생성 중단 — 103 의 daily-briefing 예약 삭제(코드 /api/briefing/cron 도 이미 아무것도 하지 않는다).
--  2) analyst_reports.sent_fp — 팀즈로 보낸 버전의 매출 지문(건수:합계). 다시 분석해도 발송 기록을 지우지 않고,
--     14:30 자동 발송은 '매출이 반영된 리포트를 보낸 적이 없을 때'만 돈다(광고만 먼저 보낸 것은 발송으로 치지 않는다).
--  적용: Supabase SQL Editor 에 붙여넣고 Run. 멱등. 키 치환 없음.
--  확인: select jobname, schedule, active from cron.job;  → daily-briefing 이 없어야 하고 daily-analyst(30 5 * * *)는 남아 있어야 한다(다른 작업은 그대로).

do $$ begin perform cron.unschedule('daily-briefing'); exception when others then null; end $$;

alter table analyst_reports add column if not exists sent_fp text;
-- 적용 전에 보낸 리포트는 그 버전을 보낸 것으로 본다(적용 당일 14:30 이 한 번 더 보내지 않게)
update analyst_reports set sent_fp = sales_fp where sent_at is not null and sent_fp is null;

notify pgrst, 'reload schema';
