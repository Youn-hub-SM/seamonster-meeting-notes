-- 055 배송일지(delivery_log) — 구글시트 '택배일지/도착보장/드라이아이스'를 웹으로 이관.
--  날짜별 1행. 택배량·기본운임은 발주처리가 자동 기록, 추가운임·파도·드라이아이스·비고는 수동 편집.
-- 적용: Supabase SQL Editor 에 이 파일 하나만 붙여넣고 Run. 멱등.

create table if not exists delivery_log (
  log_date        date primary key,
  -- 자동(발주처리에서 기록): 박스종류별 개수 {"굴":n,...}
  boxes_normal    jsonb  not null default '{}'::jsonb,   -- 일반 택배량
  boxes_guar      jsonb  not null default '{}'::jsonb,   -- 도착보장 택배량
  base_fee_normal bigint not null default 0,             -- 씨몬 기본운임(일반) = 그날 기본운임 합
  base_fee_guar   bigint not null default 0,             -- 도착보장 기본운임 합
  -- 수동
  extra_fee       bigint not null default 0,             -- 씨몬 추가운임
  guar_extra_fee  bigint not null default 0,             -- 도착보장 추가운임
  pado_fee        bigint not null default 0,             -- 파도 운임
  pado_extra      bigint not null default 0,             -- 파도 추가운임
  pado_cod        bigint not null default 0,             -- 파도 착불
  dryice_full     numeric not null default 0,            -- 드라이아이스 풀박
  dryice_half     numeric not null default 0,            -- 드라이아이스 반박
  memo            text,
  updated_at      timestamptz not null default now()
);

create index if not exists delivery_log_date_idx on delivery_log (log_date desc);
alter table delivery_log enable row level security;

notify pgrst, 'reload schema';
