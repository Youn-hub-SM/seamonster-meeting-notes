-- 144 이익률 계산기 화면 삭제 — 설정 키 정리 (2026-10-20 대표 결정)
--
-- ■ 왜
--   이익률 계산기(/sales/margin-calc)의 산식이 AI 데이터 비서의 margin_calc 도구로 들어가(비서가 같은 숫자를 냄) 화면·API 를 지웠다.
--   남는 것: app/lib/margin-calc.ts 의 산식(computeSpecItem·loadMarginRef)과 원가표(products)·채널표(sales_channel_config).
-- ■ 지우는 것(b2b_settings kv)
--   margin_calc_prompt     — 계산기의 편집 가능 지침(비서는 쓰지 않음)
--   margin_calc_saved_list — 저장된 계산 시나리오 목록(비서에선 대화로 다시 물으면 됨)
--   ai_model_margin        — 계산기 전용 AI 모델 설정
-- ■ 되돌릴 수 없음 — 저장된 시나리오가 사라진다(대표 확인).
--
-- 적용: Supabase Dashboard > SQL Editor 에 전체 붙여넣고 Run. 멱등.

delete from public.b2b_settings where key in ('margin_calc_prompt', 'margin_calc_saved_list', 'ai_model_margin');

notify pgrst, 'reload schema';
