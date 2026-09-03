-- 103: 대표 전용 일일 브리핑 (2026-09-02)
--  업무도우미 전 영역(발주·재고·생산·VOC·매출·활동·도구 변경)을 매일 아침 집계해
--  변화 요약 + AI 인사이트를 만들어 보관한다. 화면 = /briefing (관리자 전용).
--  생성은 크론(운영) 또는 화면의 [다시 생성] 버튼. 하루 한 건(재생성 = 덮어쓰기).
-- 적용: Supabase SQL Editor 에 붙여넣고 Run. 멱등.

create table if not exists briefings (
  brief_date  date primary key,          -- 브리핑 대상일(KST, 보통 오늘 아침 = 어제까지의 변화)
  data        jsonb not null,            -- 집계 원자료(영역별 숫자) — 인사이트 검증·추세 계산용
  insight     text,                      -- AI 브리핑 본문(마크다운). null = 집계만 있고 AI 생성 전
  model       text,                      -- 생성에 쓴 모델
  created_at  timestamptz not null default now()
);

alter table briefings enable row level security;

-- 매일 06:30 KST(=21:30 UTC) 운영 서버의 브리핑 생성 엔드포인트를 호출한다.
--  Vercel Hobby 크론 2개가 이미 일정 브리핑에 쓰여(§5 한도) 092 와 같은 pg_cron + http 방식.
--  ⚠️ 적용 전에 아래 <<DIGEST_CRON_KEY>> 를 실제 값(Vercel env 의 DIGEST_CRON_KEY)으로 바꿔 넣을 것 — 092 와 같은 키.
create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$ begin perform cron.unschedule('daily-briefing'); exception when others then null; end $$;

select cron.schedule(
  'daily-briefing',
  '30 21 * * *',
  $$
  select net.http_get(
    url := 'https://meeting-notes-beryl.vercel.app/api/briefing/cron',
    headers := jsonb_build_object('Authorization', 'Bearer <<DIGEST_CRON_KEY>>'),
    timeout_milliseconds := 55000
  ) as request_id;
  $$
);

notify pgrst, 'reload schema';
