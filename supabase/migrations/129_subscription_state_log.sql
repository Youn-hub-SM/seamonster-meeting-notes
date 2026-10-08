-- 129 정기배송 상태 변경 로그(2026-10-08 대표 결정)
--
-- ■ 왜
--   매일 수집(127)은 각 신청의 '지금 상태' 한 줄만 덮어쓴다. 어제 일시정지였다가 오늘 이용중으로
--   바뀌어도 어제 값이 사라져, "일시정지했다가 다시 시작한" 흐름을 알 수 없었다.
--   이 표는 수집 때 신청 단위 상태(U 이용중 / P 일시정지 / C 해지)가 직전 저장값과 달라진 신청만
--   한 줄 기록한다. 신청번호로 어떤 신청이 재개·정지·해지됐는지 추적한다(정확한 고객은 카페24에서 확인).
--
-- ■ 개인정보 — 저장하지 않는다
--   127 과 같다. 신청번호와 회원 아이디 HMAC(되돌릴 수 없는 암호화 값)만 남긴다. 이름·연락처·주소 없음.
--
-- ■ 멱등 / 정확성
--   같은 데이터를 다시 수집해도 '직전 저장값 == 새 값'이라 아무것도 기록되지 않는다.
--   변화를 '관측한' 기준일(changed_on = 수집 asOf)만 안다 — 수집이 하루 1회라 하루 안의 정지↔재개는 묶여 보일 수 있다.
--   이 표가 생긴 이후의 변화부터 쌓인다(과거 전이는 수집 이력이 없어 소급 불가).
--
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.
--   미적용이어도 수집(127)과 분석 화면은 그대로 동작한다(상태 변화 섹션만 비어 보인다).

create table if not exists public.cafe24_subscription_state_log (
  id              bigint generated always as identity primary key,
  subscription_id text not null,             -- 신청번호(S-YYYYMMDD-NNNNNNN)
  member_hash     text,                      -- 회원 아이디 HMAC(고객 단위 묶기용)
  prev_state      text,                      -- 직전 상태 U/P/C, null = 최초 관측(신규 유입)
  new_state       text not null,             -- 바뀐 상태 U 이용중 / P 일시정지 / C 해지
  round           integer,                   -- 변화 시점 대표 회차(품목 최대 subscription_shipments_sequence) — 'n회 구독 중 정지·해지' 집계용
  cycle           text,                      -- 변화 시점 배송주기 라벨('2주'·'1개월' 등)
  changed_on      date not null,             -- 변화를 관측한 기준일(수집 asOf)
  created_at      timestamptz not null default now()
);
-- 이미 적용된 환경에도 컬럼을 더한다(재실행 안전)
alter table public.cafe24_subscription_state_log add column if not exists round integer;
alter table public.cafe24_subscription_state_log add column if not exists cycle text;
create index if not exists cafe24_sub_state_log_sub_idx    on public.cafe24_subscription_state_log (subscription_id, created_at);
create index if not exists cafe24_sub_state_log_member_idx on public.cafe24_subscription_state_log (member_hash);
create index if not exists cafe24_sub_state_log_changed_idx on public.cafe24_subscription_state_log (changed_on);

-- 서버(service role)만 읽고 쓴다 — 공개 키로는 접근 불가
alter table public.cafe24_subscription_state_log enable row level security;

notify pgrst, 'reload schema';
