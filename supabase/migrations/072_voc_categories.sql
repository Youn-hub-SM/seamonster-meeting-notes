-- 072_voc_categories.sql
-- VOC '문제 유형'을 관리 객체로 승격 — 유형 마스터 테이블 + 유형별 개선 상태.
--  배경: 개선 작업은 Flow 에서 하므로 VOC 건별 상태(접수/응대·개선중/개선완료) UI 는 제거하고,
--  개선 추적은 '유형 단위'로 한다. 유형이 개선완료 처리되면 resolved_at 이 남아 월말 결산의
--  '개선' 축이 된다(발생 = voc.received_at 기준).
--
--  적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run.

create table if not exists voc_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  fault text not null default '미분류' check (fault in ('제조사','물류','자사','고객','미분류')), -- 귀책 기본값(등록 시 자동 추정)
  status text not null default '관찰' check (status in ('관찰','개선중','개선완료')),             -- 유형별 개선 상태
  resolved_at timestamptz,        -- 마지막 개선완료 처리 시각(월말 결산 '개선' 축). 재발로 되돌려도 지우지 않음
  sort int not null default 0,
  active boolean not null default true, -- 비활성 = 새 등록 선택지에서 숨김(과거 데이터는 유지)
  memo text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table voc_categories enable row level security;

-- 기존 8종 시드 — 귀책 기본값은 기존 하드코딩(FAULT_BY_CATEGORY)과 동일
insert into voc_categories (name, fault, sort) values
  ('배송', '물류', 1),
  ('품질', '제조사', 2),
  ('포장', '제조사', 3),
  ('누락', '자사', 4),
  ('오배송', '물류', 5),
  ('가시', '제조사', 6),
  ('이물', '제조사', 7),
  ('기타', '미분류', 8)
on conflict (name) do nothing;

-- voc.category 의 8종 고정 CHECK 해제 — 유형을 사용자가 추가/수정할 수 있게 (023 에서 생성된 제약)
alter table voc drop constraint if exists voc_category_check;

-- PostgREST 스키마 캐시 갱신
NOTIFY pgrst, 'reload schema';
