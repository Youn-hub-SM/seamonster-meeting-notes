-- 163: 주간 생산 요청서 AI 초안 삭제(2026-11-08 대표: "안 쓰고 있어") — 147 의 pg_cron 틱을 해제한다.
--   코드(/api/production/requests/draft·설정 카드·중계 crontab)는 같은 날 지웠다. b2b_settings 의 production_draft_* 키도 지운다(읽는 곳 없음).
-- 적용: Supabase SQL Editor 에 붙여넣고 Run. 멱등.
do $$ begin perform cron.unschedule('production-draft-tick'); exception when others then null; end $$;
delete from b2b_settings where key in ('production_draft_schedule', 'production_draft_done', 'production_draft_last_run', 'production_draft_ai_note');
