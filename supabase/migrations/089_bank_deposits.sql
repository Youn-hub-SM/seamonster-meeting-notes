-- 은행 입금 내역 (팝빌 계좌조회 수집분) — B2B 입금 자동 매칭의 소스.
-- 팝빌 계좌조회 API 로 국민은행 입금 거래를 수집해 쌓고,
-- 미수금 발주(입금전·일부입금)와 대조해 자동/수동 매칭한다.
-- 매칭되면 payments 에 입금 기록이 생기고 발주 payment_status 가 바뀐다.

create table if not exists bank_deposits (
  id uuid primary key default gen_random_uuid(),
  tid text not null unique,            -- 팝빌 거래내역 아이디 (재수집 중복 방지 키)
  trdate text not null,                -- 거래일자 yyyyMMdd
  trdt text not null,                  -- 거래일시 yyyyMMddHHmmss
  amount numeric not null,             -- 입금액 (accIn) — 입금 거래만 저장한다
  balance numeric,                     -- 거래 후 잔액
  remark text,                         -- 입금자명·적요 (은행 비고 remark1~4 병합)
  status text not null default '확인필요'
    check (status in ('확인필요','자동매칭','수동매칭','무시')),
  matched_order_id uuid references orders(id) on delete set null,
  payment_id uuid references payments(id) on delete set null,  -- 매칭 시 생성된 입금 기록
  matched_by text,                     -- '자동' 또는 작업자명
  matched_at timestamptz,
  raw jsonb,                           -- 팝빌 원본 거래 객체 (감사·디버그용)
  created_at timestamptz not null default now()
);

create index if not exists idx_bank_deposits_status on bank_deposits (status, trdt desc);
create index if not exists idx_bank_deposits_trdt on bank_deposits (trdt desc);
