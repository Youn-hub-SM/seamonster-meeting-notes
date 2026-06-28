-- VOC(고객의 소리) 관리 — 직접 입력부터. 설문(탈리)·리뷰는 source 로 구분해 같은 표에 적재.
-- 적용: Supabase Dashboard > SQL Editor 에 전체 붙여넣고 Run. 멱등 — 재실행 안전.

create table if not exists voc (
  id uuid primary key default gen_random_uuid(),
  received_at date not null default current_date,          -- 접수일
  source text not null default '직접입력'
    check (source in ('직접입력', '설문', '리뷰', '기타')), -- 수집 경로
  channel text,                                            -- 접촉 채널(전화/카톡/이메일 등) 자유
  customer text,                                           -- 고객명/연락처
  product text,                                            -- 관련 상품(자유 입력)
  category text not null default '불만'
    check (category in ('불만', '문의', '요청', '칭찬', '제안', '기타')),
  content text not null,                                   -- VOC 내용
  sentiment text check (sentiment in ('긍정', '부정', '중립')), -- 자동분류 대비(선택)
  status text not null default '접수'
    check (status in ('접수', '처리중', '완료', '보류')),
  assignee text,                                           -- 담당자
  resolution text,                                         -- 처리 내용/메모
  loss_amount numeric(12,0) not null default 0,            -- 손해/보상 금액
  created_by text,                                         -- 입력자
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists voc_status_idx on voc (status);
create index if not exists voc_received_idx on voc (received_at desc);
create index if not exists voc_source_idx on voc (source);

alter table voc enable row level security;  -- 서비스롤로만 접근(정책 없음)

NOTIFY pgrst, 'reload schema';
