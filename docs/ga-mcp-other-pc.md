# 다른 PC 의 클로드 코드에 GA MCP 붙이기 (2026-10-29)

클로드 코드 작업창에서 GA4 를 직접 조회(아무 차원·측정항목 조합)하려면 PC 마다 구글 공식 `analytics-mcp` 를 등록해야 한다.
업무도우미(웹)와 Poke 는 서버 쪽 설정이라 PC 와 무관하고, 이 문서는 **클로드 코드용**이다. 전체 배경은 `docs/ga4-setup.md`.

## 0. 준비물

| 항목 | 설명 |
|---|---|
| 클로드 코드 | 설치·로그인된 상태 |
| 파이썬 3.11 이상 | 터미널에서 `python --version` 으로 확인. 없으면 python.org 설치(설치 때 "Add to PATH" 체크) |
| 서비스 계정 키 JSON | 구글 클라우드 프로젝트 `seamonster-helper` 의 GA 읽기용 서비스 계정 키. **새 서비스 계정을 만들지 말고** 같은 계정에서 키를 받는다(아래 1단계) |
| 프로젝트 ID | `seamonster-helper` |

## 1. 키 파일 받기 (한 번만)

- 구글 클라우드 콘솔 › IAM 및 관리자 › 서비스 계정 › GA 읽기용 계정(ga-reader) › 키 탭 › **키 추가 › 새 키 만들기(JSON)**. 키는 여러 개 공존하므로 PC 마다 하나씩 만들어도 된다.
- 또는 기존 PC 의 `C:\Users\<사용자>\.secrets\ga-reader.json` 을 복사한다. **메신저·메일·팀즈로 보내지 않는다** — USB 나 본인 OneDrive 개인 폴더로 옮긴 뒤 지운다.
- 새 PC 에 `C:\Users\<사용자>\.secrets\` 폴더를 만들고 `ga-reader.json` 으로 둔다. 이 폴더는 저장소 밖이라 git 에 들어가지 않는다.
- GA 속성 뷰어 권한은 서비스 계정 이메일에 이미 있으므로 다시 줄 필요 없다(키가 바뀌어도 계정은 같다).

## 2. pipx 설치 (한 번만)

PowerShell 또는 명령 프롬프트에서:

```bash
python -m pip install --user pipx
```

```bash
python -m pipx ensurepath
```

터미널을 한 번 닫았다 연다. 확인:

```bash
python -m pipx --version
```

## 3. 클로드 코드에 등록

`<사용자>` 를 그 PC 의 윈도우 계정 이름으로 바꿔 한 줄로 실행한다. 사용자 범위(`--scope user`)라 어느 폴더에서 열어도 붙는다.

```bash
claude mcp add analytics-mcp --scope user -e "GOOGLE_APPLICATION_CREDENTIALS=C:\Users\<사용자>\.secrets\ga-reader.json" -e "GOOGLE_PROJECT_ID=seamonster-helper" -e "GOOGLE_CLOUD_PROJECT=seamonster-helper" -- python -m pipx run analytics-mcp
```

- 첫 실행 때 pipx 가 `analytics-mcp` 를 내려받아 1~2분 걸린다. 그 뒤로는 바로 뜬다.
- 등록 확인:

```bash
claude mcp list
```

`analytics-mcp` 가 보이면 된다. 이미 열려 있던 클로드 코드 세션에는 안 보이므로 **새 세션**을 연다.

## 4. 동작 확인

새 세션에서 "GA 속성 목록 보여 줘" 또는 "최근 7일 공식몰 세션 수"라고 묻는다. 도구 `get_account_summaries` 가 "씨몬스터 - GA4"(속성 341594579)를 돌려주면 연결된 것이다.

## 5. 막힐 때

| 증상 | 원인·조치 |
|---|---|
| `python` 을 찾을 수 없음 | PATH 미등록. 파이썬 재설치 때 "Add to PATH" 체크, 또는 명령의 `python` 을 `py -3` 으로 바꾼다 |
| 도구는 보이는데 403 / permission denied | 키 파일 경로 오타이거나 다른 서비스 계정 키. 경로의 사용자 이름과 파일명을 다시 본다 |
| 속성 목록이 비어 있음 | 서비스 계정에 GA 속성 뷰어 권한이 없음(계정을 새로 만든 경우). 기존 ga-reader 계정 키를 쓴다 |
| 첫 호출이 오래 걸림 | pipx 가 패키지를 받는 중. 한 번만 그렇다 |
| 세션에 `analytics-mcp` 도구가 없음 | 등록 뒤 세션을 새로 열지 않음. 또는 `--scope user` 를 빼고 등록해 그 폴더에만 붙음 |

## 6. 지우기

```bash
claude mcp remove analytics-mcp --scope user
```

키 파일은 따로 지운다. 구글 콘솔에서 그 키를 삭제하면 그 PC 만 끊기고 다른 PC·업무도우미는 영향 없다.
