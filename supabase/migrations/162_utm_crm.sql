-- 162: UTM 만들기 CRM 모드(2026-11-06, docs/utm-crm-builder-plan.md 결정 6: CRM 가져오기와 한 묶음).
--   utm_links.purpose      : 'ad'(광고·SNS) | 'crm'(CRM 메시지 링크) — 히스토리 용도 구분
--   utm_links.crm_campaign : CRM 모드에서 만든 링크의 utm_campaign(메시지 묶음 표시용. campaign 열과 같지만 용도 필터에 쓴다)
--   슬러그 사전은 utm_settings(key='content_slugs') 에 들어가므로 구조 변경 없음.
-- 적용: Supabase SQL Editor 에 붙여넣고 Run. 멱등. 미적용이어도 코드는 두 열 없이 저장하는 폴백으로 동작한다.
-- ※ CRM 메시지 엑셀 가져오기(2026-11-06)는 기존 열(msg 본문)과 links jsonb(urls·utm_term)만 써서 구조 변경이 없다 — 이 파일은 UTM 기록 열뿐.

alter table utm_links add column if not exists purpose text not null default 'ad';
alter table utm_links add column if not exists crm_campaign text not null default '';
create index if not exists utm_links_purpose_idx on utm_links (purpose, created_at desc);

comment on table  utm_links is 'UTM 만들기 생성 히스토리(최근 100건 유지). 광고·SNS 링크와 CRM 메시지 링크';
comment on column utm_links.purpose is '용도: ad=광고·SNS, crm=CRM 메시지 링크(규칙: source=kakao, medium=메시지종류-경로, content=버튼, term=a/b)';
comment on column utm_links.crm_campaign is 'CRM 모드에서 만든 링크의 utm_campaign(메시지 묶음 식별)';

NOTIFY pgrst, 'reload schema';
