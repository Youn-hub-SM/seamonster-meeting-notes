# Microsoft 365 문서 연결 절차 (2026-10-25)

목표: AI 비서가 회사 공용 문서(SharePoint 사이트·OneDrive)를 검색하고 본문을 읽는다.
대표 결정(2026-10-25): **회사 공용 문서만, 읽기만.** 직원별 Microsoft 로그인 없이 앱 자격 하나로 읽고, 읽을 곳은 관리자가 설정 화면에 적은 사이트뿐이다.

구조: Entra 앱 등록(앱 권한) → Vercel 환경 변수 3개 → 관리자 › 설정 › 연결 › Microsoft 365 문서에 사이트 주소 → [연결 확인].
코드: `app/lib/msgraph.ts`(Graph 클라이언트) · `app/lib/ms365-docs.ts`(검색·본문 추출) · 비서 도구 docs_search·docs_list·docs_read.

## 1. Entra 앱 등록 (Microsoft 365 전역 관리자, 한 번만)

1. https://entra.microsoft.com → **앱 등록** → **새 등록**
   - 이름: `seamonster-helper-docs` (아무거나)
   - 지원되는 계정 유형: **이 조직 디렉터리만**
   - 리디렉션 URI: 비움 → 등록
2. 개요 화면에서 **애플리케이션(클라이언트) ID** 와 **디렉터리(테넌트) ID** 를 적어 둔다.
3. **인증서 및 암호** → 클라이언트 암호 → **새 클라이언트 암호** → 만료 24개월 → 추가 → **값**을 즉시 복사해 둔다(화면을 떠나면 다시 못 본다).
   - 만료되면 비서의 문서 도구가 "토큰 발급 실패"를 낸다 → 새 암호를 만들어 Vercel 값만 바꾼다.
4. **API 권한** → 권한 추가 → **Microsoft Graph** → **애플리케이션 권한**(위임 아님) → 아래 중 하나
   - 권장 **`Sites.Selected`**: 허용한 사이트만 읽는다(2단계에서 사이트별로 허용). 회사 문서 전체가 열리지 않는다.
   - 간단 `Sites.Read.All` + `Files.Read.All`: 테넌트의 모든 사이트·문서함을 읽을 수 있다(설정 화면에 적은 곳만 읽긴 하지만 권한 자체는 전체). 2단계 생략.
5. **"(조직)에 대한 관리자 동의 허용"** 클릭 → 상태가 "허용됨"이어야 한다.

## 2. Sites.Selected 를 골랐으면 — 사이트별 읽기 허용

`Sites.Selected` 는 사이트에 권한을 따로 줘야 Graph 가 403(accessDenied)을 안 낸다. 가장 쉬운 길은 Graph 탐색기.

1. https://developer.microsoft.com/graph/graph-explorer 에 **전역 관리자**로 로그인.
2. 사이트 ID 조회: `GET https://graph.microsoft.com/v1.0/sites/회사.sharepoint.com:/sites/사이트이름` → 응답의 `id` 복사
   - 개인 OneDrive 를 공용으로 쓰면: `GET .../sites/회사-my.sharepoint.com:/personal/이름_회사_com`
3. 권한 부여: `POST https://graph.microsoft.com/v1.0/sites/{사이트 id}/permissions`, 본문:

   ```json
   {
     "roles": ["read"],
     "grantedToIdentities": [{ "application": { "id": "<1단계의 클라이언트 ID>", "displayName": "seamonster-helper-docs" } }]
   }
   ```

   - Graph 탐색기가 "권한 동의 필요"라고 하면 상단 **권한 수정** 탭에서 `Sites.FullControl.All` 에 동의한 뒤 다시 보낸다(관리자 본인 위임 권한이라 앱에는 안 남는다).
4. 읽을 사이트마다 2~3 반복.

## 3. 업무도우미에 연결 (Vercel)

Vercel → 프로젝트 → Settings → Environment Variables (Production·Preview 둘 다), 넣은 뒤 **재배포**.

| 이름 | 값 |
|---|---|
| `MS_TENANT_ID` | 디렉터리(테넌트) ID |
| `MS_CLIENT_ID` | 애플리케이션(클라이언트) ID |
| `MS_CLIENT_SECRET` | 3단계 클라이언트 암호 **값** |

## 4. 읽을 문서함 등록

1. 관리자 › 설정 › 연결 → **Microsoft 365 문서** 카드 → "읽을 문서함"에 한 줄에 하나:
   ```
   https://회사.sharepoint.com/sites/docs | 공용 문서
   https://회사-my.sharepoint.com/personal/이름_회사_com | 대표 OneDrive
   ```
   `| 이름` 은 비서가 부르는 이름(생략하면 사이트 이름).
   사이트 주소 뒤에 붙은 `/Shared Documents/Forms/...` 는 넣어도 되고 코드가 잘라낸다.
2. [저장] → [연결 확인]. "OK (Documents)" 처럼 문서함 이름이 나오면 성공.
   - "접근 거부(accessDenied)" → 2단계(사이트 허용)가 빠진 것.
   - "토큰 발급 실패" → 3단계 값(특히 암호 '값'이 아니라 '암호 ID'를 넣은 경우) 확인.
3. AI 비서에게 "공용 문서에서 거래처 계약서 찾아줘"라고 물어 본다.

## 읽는 형식·한계

- docx·pptx·xlsx·pdf·txt·csv·md·json. 옛 doc·xls·ppt 는 Graph 의 PDF 변환을 거쳐 읽는다. OneNote·이미지·한글(hwp)은 못 읽는다.
- 파일 25MB 상한, 본문은 한 번에 2만 4천 자씩 이어 읽는다(비서가 next 로 알아서 넘긴다). 엑셀은 시트당 앞 500행.
- 검색은 SharePoint 검색 인덱스를 쓴다 — 방금 올린 문서는 몇 분 뒤에 잡힌다. 이름 검색이 안 되면 docs_list 로 폴더를 따라간다.
- 쓰기·수정·삭제 없음. 직원별 권한 구분 없음(여기 적은 문서함은 업무도우미 사용자 전원이 비서를 통해 읽는다) — 민감 문서가 있는 사이트는 적지 않는다.
