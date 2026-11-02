# 월간 VOC 리포트 업그레이드 기획안 — 판매·배송 대비 비율 분석 + 시각화 + 완성형 리포트

2026-11-02 · 대표 요청 "판매량·배송량을 반영해 비율로, 그래프 포함, 초안 말고 제대로 된 리포트 한 편, Word/PDF 유지, Fable 5.1" · 상태: **구현 완료 · 베타(2026-11-02, migration 159 적용 필요)** — §7 결정: 1 SKU 어종 코드 · 2 도매는 VOC 가 있을 때만 별도 기재 · 3 6개월 · 4 편집 칸 유지 · 5 Fable 5.1 effort high · 6 최소 판매 수량 기준 없음(율 그대로)

## 1. 목표

제조사에 그대로 제출할 수 있는 **월간 '고객 반응' 리포트 한 편**을 버튼 한 번으로 만든다.
건수만 나열하던 지금 문서를 **"얼마나 팔았고, 그중 몇 건이 문제였나"** 로 바꾼다. 숫자와 비율은 코드가 DB에서 계산하고(facts), 글은 Fable 5.1 이 facts 안에서만 쓴다. 차트는 화면과 Word 둘 다 들어간다.

## 2. 지금과 달라지는 것

| 항목 | 지금 | 바뀐 뒤 |
|---|---|---|
| 숫자의 기준 | VOC 건수(절대값) | **VOC율** = 건수 ÷ 판매 수량(또는 배송 건수) × 1,000. 전월·전년 같은 달·최근 6개월 추이 |
| 분석 축 | 유형·제품(VOC 안에서만) | **어종(품목 계열)·채널·유형·귀책·첫/재구매**를 매출 원장과 같은 키로 대조 |
| 글 | "초안" (편집 전제) | **완성 리포트**. 섹션·순서 고정, 모든 수치는 facts 에서만 인용(세지 않음) |
| 시각화 | 없음 | 추이(건수 막대+율 선)·유형별 6개월 누적·어종별 VOC율·채널별 VOC율·귀책 도넛. 종합 리포트와 같은 `charts.tsx` 프리미티브 |
| 출력 | Word·인쇄/PDF(텍스트만) | **그대로 유지** + Word 에 차트 PNG·표 삽입. 정산 엑셀 그대로 |
| 모델 | 설정값(기본 fable) | Fable 5.1 고정(effort 는 §7), 월 1회 수동 호출 |
| 저장 | draft·counts | + **facts(JSON)** 저장(migration 159) — 다시 열 때 재계산·재호출 없이 차트까지 그대로 |

## 3. 데이터 연결 — 무엇을 무엇으로 나누나

### 3-1. 연결 키

| 축 | VOC 쪽 | 매출·배송 쪽 | 비고 |
|---|---|---|---|
| **어종(품목 계열)** | `voc.product`(구매상품 — 상품마스터 콤보박스 이름) → `products.sku` → **어종 코드**(SKU 의 어종 토큰: DSC·CD·GA·AG·NA·DG·YA·SH·T …) | `sales_orders.sku_code` → `product_cost_lookup.product_sku`(158, TD_ 처리됨) → 같은 어종 코드 | 세트(예 `P-R-YA.DSC`)는 들어 있는 어종 모두에 1건씩. 마스터에 없는 VOC 상품명은 **'미매칭'** 으로 따로 세어 리포트에 밝힌다 |
| **채널** | `voc.purchase_place` (주문번호로 자동 채운 건은 매출 채널명과 같음) | `sales_orders.channel` | 손으로 적은 표기(공식몰·카페24 등)는 별칭표로 정규화, 안 맞으면 '기타' |
| **주문 1건** | `voc.order_no`(148) | `sales_orders.order_id` → `order_unit` | 있으면 어종·채널을 이름 대신 **주문에서 직접** 가져온다(가장 정확) |
| **첫/재구매** | `voc.buyer_type`(주문번호 자동) | `sales_new_repeat(p_from,p_to)` | "VOC 중 재구매 비중 vs 전체 고객 중 재구매 비중" |
| **네이버 문의** | `channel_inquiries`(137, 스마트스토어) | 스마트스토어 배송 건수 | 문의율 = 문의 ÷ 스마트스토어 배송 건수 × 1,000 |
| **도매** | `voc.purchase_place` 가 도매 업체명 또는 '도매' | `orders`(B2B, status 발송완료·ship_date 그 달) + `order_items` 수량 | §7-2 결정 뒤 포함 |

### 3-2. 분모(그 달)

- **판매 수량** = `sum(sales_orders.quantity)` (설문·취소 제외 없음 — 원장 그대로), 어종·채널별로도.
- **배송 건수** = `count(distinct order_unit)` (146 기준: 톡스토어 같은 주문자·주문일 = 1건) — "택배 1건당" 비율의 분모.
- 어종별 수량은 세트를 **구성품으로 전개**한 수량(`product_bundles`)을 쓴다 — 11팩 세트 1개 = 삼치 11팩. 전개는 `expandBundleQty()` 규칙과 같다.

### 3-3. 계산하는 facts (전부 코드, AI 는 읽기만)

```
summary: { month, voc_total, voc_mfg(제조사 귀책), loss_total, sold_qty, parcels, rate_per_1k_qty, rate_per_1k_parcel,
           prev: {…같은 항목}, yoy: {…}, inquiries: {total, unanswered, avg_answer_h, rate_per_1k_parcel} }
trend[6]:   { month, voc, sold_qty, parcels, rate_per_1k_qty }          ← 차트 ① (막대 건수 + 선 율)
by_category_trend[6]: { month, 배송, 품질, 포장, 누락, 오배송, 가시, 이물, 기타 }   ← 차트 ②
by_species: [{ code, name, sold_qty, voc, rate, top_category, mfg, loss }] (판매 ≥ 최소 수량만 율 표시) ← 차트 ③
by_channel: [{ channel, parcels, voc, rate, top_category }]                 ← 차트 ④
by_fault:   [{ fault, count, loss }]   by_category: [{ category, count, prev }]  ← 차트 ⑤ 도넛·파이
buyer: { voc_repeat_share, customers_repeat_share }
unmatched: { products: [name, count], places: [name, count] }           ← 리포트가 '집계 제외'로 밝힘
mfg_claims: 기존 buildManufacturerReport 결과(손해 청구 — 그대로)
```

## 4. 리포트 구성(고정)

| 번호 | 섹션 | 쓰는 쪽 | 차트 |
|---|---|---|---|
| 0 | 제목 + KPI 띠 4개: VOC율(판매 1,000개당)·VOC 건수·제조사 귀책 손해액·네이버 문의 | 코드 | — |
| 1 | 이번 달 종합 — 지난달·작년 같은 달 대비, 주요 정리, 제조사 요청 | AI | ① 추이 |
| 2 | 판매 대비 VOC 분석 — 어종별·채널별·유형별(율이 높은 곳, 오른 곳) | AI(facts 인용) | ③ 어종별 율 · ④ 채널별 율 · ② 유형 추이 |
| 3 | 고객 문의 — 가. 클레임 / 나. 그 외 문의 (VOC + 스마트스토어 문의, 2026-11-02 반영분) | AI | — |
| 4 | 고객 설문 — 긍정 / 개선·부정 | AI | — |
| 5 | 손해 청구(제조사 귀책) — 제품별·접수 상세 | 코드(지금 그대로) | ⑤ 귀책 도넛 |

AI 규칙: facts 에 없는 숫자 금지(세지 않음), 비율은 "판매 1,000개당 N건" 표기, 비교는 prev·yoy 만, 미매칭 건수는 "집계에서 뺀 N건" 한 줄로 밝힘, 고객 이름·아이디·연락처 금지(maskPii). 출력은 지금과 같은 "숫자. / 가. / - 라벨 : 내용" 순수 텍스트 — 화면·Word 변환기 호환.

## 5. 화면·출력

- **생성**: [리포트 생성] 한 번 → facts 계산(SQL 5~6개) → Fable 1회 → 저장(draft+facts). "초안" 표현 제거. 편집 칸은 §7-4.
- **화면**: KPI 띠(`.b2b-dash-grid > .b2b-stat-card`) → 리포트 본문(섹션 카드) → 섹션 뒤에 차트 카드(`charts.tsx` ComboBarLine·StackedBar·BarList·Donut·PieCard, 색은 PIE_COLORS·토큰만). 다시 열면 저장된 facts 로 즉시 렌더.
- **Word**: 화면의 SVG 차트를 브라우저에서 canvas → PNG 로 바꿔 본문과 함께 보내고, docx 가 `ImageRun`(PNG) 과 `Table` 로 넣는다. 서버에 이미지 라이브러리·폰트 추가 없음(한글 폰트는 브라우저가 그린다). 섹션 뒤 차트 위치는 §4 표와 같다.
- **인쇄/PDF**: 화면 그대로(SVG). 정산 엑셀: 변경 없음.
- **폴백**: 매출 원장이 그 달에 없으면 율 칸을 숨기고 건수만(0 으로 그리지 않음). 137 미적용이면 문의 생략. 옛 저장본(facts 없음)은 지금 모양.

## 6. 비용·부하

- AI 호출: 월 1회 수동(다시 생성 포함). 입력 ≈ facts 3천 자 + 원문(VOC·문의 각 ≤40건, 글자 상한) ≈ 2만 토큰. Fable 5.1 effort high 기준 회당 약 $0.5~1.
- DB: 생성 때만 집계 SQL(원장 1달 + 추이 6달 집계, 모두 인덱스 있는 날짜 범위). 크론·틱·폴링 없음. Vercel 호출 증가 0.
- 저장: `voc_monthly_reports.facts jsonb`(159) — 월 1행.

## 7. 대표 결정 (6건)

| # | 질문 | 추천 |
|---|---|---|
| 1 | 어종(품목 계열) 기준을 **SKU 어종 코드**로 잡는다(DSC 삼치·CD 참돔·GA 광어·AG 아귀·NA 농어·DG 대구·YA 연어·SH 새우·T 틸라피아). 빠진 코드가 있으면 알려 주세요 | 추천. 상품마스터 `attrs` 가 더 좋은 분류라면 그걸로 바꿀 수 있음 |
| 2 | **도매(B2B 발송)** 를 분모에 넣을지 — VOC 에 도매 건이 실제로 들어오나요 | 1차는 소매(매출 원장)만. 도매 VOC 가 쌓이면 2차 |
| 3 | 추이 창 **최근 6개월** vs 12개월 | 6개월(차트가 읽힘). 전년 같은 달은 숫자로 따로 |
| 4 | 화면 안 **편집 칸** — 유지(지금처럼 고쳐 자동 저장) vs 제거(Word 에서만 수정) | 유지(Word 전에 오탈자 바로잡기용). 이름만 '리포트 편집' |
| 5 | Fable 5.1 **effort** — high(약 $1/회) vs medium(약 $0.5) | high. 월 1회라 부담 작음 |
| 6 | 율 표시의 **최소 판매 수량** — 어종·채널이 그 달에 이 수량 미만이면 율을 숨기고 건수만(소량 품목의 1건이 율 1위로 튀는 것 방지) | 200개 |

## 8. 단계·일정 (총 4일)

| 단계 | 내용 | 일 |
|---|---|---|
| 1 | `app/lib/voc-monthly-facts.ts`(집계·어종 매핑·별칭표) + migration 159(facts) + `/api/voc/manufacturer/facts` | 1 |
| 2 | 프롬프트 개편(Fable, 섹션 고정, facts 인용 규칙) + 생성 흐름 | 0.5 |
| 3 | 화면: KPI 띠·섹션 카드·차트 5종·저장 facts 렌더 | 1 |
| 4 | Word: 차트 PNG(브라우저 변환) + docx ImageRun·Table, 인쇄 확인 | 1 |
| 5 | 가이드·메모리·베타 검증(10월 데이터로 실생성) | 0.5 |

## 9. 위험·전제

- VOC `product` 가 상품마스터 이름과 다르게 손으로 적힌 옛 행은 '미매칭'으로 빠진다. 리포트가 건수를 밝히므로 숨지는 않지만, 비율의 정확도는 등록 습관에 달려 있다(콤보박스에서 고르기).
- 매출 원장은 업로드 시점까지만 있다. 그 달 원장이 덜 올라간 상태에서 생성하면 율이 높게 나온다 → 화면에 '매출 반영 ~{maxOrderDate}' 를 띄운다.
- 종합 리포트(/briefing)와 산식·용어를 맞춘다(배송 건수 = order_unit, 재구매 = sales_new_repeat). 다른 수치가 두 리포트에 따로 나오지 않게.
