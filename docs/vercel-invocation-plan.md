# Vercel 함수 호출 감축 실행 계획 (2026-10-28)

## 0. 배경

2026-10 사용량(대표 확인, Vercel 사용량 화면):

| 항목 | 사용 | Hobby 포함량 |
|---|---|---|
| Invocations(호출) | 1,049,124 | 1,000,000 |
| Fluid Active CPU | 5h 40m | 4h |

호출 내역(같은 화면, 종류별):

| 종류 | 호출 | 비중 |
|---|---|---|
| 미들웨어(edge, `middleware.ts`) | 638,977 | 60.8% |
| 함수(nodejs24.x, 페이지·API) | 411,582 | 39.2% |

핵심: **미들웨어 실행도 같은 100만 한도에 들어간다.** 보호 대상이 아닌 경로(자체 인증 API·웹훅·QR)까지
미들웨어가 한 번씩 돌고 있어, 함수 호출 1건이 사실상 2건으로 잡힌다. 미들웨어만 도는 요청(로그인 리다이렉트·401, 봇 스캔)이 약 23만 건 더 있다.

공식 문서: Hobby 는 포함량을 넘으면 기능이 멈추고(paused) 다음 주기까지 최대 30일 대기. 지금은 유예 상태.
Pro 전환 여부와 별개로, 아래는 낭비를 없애는 작업이라 플랜과 무관하게 진행한다.

## 1. 호출이 나오는 곳 (코드 확인 결과)

| 순위 | 원인 | 근거 | 월 추정 |
|---|---|---|---|
| 1 | 채널 명령 중계 데몬 10초 폴링 | `scripts/channel-commands-runner.mjs --daemon`, 중계 서버(클라우드웨이즈) crontab 실측: 데몬 워치독 `*/5` + 원샷 백업 `*/2`. 하루 9,360회 × (미들웨어 1 + 함수 1) | 약 560,000 (전체의 절반) |
| 2 | 미들웨어만 도는 요청 | 비로그인 리다이렉트·401 JSON, `*.vercel.app`·`link.seamonster.kr` 봇 스캔, 공개 html 2개 | 약 230,000 (경로별 확인 필요) |
| 3 | 사이드바 링크 미리 읽기(prefetch) | Next 16 `<Link>` 기본값 = 보이는 링크마다 경로를 미리 요청(운영 빌드만). `app/AppSidebar.tsx` 6곳, 홈 사이트맵. 메뉴 71개. 요청마다 미들웨어 + 함수 | 미측정 |
| 4 | 화면 폴링 | 활동 피드 60초(보이는 탭만), 송장 스캔 30초(유휴 때만), 채널 명령 15초(대기 명령 있을 때만) | 약 100,000 이하 |
| 5 | 외부 유입 | 클레임 폴러 10분, 생산 초안 틱(화·수 5분), 입금 문자·QR·Tally·인스타 웹훅, Poke MCP, 일정 알림 크론 2회 | 약 20,000 |

활성 CPU 초과는 호출 수와 별개 — 10-27 문서 전량 색인(2,291건 본문 추출)이 주범으로 추정, 다음 달엔 자연 감소.

## 2. 실행 단계

### 1단계 — 미들웨어 범위 축소 (1시간, `middleware.ts` matcher 만) — 2026-10-28 완료

지금은 정적 파일 몇 종만 빼고 모든 요청에 미들웨어가 돈다. 미들웨어 안에서 "자체 검증이 있어 통과" 처리하는 경로를
matcher 자체에서 제외해 아예 실행되지 않게 한다.

- 제외 대상: `/api/channel-commands`, `/api/mcp/*`, `/q/*`, `/api/b2b/schedule-digest`, `/api/analyst/cron`, `/api/b2b/deposits/webhook`,
  `/api/sms/otp`, `/api/instagram/webhook`, `/api/voc/tally`, `/api/naver/catalog/sync|upload`, `/api/claims/report`,
  `/api/production/requests/draft`, `/api/subscription/sync` + 확장자 `txt|xml|json|webmanifest`(public 의 html 2개는 로그인 보호 유지를 위해 제외하지 않음).
- 효과: 데몬의 미들웨어 절반(월 약 28만)이 즉시 사라진다. 웹훅·크론 몫도 함께.
- 주의: `link.seamonster.kr/코드` → `/q/코드` 리라이트는 단일 세그먼트 경로라 matcher 에 남는다(동작 유지).
  파도소리 도메인(pdsr.kr)에서 `/q/*` 를 치면 지금은 /factory 로 보내지만 바꾸면 QR 리다이렉트가 그대로 동작 — 실사용 영향 없음.
- `middleware.ts` 는 공용 파일(CLAUDE.md 3b) — 다른 세션에 알리고 matcher 한 줄만 고친다.

### 2단계 — 중계 데몬 끄기, 2분 원샷 크론만 남김 (대표 결정 2026-10-28: 2분이면 충분) — 2026-10-28 완료(대표 실행, 데몬 종료·워치독 삭제 확인)

- 중계 서버 crontab 에서 데몬 워치독 줄(`*/5 … --daemon`)을 지우고, 떠 있는 데몬 프로세스를 내린다. 원샷 `*/2` 줄은 그대로.
- 원샷은 큐가 비면 호출 한 번 하고 종료 → 하루 720건, 월 약 2만 건(1단계 뒤엔 미들웨어 몫 없음).
- 체감: [적용] 뒤 평균 1분·최대 2분(2026-09-09 이전 동작으로 복귀). 선점·고아 재선점·결과 보고는 원샷 모드에도 동일.
- 코드 변경·마이그레이션·중계 서버 파일 교체 없음. 2026-10-28 실행 시 자동 모드 분류기가 ssh 원격 변경을 막아 대표가 직접 실행(명령은 아래 §5).
- (보류) Supabase 직접 확인 방식은 10초 체감이 다시 필요해질 때 꺼낸다.

### 3단계 — 사이드바 링크 미리 읽기 끄기 (30분, 코드만) — 2026-10-28 완료

- `app/AppSidebar.tsx` 의 `<Link>` 6곳, `app/HomeSitemap.tsx`·`app/HomeQuickLaunch.tsx` 에 `prefetch={false}`.
- 대가: 메뉴 클릭 뒤 페이지가 0.1~0.3초 늦게 뜸. 본문 링크(발주 목록 등)는 그대로.

### 4단계 — 미들웨어만 도는 23만 건의 정체 확인

- Vercel › 프로젝트 › Observability(또는 Logs) 에서 미들웨어 요청을 경로·호스트별로 본다.
- 봇 스캔(`/wp-admin`, `/.env`, `*.vercel.app` 루트 등)이 대부분이면: Vercel Firewall 사용자 규칙으로 차단(전 플랜 제공, 차단된 요청은 호출로 세지 않음).
- 만료 세션의 리다이렉트가 대부분이면: 그대로 둔다(정상 동작).

### 5단계 — 측정 (1~3단계 배포 3일 뒤)

- 사용량 화면 종류별(미들웨어/함수) 전후 비교. 목표: 월 환산 1,000,000 → 350,000 이하.

### 6단계 — 활성 CPU (다음 달 수치 보고 판단)

- 11월 첫 주 Active CPU 가 2시간 이하면 색인이 원인이었던 것으로 종결.
- 여전히 높으면 `ms365` 색인 경로·발주처리 엑셀 파싱·상세 이미지 변환(puppeteer)을 함수별로 본다.

## 3. 하지 않는 것

- 화면 폴링 주기 추가 연장: 이미 손본 상태(60/30/15초, 조건부)라 효과 대비 체감 손해가 큼.
- 외부 웹훅·크론 축소: 월 2만 건 수준이라 의미 없음.
- Pro 전환 결정: 이 계획과 별개. 줄여도 상한의 35% 안팎에서 살게 되므로 화면·리포트가 늘면 다시 닿는다.

## 4. 필요한 확인(대표)

1. (결정됨) 2단계 = 데몬 끄기, 2분 원샷만.
2. 사용량 화면의 **사용 주기(Usage period) 날짜** — 언제 초기화되는지.
3. Observability 의 미들웨어 경로·호스트 상위 목록(4단계용).

## 5. 중계 서버 작업 명령 (2단계, 대표 실행)

```bash
ssh -i ~/.ssh/cloudways_ed25519 master_nnncfdcsyy@158.247.253.90 'cd ~/seamonster-sync && crontab -l > crontab.bak.20261028 && crontab -l | grep -v -- "--daemon" | crontab - && P=$(pgrep -f "^/usr/bin/node bin/channel-commands-runner[.]cjs .*--daemon" || true) && [ -n "$P" ] && kill $P; sleep 2; crontab -l | grep -n channel-commands; echo "daemon left: $(pgrep -f -- "--daemon" || echo none)"'
```

- 백업 `~/seamonster-sync/crontab.bak.20261028` 에 원래 crontab 이 남는다. 되돌리려면 `crontab crontab.bak.20261028`.
- 확인: 출력에 `*/2 … channel-commands-runner.cjs` 한 줄만 보이고 `daemon left: none` 이면 끝.
