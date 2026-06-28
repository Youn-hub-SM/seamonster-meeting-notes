-- VOC(고객의 소리) 관리 — 직접 입력부터. 설문(탈리)·리뷰는 source 로 구분해 같은 표에 적재.
-- 적용: Supabase Dashboard > SQL Editor 에 전체 붙여넣고 Run. 멱등 — 재실행 안전.
-- (이전 버전 023 을 이미 실행했다면, 데이터가 없을 때 먼저 `drop table if exists voc cascade;` 한 줄 실행 후 아래 실행.)

create table if not exists voc (
  id uuid primary key default gen_random_uuid(),
  received_at date not null default current_date,        -- 접수일
  channel text,                                          -- 접수채널 (전화/카톡/이메일/리뷰/설문 등)
  source text not null default '직접입력'
    check (source in ('직접입력', '설문', '리뷰', '기타')), -- 수집 방식(자동수집 구분용; 직접입력 폼 기본값)
  customer text,                                         -- 고객명
  purchase_date date,                                    -- 구매일
  purchase_place text,                                   -- 구매처
  product text,                                          -- 구매상품
  category text not null default '배송'
    check (category in ('배송', '품질', '포장', '누락', '오배송', '가시', '이물', '기타')), -- 클레임 유형
  content text not null,                                 -- 상세내용
  resolution text,                                       -- 처리내용
  cause text,                                            -- 원인
  status text not null default '대기'
    check (status in ('대기', '진행중', '완료')),          -- 처리 상태
  improvement text,                                      -- 개선 필요사항
  assignee text,                                         -- 담당자(선택)
  sentiment text check (sentiment in ('긍정', '부정', '중립')), -- 자동분류 대비(선택)
  loss_amount numeric(12,0) not null default 0,          -- 손해/보상 금액(손해금액 산정 기능용)
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists voc_status_idx on voc (status);
create index if not exists voc_received_idx on voc (received_at desc);
create index if not exists voc_category_idx on voc (category);
create index if not exists voc_source_idx on voc (source);

alter table voc enable row level security;  -- 서비스롤로만 접근(정책 없음)

NOTIFY pgrst, 'reload schema';
