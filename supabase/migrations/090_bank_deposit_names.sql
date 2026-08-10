-- 입금자명 등록 (은행 입금 자동확인) — 허용 목록 + 업체 별칭.
--  company_id 있으면: 그 업체의 입금자명 별칭 → 자동 매칭에 업체명과 동급으로 사용
--  company_id 없으면: '등록된 입금자명' → 확인필요 알림만 허용
-- 등록되지 않은 이름의 입금은(업체명 자체와도 안 맞으면) 알림 없이 '무시(미등록)' 처리된다.
--  예외: 금액이 어떤 미수금 발주의 잔액과 정확히 일치하면 미등록이어도 확인필요로 올린다.

create table if not exists bank_deposit_names (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references companies(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

-- 같은 (업체, 이름) 중복 등록 방지 — company_id 가 null 인 일반 등록끼리도 중복 금지 (PG15+)
create unique index if not exists idx_bank_deposit_names_uniq
  on bank_deposit_names (company_id, name) nulls not distinct;
