-- 154 AI 비서 지식 통합 3단계 (2026-10-27, docs/assistant-knowledge-plan.md, 대표 결정 A5 폐기)
--  회사 지식의 단일 기준은 셰어포인트 매뉴얼의 '[비서]' 페이지. 업무도우미 안의 지식 사본을 없앤다.
--  · cs_manual(CS 코치 매뉴얼 6항목) → '[비서] CS'·'CS 보상·판정 기준'·'CS 담당자표'·'반복 클레임 응대 매뉴얼'·'이유식 생선 고객 답변 가이드라인' 페이지로 이관 완료
--  · report_glossary(회사 용어 사전 2항목) → '[비서] 용어 정의' 페이지로 이관 완료
--  · b2b_settings 'notice_prompt'(공지 톤) → '[비서] 공지문 작성 기준' 페이지
--  report_feedback 은 그대로(비서 피드백). run_report 차단 정규식의 report_glossary 이름은 남아 있어도 무해.

drop table if exists cs_manual;
drop table if exists report_glossary;
delete from b2b_settings where key = 'notice_prompt';
