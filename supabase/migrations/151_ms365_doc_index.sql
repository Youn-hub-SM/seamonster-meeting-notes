-- 151 회사 문서함 본문 색인 (2026-10-27)
--  Microsoft Graph 의 드라이브 검색 끝점(search(q=))이 사이트별 허용(Sites.Selected) 앱 권한에서 500 을 내서
--  AI 비서가 문서 본문으로 찾지 못했다. 업무도우미가 문서함을 직접 훑어 이름·경로·본문 글을 여기 저장하고 docs_search 가 이 표를 찾는다.
--  갱신: 관리자 › 설정 › 연결 › Microsoft 365 문서 [문서 색인 갱신] + 일정 알림 크론 틱(아침·오후). 비서는 docs_* 도구로만 읽는다(run_report 차단).

create table if not exists ms365_doc_index (
  ref         text primary key,                  -- '드라이브ID:항목ID' (docs_read 의 ref 와 같다)
  source      text not null default '',          -- 문서함 이름(설정의 라벨)
  site_id     text not null,
  drive_id    text not null,
  name        text not null default '',
  path        text not null default '',          -- 드라이브 루트 기준 경로
  url         text not null default '',
  modified    text not null default '',          -- Graph lastModifiedDateTime — 같으면 다시 읽지 않는다
  size_kb     integer not null default 0,
  status      text not null default 'ok' check (status in ('ok', 'skipped', 'error')),
  error       text not null default '',
  text        text not null default '',          -- 본문 앞 60,000자(skipped·error 는 빈 문자열)
  haystack    text not null default '',          -- lower(name + path + text) — ilike 검색용
  indexed_at  timestamptz not null default now(),
  seen_at     timestamptz not null default now()
);
create index if not exists ms365_doc_index_site_idx on ms365_doc_index (site_id, drive_id);

comment on table ms365_doc_index is '회사 문서함(Microsoft 365) 본문 색인 — AI 비서 docs_search 전용(run_report 차단). 문서 본문이 들어 있다';

-- run_report 차단 정규식에 ms365_doc_index 추가(141 의 본문 그대로, 목록만 넓힘)
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
  if q ~* '\m(sales_customers|b2b_settings|app_users|okr_checkins|bank_deposits|bank_deposit_names|shipments|companies|survey_responses|utm_settings|channel_commands|tax_invoices|report_threads|report_messages|report_tables|report_glossary|report_feedback|briefings|ms365_doc_index)\M' then
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
