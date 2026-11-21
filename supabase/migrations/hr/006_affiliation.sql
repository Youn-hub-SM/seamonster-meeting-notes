-- hr/006 소속 (2026-11-21, docs/payroll-leave-plan.md 19장)
--
-- 대표: "소속 필드를 넣어줘. 한 회사에 여러 소속이 있어. 지금은 파도소리, 엄마와 바다 가 있어."
-- ■ 무엇을 바꾸나
--   · hr.workplaces.affiliations — 그 사업장(회사) 안의 소속 이름 목록. [사업장 수정] 창에서 고친다.
--   · hr.employees.affiliation  — 직원의 소속(그 목록 가운데 하나의 이름). 빈 값 = 정하지 않음.
--   소속은 이름(글자)으로 둔다 — 목록에서 이름을 지워도 그 소속이던 직원의 값은 그대로 남는다(화면이 '목록에 없음'으로 보여 준다).
--   부서(dept)와는 다른 칸이다: 소속 = 회사 안의 사업 단위(파도소리 · 엄마와 바다), 부서 = 그 안의 팀.
-- ■ 처음 값
--   사업장이 하나뿐이고 소속 목록이 비어 있으면 '파도소리', '엄마와 바다'를 넣어 둔다.
--   사업장이 둘 이상이면 넣지 않는다(어느 회사의 소속인지 알 수 없다) — [사업장 수정]에서 직접 넣는다.
-- ■ 미적용이면
--   소속 칸 없이 그대로 돈다(인사대장·직원 등록·엑셀은 평소대로). 소속을 넣으려 하면 'DB 준비 전(hr/006 적용)'을 보인다.
--
-- 이 번호열은 hr 스키마 밖을 건드리지 않는다. 적용: Supabase SQL Editor 에 이 파일 하나를 붙여넣고 Run. hr/005 다음.
-- 다시 실행해도 된다 — 단, 소속 목록을 일부러 비워 둔 사업장 하나짜리 환경에서는 처음 값이 다시 들어간다.

alter table hr.workplaces add column if not exists affiliations text[] not null default '{}';
comment on column hr.workplaces.affiliations is '소속 이름 목록(한 회사 안의 사업 단위 — 예: 파도소리, 엄마와 바다). 직원의 소속은 이 가운데서 고른다';

alter table hr.employees add column if not exists affiliation text not null default '';
comment on column hr.employees.affiliation is '소속(사업장 affiliations 가운데 하나의 이름). 빈 값 = 정하지 않음. 부서(dept)와 다른 칸';

update hr.workplaces
   set affiliations = array['파도소리', '엄마와 바다']
 where affiliations = '{}'
   and (select count(*) from hr.workplaces) = 1;

notify pgrst, 'reload schema';
