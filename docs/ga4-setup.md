# GA4 연결 절차 (2026-10-22)

> 2026-10-22 확인: 1·2 는 이미 되어 있다 — 기존 서비스 계정(CRM 메시지맵 연동용)으로 Vercel env 3개가 들어가 있고, 베타 AI 비서 ga_report 가 실데이터를 돌려줬다.
> 남은 것은 3(클로드 코드 MCP)뿐. 새 서비스 계정을 만들지 말고 그 계정의 JSON 키를 쓴다(키 파일이 없으면 같은 계정에 '키 추가'로 하나 더 만들면 된다 — 키는 여러 개 공존 가능).

목표: ① 업무도우미(CRM 메시지맵 → AI 비서·종합 리포트)가 GA4 데이터를 읽는다 ② 클로드 코드 작업창에 GA MCP 를 붙인다.
둘 다 같은 서비스 계정 하나로 한다. 비밀키는 Vercel 환경 변수와 내 PC 파일에만 두고, 채팅·깃에 올리지 않는다.

## 1. 구글 쪽 (한 번만)

1. Google Cloud 콘솔(console.cloud.google.com) → 프로젝트 새로 만들기(예: `seamonster-helper`). 프로젝트 ID 를 적어 둔다.
2. API 및 서비스 → 라이브러리 → 아래 둘을 각각 검색해 **사용 설정**
   - Google Analytics Data API
   - Google Analytics Admin API (MCP 가 속성 목록을 읽을 때 씀)
3. IAM 및 관리자 → 서비스 계정 → 만들기(예: `ga-reader`). 역할은 주지 않아도 된다(GA 권한은 4단계에서 GA 쪽에서 준다).
4. 만든 서비스 계정 → 키 → 키 추가 → 새 키 → **JSON** → 내려받은 파일을 내 PC 안전한 곳에 둔다(예: `C:\Users\younh\.secrets\ga-reader.json`).
   - 파일 안 `client_email` = 서비스 계정 이메일, `private_key` = 비밀키.
5. GA4(analytics.google.com) → 관리 → 속성 → **속성 액세스 관리** → 추가 → 4 의 `client_email` 을 **뷰어**로 추가.
   - 뷰어가 아니면 오류가 아니라 **빈 결과**가 나온다. 안 보이면 이걸 먼저 의심한다.
6. GA4 → 관리 → 속성 설정 → **속성 ID**(숫자, 예: 123456789)를 적어 둔다.

## 2. 업무도우미에 연결 (Vercel)

Vercel → 프로젝트 → Settings → Environment Variables 에 셋을 넣는다(Production·Preview 둘 다).

| 이름 | 값 |
|---|---|
| `GA4_PROPERTY_ID` | 6 의 속성 ID 숫자 |
| `GA_SA_EMAIL` | JSON 의 `client_email` |
| `GA_SA_PRIVATE_KEY` | JSON 의 `private_key` 값 전체(`-----BEGIN PRIVATE KEY-----` 부터 `END` 까지). 개행이 `\n` 글자로 들어가도 코드가 되돌린다 |

넣은 뒤 **재배포**(환경 변수는 다음 배포부터 적용). 확인: CRM 메시지맵 › 통계 탭에 GA 성과가 보이면 성공.
비어 있으면 5 의 뷰어 권한과 6 의 속성 ID 를 다시 본다.

## 3. 클로드 코드에 GA MCP 붙이기 (내 PC)

구글 공식 서버 `analytics-mcp`(PyPI). 파이썬 3.13 은 있고 pipx 는 없다.

```bash
python -m pip install --user pipx
```

```bash
python -m pipx ensurepath
```

(터미널을 새로 연 뒤) 서비스 계정 키 파일을 그대로 자격으로 쓴다 — gcloud 설치·로그인 없이 된다.

```bash
claude mcp add analytics-mcp --scope user -e "GOOGLE_APPLICATION_CREDENTIALS=C:\Users\younh\.secrets\ga-reader.json" -e "GOOGLE_PROJECT_ID=<프로젝트 ID>" -e "GOOGLE_CLOUD_PROJECT=<프로젝트 ID>" -- pipx run analytics-mcp
```

- `<프로젝트 ID>` 는 1-1 의 Cloud 프로젝트 ID. 공식 문서가 두 이름을 섞어 써서 둘 다 넣는다.
- 붙인 뒤 클로드 코드 세션을 새로 열면 `analytics-mcp` 도구(속성 목록·리포트 실행)가 보인다.
- 읽기 전용이다(`--allow-write` 를 넣지 않는다).

## 4. 그다음 (클로드가 함)

AI 비서·종합 리포트에 `ga_report` 도구 — 기간·측정항목(세션·사용자·구매·구매액·전환율)·차원(채널·소스/매체·캠페인·랜딩·기기) 조회. 2 가 끝나야 실데이터로 검증한다.
