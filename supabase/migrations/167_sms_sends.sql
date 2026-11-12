-- 167: 고객 문자 보내기 — 업무도우미에서 쓴 문자를 중계 서버(클라우드웨이즈)가 알리고 API 로 보낸다 (2026-11-12 대표 요청)
--  적용: Supabase SQL Editor 에 전체 붙여넣고 Run. 멱등 — 재실행 안전. (166 다음에 적용)
--
-- 알리고는 등록한 서버 IP 에서만 발송을 받는다. Vercel 은 IP 가 고정되지 않아 고정 IP 인 중계 서버(158.247.253.90)가 보낸다.
-- 흐름: /sms 에서 [문자 보내기] → sms_sends '대기' 행 → 중계 실행기(scripts/aligo-sms-runner.mjs, 2분마다)가 선점 →
--       알리고 /send/ 호출 → 결과 보고(완료·실패, 성공·실패 건수, 알리고 메시지 id).
-- 고객에게 나가는 문자라 '정확히 한 번'이 아니라 '많아야 한 번'을 지킨다:
--  · 30분 넘게 대기한 행은 보내지 않고 실패로 닫는다(늦게 엉뚱한 시각에 나가지 않게).
--  · 선점됐는데 결과 보고가 없는 행은 다시 보내지 않는다 — '확인 필요'로 두고 사람이 알리고 전송 내역을 본다.
-- 받는 번호는 개인정보 → AI 비서 조회 차단(BLOCKED_RELATIONS + 아래 run_report 정규식).

create table if not exists sms_sends (
  id bigserial primary key,
  message text not null,                      -- 문자 본문
  title text,                                 -- 제목(LMS 만, 선택)
  msg_type text not null default 'SMS',       -- SMS(90바이트 이하) | LMS(2,000바이트 이하)
  receivers jsonb not null,                   -- 받는 번호 배열(숫자만) — 개인정보
  receiver_count integer not null default 0,
  status text not null default '대기',        -- 대기 | 실행중(실행기 선점) | 완료 | 실패 | 확인 필요(선점 뒤 보고 없음)
  test boolean,                               -- 시험 발송(알리고 testmode — 실제로 나가지 않음). 실행기가 보고
  aligo_msg_id text,                          -- 알리고 메시지 id(전송 내역 조회용)
  success_cnt integer,                        -- 알리고가 접수한 건수
  error_cnt integer,                          -- 알리고가 거절한 건수
  error text,                                 -- 실패 사유
  requested_by text,                          -- 보낸 사람(업무도우미 계정)
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  executed_at timestamptz
);

comment on table sms_sends is '고객 문자 발송 기록(개인정보 — AI 비서 run_report 차단). /sms 화면에서 요청, 중계 서버가 알리고 API 로 발송';
comment on column sms_sends.msg_type is 'SMS(90바이트 이하) | LMS(2,000바이트 이하)';
comment on column sms_sends.receivers is '받는 휴대폰 번호 배열(숫자만)';
comment on column sms_sends.status is '대기 | 실행중 | 완료 | 실패 | 확인 필요(발송 서버가 가져간 뒤 결과를 알리지 않음 — 알리고 전송 내역 확인)';
comment on column sms_sends.test is 'true = 시험 발송(알리고 testmode, 실제로 나가지 않음)';
comment on column sms_sends.success_cnt is '알리고가 접수한 건수(통신사 도달 여부는 알리고 전송 내역에서 확인)';

create index if not exists sms_sends_created_idx on sms_sends (created_at desc);
create index if not exists sms_sends_status_idx on sms_sends (status) where status in ('대기', '실행중');

alter table sms_sends enable row level security;  -- service key 전용(정책 없음)

-- run_report 차단 정규식에 sms_sends 추가(156 의 본문 그대로, 목록만 넓힘)
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
  if q ~* '\m(sales_customers|b2b_settings|app_users|okr_checkins|bank_deposits|bank_deposit_names|shipments|companies|survey_responses|utm_settings|channel_commands|tax_invoices|report_threads|report_messages|report_tables|report_glossary|report_feedback|briefings|ms365_doc_index|fulfill_customers|sms_sends)\M' then
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
