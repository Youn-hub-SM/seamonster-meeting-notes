# 씨몬스터 내부도구 디자인 시스템

> 목적: **어떤 세션이 만들어도 같은 화면이 나오게 한다.** 사용자는 같은 의미를 같은 자리·같은 모양으로
> 만나는 익숙함을 느껴야 한다. UI(화면·컴포넌트·차트)를 만들거나 고치기 전에 이 문서를 먼저 읽는다(CLAUDE.md 규칙).
>
> 한 줄 요약: **색은 시맨틱 토큰, 간격은 4px 스케일, 컴포넌트는 결정표에서, 차트는 프리미티브에서,
> 같은 의미는 색 지도에서. 없으면 지어내지 말고 시스템에 추가한다.**

토큰 단일 소스: **`app/globals.css` 의 `:root`**. 이 문서의 값과 코드가 다르면 **코드가 정답**이고,
그걸 발견한 세션이 이 문서를 고친다. (과거 이 문서의 낡은 값 #666/#999 가 코드 5곳에 박제된 적이 있다 —
문서가 틀리면 문서 자체가 이탈의 발원지가 된다.)

---

## 0. 4대 원칙

1. **하드코딩 금지.** 인라인 `style={{ color: "#c92a2a" }}` / `fontSize: 13` 대신 토큰(`var(--sm-danger)`)과 공용 클래스.
2. **공용 우선.** 만들기 전에 §1 결정표에서 찾는다. 표에 없으면 `grep -rn "필요한것" app/globals.css app/b2b/b2b.css` —
   클래스 정의는 이 두 파일뿐이다.
3. **없으면 시스템에 추가.** 새 색·간격은 `:root` 에 토큰으로. 전 도구 공용 컴포넌트는 `.sm-*` 로 `globals.css` 에
   (`.b2b-*` 신설 금지 — CLAUDE.md 4항. 페이지 전용이면 `.ma-*`·`.sales-*` 같은 접두사).
4. **없는 토큰을 지어내지 않는다.** `var(--sm-surface-2, #f7fafb)` 처럼 쓰면 grep 에 안 걸려 규칙을 지킨 듯 보이지만,
   그 이름이 `:root` 에 없으면 **폴백 hex 가 항상 렌더된다**(= 인라인 하드코딩). 폴백이 없으면 선언 자체가 무효가 되어
   색이 조용히 상속된다. 쓰기 전 확인: `grep -- "--sm-<이름>:" app/globals.css` — 매치 0이면 존재하지 않는 토큰이다.

---

## 1. 결정표 — 새 화면을 만들거나 고칠 때 여기서 찾는다

| 필요한 것 | 쓰는 것 | 주의 |
|---|---|---|
| 페이지 셸 | `.b2b-container` > `.b2b-page-head` > `h1.b2b-page-title` + `p.b2b-page-subtitle` + `.b2b-page-actions` | 폭·여백은 layout 의 `.b2b-main` 이 담당 |
| 제목 있는 섹션 | `.b2b-card` + `.b2b-card-head` > `span.b2b-card-title` | **`.b2b-card` 는 투명 플랫 래퍼(border:none)** — 시각적 카드가 아니다. §2-3 |
| 테두리 있는 카드 / KPI 타일 | `.b2b-stat-card` + `-label` + `-value` (+`-hint`) | 진짜 테두리·그림자는 이쪽 |
| 폼 섹션(흰 배경 박스) | `.b2b-form-section` + `-title` + `.b2b-form-foot` | |
| 탭·토글 (상태/기간/뷰 전환 전부) | `.sm-tabbar` 또는 `.sm-tabs` > `.sm-tab` + `.is-active` | 자체 Chip 금지. 활성 = 주황 채움 + 흰 글씨가 앱 표준. §5 스니펫 |
| 버튼 | `.b2b-btn-primary` / `-secondary` / `-danger` · `.b2b-link-btn` · `.b2b-icon-btn` | |
| 입력·폼 필드 | `.b2b-input` · `.b2b-field` + `.b2b-field-label` · `.b2b-combo` · `.b2b-checkbox` | |
| 표 | `.b2b-table-wrap` > `.b2b-table` | 모바일 카드 변환은 `data-label` |
| 오류 배너 | `.b2b-error` | |
| 성공 / 경고 배너 | `.sm-success` / `.sm-warn` | `.b2b-error` 와 형태가 같은 3형제(globals.css). `.prod-sku-ok` 는 SKU 생성기 전용 — 차용 금지 |
| 상태 배지 | `.b2b-status-pill` + 색은 §4 색 지도에서 | `.b2b-feed-pill` 은 네비 '최근 변경' 드롭다운 **트리거** — 배지 아님(기존 사용처는 점진 정리) |
| 빈 상태 / 로딩 | `.b2b-empty` / `.b2b-loading` | **서로 바꿔 쓰지 말 것** — 같은 회색·같은 패딩이라 화면에서 구분 불가 |
| 모달 | `.b2b-modal-backdrop` > `.b2b-modal` + `-head` / `-body` / `-foot` | |
| 통계 히어로(도넛+총계+지표) | `.b2b-card.sm-stat-hero` | 예: b2b/reports · voc/stats · voc/loss |
| 차트 | `app/components/charts.tsx` 프리미티브 | **자체 차트 금지** — §6 |
| 캘린더 | `prod-cal` / `b2b-cal` 세트 (노션풍) | |
| 본문·부제목 안 인라인 링크 | `.sm-link` (크기 상속) | 클래스 없는 `<a>` 는 리셋 때문에 본문과 같은 검정으로 렌더됨. `.change-link` 는 홈 업데이트 노트 전용(12.5px 고정) |
| 표 안 상태 변경 select | `.b2b-status-select` + 색은 색 지도에서 | `.b2b-input` 으로 흉내내지 말 것 |
| KPI 숫자 타일 | `.b2b-stat-card` + `-label` + `-value`(`b2b-money`) + `-hint` | 화면마다 자체 타일을 만들지 말 것 |
| iframe 도구 전체 높이 | `.sm-iframe-fill` | 모바일 상단바 높이까지 계산돼 있음 |
| VOC 미구현 메뉴 | `VocPlaceholder` 컴포넌트 | |
| 체크박스식 다중 필터 | `.b2b-checkfilter-row` | |

사이드바(전역): `.app-sb-*` — `app/globals.css`.

### 카피 규칙 — 안내 문구는 설명이 아니라 규칙만 (부제·카드 캡션·폼 도움말·모달 전부)

**"이 화면(기능)이 무엇을 하는지" 설명·사용법 안내·설득 문구·`(전체 N건)` 카운트·사이드바와 중복인 링크를
화면 어디에도 쓰지 않는다.** 부제만이 아니라 카드 캡션·폼 도움말(`sm-faint`)·모달 안내까지 전부다.
사용자는 이미 알고, 텍스트가 많으면 화면이 복잡해진다(2026-07 사용자 결정으로 68곳 전수 삭제).
새 기능을 만들 때도 같다 — 안내 문구가 허용되는 경우는 둘뿐, 어느 쪽이든 **한 줄 이하**:
1. **집계·계산 기준** — 지우면 숫자를 오독하는 것. 예: "발주일 기준 · 취소 제외", "각 칸 = 그 시점까지의 누적 생산량"
2. **데이터 부작용 규칙** — 모르면 실수하는 것. 예: "단가는 적용 시작일별로 관리 — 소급 적용되지 않습니다",
   "SKU가 상품 마스터에 없으면 자동 생성됩니다"

나쁜 예(실제 있었던 것): "이 SKU가 상품에 없으면 자동 생성됩니다. **아래 정보까지 넣으면 상품마스터에 갈 필요가 없습니다.**"
— 첫 문장은 데이터 규칙이라 유지, 둘째 문장은 설득이라 삭제.

안내가 아닌 **데이터**(거래처 상세의 사업자번호 등)·**조건부 상태 경고**(발주 복제 직후)·**입력 형식 지정**(업로드 파일 종류)은 예외.
다운로드되는 엑셀 양식 안 설명문은 UI 가 아니므로 이 규칙 밖(맥락 없이 읽히므로 오히려 자세히).

---

## 2. 함정 — 실제로 반복해서 빠진 것들 (2026-07 전수 점검에서 확인)

몰라서 생기는 이탈이다. 새 세션도 똑같이 빠지므로 UI 작업 전에 한 번 훑는다.

1. **문서·주석·기존 코드의 색 값을 믿지 말 것.** `:root` 가 정답. 낡은 값이 코드에 남아 선례처럼 보이는 경우가 있다.
2. **유령 토큰** — §0 원칙 4. `var(--없는토큰, #hex)` 32곳이 이걸로 생겼다.
3. **`.b2b-card` 에 `borderColor`** — `border:none` 이라 아무것도 그려지지 않는다. 8곳이 "강조 테두리가 있는 줄" 알았지만
   화면엔 없었다. 테두리가 필요하면 `.b2b-stat-card` / `.b2b-form-section`.
4. **SVG `<rect rx>`** — 네 모서리가 전부 둥글어진다. 막대 꼭대기만 둥글게는 charts.tsx 의 `barPath()` (이미 프리미티브가 처리).
5. **빈 상태를 `.b2b-loading` 으로 그리기** — 사용자가 "로딩 중인지 결과가 없는 건지" 구분 못 한다. 빈 상태는 `.b2b-empty`.
6. **성공/실패 분기에 문자열 스니핑** — `msg.startsWith("")` 는 항상 true(실제 버그였음). `{ ok, text }` 플래그로.
7. **캔버스(Chart.js)는 CSS 변수를 못 읽는다** — /subscription 은 `CSSV()` 로 런타임 해석. §6 예외.
8. **`document.write` 인쇄 팝업은 별도 문서** — globals.css 미로드, `var()` 불가(fulfill/scan). 리터럴 유지가 맞다.
9. **`app/globals.css`·`app/b2b/b2b.css` 는 전 서비스 공용 파일** — 고치기 전에 다른 세션에 알린다(CLAUDE.md 3-(b)).
10. **표를 `.b2b-table-wrap` 없이 두면 모바일에서 페이지 전체가 옆으로 밀린다** — th 가 nowrap 이라 4열 이상은
    콘텐츠 폭(347px)을 초과한다. 인쇄용 문서 페이지(결산·명세표·요청서)도 화면으로 먼저 보이므로 예외가 아니다
    (2026-07 실제로 7개 표가 이 상태였고, 운임 설정은 삭제 버튼이 화면 밖이라 조작 불가였다).
11. **`100vh` 는 iOS 에서 주소창만큼 어긋난다** — 새 코드는 `100dvh`(+ vh 폴백). 상단바 높이는 52px 하나뿐이다
    — 60px/64px 는 삭제된 옛 헤더의 잔재값이니 보이면 의심할 것.

---

## 3. 토큰

### 색 — 시맨틱은 텍스트 / -bg / -border 3종 세트

배너·배지는 이 세트만 조합한다. (danger 만 3종이던 시절, 나머지는 테두리 색이 없어 화면마다 hex 를 지어냈다 — 세트에 구멍을 내지 말 것.)

| 의미 | 텍스트 | -bg | -border | 용도 |
|---|---|---|---|---|
| `--sm-danger` | #C92A2A | #FCE4E4 | #F5C6C6 | 오류·삭제·미입금 + **진짜 이상치**(재고 마이너스·부족). 정상 흐름(출고 등)에 쓰지 않는다 |
| `--sm-success` | #22863A | #E6FFED | #C6EDD3 | 완료·성공·입금완료 |
| `--sm-warning` | #B08800 | #FFF4E0 | #F0D9A8 | 대기·주의 |
| `--sm-info` | #1971C2 | #E0F0FF | #B8D6F2 | 정보·진행중·링크강조 |

브랜드: `--sm-orange` #F15A30 · `-hover` #D94E26 · `-light` rgba(241,90,48,.06) · `-border` rgba(241,90,48,.12)

중립: `--sm-black` #1A1A1A(본문) · `--sm-dark` #37352F(짙은 웜그레이) · `--sm-text-mid` #555(보조) ·
`--sm-text-light` #6B6B6B(흐림) · `--sm-text-faint` #C7C7C7(값 없음 "·" 플레이스홀더) · `--sm-white` ·
`--sm-bg` #FAFAFA(페이지) · `--sm-bg-warm` #FFF5F0 · `--sm-bg-subtle` #F7F8FA(표 헤더·합계행) ·
`--sm-border` #EEE · `--sm-border-light` #F4F4F4(차트 격자)

### 간격 (4px 베이스) / 타이포 / 반경 / 폰트

- 간격: `--sm-space-1~6` = 4 / 8 / 12 / 16 / 24 / 32 (`--sm-pad`=24 페이지 여백). 임의 px(5·7·13) 대신 이 단계로.
- 타이포: `--sm-fs-xs~2xl` = 12 / 13 / 14(본문) / 15 / 17 / 19 / 23
- 반경: `--sm-radius`=8 · `-btn`=12 · `-card`=16 · `-pill`=50 / 그림자: `--sm-shadow-card` · `--sm-shadow-float`
- 폰트: `--sm-mono` (SKU·코드용 모노스페이스 스택)

### 유틸 클래스 (globals.css) — 반복 인라인 대체

`.sm-row` `.sm-row-wrap` `.sm-col` `.sm-between` (flex) · `.sm-muted`(--sm-text-mid) `.sm-faint`(--sm-text-light) ·
`.sm-nowrap` `.sm-ellipsis` · `.sm-gap-1~4`

---

## 4. 의미축 색 지도 — 같은 뜻은 항상 같은 색

정의는 lib 한 곳, **배지·표·차트가 전부 그 지도를 조회한다.** 화면에서 새로 선언하지 말 것.
(어기면 같은 "출고"가 배지는 파랑·숫자는 빨강, 같은 "개선완료"가 히어로는 초록·추세는 주황으로 갈린다 — 실제 있었던 일.)

| 축 | 지도 | 위치 |
|---|---|---|
| 재고 유형 (입고=success · 출고=info · 조정=warning) | `INV_TYPE_COLOR` | `app/lib/inventory.ts` |
| 재고 채널 (도매=orange · 소매=info) | `INV_CHANNEL_COLOR` | `app/lib/inventory.ts` |
| 발주 상태·생산·입금·세금계산서·발송 | `STATUS_COLORS` `PRODUCTION_COLORS` `PAYMENT_COLORS` `TAX_INVOICE_COLORS` `SHIPMENT_STATUS_COLORS` | `app/lib/b2b-orders.ts` |
| VOC 상태 (접수=info · 응대개선중=warning · 개선완료=success) | `VOC_STATUS_COLOR` | `app/lib/voc.ts` |
| VOC 귀책 (제조사=success · 물류=warning · 자사=danger · 고객=info · 미분류=text-light) | `VOC_FAULT_COLOR` | `app/lib/voc.ts` |
| 생산요청 상태 | `PR_STATUS_COLOR` | `app/lib/wholesale-production.ts` |

**categorical 예외** (서열 없는 구분용 — 의도적으로 토큰이 아님): `PIE_COLORS`(charts.tsx) ·
`COLORS`(production-promotions 캘린더 밴드) · `CH_COLOR`(crm 채널). 이 밖에 새 categorical 팔레트를 만들지 말 것.

**증감·이익 색 규칙**: 요약(KPI·배지)에서 좋은 값 = `--sm-success`, 나쁜 값 = `--sm-danger`.
빽빽한 표 안 금액은 중립(`--sm-dark`) — 표 전체가 초록이 되면 오히려 신호가 죽는다. 주황은 브랜드 강조지 시맨틱이 아니다.

**금액 표기**: 반올림·콤마는 `app/lib/format.ts` 의 `won()` 한 곳(접미사 "원"만 화면 로컬).
억/만 축약은 `moneyCompact`(charts.tsx) — 자체 축약 함수를 만들지 말 것.

---

## 5. 탭 스니펫 (`.sm-tab` — 전 도구 공용, globals.css)

상태·기간·뷰 전환 등 모든 토글이 이 하나다. `.sm-tab:disabled` 는 잠김(50% 흐림).

```tsx
<div className="sm-tabbar">
  {(["전체", ...STATUSES]).map((s) => (
    <button key={s} className={`sm-tab ${tab === s ? "is-active" : ""}`} onClick={() => setTab(s)}>
      {s}<span className="sm-tab-count">{counts[s]}</span>
    </button>
  ))}
  <input className="b2b-input sm-tab-search" placeholder="검색" />  {/* 우측 240px, 모바일 전체폭 */}
</div>
```

검색이 없으면 `.sm-tabbar` 대신 `.sm-tabs`.

---

## 6. 차트 — charts.tsx 프리미티브만 (`app/components/charts.tsx`)

| 프리미티브 | 용도 | 주요 prop |
|---|---|---|
| `Donut` | 도넛 + 중앙 총계 | `data` `colors` `size`(기본 132) `center` `centerSub` |
| `PieCard` | 도넛 + 값·비율 범례 카드 (Donut 재사용) | `title` `data` `fmt` `colors` `size` |
| `TrendChart` | 단일 세로막대 추세 | `data` `fmtAxis` **`accent`(의미색)** |
| `StackedBar` | 누적 세로막대 (기간 x 카테고리) | `periods` `series` **`colors`(색 지도)** `fmtAxis` `unit` |
| `ComboBarLine` | 누적막대 + 선, 좌우 2축 | `barColors` **`barFmt`**(금액이면 `moneyCompact`) `lineFmt` `lineColor`(기본 `CHART_LINE` 보라) |
| `BarList` | 가로 순위막대 카드 | `title` `caption` `accent` `fmt` `sub` `minPct` `sorted` |
| `ChartLegend` | 범례 | `items: [라벨, 색][]` — 인라인 범례 재구현 금지 |
| 헬퍼 | `moneyCompact`(억/만 축약) · `niceCeil`(축 상한) · `PIE_COLORS` · `CHART_LINE` | |

규칙:
- **화면에서 자체 차트를 만들지 않는다.** 표현이 부족하면 프리미티브에 prop 을 추가한다.
  (accent·barFmt·sub·minPct 가 없던 시절 화면마다 자작 차트가 생겼고, 그게 그래프 불일치의 뿌리였다.)
- 의미축 데이터는 §4 색 지도를 `accent`/`colors` 로 전달. 지도 없는 분류만 `PIE_COLORS` 순환.
- 좌표계(높이 240·여백·막대폭·모서리 4)는 내부 `GEOM` 상수가 3종 막대에 공유된다 — 개별 화면에서 크기를 흉내내지 말 것.
- X축 라벨은 기간이 많으면 자동으로 솎아진다 — 화면에서 직접 그리지 말 것.

**예외 — `/subscription`** (`public/subscription-dashboard.html`): 코드베이스 유일의 Chart.js(CDN).
캔버스는 CSS 변수를 못 읽으므로 색은 `CSSV()`/`T{}` 로 **파일의 `:root` 에서 런타임 해석**한다 — JS 에 hex 하드코딩 금지.
규격(직선·점 2.4·모서리 4·격자색)은 `applyChartDefaults()` 가 공용 차트에 맞춘다.

---

## 7. 변경 전파 — 시스템을 바꾸면 어디가 따라오나

| 바꾸는 것 | 따라오는 곳 | 방법 |
|---|---|---|
| 색·간격·타이포 토큰 (`globals.css` `:root`) | React 전 화면 | 자동 (`var()` 참조) |
| 〃 | `public/` 정적 HTML 2개 (utm-builder · subscription-dashboard) | **`npm run sync-tokens`** — `npm run build` 가 먼저 실행하므로 배포는 항상 동기. dev 중엔 수동 실행 |
| 〃 | /subscription 의 Chart.js 색 | 파일 `:root` 를 런타임에 읽으므로 sync 만 되면 자동 |
| 컴포넌트 모양 (`.b2b-*` / `.sm-*`) | 전 화면 | 자동 (클래스) — 단 두 CSS 는 공용 파일(§2-9) |
| 차트 규격 (`GEOM`·프리미티브) | 통계 화면 전부 | 자동 |
| 의미색 (lib 색 지도) | 그 축을 그리는 배지·표·차트 | 자동 (지도 조회) |
| 따라오지 **않는** 곳 | fulfill/scan 인쇄 팝업(별도 문서) · categorical 팔레트(의도) | 수동 / 불변 |

동기화 스크립트: `scripts/sync-design-tokens.mjs` (`--check` = 검사만, 어긋나면 exit 1).
정적 도구를 새로 만들면 이 스크립트의 `TARGETS` 에 매핑을 등록한다.

---

## 8. 검증

- `npx tsc --noEmit` + `npm run build` — 단 **둘 다 색·클래스 오용은 못 잡는다**(토큰은 그냥 문자열이다).
- `public/` 정적 HTML 을 고쳤으면 인라인 스크립트 문법 검사:
  `node -e "const s=require('fs').readFileSync('public/파일.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1]; new (require('vm').Script)(s); console.log('OK')"`
- 색·레이아웃 변경은 화면으로 확인한다. dev 서버는 로그인 게이트가 있어 세션이 직접 못 보는 경우가 많다 —
  그때는 사용자에게 스크린샷 확인을 요청한다(실제로 막대 모서리 회귀를 사용자 스크린샷이 잡았다).

---

## 9. 레거시 별칭 (신규 사용 금지)

`.container` / `.page-title` / `.page-subtitle` / `.btn-*` 는 AI툴 5화면(홈·correct·cs·cs/manual·meeting)의 구 셸.
`.b2b-*` 와 동일 수치로 정렬돼 있다(2026-07 반응형 포함). **신규 화면은 `.b2b-*`.**

---

**규칙 요약: 색은 시맨틱 토큰(3종 세트), 간격은 4px 스케일, 컴포넌트는 §1 결정표, 차트는 §6 프리미티브,
같은 뜻은 §4 색 지도. 없으면 지어내지 말고 시스템에 추가하고, 토큰을 바꿨으면 `npm run sync-tokens`.**
