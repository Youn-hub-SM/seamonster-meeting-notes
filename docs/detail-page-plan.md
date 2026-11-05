# 상세페이지 전송 — 기획·구현 메모 (2026-11-03)

공식몰(카페24) 상품 상세설명에 넣을 HTML 소스를 업무도우미에서 관리하고 카페24 Admin API로 쏜다.
목표: **고치기 쉬울 것**, **GEO·SEO 에 확실히 읽힐 것**(텍스트가 상세설명 본문에 서버 렌더링으로 들어 있어야 한다).

## 1. 확정된 전제 (대표와의 대화)

- 상세설명 안에서 다른 HTML 을 불러오는 길은 JS·iframe 뿐이고, 구글 외 AI 크롤러(GPTBot·ClaudeBot·PerplexityBot·Yeti)는 그 내용을 못 본다. 웹 FTP 등 외부 호스팅은 저장처일 뿐 "임포트"는 안 된다.
- 카페24 스킨은 상품·분류별로 detail.html 을 나눌 수 없다(공식 문서 확인: 분류별 분기는 상품 목록만, 대분류까지).
- 그룹 공통(이유식용·순살생선·기타 등)은 상품 페이지 본문에 **실제로 들어 있어야** 하므로, 소스를 상세설명에 직접 써 넣는다.
- 카페24 상품 수정 API(`PUT /api/v2/admin/products/{product_no}`)가 `description`·`mobile_description` 을 HTML 그대로 받는다. scope WRITE_PRODUCT, 초당 40회, 길이 제한 없음(문서 기준).

## 2. 흐름 (대표 지시 4단계)

1. 적용할 HTML 입력 (`/detail` 소스 편집)
2. 변환해 보기 (PC·모바일 미리보기 — sandbox iframe, 스크립트 미실행, 스킨 CSS 미적용)
3. 적용할 상품번호 입력 (쉼표·줄바꿈, 카탈로그 상품명 자동 표시)
4. 쏘기 (관리자) → `detail_applies` 대기 → 중계 실행기가 카페24에 반영 → 상태·마커 확인 결과 표시

전송한 상품번호는 소스별로 기록되어 **"이 소스가 적용된 상품"**·**"이 상품에 적용된 소스"** 를 적용 현황에서 바로 거른다.

## 3. 구현 (2026-11-03, dev)

| 구분 | 파일 |
|---|---|
| DB | `supabase/migrations/160_detail_sources.sql` — detail_sources(소스·버전·넣는 자리), detail_applies(적용 기록·큐·백업) |
| 규칙 | `app/lib/detail-page.ts` — 마커 `<!-- sm:src=ID -->…<!-- /sm:src=ID -->`, 조립(mergeDescription), 상품번호 파싱, 상태 색 |
| API | `app/api/detail/sources`(목록·저장·삭제), `app/api/detail/applies`(기록·상품명·전송 요청·claim/report) |
| 화면 | `app/detail/page.tsx`(+layout·detail.css `.dp-*`), nav 마케팅 › 상세페이지 전송(베타), guide-data |
| 실행기 | `scripts/detail-apply-runner.mjs` — claim → GET 상품(백업) → 조립 → PUT → 공개 페이지 마커 확인 → report |
| 미들웨어 | `/api/detail/applies` 예외(실행기 Bearer) |

- 넣는 자리: replace(전체 교체) · prepend(기존 맨 앞) · append(기존 맨 뒤, 기본). 같은 소스 마커가 이미 있으면 그 자리만 갱신(중복 방지).
- 모바일 상세설명을 따로 쓰는 상품은 거기에도 같은 규칙으로 넣는다(PC 만 바뀌는 사고 방지).
- 소스 HTML 이 바뀌면 version +1. 적용 현황의 "(구버전)" = 고친 뒤 아직 다시 쏘지 않은 상품.
- 실행기는 카페24 토큰 파일(`.cafe24-token.json`)을 중계 서버에서만 쓴다(refresh 회전 경합 방지). Vercel 추가 호출은 사람이 누를 때뿐.

## 3-1. 소스 조합 (2026-11-05, migration 161)

대표 시나리오: abcd·abc·adb·ad 처럼 상품마다 공통 소스 조합이 다를 때, a 만 고치면 한 번에 반영되게.

- `detail_sets`(이름·구성 소스 id 배열=순서·넣는 자리). 조합은 HTML 이 없다.
- 조합을 쏘면 `detail_applies` 에 `command='set'` 행 1개/상품 + `members` 스냅샷([{source_id, version, html}]). 실행기는 상품을 한 번 읽어 **구성 블록을 전부 걷어낸 뒤 조합 순서대로 묶어서** position 에 넣고 한 번 쓴다(= 순서 재정렬도 됨). 마커 확인은 구성 전부.
- 소스별 적용 상품·구버전·필터는 조합 행의 members 까지 본다(`memberIds`).
- ① 소스 편집에 [들어간 상품 전체 채우기] — `?applied_for=ID`(상품별 최신 완료 행에 그 소스가 들어 있으면)로 ④ 상품번호를 채운다. 쏘기는 사람이 누른다. 소스 하나 재전송이라 블록이 있는 자리에서만 바뀐다.
- 161 미적용이면 조합 영역에 안내만 뜨고 소스 쏘기는 그대로 된다(컬럼 폴백).

## 4. 적용 순서

1. Supabase SQL Editor 에 160 적용
2. 베타에서 `/detail` 열어 소스 저장·미리보기·상품번호 확인
3. 중계 서버(또는 로컬)에서 `node scripts/detail-apply-runner.mjs` 1회 실행 → 테스트 상품 1개로 반영 확인(원본 HTML 에 마커)
4. 채널 재고 실행기 크론에 한 줄 추가(같은 주기) 또는 필요할 때 수동 실행
5. 운영 배포는 대표 확인 뒤 `git push origin dev:main`

## 5. GEO 체크리스트 (소스 작성 규칙)

텍스트로 쓰기 · h2/h3 에 상품명 · 스펙·보관·조리·월령 한 문장씩 · FAQ · 공통 섹션 제목에 그룹명 · 핵심 텍스트 숨김 금지 · 이미지 alt·width·height·lazy · 인라인 style/script 없음(스킨 CSS 클래스만).
별도: 카페24 SEO 설정 robots.txt 에서 AI 크롤러 차단 여부 확인. Product JSON-LD 는 detail.html 에 템플릿 변수로 1회.

## 6. 남은 것·후보

- 되돌리기 버튼(backup_html 로 복원 전송) — 기록은 쌓이고 있음, 화면만 추가하면 된다.
- FAQ 입력 → FAQPage JSON-LD 자동 생성(소스 안에 직접 써도 된다).
- 최초 이관: 현재 상세설명 전체를 소스로 가져오는 `--import` (필요해지면).
