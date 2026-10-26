-- 149 CRM 발송 수치(수단별 일/주 집계) + 메시지맵 utm_medium (2026-10-26, docs/crm-dashboard-plan.md)
--  구글 시트에 손으로 모으던 '발송 수단별 CRM 성과'를 업무도우미가 모은다: 솔라피는 API, 데이터라이즈·블룸은 CSV 업로드,
--  네이버 톡톡·톡스토어·문자는 직접 입력. 같은 (수단·단위·날짜·템플릿) 은 한 줄 — 다시 올리면 덮어쓴다.

create table if not exists crm_send_stats (
  id            uuid primary key default gen_random_uuid(),
  source        text not null,                      -- datarize_brand·datarize_alimtalk·blumn·solapi·naver_talk·talkstore·sms·other
  grain         text not null default 'day' check (grain in ('day', 'week')),
  date          date not null,                      -- 일별이면 그 날, 주별이면 주 시작일(월요일)
  template      text not null default '',           -- 템플릿·캠페인 이름(솔라피는 카카오 템플릿 ID)
  sent          integer not null default 0,         -- 발송(성공) 건수
  delivered     integer,                            -- 수신(도달) — 없으면 null
  clicked       integer,                            -- 클릭 — 없으면 null
  cost          numeric,                            -- 발송비(원) — 없으면 null
  utm_campaign  text,                               -- GA 연결용(선택)
  note          text not null default '',
  batch         text not null default '',           -- 업로드 묶음(파일명·시각) 또는 'solapi-sync'
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (source, grain, date, template)
);
create index if not exists crm_send_stats_date_idx on crm_send_stats (date);

comment on table  crm_send_stats is 'CRM 발송 수치 — 발송 수단별 일/주 집계(솔라피 API·데이터라이즈/블룸 CSV·직접 입력). 주간 성과표의 원천';
comment on column crm_send_stats.source is '발송 수단: datarize_brand(데이터라이즈 브랜드메시지)·datarize_alimtalk(데이터라이즈 알림톡)·blumn(블룸 AI 알림톡)·solapi(솔라피)·naver_talk(네이버 톡톡)·talkstore(톡스토어 마케팅메시지)·sms(알리고 문자)·other';
comment on column crm_send_stats.grain is 'day=일별, week=주별(date 는 주 시작일 월요일)';
comment on column crm_send_stats.template is '템플릿·캠페인 이름. 솔라피는 카카오 템플릿 ID';
comment on column crm_send_stats.sent is '발송 성공 건수';

alter table crm_messages add column if not exists utm_medium text not null default '';
comment on column crm_messages.utm_medium is 'GA utm_medium(규칙: 메시지종류-경로, 예 alimtalk-naver·brandmessage-cafe24) — 주간 성과표가 수단별 GA 세션·구매를 이 값으로 잇는다';
