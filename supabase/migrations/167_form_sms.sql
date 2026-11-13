-- 167: 신청자 문자 — 탈리 폼 신청자에게 매일 13시에 문자(솔라피) (2026-11-14 대표 지시)
--
-- ■ 왜
--   지금까지 '탈리 → 구글시트 앱스크립트 → 재피어 → 솔라피'로 챌린지 신청자에게 문자를 보냈다.
--   탈리 응답은 이미 /api/voc/tally 로 들어와 survey_responses(025)에 쌓이므로, 중간 두 단계를 빼고
--   업무도우미가 매일 13시에 '아직 안 보낸 신청자'에게 솔라피로 보낸다(신청 직후에 바로 보내지 않으려는 것).
--
-- ■ 이 표 = 발송 결과 기록(신청 한 건에 한 줄)
--   '대기'는 저장하지 않는다 — survey_responses 가운데 여기에 줄이 없는 신청이 대기다.
--   response_id 가 unique 라 같은 신청에 두 번 보내지 않는다(예약 신호와 [지금 보내기]가 겹쳐도 한쪽만 줄을 만든다).
--   전화번호 원문은 저장하지 않는다(가린 번호만). 원문은 survey_responses.answers 에만 있고 그 표는 AI 비서 차단 목록에 있다.
--
-- ■ 예약 신호
--   pg_cron 이 매일 04:00 UTC(= 13:00 KST)에 /api/form-sms/tick 을 한 번 두드린다(월 약 30번).
--   보낼지는 앱이 설정(마케팅 › 신청자 문자, b2b_settings form_sms_rule)을 보고 정한다 — 꺼져 있으면 아무 일도 없다.
--
-- ★ 운영 배포(이 기능이 든 코드가 main 에 나간 뒤)에 적용할 것 — 옛 코드는 이 주소가 없어 404 만 돌려준다(피해는 없음).
-- ★ 적용 전에 <<DIGEST_CRON_KEY>> 를 실제 값으로 바꿀 것 (Vercel 환경변수 DIGEST_CRON_KEY — 092·165 와 같은 값).
--    바꾸지 않고 실행해도 앱이 401 로 거절할 뿐 다른 피해는 없다(13시 자동 발송만 안 된다 — 화면에 '예약 신호가 오지 않습니다'가 보인다).
--
-- 실행 확인: select jobname, schedule, active from cron.job;
--            select status, return_message, start_time from cron.job_run_details order by start_time desc limit 10;
-- 끄기:      select cron.unschedule('form-sms-tick');
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

create table if not exists public.form_sms_sends (
  id          bigint generated always as identity primary key,
  response_id uuid not null unique,              -- survey_responses.id (신청 한 건)
  form_id     text,                              -- 탈리 폼 ID
  phone_mask  text,                              -- 가린 전화번호(010-****-1234). 원문은 저장하지 않는다
  status      text not null,                     -- sending 보내는 중 / sent 접수됨 / failed 접수 실패 / skipped 건너뜀 / unknown 확인 필요
  reason      text,                              -- 실패·건너뜀·확인 필요의 사유
  group_id    text,                              -- 솔라피 발송 그룹 ID(솔라피 콘솔에서 찾을 때)
  sent_by     text,                              -- '예약'(13시 자동) 또는 [지금 보내기]를 누른 사람
  created_at  timestamptz not null default now(),
  sent_at     timestamptz                        -- 솔라피가 접수한 시각
);
create index if not exists form_sms_sends_created_idx on public.form_sms_sends (created_at desc);
create index if not exists form_sms_sends_form_idx on public.form_sms_sends (form_id);

-- 서버(service role)만 읽고 쓴다 — 공개 키로는 접근 불가
alter table public.form_sms_sends enable row level security;

comment on table public.form_sms_sends is '신청자 문자 발송 결과(탈리 폼 신청 한 건에 한 줄, 매일 13시 솔라피 발송). 전화번호는 가린 값만. 대기 중인 신청은 여기에 없다';
comment on column public.form_sms_sends.response_id is 'survey_responses.id — 신청 한 건. unique 라 같은 신청에 두 번 보내지 않는다';
comment on column public.form_sms_sends.status is 'sending 보내는 중 / sent 솔라피 접수됨 / failed 접수 실패 / skipped 건너뜀(번호 없음·중복) / unknown 응답을 못 받아 확인 필요';
comment on column public.form_sms_sends.sent_by is '예약 = 13시 자동 발송, 그 밖은 [지금 보내기]를 누른 사람 이름';

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$ begin perform cron.unschedule('form-sms-tick'); exception when others then null; end $$;

select cron.schedule(
  'form-sms-tick',
  '0 4 * * *',
  $$
  select net.http_post(
    url := 'https://meeting-notes-beryl.vercel.app/api/form-sms/tick',
    body := jsonb_build_object('tick', true),
    headers := jsonb_build_object('Authorization', 'Bearer <<DIGEST_CRON_KEY>>', 'Content-Type', 'application/json'),
    timeout_milliseconds := 60000
  ) as request_id;
  $$
);

notify pgrst, 'reload schema';
