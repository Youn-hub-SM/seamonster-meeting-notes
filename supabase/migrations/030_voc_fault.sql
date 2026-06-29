-- VOC 손해 귀책(누구 책임인가) — 제조사 청구가능액 vs 자사 부담액 분리용.
--  제조사 / 물류 / 자사 / 고객 / 미분류. 기존 행은 클레임유형 기준 1차 자동 추정 백필.
-- 적용: Supabase Dashboard > SQL Editor 에 붙여넣고 Run. 멱등 — 재실행 안전.

alter table voc add column if not exists fault text not null default '미분류'
  check (fault in ('제조사', '물류', '자사', '고객', '미분류'));

-- 최초 1회 추정 백필(아직 미분류인 행만; 사람이 건별로 보정 가능)
update voc set fault = '제조사' where fault = '미분류' and category in ('품질', '가시', '이물', '포장');
update voc set fault = '물류'   where fault = '미분류' and category in ('배송', '오배송');
update voc set fault = '자사'   where fault = '미분류' and category in ('누락');

NOTIFY pgrst, 'reload schema';
