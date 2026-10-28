# Vercel Pro 전환 실행안 (2026-10-28)

> **상태(2026-10-28 저녁): 잠정 보류.** 대표 결정 — 지금 기능에 문제가 없으면 Hobby 유지, 예약 발송 기능도 당장 만들지 않는다.
> 10-31 사용량(호출·Active CPU) 확인 뒤 월 환산 호출 50만 이하·Active CPU 2시간대면 Hobby 확정. 아래는 다시 꺼낼 때를 위한 보관본.

Hobby 한도 초과(10월 호출 105만/100만, Active CPU 5h40m/4h)와 예약 발송 기능 요구(분 단위 시각·1회 날짜 지정)로
Pro 전환을 결정했다. 이 문서는 전환 자체와 전환 뒤에 바꿀 것을 순서대로 적는다.
호출 감축 작업은 `docs/vercel-invocation-plan.md`(10-28 완료분)과 별개로 그대로 유효하다.

Pro 에서 달라지는 것(2026-10 Vercel 문서 기준): 크론 프로젝트당 100개·분 단위 실행·정확한 시각 / 함수 최대 800초(Hobby 300초) /
호출 100만·Active CPU 4시간 포함 뒤 종량제(멈춤 없음, 호출 $0.60/백만, icn1 CPU $0.169/시간) / Observability 보관 연장 / WAF 규칙·속도 제한 / 콜드 스타트 방지.

## 0. 전환 (대표)

1. Vercel 은 Pro 를 **팀(Team)** 단위로 판다. 개인(Hobby) 계정의 프로젝트면 팀을 만들고 프로젝트를 팀으로 **이전(Transfer)** 한다.
   도메인·환경변수·배포 이력이 따라오지만, 이전 뒤 아래 §1 에서 확인한다.
2. 결제 수단 등록 → Pro. 사용자 1명(대표)만 멤버로 두면 월 20달러.
3. **Spend Management** 에서 월 지출 알림(예: 30달러)을 켠다. 한도 초과 자동 정지는 켜지 않는다(업무 화면이 멈춘다).
4. 전환이 끝나면 알려 준다. 이후는 세션이 진행.

## 1. 전환 직후 확인 (세션, 30분)

- 운영 주소(meeting-notes-beryl·link.seamonster.kr·pdsr.kr)와 베타 주소 정상, 환경변수 Production·Preview 모두 남아 있는지.
- `git push origin dev` 로 베타 배포 1회 → 빌드·크론 등록(vercel.json 2개) 정상.
- 사용량 화면이 Pro 기준으로 바뀌었는지(포함량 표시). 10월 초과분이 청구되는지 메모.

## 2. 예약 발송 기능 — '정기 받기' 확장 (세션, 1일) — 대표 결정 반영

결정(10-28): 시간·주기 상세 지정 + 1회 날짜 지정, 예약 설정은 화면 버튼, 메일 = 표 + 간단 해석.

- 저장 구조(저장 리포트 kv JSON `schedule`): `{ kind: daily|weekly|monthly|once, days?: [0-6], day?: 1-31, date?: YYYY-MM-DD, time: "HH:MM"(KST, 5분 단위), to: [...], interpret: boolean, lastSentKey?: string }`.
  dedup = `lastSentKey`(= 대상 시각의 KST 문자열). `once` 는 보낸 뒤 `schedule` 을 null 로.
- 틱: `vercel.json` 에 `*/5 * * * *` → 새 경로 `/api/report/schedule/tick`(자체 인증 = Vercel `x-vercel-cron` 헤더 또는 CRON_SECRET, 미들웨어 matcher 예외 + 통과 목록 **같은 커밋**).
  한 틱 최대 6건, 각 건 = SQL 실행 → (interpret 면) Sonnet 3~5줄 해석(시스템에 `[비서] 데이터 해석 기준` 포함, effort low) → 메일(sales-mailer).
  `maxDuration 120`. 보낼 게 없으면 kv 1회 읽고 종료(월 8,640회, Pro 포함량의 1%).
- 화면(`app/report/page.tsx` 정기 받기 창): 주기 4종·요일 체크·날짜·시각 셀렉트·받는 사람·'해석 넣기' 토글·[지금 보내기]. `SCHEDULE_ENABLED` 두 곳 true.
  카드 배지에 "매주 월·목 09:00 · 마지막 10-28" 식 요약.
- 기존 `report-schedule.ts` 의 `isDueToday/scheduleRange` 는 새 모델로 대체(기간 변수 자동 채움은 유지: 매일=어제, 매주=지난주, 매월=지난달, 1회=어제까지 7일).
- 가이드(`guide-data.ts`)·업데이트 노트. 베타에서 [지금 보내기]·5분 뒤 자동 발송 2가지 확인 뒤 운영 배포.

## 3. 크론 통합 — pg_cron HTTP 틱을 Vercel 크론으로 (세션, 반나절, §2 뒤)

Hobby 하루 1회 제한 때문에 만든 우회를 걷는다. HTTP 를 쏘지 않는 DB 전용 pg_cron(093 원가 예약 적용)은 그대로.

| 지금 | 바꿈 |
|---|---|
| 092 `b2b-digest-tick` pg_cron `*/5`(gate=times) + vercel.json 예비 2개(0 21·0 7 UTC) | vercel.json `*/5 * * * *` 1개로 통합(쿼리 `?gate=times` 허용 여부 확인, 안 되면 `/api/b2b/schedule-digest/tick` 경로 추가). 예비 2개 삭제 |
| 147 `production-draft-tick` pg_cron `*/5`(화·수) | vercel.json `50 4 * * 3`(수 13:50 KST) 직접 호출. 틱 분기 코드는 남겨도 무해 |
| 중계 서버 crontab: 채널 명령 원샷 `*/2`, 클레임 폴러 `*/10`, 네이버·쿠팡·카페24 동기화, 정기배송 수집 14:59 UTC, 생산 초안 수 04:50 | **그대로**(채널 API 는 중계 서버에서 돌아야 함). 정기배송 수집·생산 초안 노크만 Vercel 크론으로 옮길 수 있는지 확인 뒤 결정 |

- migration `157_pg_cron_http_off.sql`: `b2b-digest-tick`·`production-draft-tick` unschedule(파일만, 대표 적용). pg_net 확장은 두어도 된다.
- CLAUDE.md §5 수정: "Hobby 최대 2개" → "Pro: 프로젝트당 100개·분 단위. 그래도 크론 추가 = vercel.json + middleware.ts 통과 목록 + matcher 예외 세 곳 같은 커밋".
- `docs/vercel-invocation-plan.md` 끝에 Pro 전환 사실과 이 문서 링크 한 줄.

## 4. 실행 시간 연장 활용 (세션, 반나절, 11월 Active CPU 확인 뒤)

| 경로 | 지금 | 바꿈 |
|---|---|---|
| AI 비서 대화 `report/chat/threads/[id]/send` | 300 (CHAT_DEADLINE 270초) | 800 (기한 720초) — 긴 조사 끝까지 |
| 종합 리포트 `analyst` | 300 | 800 — 월간 여유 |
| MS365 색인 `b2b/settings/ms365/index` | 300 | 800 — 한 번에 전체 |
| 녹취 요약 `summarize` | 300 | 600 |
| 제조사 VOC 다이제스트 | 300 | 600 |

- AI 대기 시간은 Active CPU 에 안 들어가므로 비용 증가는 작다. 11월 사용량 화면의 함수별 Active CPU 를 보고 순서대로 올린다.
- 120초짜리 2회 분할 호출(공지·CS 코치·생산 조언)은 그대로 둔다(동작 중, 이득 작음).

## 5. Observability·WAF (세션 조사 → 대표 1클릭)

- 미들웨어 단독 약 23만 건/월의 정체: Observability 에서 호스트·경로 상위 목록. `*.vercel.app` 봇이면 WAF 규칙으로 차단 또는 대표 도메인으로 리다이렉트, 웹훅 경로엔 속도 제한.
- 결과는 `docs/vercel-invocation-plan.md` 4단계에 기록.

## 6. 순서와 날짜

| 순서 | 일 | 담당 |
|---|---|---|
| §0 Pro 전환 | D0 | 대표 |
| §1 확인 | D0 | 세션 |
| §2 예약 발송 | D1 | 세션(베타 → 대표 확인 → 운영) |
| §3 크론 통합 + 157 + CLAUDE.md | D2 | 세션(157 은 대표 적용) |
| §5 Observability 조사 | D3 | 세션 |
| §4 실행 시간 연장 | 11월 첫 주 | 세션 |

## 7. 하지 않는 것

- 한도 초과 자동 정지(Spend Management pause) — 업무 화면이 멈춘다. 알림만.
- 중계 서버 폐지 — 채널 API 동기화는 거기서만 돈다.
- 멤버 추가 — 직원은 업무도우미 화면만 쓰므로 Vercel 자리가 필요 없다(자리당 요금).
