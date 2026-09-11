# DB 고아 객체 대장 (삭제하지 않고 보존 — 대표 결정 2026-09-11)

2026-09-11 전수 조사(마이그레이션 109개+factory열의 객체 95개를 코드·뷰·함수·pg_cron·looker_ro grant와 대조) 결과.
대표 결정: **지우지 않고 그대로 둔다.** 이 문서는 버그 리포트·감사·리팩터링 때 "소비자 없는 게 정상"인 객체를
결함으로 오인하지 않도록 하는 제외 목록이다.

| 객체 | 종류 | 출처 | 상태 | 비고 |
|---|---|---|---|---|
| `sales_sku_cost` | table | 043 | 고아 확정 | 044에서 products 기준 전환 후 소비자 0. 데이터는 로컬 이익률계산백데이터.xlsx 로 재시드 가능 |
| `shipping_codes` | table | 053 | DB에 없음 | 054가 이미 drop. 마이그레이션 파일·주석만 잔존 |
| `sales_okr` | view | 056 | 휴면(외부 의존) | 앱 코드 소비 0. looker_ro grant + report-schema.ts 화이트리스트 등재 — 루커 OKR 차트 사용 여부 미확인이라 보존 |
| `sales_okr_babyfood_pattern` | table | 056 | 휴면 | sales_okr 뷰의 서브쿼리만 참조. 뷰 운명에 종속 |
| `okr_checkins` | table | 097 | 고아 확정(데이터 보존) | OKR 1:1 화면/API는 제거됨. 1:1 면담 비공개 요약·todos 원장이 남아 있어 보존 |
| `sales_customer_summary` | view | 058 | **사용 중 취급** | 이름이 OKR 이관본이라 혼동 주의 — 실체는 루커 신규/재구매 대시보드 데이터소스. 삭제 금지 |

관련 코드 잔재(무해, 함께 보존): `scripts/seed-sku-cost.ts`(sales_sku_cost 1회성 시드, gitignore 대상),
`app/lib/voc-asana.ts` `getAsanaTasksStatus`(호출자 0), `app/lib/order-fulfill.ts` 3행 shipping_codes 주석,
`app/lib/report-schema.ts` 의 sales_okr·sales_customer_summary 등재(뷰가 살아 있으므로 정상).

삭제를 다시 검토하게 되면: 루커에서 OKR 차트 사용 여부 확인 + okr_checkins CSV 백업 여부 결정 후,
drop 순서는 `sales_okr`(뷰) → `sales_okr_babyfood_pattern` 순. sales_okr 삭제 시 report-schema.ts 3곳도 제거.
