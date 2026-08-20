-- 096 VOC → 아사나(Asana) 업무 등록 연동 — 협업 스택 전환(flow 대체, 2026-08-21).
--  · 042(flow)와 같은 구조: 등록 식별자 + 중복 방지 + '등록됨' 표시. flow 컬럼은 이력 보존을 위해 그대로 둔다.
alter table voc add column if not exists asana_task_gid text;         -- 아사나가 반환한 task gid
alter table voc add column if not exists asana_task_url text;         -- 업무 바로가기(permalink) — 목록의 ✓에서 클릭 이동
alter table voc add column if not exists asana_task_at  timestamptz;  -- 등록 시각(값 있으면 '등록됨')

notify pgrst, 'reload schema';
