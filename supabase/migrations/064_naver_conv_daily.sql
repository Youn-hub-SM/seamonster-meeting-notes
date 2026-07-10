-- 064: 네이버 검색광고 '구매 전환' 일별 캐시
-- AD_CONVERSION_DETAIL 리포트(하루 단위 비동기)를 파싱해 엔티티별 '구매(purchase)' 전환수/매출을 저장.
-- /stats 는 전환유형(구매/장바구니) 필터가 없어, 구매 기준 ROAS를 이 캐시로 계산한다.
-- 리포트 재생성이 무겁기 때문에 일자 단위로 캐시(최근 2일은 매번 갱신).

create table if not exists naver_conv_daily (
  stat_date      date    not null,
  entity_type    text    not null check (entity_type in ('keyword', 'adgroup')),
  entity_id      text    not null,
  purchase_conv  integer not null default 0,
  purchase_sales bigint  not null default 0,
  updated_at     timestamptz not null default now(),
  primary key (stat_date, entity_type, entity_id)
);

create index if not exists idx_naver_conv_daily_range on naver_conv_daily (entity_type, stat_date);

-- 서비스 롤(supabaseAdmin)만 접근. RLS 켜고 정책 없음 → 익명/공개 접근 차단(마이그레이션 060 정책과 동일 취지).
alter table naver_conv_daily enable row level security;
