-- 110: 미사용 DB 객체 정리 (2026-09-11 전수 조사 — 95개 객체 중 사용중 89, 고아/후보 6)
--
-- [바로 실행되는 부분] 코드·뷰·함수·크론·루커 어디서도 참조하지 않음이 검증된 고아만 삭제.
-- [주석 처리된 부분] 대표 확인이 필요한 항목 — 확인 후 주석을 풀어 별도 실행.
--
-- 참고: shipping_codes 는 054 가 이미 drop 완료(조치 불필요).
--       sales_customer_summary 는 루커 '신규/재구매' 대시보드의 데이터소스일 가능성이 높아 삭제 대상에서 제외
--       (이름에 OKR 이 없지만 구글시트 'OKR_고객요약' 이관본이라 혼동 주의 — OKR 스코어카드와 다른 물건).

-- 1) sales_sku_cost — 이익률 백데이터 원가표(043). 044에서 products 기준으로 전환된 뒤 소비자 0.
--    데이터는 로컬 '이익률계산백데이터.xlsx' 로 재시드 가능해 보존가치 낮음.
drop table if exists public.sales_sku_cost;

-- 2) [확인 후 실행] OKR 스코어카드 계열 — 코드 소비자는 없고, 루커(looker_ro grant)와
--    커스텀 리포트 화이트리스트만 물려 있음. **루커 대시보드에서 OKR 차트를 안 쓰는지 확인 후** 주석 해제.
--    (해제 시 코드측 app/lib/report-schema.ts 의 sales_okr 등재 3곳도 제거해야 함 — 요청 시 처리)
-- drop view if exists public.sales_okr;
-- drop table if exists public.sales_okr_babyfood_pattern;  -- sales_okr 뷰 삭제 후에만 가능

-- 3) [확인 후 실행] okr_checkins — OKR 1:1 체크인 원장(097). 화면/API 는 베타 대개편에서 제거되어 소비자 0.
--    단 1:1 면담 비공개 요약·todos 가 저장돼 있음 — **기록을 남길 필요가 없는지 확인 후** 주석 해제.
--    (남기려면 Supabase Dashboard > Table Editor 에서 CSV 내보내기 후 실행)
-- drop table if exists public.okr_checkins;
