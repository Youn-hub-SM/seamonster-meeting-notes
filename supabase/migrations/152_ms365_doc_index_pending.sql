-- 152 문서 색인 'pending' 상태 (2026-10-27)
--  151 의 색인은 폴더를 하나씩 걷느라 파일 1,500개에 시간 예산을 다 써 본문을 한 건도 못 읽었다.
--  바꾼 방식: Graph 변경분(delta)으로 목록을 받아 새·바뀐 파일을 먼저 'pending' 으로 저장하고, 남은 예산에서 작은 파일부터 읽는다.
--  못 읽은 것은 다음 실행(버튼 자동 반복·크론 틱)이 이어서 읽는다.

alter table ms365_doc_index drop constraint if exists ms365_doc_index_status_check;
alter table ms365_doc_index add constraint ms365_doc_index_status_check check (status in ('ok', 'skipped', 'error', 'pending'));
create index if not exists ms365_doc_index_pending_idx on ms365_doc_index (site_id, status, size_kb);

comment on column ms365_doc_index.status is 'ok=본문 저장 · skipped=읽지 않는 형식/25MB 초과(이름만) · error=읽기 실패 · pending=목록엔 있고 본문은 아직';
