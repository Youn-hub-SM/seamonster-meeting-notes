-- 128 세금계산서 발행(볼타 API) — 거래처 계산서 정보 + 발행 기록 (2026-10-08 대표 결정)
--
-- ■ 왜
--   B2B 세금계산서를 볼타(Bolta) API 로 업무도우미에서 바로 발행한다(발주 1건 = 1장, 과세·면세가 섞이면 2장).
--   발행에 필요한 공급받는자 정보(업태·종목·사업장 주소·계산서 수신 이메일)가 거래처에 없고, 발행 기록을 남길 곳도 없었다.
--
-- ■ 바뀌는 것
--   companies: 업태·종목·사업장 주소·계산서 수신 이메일·담당자·전화 칸 추가(address 는 지금처럼 '기본 배송지').
--   tax_invoices: 볼타로 보낸 문서 1장 = 1행. 보낸 내용 전체를 스냅샷으로 둔다(발주를 고치면 품목 행이 다시 만들어지므로).
--     같은 발주·같은 과세 구분·같은 모드(test/live)에 '요청·발행완료' 문서는 하나만(중복 발행 방지).
--   기존 업태·종목이 메모에 '업태: … / 종목: …' 로 들어간 업체는 새 칸으로 옮겨 채운다(이미 값이 있으면 그대로).
--
-- 미적용이어도 앱은 죽지 않는다(발행 화면이 '128 적용 필요'를 알린다).
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table public.companies
  add column if not exists biz_type text,           -- 업태
  add column if not exists biz_item text,           -- 종목
  add column if not exists biz_address text,        -- 사업장 소재지(배송지 address 와 분리)
  add column if not exists tax_email text,          -- 계산서 수신 이메일
  add column if not exists tax_manager_name text,   -- 계산서 담당자
  add column if not exists tax_manager_phone text;  -- 계산서 담당자 전화

-- 사업자등록증 판독(OCR)이 메모에 붙여 둔 업태·종목을 새 칸으로(첫 값, 빈 칸만)
update public.companies set
  biz_type = coalesce(biz_type, nullif(trim(substring(notes from '업태: ([^/\n]*)')), '')),
  biz_item = coalesce(biz_item, nullif(trim(substring(notes from '종목: ([^/\n]*)')), ''))
where notes ~ '(업태|종목): ';

create table if not exists public.tax_invoices (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid references public.orders(id) on delete set null,  -- 발주를 지워도 발행 기록은 남긴다
  order_no      text,
  company_name  text,
  tax_type      text not null check (tax_type in ('TAXABLE', 'TAX_FREE')),   -- 세금계산서(과세) / 계산서(면세)
  purpose       text not null check (purpose in ('RECEIPT', 'CLAIM')),       -- 영수 / 청구
  write_date    date not null,                                               -- 작성일자
  supply_cost   bigint not null,
  tax           bigint,                                                      -- 면세는 null
  total         bigint not null,
  request       jsonb not null,                                              -- 볼타로 보낸 본문
  client_ref    text not null unique,                                        -- Bolta-Client-Reference-Id(영구 1회용)
  issuance_key  text unique,                                                 -- 볼타 접수 번호
  status        text not null default '요청' check (status in ('요청', '발행완료', '실패')),
  nts_id        text,                                                        -- 국세청 승인번호
  issued_at     timestamptz,
  fail_code     text,
  fail_message  text,
  mode          text not null check (mode in ('test', 'live')),              -- test = 국세청 미전송(테스트 키)
  key_fp        text,                                                        -- 발행한 API 키 지문(sha256 앞 12자) — 키를 바꾼 뒤 옛 문서를 '접수 안 됨'으로 오판하지 않게
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
alter table public.tax_invoices add column if not exists key_fp text;
create index if not exists tax_invoices_order_idx on public.tax_invoices (order_id);
create unique index if not exists tax_invoices_live_uniq
  on public.tax_invoices (order_id, tax_type, mode) where status in ('요청', '발행완료');

alter table public.tax_invoices enable row level security;

notify pgrst, 'reload schema';
