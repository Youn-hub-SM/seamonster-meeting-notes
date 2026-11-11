-- 166: 광고 카피 에이전트(/agents 'ad-copy') 자료 표 — 타사 광고 레퍼런스 + 공식몰 리뷰.
--  적용: Supabase SQL Editor 에 전체 붙여넣고 Run. 멱등 — 재실행 안전. (165 다음에 적용)
--
-- 광고 카피 에이전트는 매주 ① 리뷰·문의·VOC ② 타깃 트렌드(웹 조사) ③ 메타 광고 성과·타사 레퍼런스를 보고 신규 소재 목록을 낸다.
--  · ad_references = 담당자가 /agents 화면에서 직접 올리는 타사 광고(링크·문구·이미지). 자동 수집 없음.
--  · shop_reviews  = 중계 서버(scripts/cafe24-review-sync.mjs)가 카페24 게시판 API 로 올리는 공식몰 리뷰.
--    작성자 이름·아이디·연락처·주문번호는 받지 않는다(본문·별점·상품·작성일만).
--  보고서 자체는 agent_reports(164)에 쌓인다 — 이 에이전트의 draft 는 소재 배열이다(아래 comment 갱신).

create table if not exists ad_references (
  id uuid primary key default gen_random_uuid(),
  brand text not null,                         -- 브랜드·광고주 이름
  channel text,                                -- 본 곳(메타·인스타그램·유튜브·네이버·기타)
  url text,                                    -- 광고 라이브러리·게시물 링크
  copy_text text,                              -- 광고 문구(본문·제목을 옮겨 적은 것)
  note text,                                   -- 담당자 메모(눈에 띈 점·참고할 점)
  images jsonb not null default '[]'::jsonb,   -- 캡처 이미지 공개 주소 배열(Storage 'ad-references')
  created_by text,
  created_at timestamptz not null default now()
);
comment on table ad_references is '타사 광고 레퍼런스(/agents 광고 카피 에이전트 자료). 담당자가 직접 올린다. brand=광고주, copy_text=광고 문구, note=담당자 메모, images=캡처 이미지 주소 배열';
comment on column ad_references.channel is '광고를 본 곳(메타·인스타그램·유튜브·네이버·기타)';
comment on column ad_references.copy_text is '타사 광고의 문구(본문·제목). 담당자가 옮겨 적은 글';
comment on column ad_references.images is '캡처 이미지 공개 주소 배열(문자열). 광고 카피 에이전트가 이미지로 읽는다';
create index if not exists ad_references_created_idx on ad_references (created_at desc);
alter table ad_references enable row level security;  -- service key 전용(정책 없음)

create table if not exists shop_reviews (
  id uuid primary key default gen_random_uuid(),
  channel text not null default '공식몰',       -- 리뷰가 달린 곳
  board_no integer not null,                   -- 카페24 게시판 번호
  article_no bigint not null,                  -- 게시글 번호
  product_no bigint,                           -- 카페24 상품 번호
  product_name text,                           -- 상품명(수집 시점)
  rating integer,                              -- 별점 1~5(없으면 null)
  title text,
  content text,                                -- 리뷰 본문(태그 제거)
  has_photo boolean not null default false,
  written_at timestamptz,                      -- 작성 시각
  synced_at timestamptz not null default now(),
  unique (channel, board_no, article_no)
);
comment on table shop_reviews is '공식몰(카페24) 상품 리뷰. 중계 서버가 게시판 API 로 수집. 작성자 정보는 저장하지 않는다. rating=별점, content=리뷰 본문, written_at=작성 시각';
comment on column shop_reviews.rating is '별점 1~5. 게시판이 별점을 주지 않으면 null';
comment on column shop_reviews.content is '리뷰 본문(HTML 태그 제거). 고객이 쓴 글 그대로라 연락처 등이 섞일 수 있어 읽는 쪽이 가린다';
comment on column shop_reviews.product_name is '리뷰가 달린 상품 이름(수집 시점)';
create index if not exists shop_reviews_written_idx on shop_reviews (written_at desc);
alter table shop_reviews enable row level security;  -- service key 전용(정책 없음)

comment on column agent_reports.draft is '에이전트가 낸 결과 배열. wholesale-request: 제안 품목(sku, name, qty, reason, urgent, wholesale_stock, daily_out, formula, open_req). ad-copy: 신규 광고 소재(title, kind=새 시도|변주, angle=소구점, target, format, hook, story, offer, primary_text=광고 본문, headline, visual, basis=근거)';
comment on column agent_reports.facts is '작성 시점 사실 요약. wholesale-request: 기준일·목표 일수·품목 수·경고. ad-copy: stage(단계 진행), notes(단계별 조사 요약: voice=고객 목소리, trend=타깃 트렌드), counts(읽은 자료 수), warnings';
