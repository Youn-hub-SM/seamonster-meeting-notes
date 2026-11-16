-- 169 회의 정리 기능 삭제 — 설정 키 정리 (2026-11-16 대표: "회의 정리 봇은 기능 완전 삭제. 이 기능 안 쓸거야.")
--
-- ■ 왜
--   회의 정리 화면(/meeting)과 API(/api/summarize, /api/meeting/terms, /api/b2b/settings/meeting-prompt)를 코드에서 지웠다.
--   정리 결과는 DB 에 저장하지 않았으므로 지울 표는 없고, 설정 표(b2b_settings)에 남은 키 세 개만 정리한다.
-- ■ 지우는 것(b2b_settings kv)
--   meeting_prompt   — 회의록 정리 지침(관리자 › 설정 › AI 에서 편집하던 값)
--   meeting_terms    — 회의 화면의 공유 용어집
--   ai_model_meeting — 회의록 정리 전용 AI 모델 설정
-- ■ 되돌릴 수 없음 — 용어집과 고쳐 쓴 지침이 사라진다. 적용하지 않아도 동작에는 영향이 없다(읽는 코드가 없다).
--
-- 적용: Supabase Dashboard > SQL Editor 에 전체 붙여넣고 Run. 멱등.

delete from public.b2b_settings where key in ('meeting_prompt', 'meeting_terms', 'ai_model_meeting');

notify pgrst, 'reload schema';
