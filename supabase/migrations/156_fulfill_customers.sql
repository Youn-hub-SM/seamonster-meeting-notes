-- 156: 단골·블랙 고객 메모(fulfill_customers) — 택배 발주처리에서 그 고객의 주문을 찾아 확인(체크)을 받는다 (2026-10-27 대표 요청)
--
-- ■ 왜
--   단골(챙길 고객)·블랙(주의 고객)을 발주 담당자가 매번 기억할 수 없다. 발주처리 ② CN 파일 다운로드 단계의
--   주소 경고·배송메시지 확인 옆에 '단골·블랙 고객 N건' 카드가 뜨고, 체크하지 않으면 다운로드가 켜지지 않는다.
-- ■ 표
--   fulfill_customers: 구분(단골·블랙)·이름·전화(숫자만, 매출 PII 와 같은 정규화)·주소 일부·메모(사유)·사용 여부·등록자.
--   매칭(앱 fulfill-customers.matchFlaggedCustomers): 전화 일치 → 이름+주소 포함 → 이름만(등록 주소·전화가 없거나 주문 전화가 없을 때).
--   개인정보 표 — AI 비서 run_report 차단 목록에 넣는다(report-schema BLOCKED_RELATIONS + 아래 정규식, 이중 방어).
-- ■ 미적용이면
--   등록 화면이 '156 적용 필요'를 보이고, 발주처리는 고객 확인 카드 없이 종전대로 돈다(화면에 미적용 안내).
--
-- 적용: Supabase SQL Editor 에 이 파일 하나만 붙여넣고 Run. 멱등(재실행 안전). 155 다음.

create table if not exists fulfill_customers (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null check (kind in ('단골', '블랙')),
  name          text not null,
  phone_digits  text not null default '',   -- 숫자만(하이픈 없음). 비어 있으면 이름(+주소)으로만 찾는다
  address       text not null default '',   -- 주소 일부(동·아파트 등) — 주문 주소에 포함되면 일치
  memo          text not null default '',   -- 사유·응대 메모(발주 화면에 그대로 보인다)
  active        boolean not null default true,
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists fulfill_customers_phone_idx on fulfill_customers (phone_digits) where phone_digits <> '';
create index if not exists fulfill_customers_name_idx on fulfill_customers (name);

alter table fulfill_customers enable row level security;

comment on table fulfill_customers is '단골·블랙 고객 메모(개인정보 — AI 비서 run_report 차단). 택배 발주처리 ② 단계에서 그 고객의 주문을 찾아 확인을 받는다';
comment on column fulfill_customers.kind is '단골 | 블랙';
comment on column fulfill_customers.phone_digits is '전화 숫자만(하이픈 없음). 빈 값 = 전화로는 찾지 않음';
comment on column fulfill_customers.address is '주소 일부 — 주문 주소에 포함되면 일치(공백 무시)';
comment on column fulfill_customers.memo is '사유·응대 메모 — 발주 화면 카드에 그대로 보인다';

-- run_report 차단 정규식에 fulfill_customers 추가(151 의 본문 그대로, 목록만 넓힘)
create or replace function public.run_report(q text, p_limit int default 5000)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  r json;
  cap int := least(greatest(coalesce(p_limit, 5000), 1), 100000);
begin
  if q ~* '\m(sales_customers|b2b_settings|app_users|okr_checkins|bank_deposits|bank_deposit_names|shipments|companies|survey_responses|utm_settings|channel_commands|tax_invoices|report_threads|report_messages|report_tables|report_glossary|report_feedback|briefings|ms365_doc_index|fulfill_customers)\M' then
    raise exception '비공개 테이블(개인정보·계정·설정·면담·입금·문서 본문)은 조회할 수 없습니다. 업체명은 companies_report, 발송은 shipments_report 를 사용하세요.';
  end if;
  -- 다른 스키마·카탈로그 참조 차단(비서의 스키마 조회문 '/*schema*/' 만 예외)
  if q !~ '^\s*/\*schema\*/' and q ~* '\m(pg_catalog|pg_[a-z_]+|information_schema|factory|auth|storage|extensions)\s*\.' then
    raise exception 'public 스키마의 표·뷰만 조회할 수 있습니다.';
  end if;
  perform set_config('statement_timeout', case when cap > 5000 then '60000' else '15000' end, true);
  execute format(
    'select coalesce(json_agg(t), ''[]''::json) from (select * from (%s) _sub limit %s) t',
    q, cap
  ) into r;
  return r;
end $$;

revoke all on function public.run_report(text, int) from public;
revoke all on function public.run_report(text, int) from anon;
revoke all on function public.run_report(text, int) from authenticated;
grant execute on function public.run_report(text, int) to service_role;

notify pgrst, 'reload schema';
