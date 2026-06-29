-- VOC 폼 강화: 구매자 구분(첫/재구매) + 보상유형·수량(손해금액 자동계산) + 고객 특이사항.
-- 접수채널(channel)은 UI 에서만 제거하고 컬럼은 유지(기존 데이터 보존). 멱등 — 재실행 안전.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run.

alter table voc add column if not exists buyer_type text
  check (buyer_type in ('첫구매', '재구매'));                         -- 구매자 구분(선택)
alter table voc add column if not exists comp_type text not null default '없음'
  check (comp_type in ('환불', '반품', '교환·재발송', '추가보상', '부분환불', '없음')); -- 보상유형
alter table voc add column if not exists comp_qty integer not null default 1;  -- 보상 수량(자동계산용)
alter table voc add column if not exists customer_note text;          -- 고객 특이사항

NOTIFY pgrst, 'reload schema';
