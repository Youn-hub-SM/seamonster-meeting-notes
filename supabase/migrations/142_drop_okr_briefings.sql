-- 142 안 쓰는 기능 정리 — OKR 1:1 체크인·옛 06:30 업무 브리핑 삭제 (2026-10-20 대표 결정 "drop")
--
-- ■ 지우는 것
--   okr_checkins(097)  — OKR 1:1 체크인 기록. 화면·API 는 이미 없고 표만 남아 있었다.
--   briefings(103)     — 옛 06:30 업무 브리핑 본문. 2026-09-30 중단, 코드(app/lib/briefing.ts·/api/briefing)는 이 커밋에서 삭제.
--   b2b_settings 의 옛 브리핑 키: briefing_auto, briefing_webhook, ai_model_briefing.
-- ■ 건드리지 않는 것
--   /briefing 화면과 analyst_reports·analyst_period_reports(종합 리포트)는 그대로. analyst_mail_to(종합 리포트 메일 수신자)도 그대로.
--   run_report(141) 차단 정규식의 okr_checkins·briefings 이름은 표가 없어져 아무 효과가 없으니 두었다.
-- ■ 되돌릴 수 없음 — 두 표의 데이터가 사라진다(대표 확인: 사용하지 않는 기능).
--
-- 적용: Supabase Dashboard > SQL Editor 에 전체 붙여넣고 Run. 멱등 — 재실행 안전.

drop table if exists public.okr_checkins;
drop table if exists public.briefings;

delete from public.b2b_settings where key in ('briefing_auto', 'briefing_webhook', 'ai_model_briefing');

notify pgrst, 'reload schema';
