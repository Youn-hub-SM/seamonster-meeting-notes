# 씨몬스터 내부도구 디자인 기준 (Design System)

> 목적: 페이지마다 흩어진 색·간격·폰트를 **단일 토큰**으로 통일한다.
> 새 화면을 만들 때 이 문서의 토큰과 공용 클래스만 쓰면 자동으로 톤이 맞는다.

토큰 정의 위치: **`app/globals.css` 의 `:root`** (단일 소스).
값을 바꾸려면 여기 한 곳만 고치면 전체에 반영된다.

---

## 0. 3대 원칙

1. **하드코딩 금지.** 인라인 `style={{ color: "#c92a2a" }}` / `fontSize: 13` 대신 토큰(`var(--sm-danger)`)과 공용 클래스를 쓴다.
2. **공용 클래스 우선.** 버튼·입력·카드·표·모달은 이미 `.b2b-*` 클래스가 있다. 새로 스타일 짜지 말고 재사용한다.
3. **없으면 토큰에 추가.** 정말 새로운 색/간격이 필요하면 인라인으로 박지 말고 `:root` 에 토큰을 추가한 뒤 사용한다.

---

## 1. 색 토큰

### 브랜드
| 토큰 | 값 | 용도 |
|---|---|---|
| `--sm-orange` | #F15A30 | 주요 액션·강조·활성 |
| `--sm-orange-hover` | #D94E26 | 호버 |
| `--sm-orange-light` | rgba(241,90,48,.06) | 활성/선택 배경 |
| `--sm-orange-border` | rgba(241,90,48,.12) | 강조 테두리 |

### 시맨틱(상태/피드백) — **빨강·초록·파랑·노랑은 반드시 여기서**
| 토큰 | 값 | 용도 |
|---|---|---|
| `--sm-danger` / `--sm-danger-bg` / `--sm-danger-border` | #C92A2A / #FCE4E4 / #F5C6C6 | 오류·삭제·미입금·경고 |
| `--sm-success` / `--sm-success-bg` | #22863A / #E6FFED | 완료·성공·입금완료 |
| `--sm-warning` / `--sm-warning-bg` | #B08800 / #FFF4E0 | 대기·주의 |
| `--sm-info` / `--sm-info-bg` | #1971C2 / #E0F0FF | 정보·진행중·링크강조 |

### 중립(텍스트/표면)
| 토큰 | 값 | 용도 |
|---|---|---|
| `--sm-black` | #1A1A1A | 본문 기본 텍스트 |
| `--sm-text-mid` | #666 | 보조 텍스트 |
| `--sm-text-light` | #999 | 흐린 텍스트·플레이스홀더 |
| `--sm-white` | #FFF | 카드·입력 배경 |
| `--sm-bg` | #FAFAFA | 페이지 배경 |
| `--sm-bg-subtle` | #F7F8FA | 표 헤더·옅은 영역 |
| `--sm-border` / `--sm-border-light` | #EEE / #F4F4F4 | 구분선·테두리 |

---

## 2. 간격 스케일 (4px 베이스)

`--sm-space-1`=4 · `-2`=8 · `-3`=12 · `-4`=16 · `-5`=24 · `-6`=32
(`--sm-pad`=24 는 페이지 기본 여백)

> 패딩/마진/gap 은 임의 px(`5px`,`7px`,`13px`) 대신 위 단계로 맞춘다.

## 3. 타이포 스케일

`--sm-fs-xs`=11 · `-sm`=12 · `-base`=13(본문) · `-md`=14 · `-lg`=16 · `-xl`=18 · `-2xl`=22

> 본문 기본은 13px(`body`). 전 화면 폰트는 2025-06 기준 일괄 -2px 적용됨.

## 4. 반경 / 그림자

`--sm-radius`=8(기본) · `--sm-radius-btn`=12 · `--sm-radius-card`=16 · `--sm-radius-pill`=50
`--sm-shadow-card` (카드) · `--sm-shadow-float` (모달/팝오버)

---

## 5. 공용 컴포넌트 클래스 (재사용)

정의: `app/b2b/b2b.css` (B2B·생산·VOC 등 내부도구 전체에서 공용).

| 분류 | 클래스 | 비고 |
|---|---|---|
| 버튼 | `.b2b-btn-primary` `.b2b-btn-secondary` `.b2b-btn-danger` `.b2b-icon-btn` `.b2b-link-btn` | |
| 입력 | `.b2b-input` `.b2b-field` `.b2b-field-label` `.b2b-field-row` `.b2b-combo` `.b2b-checkbox` | |
| 레이아웃 | `.b2b-container` `.b2b-card` `.b2b-card-head` `.b2b-card-title` `.b2b-dash-grid` | |
| 페이지 헤더 | `.b2b-page-head` `.b2b-page-title` `.b2b-page-subtitle` `.b2b-page-actions` | |
| 표 | `.b2b-table` `.b2b-table-wrap` (모바일은 `data-label` 카드 변환) | |
| 폼 | `.b2b-form-section` `.b2b-form-section-title` `.b2b-form-foot` | |
| 모달 | `.b2b-modal-backdrop` `.b2b-modal` `.b2b-modal-head` `.b2b-modal-body` `.b2b-modal-foot` | |
| 상태 | `.b2b-error`(오류배너) `.b2b-empty`(빈상태) `.b2b-loading` | |
| 탭/필터 | **`.sm-tab`** (둥근 탭 — 아래 5.1, `globals.css`) · `.b2b-checkfilter-row`(엑셀식 체크필터) | |

사이드바(전역): `.app-sb-tool` `.app-sb-menu-item` `.app-sb-chev` 등 — `app/globals.css`.

### 5.1 탭 / 필터 (`.sm-tab`) — 전 도구 공용, `app/globals.css`
상태·기간·뷰 전환 등 **모든 토글 탭은 이 컴포넌트로 통일**(구 `.prod-range-tab`·`.voc-tab` 폐기).
앱 버튼과 같은 radius(`--sm-radius-btn`)·오렌지 톤이라 버튼군과 자동으로 어울린다.

| 클래스 | 용도 |
|---|---|
| `.sm-tabbar` | 탭 + 검색을 한 줄에 두는 바(검색 입력에 `.sm-tab-search` → 우측 고정폭 240px, 모바일 전체폭) |
| `.sm-tabs` | 토글 탭만 묶는 그룹(검색 없음) |
| `.sm-tab` / `.sm-tab.is-active` | 탭 버튼 / 활성(오렌지 채움) |
| `.sm-tab-count` | 탭 안 카운트 배지(선택) |

```tsx
<div className="sm-tabbar">
  {(["전체", ...STATUSES]).map((s) => (
    <button key={s} className={`sm-tab ${tab === s ? "is-active" : ""}`} onClick={() => setTab(s)}>
      {s}<span className="sm-tab-count">{counts[s]}</span>
    </button>
  ))}
  <input className="b2b-input sm-tab-search" placeholder="검색" />
</div>
```

### 유틸 클래스 (반복 인라인 대체) — `app/globals.css`
레이아웃/텍스트의 반복 인라인 `style` 은 아래 유틸로 대체한다(간격 스케일 불변).
| 클래스 | = |
|---|---|
| `.sm-row` / `.sm-row-wrap` | flex + 가운데정렬 (+ 줄바꿈) |
| `.sm-col` | flex 세로 |
| `.sm-between` | flex + 양끝정렬 |
| `.sm-muted` / `.sm-faint` | 보조(#666) / 흐린(#999) 텍스트 |
| `.sm-nowrap` / `.sm-ellipsis` | 줄바꿈 방지 / 말줄임 |
| `.sm-gap-1~4` | gap = `--sm-space-1~4` (4·8·12·16) |

> gap/margin 이 스케일(4·8·12·16·24·32)에 맞으면 `.sm-gap-*` 사용, 어중간한 값(6·10·14 등)은 당분간 인라인 유지 → 점진적으로 스케일에 수렴.

---

## 6. 화면 통일 — 단일 시각 언어

내부도구 전 화면이 두 가지 인터랙션 모델로 나뉘지만 **시각 언어는 하나**다.
- **데이터툴**(B2B·생산·VOC): 표/카드/폼. `.b2b-container`(레이아웃의 `.b2b-main`) + `.b2b-page-head` + `.b2b-*`.
- **AI 단일입력툴**(문장교정·CS·회의)·**홈**: 입력→결과 레이아웃은 유지하되 **같은 토대**를 씀.
  구 클래스가 b2b 동등물과 **수치까지 동일**하게 정렬됨:
  | 구(단순툴) | = B2B |
  |---|---|
  | `.container` (1800 / 40·32·96) | `.b2b-main` |
  | `.page-title` 31px / `.page-subtitle` 15px | `.b2b-page-title` / `.b2b-page-subtitle` |
  | `.btn-primary/secondary/danger` | `.b2b-btn-*` (토큰 동일) |
- **VOC 미구현 메뉴**: 공용 `VocPlaceholder`(표준 셸 + '준비중' 빈상태) — 8개 한 컴포넌트로 통일.

> 신규 화면은 `.b2b-*` 를 쓴다(구 `.container`/`.page-title`/`.btn-*` 는 동일 룩의 레거시 별칭).

### 적용 현황 & 다음 단계
- ✅ 색 토큰화 · 전역 폰트 -2 · 타이포/간격 스케일 · 유틸 클래스.
- ✅ 컨테이너·페이지헤더·버튼·타이틀 전 화면 단일 기준 정렬. 죽은 page.module.css 제거.
- ✅ 탭/필터 단일화 — `.sm-tab` 으로 B2B·생산·VOC 전 화면 통일(구 `.prod-range-tab`·`.voc-tab` 제거).
- ✅ 캘린더 노션풍 통일(`prod-cal`·`b2b-cal`): 얇은 그리드선(`--sm-border-light`)·오늘=숫자 원형(오렌지)·이벤트 칩·셀 호버.
- ✅ VOC 통계 대시보드화(`.voc-hero` 도넛+총계+구분지표, 추세 세로 막대차트 그리드선·축) — 차트 카테고리 색은 `PIE_COLORS` 예외 팔레트.
- ⬜ 인라인 `style` 의 padding/margin/fontSize → 스케일/유틸로 점진 이관(새/수정 화면부터).

**규칙 요약: 색은 시맨틱 토큰, 간격은 4px 스케일, 컴포넌트는 `.b2b-*` 재사용. 인라인 hex/px 금지.**
