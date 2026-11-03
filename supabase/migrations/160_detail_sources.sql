-- 160: 상세페이지 전송 — 공식몰(카페24) 상품 상세설명에 넣을 HTML 소스와 적용 기록.
--  적용: Supabase SQL Editor 에 전체 붙여넣고 Run. 멱등 — 재실행 안전. (159 다음에 적용)
--
-- 흐름: /detail 에서 소스 HTML 입력·미리보기 → 상품번호 입력 → [쏘기] = detail_applies 대기 행 생성 →
--  중계 실행기(scripts/detail-apply-runner.mjs)가 claim → 카페24 상품 수정 API(description) → report.
-- 카페24 Admin API 는 IP 제한이 없지만 refresh_token 이 쓸 때마다 회전하므로 토큰 보유처는 중계 서버 하나로 통일(기존 방침).
-- 소스 블록은 상세설명 안에 <!-- sm:src=ID --> … <!-- /sm:src=ID --> 주석 마커로 감싸 넣는다 —
--  같은 소스를 다시 쏘면 그 자리만 갱신되고 중복으로 쌓이지 않는다. 주석은 화면·크롤러 모두에 보이지 않는다.

create table if not exists detail_sources (
  id bigserial primary key,
  name text not null,
  html text not null default '',
  position text not null default 'append',   -- replace(전체 교체) | prepend(기존 맨 앞) | append(기존 맨 뒤)
  version integer not null default 1,        -- html 이 바뀔 때마다 +1
  created_by text,
  created_at timestamptz not null default now(),
  updated_by text,
  updated_at timestamptz not null default now()
);

comment on table detail_sources is '공식몰(카페24) 상품 상세설명에 넣는 HTML 소스(공통 블록). /detail 화면에서 편집';
comment on column detail_sources.position is '넣는 자리: replace=전체 교체, prepend=기존 상세설명 맨 앞, append=맨 뒤';
comment on column detail_sources.version is 'HTML 이 바뀔 때마다 1씩 증가. detail_applies.source_version 과 비교하면 옛 버전이 적용된 상품을 찾을 수 있다';

create table if not exists detail_applies (
  id bigserial primary key,
  source_id bigint not null references detail_sources(id) on delete cascade,
  source_version integer not null,
  product_no integer not null,               -- 카페24 상품번호
  product_name text,                         -- 요청 시점 카탈로그 상품명(표시용)
  html text not null,                        -- 쏜 시점의 소스 HTML 스냅샷
  position text not null,
  status text not null default '대기',       -- 대기 | 실행중(실행기 선점) | 완료 | 실패
  error text,
  verified boolean,                          -- 완료 뒤 공개 상품 페이지 원본 HTML 에서 마커 확인 여부
  backup_html text,                          -- 실행기가 쓰기 직전 읽은 원래 상세설명(되돌리기용)
  requested_by text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,                    -- 10분 지난 '실행중'은 고아로 보고 재선점
  executed_at timestamptz
);

comment on table detail_applies is '상세페이지 소스를 어떤 상품에 언제 쏘았는지(적용 기록). 소스별 적용 상품·상품별 적용 소스 조회는 status=완료 의 최신 행';
comment on column detail_applies.product_no is '카페24 상품번호(channel_catalog.origin_no, 채널 카페24)';
comment on column detail_applies.status is '대기 | 실행중 | 완료 | 실패';
comment on column detail_applies.backup_html is '쓰기 직전 카페24에서 읽은 원래 상세설명 전체';

create index if not exists detail_applies_source_product_idx on detail_applies (source_id, product_no, created_at desc);
create index if not exists detail_applies_product_idx on detail_applies (product_no, created_at desc);
create index if not exists detail_applies_status_idx on detail_applies (status, created_at);

alter table detail_sources enable row level security;  -- service key 전용(정책 없음)
alter table detail_applies enable row level security;

NOTIFY pgrst, 'reload schema';
