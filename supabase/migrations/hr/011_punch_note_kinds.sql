-- 급여·연차 창: 미리 적기에 조퇴·결근·병가 (2026-11-25)
--
-- ■ 왜
--   대표: "근무대장의 미리적기에 출퇴근 미입력뿐 아니라 조퇴, 결근, 병가, 기타 를 미리 적을 수 있도록 해줘"
--   hr/010 의 punch_notes.kind 는 ('in','out','both','etc') 넷만 받는다. 여기에 early(조퇴)·absent(결근)·sick(병가)를 더한다.
-- ■ 바뀌는 것
--   hr.punch_notes 의 kind 제약 하나뿐이다. 표·칸·데이터는 그대로다(이미 적어 둔 것도 그대로).
-- ■ 미적용이면
--   지금까지의 넷(출근 못 찍음·퇴근 못 찍음·둘 다 못 찍음·기타)은 그대로 적힌다.
--   조퇴·결근·병가만 저장이 거절되고 화면에 'DB 준비 전(hr/011 적용)'이 보인다.
--
-- 이 번호열은 hr 스키마 밖을 건드리지 않는다. 적용: Supabase SQL Editor 에 이 파일 하나를 붙여넣고 Run. 멱등 — 재실행 안전. hr/010 다음.

do $$
declare c text;
begin
  if to_regclass('hr.punch_notes') is null then
    raise exception 'hr.punch_notes 가 없습니다. hr/010_attendance.sql 을 먼저 적용하세요.';
  end if;
  -- kind 에 걸린 옛 제약을 이름과 무관하게 걷는다(010 은 이름을 정하지 않고 만들었다)
  for c in
    select conname from pg_constraint
    where conrelid = 'hr.punch_notes'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ '\mkind\M'
  loop
    execute format('alter table hr.punch_notes drop constraint %I', c);
  end loop;
  alter table hr.punch_notes
    add constraint punch_notes_kind_check check (kind in ('in', 'out', 'both', 'early', 'absent', 'sick', 'etc'));
end $$;

comment on column hr.punch_notes.kind is '미리 적은 내용: in 출근 못 찍음 · out 퇴근 못 찍음 · both 둘 다 못 찍음 · early 조퇴 · absent 결근 · sick 병가 · etc 기타';
comment on table hr.punch_notes is '출근 기록에 대해 미리 들은 것(못 찍음·조퇴·결근·병가·기타). 세콤 파일을 넣을 때 그날 줄에 붙는다';
