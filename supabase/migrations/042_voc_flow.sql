-- 042 VOC → flow.team(플로우) 업무 등록 연동.
--  · 한 VOC를 flow 프로젝트의 업무(task)로 등록한 뒤, 중복 등록 방지 + '등록됨' 표시용 링크 컬럼.
alter table voc add column if not exists flow_task_id    text;         -- flow가 반환한 업무(post) 식별자(있으면)
alter table voc add column if not exists flow_project_id text;         -- 어느 프로젝트에 등록됐는지
alter table voc add column if not exists flow_task_at    timestamptz;  -- 등록 시각(값 있으면 '등록됨')

notify pgrst, 'reload schema';
