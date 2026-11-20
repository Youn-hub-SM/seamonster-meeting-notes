-- 173: 오디언스 추출 — 알림톡 발송 기록 (2026-11-20 대표 지시)
--
-- ■ 왜
--   오디언스 추출(/audience)에서 찾은 고객에게 솔라피 알림톡을 바로 보낸다(app/lib/audience-send.ts).
--   발송은 되돌릴 수 없고 요금이 나가므로, 누가 언제 어떤 조건·템플릿으로 몇 명에게 보냈는지 남기고
--   같은 요청이 두 번 나가지 않게 막는다.
--
-- ■ 이 표 = 발송 한 번에 한 줄
--   request_id 가 unique 라 같은 요청(두 번 누름·응답을 못 받고 다시 누름)은 줄을 만들지 못해 보내지 않는다.
--   보내기 전에 status = 'sending' 으로 먼저 만들고, 끝나면 결과로 바꾼다. 도중에 죽으면 'sending' 으로 남는다(화면에 '확인 필요').
--   전화번호·이름은 저장하지 않는다 — 조건(누구를 찾았는지)·템플릿·인원·결과만.
--
-- ■ 예약 실행 없음. 대체 발송(문자) 없음. 야간(20:50~08:00 한국 시간)에는 앱이 보내지 않는다.
--
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.
-- 적용 전에는 화면은 그대로 뜨고, [알림톡 보내기]를 누르면 '발송 기록 표가 없습니다'가 나오며 보내지 않는다.

create table if not exists public.audience_sends (
  id            bigint generated always as identity primary key,
  request_id    uuid not null unique,              -- 화면이 발송 창을 열 때 만든 요청 ID(두 번 보내지 않기)
  kind          text not null default 'send',      -- send 고객에게 보냄 / test 시험 발송(적은 번호 한 곳)
  mode          text not null,                     -- buy 구매 고객 / sub 정기배송 고객 / test 시험 발송
  cond          jsonb,                             -- 찾은 조건(전화번호·이름 없음). 시험 발송은 null
  cond_summary  text,                              -- 조건을 한 줄로
  template_id   text not null,                     -- 솔라피 알림톡 템플릿 ID
  template_name text,                              -- 템플릿 이름(보낸 때의)
  channel_id    text,                              -- 카카오 채널 ID(솔라피 pfId)
  variables     jsonb,                             -- 변수마다 넣은 값 {"변수명": {"kind": "name"} 또는 {"kind": "text", "value": "…"}}
  target_count  integer not null,                  -- 보내려던 인원
  attempted     integer,                           -- 솔라피에 요청한 인원(중간에 멈추면 target_count 보다 작다)
  accepted      integer,                           -- 솔라피가 접수한 인원
  failed        integer,                           -- 접수 실패 인원
  status        text not null,                     -- sending 보내는 중 / sent 전부 접수 / partial 일부만 접수 / failed 접수 없음 / unknown 응답을 못 받아 확인 필요
  reason        text,                              -- 멈춘 까닭·접수 실패 사유
  group_ids     text[],                            -- 솔라피 발송 묶음 ID(결과 확인·솔라피 콘솔에서 찾을 때)
  result        jsonb,                             -- [결과 확인]으로 받은 실제 결과 {success 수신 완료, failed 수신 실패, pending 결과 없음, checked_at}
  sent_by       text,                              -- 보낸 사람
  created_at    timestamptz not null default now(),
  finished_at   timestamptz                        -- 발송 요청이 끝난 시각
);
create index if not exists audience_sends_created_idx on public.audience_sends (created_at desc);

-- 서버(service role)만 읽고 쓴다 — 공개 키로는 접근 불가
alter table public.audience_sends enable row level security;

comment on table public.audience_sends is '오디언스 추출의 알림톡 발송 기록(발송 한 번에 한 줄, 솔라피). 전화번호·이름은 없다 — 조건·템플릿·인원·결과만';
comment on column public.audience_sends.request_id is '화면이 만든 요청 ID. unique 라 같은 요청은 두 번 보내지 않는다';
comment on column public.audience_sends.kind is 'send = 찾은 고객에게 보냄 / test = 시험 발송(한 번호)';
comment on column public.audience_sends.mode is 'buy 구매 고객 조건 / sub 정기배송 고객 조건 / test 시험 발송';
comment on column public.audience_sends.cond is '찾은 조건(오디언스 추출의 조건 그대로, 탈리 응답자 제외 폼 포함). 고객 개인정보 없음';
comment on column public.audience_sends.variables is '템플릿 변수마다 넣은 값 — kind name = 고객 이름, kind text = 적은 글자(value)';
comment on column public.audience_sends.target_count is '보내려던 인원(보내는 순간에 조건으로 다시 찾은 수)';
comment on column public.audience_sends.attempted is '솔라피에 요청한 인원. 야간·오류로 멈추면 target_count 보다 작다';
comment on column public.audience_sends.accepted is '솔라피가 접수한 인원(실제 수신 여부는 result)';
comment on column public.audience_sends.status is 'sending 보내는 중(오래 남아 있으면 확인 필요) / sent 전부 접수 / partial 일부만 접수 / failed 접수 없음 / unknown 응답을 못 받아 접수 여부 모름';
comment on column public.audience_sends.result is '솔라피가 알려 준 실제 결과: success 수신 완료 / failed 수신 실패(카카오톡 미사용·차단 등) / pending 아직 결과 없음 / checked_at 확인한 시각';

notify pgrst, 'reload schema';
