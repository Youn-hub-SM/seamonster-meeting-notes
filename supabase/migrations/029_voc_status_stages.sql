-- VOC 처리상태 3단계 재정의: 접수 / 응대·개선중 / 개선완료 (씨몬스터 기본 워크플로)
--  기존(대기·진행중·완료) → 신규로 매핑 후 체크 제약·기본값 교체. 멱등 — 재실행 안전.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run.

alter table voc drop constraint if exists voc_status_check;
alter table voc alter column status drop default;

update voc set status = '접수'       where status = '대기';
update voc set status = '응대·개선중' where status = '진행중';
update voc set status = '개선완료'    where status = '완료';

alter table voc alter column status set default '접수';
alter table voc add constraint voc_status_check check (status in ('접수', '응대·개선중', '개선완료'));

NOTIFY pgrst, 'reload schema';
