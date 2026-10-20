# AI 데이터 비서 — 데이터 가시 범위 제안서 (2026-10-20)

대표 요청: "모든 데이터를 아직 볼 수 없는 것 같다. 배송일지 건별 입력 내역을 못 본다는 답을 받았다. 이런 사례가 또 있을지 확인하고 비서가 제 역할을 해낼 제안서를 써라."

## 1. 받은 사례의 원인 — 데이터는 있었고, 설명이 없었다

비서가 "배송일지(delivery_log)에는 날짜별 박스 합계만 들어 있다"고 답했지만 사실은 다릅니다. 건별 입력 내역(시각·구분·품목·증감·사유·입력자)은 **같은 표의 `manual_entries` 컬럼(jsonb 배열)** 에, 자동칸 기록은 `record_entries` 에 들어 있습니다(migration 076·078). 비서가 보는 **스키마 카탈로그(`app/lib/report-schema.ts`)에 이 두 컬럼 설명이 빠져 있어서** "조회 가능한 테이블에 없다"고 결론지은 것입니다. 비서는 카탈로그에 적힌 컬럼만 쓰도록 되어 있으므로(규칙: "스키마에 있는 실제 컬럼만"), 설명이 없으면 데이터가 있어도 없는 것과 같습니다.

**조치(이번 커밋)**: delivery_log 카탈로그에 두 jsonb 컬럼의 구조와 풀어 보는 SQL(`jsonb_array_elements`)을 적었습니다. 같은 질문을 다시 하면 건별 내역을 표로 뽑고 합계와 대조합니다.

## 2. 같은 유형의 위험 — jsonb 안에 숨은 데이터

카탈로그가 "jsonb"라고만 적거나 아예 언급하지 않은 컬럼은 비서가 풀어 보지 못합니다. 조회 가능 표 안에서 확인한 것:

| 표 | 컬럼 | 들어 있는 것 | 카탈로그 상태 | 조치 |
|---|---|---|---|---|
| delivery_log | manual_entries, record_entries | 건별 직접수정·자동 기록 | 없음 → **이번에 명시** | 완료 |
| delivery_log | boxes_normal_manual, boxes_guar_manual | 수동 보정 박스 수 | 없음 | 1차에 명시 |
| fulfill_dispatch | keys, unmatched | 발주 키 목록, 재고 안 빠진 코드 | unmatched 만 있음 | keys 명시 |
| crm_messages | perf | 발송·클릭·전환·매출 | 키 이름만 | 키별 뜻·단위 명시 |
| sales_reports | stats | 매출 리포트 수치 | "jsonb" 만 | 주요 키 명시 |
| subscription_snapshots | snapshot | 정기배송 KPI 14종 | "KPI 14종" 만 | 키 14개 이름·뜻 명시 |
| activity_log | meta | 이벤트별 상세(수량·금액·이전값) | "meta" 만 | 자주 쓰는 이벤트의 meta 키 명시 |
| voc | photos | 사진 경로 | 없음 | 명시(개수만 쓸 수 있게) |
| utm_links | (links 등) | UTM 조합 | 부분 | 명시 |

원칙: **jsonb 컬럼은 키 이름·뜻·단위·풀어 보는 SQL 한 줄까지 적는다.** 적지 않은 jsonb 는 비서에게 없는 데이터다.

## 3. 아예 조회 목록에 없는 표 — 분류

migration 전수(약 70개 표·8개 뷰)와 조회 가능 목록(47개)을 대조했습니다. 없는 것을 셋으로 나눕니다.

### A. 추가 권장 — 개인정보 없고 질문이 자주 나올 것
| 표 | 내용 | 비서가 답할 수 있게 되는 질문 |
|---|---|---|
| cafe24_subscriptions / cafe24_subscription_items / cafe24_subscription_payments / cafe24_subscription_state_log | 정기배송 신청·품목·결제·상태 변화(이름은 HMAC, 주소는 시·도만) | "이번 달 해지한 정기배송 몇 건이고 어느 회차에서 끊겼나", "2주 주기 신청자 수 추이" — 지금은 스냅샷 KPI 만 봄 |
| channel_claims | 채널 클레임(상태·유형·채널) | "이달 클레임 유형별 건수", "배송 파손 클레임 추이" |
| channel_catalog | 채널별 상품 등록 현황 | "쿠팡에 안 올라간 SKU" |
| shipping_codes | CNplus 코드표(박스타입·운임 구간) | "운임 구간이 왜 이렇게 잡혔나" |
| survey_responses | Tally 설문 원문(연락처 열 제외해 뷰로) | "설문에서 가장 많이 나온 불만" |
| sales_sku_cost, sales_okr_babyfood_pattern | SKU 원가·이유식 패턴 분석 | "채널별 이익", "이유식 고객 재구매" — 이익 질문은 지금 못 답함 |
| quote_snapshots | 견적 스냅샷 | "거래처별 최근 견적" |
| okr_checkins | OKR 체크인(개인 코멘트는 빼고 수치만 뷰로) | "OKR 이행률" |
| voc_monthly_reports, analyst_reports, analyst_period_reports | 월간 VOC·종합 리포트 본문 | 지금은 search_text/read_report 로만 봄 → 날짜·점수 같은 구조 컬럼을 SQL 로도 |
| fulfill_order_keys, fulfill_pending_keys | 발주 키·대기 키 | "어제 발주에서 빠진 주문" |

### B. 검색 도구로만 두는 것(본문이 길거나 민감)
channel_inquiries(문의 본문 — search_text 로 마스킹해 봄), cs_manual, production_requests 메모 — 지금 방식 유지.

### C. 제외 유지 — 개인정보·계정·비서 자체
sales_customers(전화·이름), companies·shipments 원본(수취인 — 대신 companies_report·shipments_report 뷰), bank_deposits·bank_deposit_names(입금 문자 원문·입금자명), app_users, b2b_settings(토큰·웹훅 주소 포함 kv), tax_invoices(사업자 정보), report_threads·messages·tables·glossary·feedback(비서 자체), briefings(중단된 기능), ig_dm_logs 의 사용자 ID 컬럼(뷰로 가릴 때까지).

## 4. 비서가 '제 역할'을 하기 위한 장치 — 데이터 추가만으로는 부족

1. **카탈로그 규율**(가장 중요): 새 표·새 jsonb 컬럼을 만드는 커밋은 같은 커밋에서 `report-schema.ts` 를 고친다(가이드 동시 갱신 규칙과 같은 방식). 체크리스트: 조회 목록 추가 여부 결정(A/B/C) → 컬럼 설명 → jsonb 는 키와 풀어 보는 SQL.
2. **"못 본다"는 답을 자동으로 모은다**: 비서가 "조회 가능한 테이블에 없다"·"볼 수 없다"로 답한 턴을 서버가 표시해 관리자 AI 설정 카드의 '못 본 데이터' 목록에 쌓는다(틀려요 피드백과 나란히). 어떤 데이터를 열어야 하는지 수요가 보인다.
3. **카탈로그 자가 점검 스크립트**: `scripts/check-catalog.ts` — DB 의 실제 컬럼(information_schema)과 카탈로그 설명을 대조해 '설명 없는 컬럼'·'조회 목록 밖 표'를 출력. 배포 전 한 번 돌린다.
4. **첫 답에 범위를 밝힌다**: 비서가 처음 보는 표를 쓸 때 "이 표에는 ○○까지 있고 △△는 없습니다"를 한 줄 적게 프롬프트에 둔다. 사용자가 '없다'를 '비서가 못 찾았다'와 구분할 수 있다.

## 5. 단계
| 단계 | 내용 | 노력 |
|---|---|---|
| 0(완료) | delivery_log 건별 내역 카탈로그 명시 | 끝 |
| 1 | §2 jsonb 컬럼 8개 설명 보강 + §3-A 중 개인정보 없는 표 즉시 추가(cafe24_subscription 4개, channel_claims, channel_catalog, shipping_codes, sales_sku_cost, quote_snapshots, fulfill_*_keys) + 카탈로그 설명 작성 | 1일 |
| 2 | 뷰가 필요한 것(survey_responses 연락처 제외 뷰, okr_checkins 수치 뷰, ig_dm_logs 가림 뷰) — migration 141 + 조회 목록 | 0.5일 |
| 3 | §4-2 '못 본 데이터' 수집 + 관리자 카드, §4-3 점검 스크립트 | 1일 |
| 4 | §4-1 규율을 CLAUDE.md 에 한 줄로(새 표 = 카탈로그 동시 갱신) | 즉시 |

## 7. 구조 전환으로 대체 (2026-10-20 대표 결정 — "표를 하나씩 열어 주는 일을 없애자")
§3-A·§5 의 "표 하나씩 추가"는 하지 않는다. 대신:
- **허용 목록 → 차단 목록**: `app/lib/report-schema.ts` `BLOCKED_RELATIONS`(18개: 고객·거래처 원본, 설문 원문, 설정 kv·UTM 설정·채널 명령, 계정, 입금, OKR 면담, 세금계산서, 비서 자체 표, 중단된 briefings). 그 밖의 public 표·뷰는 전부 조회 가능. SQL 검증(`report-ai.ts`)은 차단 이름 + 다른 스키마(factory·pg_catalog·information_schema) 참조를 막고, migration 141 이 `run_report` 의 차단 정규식도 같은 범위로 넓힌다(이중 방어).
- **설명은 DB 주석에서**: `app/lib/report-live-schema.ts` 가 information_schema + `obj_description/col_description` 을 run_report 로 읽어(10분 캐시) 프롬프트 목록과 schema 도구를 만든다. 손 카탈로그(SCHEMA_CATALOG)는 141 로 표 주석에 옮겼고, 주석 없는 표의 보충용으로만 남는다. 새 표·컬럼 = 마이그레이션에 `comment on` 한 줄.
- **점검**: `/api/report/schema-audit`(관리자) + AI 설정 '조회 범위' 카드 — 보이는 표 수, 설명 없는 표, 설명 없는 jsonb 컬럼, 개인정보 의심 컬럼 이름(phone·email·addr·token …, HMAC·해시 제외).
- **규율**: CLAUDE.md 에 한 줄(개인정보 표 = 차단 목록 + 정규식, 새 컬럼 = 주석).
- 남는 선택: §4-2 '못 본 데이터' 자동 수집은 보류(주석 점검 카드로 먼저 본다).

## 6. 대표가 정할 것(§7 로 대체됨 — 기록용)
| # | 질문 | 추천 |
|---|---|---|
| 1 | §3-A 표를 한 번에 열지, 질문이 나온 것부터 열지 | **한 번에**(개인정보 없는 것만, 1단계) |
| 2 | 설문·OKR·인스타 DM 처럼 가려야 하는 표는 뷰를 만들어 열지 | **뷰로 연다**(2단계) |
| 3 | '못 본 데이터' 자동 수집(§4-2)을 넣을지 | **넣는다** — 어떤 데이터를 더 열지 짐작 대신 수요로 정한다 |
