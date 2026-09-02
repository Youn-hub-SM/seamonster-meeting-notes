-- 101: 월간매입 결산 확정(스냅샷) — 확정 시점의 결산 숫자를 박제한다 (2026-09-02 대표 지시).
--  결산은 매 조회마다 현재 원장을 재계산하므로, 취소·소급 입력·단가 수정이 확정 후의
--  숫자를 소리 없이 바꿀 수 있다. 확정본을 저장해 두고 화면이 현재 재계산과 비교해
--  차이가 나면 경고한다. 한 달에 확정본 하나(재확정 = 덮어쓰기).

create table if not exists quote_snapshots (
  month        text primary key check (month ~ '^\d{4}-\d{2}$'),  -- 'YYYY-MM'
  confirmed_at timestamptz not null default now(),
  confirmed_by text,
  summary      jsonb not null,   -- QuoteSummary(총 입금액·품목수·수량·금액·반품 등)
  items        jsonb not null,   -- QuoteItem[] 확정 당시 품목표
  params       jsonb,            -- 확정 당시 입력값(임대료·면세기타·과세기타)
  note         text
);

-- 서비스롤 전용(앱 서버만 접근) — 정책을 두지 않는 기존 관행 그대로
alter table quote_snapshots enable row level security;
