-- 137 채널 문의 대장 — 네이버 고객문의(1:1)·상품문의(Q&A)의 질문과 답변 (2026-10-12 대표 요청: 주간 종합 리포트 '고객의 소리')
--
-- ■ 왜
--   112 channel_claims 는 '답변이 필요한 새 문의' Teams 알림용이라 미답변 질문만(500자) 남기고 답변은 담지 않는다.
--   주간 종합 리포트에 "지난주 어떤 문의가 있었고 어떻게 답했는지"를 요약하려면 답변된 문의까지 질문·답변 전문이 필요하다.
--
-- ■ 바뀌는 것
--   channel_inquiries — 문의 1건 = 1행. 중계 서버 폴러(claims-poll)가 'KST 8일 전 0시 ~ 지금' 문의를 답변 여부와 관계없이
--   알림과 별도 요청으로 보내고, /api/claims/report 가 알림 처리 뒤 (channel, inquiry_key) 로 upsert 한다
--   (답변이 나중에 달리면 같은 행이 갱신된다).
--   개인정보 — 고객 이름·아이디는 저장하지 않는다(네이버 응답에는 있지만 버린다). 질문·답변 본문은 고객이 쓴 글이라
--   개인정보가 섞일 수 있어 RLS 를 켜 서비스 롤(서버)만 읽는다.
--
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전. 미적용이어도 알림(112)은 그대로 동작한다.

create table if not exists public.channel_inquiries (
  id            bigint generated always as identity primary key,
  channel       text not null,                    -- 스마트스토어 (쿠팡 등은 이후)
  kind          text not null,                    -- 고객문의 | 상품문의
  inquiry_key   text not null,                    -- 채널 고유 키 — inq:<inquiryNo> · qna:<questionId> (112 claim_key 와 같은 값)
  product_name  text,
  category      text,                             -- 고객문의 분류(네이버 category)
  title         text,                             -- 고객문의 제목
  question      text,                             -- 문의 본문(전문)
  answer        text,                             -- 답변 본문(여러 답변이면 순서대로 이어 붙임)
  answered      boolean not null default false,
  asked_at      timestamptz,                      -- 문의 등록 시각
  answered_at   timestamptz,                      -- 첫 답변 시각(보충·수정 답변으로 늦추지 않는다 — 리포트 '답변까지 걸린 시간')
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists channel_inquiries_key_uniq on public.channel_inquiries (channel, inquiry_key);
create index if not exists channel_inquiries_asked_idx on public.channel_inquiries (asked_at desc);

alter table public.channel_inquiries enable row level security; -- 서비스 롤(supabaseAdmin)만 접근

notify pgrst, 'reload schema';
