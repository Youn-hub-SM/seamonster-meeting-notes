-- 112: 채널 클레임 대장 — 네이버·쿠팡·카페24의 취소/반품/교환 요청을 중계 서버가 폴링해 적재.
--  새 행(중복 아님)만 Teams 알림 발송. claim_key = 채널별 클레임 고유 식별자(중복 제거 키).
-- 적용: Supabase SQL Editor 에 붙여넣고 Run. 멱등(재실행 안전).

create table if not exists channel_claims (
  id           bigint generated always as identity primary key,
  channel      text not null,                     -- 스마트스토어 | 쿠팡 | 카페24
  claim_type   text not null,                     -- 취소 | 반품 | 교환
  claim_key    text not null,                     -- 채널별 고유 키(중복 제거)
  order_id     text,                              -- 채널 주문번호(표시용)
  product_name text,
  option_name  text,
  qty          numeric(14,2),
  reason       text,                              -- 채널이 준 사유(있으면)
  status       text,                              -- 채널 원문 상태(참고)
  requested_at text,                              -- 채널이 준 요청 시각(원문 보존)
  detected_at  timestamptz not null default now(),
  notified_at  timestamptz                        -- Teams 발송 시각(null = 미발송/발송 실패)
);

create unique index if not exists channel_claims_key_uniq on channel_claims (channel, claim_key);
create index if not exists channel_claims_detected_idx on channel_claims (detected_at desc);

alter table channel_claims enable row level security; -- 서비스 롤(supabaseAdmin)만 접근

notify pgrst, 'reload schema';
