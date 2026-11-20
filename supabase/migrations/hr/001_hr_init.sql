-- hr/001 급여·연차 관리 — 스키마·사업장·인사대장·시급 이력·요율·이력·로그인 시도 (2026-11-20, docs/payroll-leave-plan.md 1단계)
--
-- ■ 이 번호열(supabase/migrations/hr/*)은 본 번호열·factory 번호열과 별개로 001부터 센다.
--   **hr 번호열은 hr 스키마 밖(public·factory)을 만들거나 바꾸지 않는다.** (CLAUDE.md §3a 와 같은 규칙)
--   public 을 건드리는 것은 본 번호열 176(run_report 차단 정규식에 hr 추가) 하나뿐이다.
--
-- ■ 왜 스키마를 따로 두나
--   급여·주민등록번호는 업무도우미의 어떤 화면·도구로도 읽히면 안 된다(대표: "오류조차 허용하지 않도록").
--   public 에 두면 AI 비서(run_report)·루커·전역 검색이 닿을 수 있다. hr 스키마는 service_role 에게만 열고,
--   앱에서는 급여 창 전용 핸들(app/lib/hr-db.ts hrDb())로만 접근한다.
--
-- ■ 주민등록번호
--   employees.rrn_enc 에는 앱 서버가 AES-256-GCM 으로 암호화한 값만 들어온다(키 = Vercel 환경변수 HR_DATA_KEY).
--   DB 에는 평문이 없다 — 이 DB 가 통째로 새도 번호는 읽히지 않는다. rrn_hash 는 같은 사람을 두 번 등록하지 않게 하는 비교용(HMAC).
--
-- ■ 사전 작업(최초 1회, SQL 아님)
--   Supabase Dashboard > Settings > API > Exposed schemas 에 hr 을 추가한다.
--   안 하면 급여 창의 모든 API 가 "DB 준비 전"으로 답한다. (노출해도 anon·authenticated 에는 권한이 없어 읽히지 않는다)
--
-- 적용: Supabase Dashboard > SQL Editor 에 이 파일 하나를 붙여넣고 Run. 멱등 — 재실행 안전.

create schema if not exists hr;

-- 권한: service_role 만. anon·authenticated·public 에는 주지 않는다(최소 권한).
revoke all on schema hr from public;
revoke all on schema hr from anon;
revoke all on schema hr from authenticated;
grant usage on schema hr to service_role;
alter default privileges for role postgres in schema hr grant all on tables to service_role;
alter default privileges for role postgres in schema hr grant all on sequences to service_role;
alter default privileges for role postgres in schema hr revoke all on tables from anon;
alter default privileges for role postgres in schema hr revoke all on tables from authenticated;

-- ── 사업장 ──────────────────────────────────────────────────────────
create table if not exists hr.workplaces (
  id                uuid primary key default gen_random_uuid(),
  name              text not null unique,                 -- 사업장 이름(급여대장·명세서에 찍힌다)
  biz_no            text not null default '',             -- 사업자등록번호
  ceo               text not null default '',             -- 대표자
  address           text not null default '',
  phone             text not null default '',
  five_plus         boolean not null default true,        -- 상시 근로자 5인 이상(연장·야간·휴일 가산과 법정 연차 적용)
  week_start        smallint not null default 1 check (week_start between 1 and 7),   -- 주의 첫 요일(1=월 … 7=일)
  weekly_pay_month  text not null default 'end' check (weekly_pay_month in ('end', 'start')), -- 달이 바뀌는 주의 주휴수당을 넣는 달(end=주가 끝나는 달)
  auto_weekly       boolean not null default true,        -- 주휴수당 자동 계산(시급에 주휴를 포함해 주면 끈다)
  payday            smallint not null default 10 check (payday between 1 and 31),     -- 급여 지급일(다음 달 n일)
  accident_rate     numeric(7,4) not null default 0,      -- 산재보험 요율(%) — 업종별, 회사만 부담
  employ_extra_rate numeric(7,4) not null default 0.25,   -- 고용안정·직업능력개발 요율(%) — 회사만 부담(150인 미만 0.25)
  fiscal_start      text not null default '01-01' check (fiscal_start ~ '^\d{2}-\d{2}$'),     -- 회계연도 첫날(MM-DD)
  leave_basis       text not null default 'fiscal' check (leave_basis in ('hire', 'fiscal')), -- 연차 기준 기본값(입사일/회계연도)
  leave_round       text not null default 'ceil_half' check (leave_round in ('ceil_half', 'ceil_one', 'round_half', 'none')), -- 비례 연차 소수점 처리
  sort              integer not null default 0,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
comment on table hr.workplaces is '급여·연차 창의 사업장(회사). 가산수당·연차 기준·회사 부담 요율을 사업장별로 둔다';

-- ── 인사대장 ────────────────────────────────────────────────────────
-- 퇴사자는 지우지 않는다(근로자 명부는 퇴직 뒤 3년 보존) — leave_date 가 있으면 퇴사.
create table if not exists hr.employees (
  id              uuid primary key default gen_random_uuid(),
  workplace_id    uuid not null references hr.workplaces(id),
  emp_no          text not null default '',               -- 사번
  name            text not null,
  rrn_enc         text,                                   -- 주민등록번호 암호문(v1:iv:tag:ct). 평문 저장 금지
  rrn_hash        text,                                   -- 같은 번호 중복 확인용 HMAC(되돌릴 수 없음)
  rrn_masked      text not null default '',               -- 화면 표시용(900101-1******)
  birth_date      date,                                   -- 번호에서 뽑은 생년월일
  gender          text not null default '' check (gender in ('', '남', '여')),
  foreigner       boolean not null default false,         -- 외국인등록번호
  address         text not null default '',
  phone           text not null default '',
  emergency       text not null default '',               -- 비상 연락처
  hire_date       date not null,                          -- 입사일
  leave_date      date,                                   -- 퇴사일
  leave_reason    text not null default '',               -- 퇴사 사유
  dept            text not null default '',
  position        text not null default '',
  job             text not null default '',               -- 맡은 업무
  emp_type        text not null default '정규직',         -- 고용 형태
  contract_start  date,                                   -- 계약 기간(정한 경우)
  contract_end    date,
  career          text not null default '',               -- 이력(학력·경력)
  pay_type        text not null default 'hourly' check (pay_type in ('hourly', 'monthly')),
  work_days       smallint[] not null default '{1,2,3,4,5}',  -- 소정근로 요일(1=월 … 7=일)
  work_start      text not null default '09:00',          -- 평소 출근 시각
  work_end        text not null default '18:00',          -- 평소 퇴근 시각
  break_min       integer not null default 60,            -- 평소 휴게(분)
  daily_hours     numeric(4,2) not null default 8,        -- 하루 소정근로시간
  dependents      smallint not null default 1 check (dependents between 1 and 11),  -- 공제대상가족 수(본인 포함)
  children        smallint not null default 0 check (children >= 0),               -- 8~20세 자녀 수
  tax_rate        smallint not null default 100 check (tax_rate in (80, 100, 120)), -- 원천징수 비율
  ins_pension     boolean not null default true,          -- 국민연금 가입
  ins_health      boolean not null default true,          -- 건강보험(장기요양 포함) 가입
  ins_employment  boolean not null default true,          -- 고용보험 가입
  ins_basis       text not null default 'notice' check (ins_basis in ('notice', 'actual')), -- 국민연금·건강보험 기준(공단 고지/그달 급여)
  pension_base    integer not null default 0,             -- 국민연금 기준소득월액(공단 고지)
  health_base     integer not null default 0,             -- 건강보험 보수월액(공단 고지)
  bank            text not null default '',
  account_no      text not null default '',
  account_holder  text not null default '',
  leave_basis     text not null default '' check (leave_basis in ('', 'hire', 'fiscal')),   -- 연차 기준('' = 사업장 기본값)
  memo            text not null default '',
  created_by      text,
  created_at      timestamptz not null default now(),
  updated_by      text,
  updated_at      timestamptz not null default now()
);
create unique index if not exists employees_emp_no_uq on hr.employees (workplace_id, emp_no) where emp_no <> '';
create unique index if not exists employees_rrn_uq on hr.employees (workplace_id, rrn_hash) where rrn_hash is not null;
create index if not exists employees_workplace_idx on hr.employees (workplace_id, leave_date);
comment on table hr.employees is '인사대장(근로자 명부). 주민등록번호는 rrn_enc 암호문으로만 저장한다';

-- ── 시급·월급 이력 ──────────────────────────────────────────────────
-- 임금은 적용 시작일별로 쌓는다. 급여 계산은 그 근무일에 유효한 줄을 쓴다 — 시급을 올려도 지난달 급여가 바뀌지 않는다.
create table if not exists hr.wages (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid not null references hr.employees(id) on delete cascade,
  effective_from  date not null,                          -- 적용 시작일
  hourly_wage     integer not null default 0 check (hourly_wage >= 0),
  monthly_wage    integer not null default 0 check (monthly_wage >= 0),
  note            text not null default '',
  created_by      text,
  created_at      timestamptz not null default now(),
  unique (employee_id, effective_from)
);
comment on table hr.wages is '직원별 시급·월급 이력(적용 시작일별). 소급 적용되지 않는다';

-- ── 요율 ────────────────────────────────────────────────────────────
-- 한 줄 = 그 날짜부터 유효한 값 전부. 값이 하나라도 바뀌는 날마다 한 줄을 더한다(앞 줄을 복사해 바뀐 칸만 고친다).
-- 4대보험·최저임금은 귀속월로, 소득세 자녀 공제는 지급일로 찾는다.
create table if not exists hr.rates (
  id                   uuid primary key default gen_random_uuid(),
  effective_from       date not null unique,
  pension_rate         numeric(7,4) not null,             -- 국민연금 전체 요율(%) — 근로자 몫은 절반
  pension_min          integer not null,                  -- 기준소득월액 하한
  pension_max          integer not null,                  -- 기준소득월액 상한
  health_rate          numeric(7,4) not null,             -- 건강보험 전체 요율(%) — 근로자 몫은 절반
  health_min_premium   integer not null default 0,        -- 근로자 몫 월 보험료 하한
  health_max_premium   integer not null default 0,        -- 근로자 몫 월 보험료 상한
  ltc_rate             numeric(8,5) not null,             -- 장기요양 전체 요율(보수월액 대비 %) — 근로자 몫은 절반
  employ_rate          numeric(7,4) not null,             -- 고용보험 근로자 요율(%)
  employ_employer_rate numeric(7,4) not null,             -- 고용보험 실업급여 사업주 요율(%)
  min_wage             integer not null,                  -- 최저임금(시급)
  child_credit_1       integer not null,                  -- 간이세액표 자녀 공제: 1명
  child_credit_2       integer not null,                  -- 2명
  child_credit_more    integer not null,                  -- 3명부터 1명당 더하는 금액
  meal_limit           integer not null default 200000,   -- 식대 비과세 월 한도
  car_limit            integer not null default 200000,   -- 자가운전보조금 비과세 월 한도
  childcare_limit      integer not null default 200000,   -- 보육수당 비과세 월 한도(6세 이하 자녀 1명당)
  note                 text not null default '',
  checked              boolean not null default false,    -- 고시·법령 원문과 대조했는가
  updated_by           text,
  updated_at           timestamptz not null default now()
);
comment on table hr.rates is '적용 시작일별 4대보험 요율·최저임금·세액표 자녀 공제·비과세 한도. checked=false 는 원문 대조 전';

-- 기본값(2026-11-20 조사, 2차 자료 — 화면에서 원문과 대조한 뒤 [원문 확인] 표시). 이미 있으면 건드리지 않는다.
insert into hr.rates (effective_from, pension_rate, pension_min, pension_max, health_rate, health_min_premium, health_max_premium,
                      ltc_rate, employ_rate, employ_employer_rate, min_wage, child_credit_1, child_credit_2, child_credit_more, note)
values
  ('2026-01-01',  9.5, 400000, 6370000, 7.19, 10080, 4591740, 0.9448, 0.9, 0.9, 10320, 12500, 29160, 25000,
   '2026년 요율. 국민연금 9.0→9.5%, 건강보험 7.09→7.19%, 장기요양 0.9448%, 최저임금 10,320원'),
  ('2026-03-01',  9.5, 400000, 6370000, 7.19, 10080, 4591740, 0.9448, 0.9, 0.9, 10320, 20830, 45830, 33330,
   '간이세액표 자녀 공제 인상(2026-03-01 이후 지급분)'),
  ('2026-07-01',  9.5, 410000, 6590000, 7.19, 10080, 4591740, 0.9448, 0.9, 0.9, 10320, 20830, 45830, 33330,
   '국민연금 기준소득월액 상·하한 조정(2026-07 ~ 2027-06)'),
  ('2027-01-01', 10.0, 410000, 6590000, 7.19, 10080, 4591740, 0.9994, 0.9, 0.9, 10700, 20830, 45830, 33330,
   '2027년 예정값. 국민연금 10.0%(법정 인상, 고시 확인 필요), 건강보험 동결, 장기요양 0.9994%, 최저임금 10,700원. 건강보험 상·하한과 고용보험은 고시 확인 필요')
on conflict (effective_from) do nothing;

-- ── 변경 이력 ───────────────────────────────────────────────────────
-- 업무도우미의 activity_log(public)에는 아무것도 남기지 않는다. 주민등록번호 열람도 여기에 남는다(번호 자체는 적지 않는다).
create table if not exists hr.audit_log (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  actor        text not null,                             -- 급여 창에 들어온 사람(HR_USERS 의 이름)
  action       text not null,                             -- login · employee_create · employee_update · rrn_view · rrn_export · rate_save …
  target_type  text not null default '',
  target_id    text not null default '',
  target_name  text not null default '',
  detail       jsonb not null default '{}'::jsonb,        -- 바뀐 칸 등. 주민등록번호·비밀번호는 넣지 않는다
  ip           text not null default ''
);
create index if not exists audit_log_at_idx on hr.audit_log (at desc);
create index if not exists audit_log_target_idx on hr.audit_log (target_type, target_id);
comment on table hr.audit_log is '급여 창의 변경·열람 이력(추가 전용)';

-- ── 로그인 시도 ─────────────────────────────────────────────────────
-- 같은 주소에서 15분 안에 5번 틀리면 잠근다(app/api/hr/auth).
create table if not exists hr.login_attempts (
  id   bigint generated always as identity primary key,
  at   timestamptz not null default now(),
  ip   text not null,
  ok   boolean not null
);
create index if not exists login_attempts_ip_idx on hr.login_attempts (ip, at desc);

-- RLS: 정책 없이 켜 둔다 — service_role 만 통과한다(스키마 권한과 이중 방어).
alter table hr.workplaces      enable row level security;
alter table hr.employees       enable row level security;
alter table hr.wages           enable row level security;
alter table hr.rates           enable row level security;
alter table hr.audit_log       enable row level security;
alter table hr.login_attempts  enable row level security;

grant all on all tables in schema hr to service_role;
grant all on all sequences in schema hr to service_role;
revoke all on all tables in schema hr from anon;
revoke all on all tables in schema hr from authenticated;

notify pgrst, 'reload schema';
