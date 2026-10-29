# 다른 PC(맥북·윈도우)의 클로드 코드에 GA MCP 붙이기 (2026-10-29)

클로드 코드 작업창에서 GA4 를 직접 조회(아무 차원·측정항목 조합)하려면 PC 마다 구글 공식 `analytics-mcp` 를 등록해야 한다.
업무도우미(웹)와 Poke 는 서버 쪽 설정이라 PC 와 무관하고, 이 문서는 **클로드 코드용**이다. 전체 배경은 `docs/ga4-setup.md`.
맥북 절차를 먼저 적고, 윈도우는 뒤에 둔다.

## 0. 준비물(공통)

| 항목 | 설명 |
|---|---|
| 클로드 코드 | 설치·로그인된 상태. 터미널에서 `claude --version` 으로 확인 |
| 파이썬 3.11 이상 | 맥: `python3 --version`. 없으면 `brew install python` |
| 서비스 계정 키 JSON | 구글 클라우드 프로젝트 `seamonster-helper` 의 GA 읽기용 서비스 계정(ga-reader) 키. **새 서비스 계정을 만들지 않는다**(아래 1단계) |
| 프로젝트 ID | `seamonster-helper` |

## 1. 키 파일 받기 (한 번만, 공통)

- 구글 클라우드 콘솔 › IAM 및 관리자 › 서비스 계정 › ga-reader › 키 탭 › **키 추가 › 새 키 만들기(JSON)**. 키는 여러 개 공존하므로 PC 마다 하나씩 만드는 것을 권한다(잃어버린 PC 의 키만 따로 지울 수 있다).
- 기존 윈도우 PC 의 `C:\Users\<사용자>\.secrets\ga-reader.json` 을 복사해도 된다. **메신저·메일·팀즈로 보내지 않는다** — USB 나 본인 OneDrive 개인 폴더로 옮긴 뒤 지운다.
- GA 속성 뷰어 권한은 서비스 계정 이메일에 이미 있으므로 다시 줄 필요 없다.

## 2. 맥북

### 2-1. 키 파일 두기

터미널(Terminal 또는 iTerm)에서:

```bash
mkdir -p ~/.secrets && chmod 700 ~/.secrets
```

받은 JSON 을 `~/.secrets/ga-reader.json` 으로 옮긴 뒤(파인더로 끌어다 놓아도 된다) 권한을 본인만 읽게 좁힌다:

```bash
chmod 600 ~/.secrets/ga-reader.json
```

### 2-2. pipx 설치

Homebrew 가 있으면:

```bash
brew install pipx && pipx ensurepath
```

Homebrew 가 없으면:

```bash
python3 -m pip install --user pipx && python3 -m pipx ensurepath
```

터미널을 한 번 닫았다 연다. 확인:

```bash
pipx --version
```

### 2-3. 클로드 코드에 등록

`$HOME` 은 그대로 둬도 되고, 본인 홈 경로(`/Users/<이름>`)로 바꿔도 된다. 사용자 범위(`--scope user`)라 어느 폴더에서 열어도 붙는다.

```bash
claude mcp add analytics-mcp --scope user -e "GOOGLE_APPLICATION_CREDENTIALS=$HOME/.secrets/ga-reader.json" -e "GOOGLE_PROJECT_ID=seamonster-helper" -e "GOOGLE_CLOUD_PROJECT=seamonster-helper" -- pipx run analytics-mcp
```

`pipx` 가 PATH 에 안 잡히면(위 확인에서 안 나오면) 마지막을 `-- python3 -m pipx run analytics-mcp` 로 바꾼다.

등록 확인:

```bash
claude mcp list
```

`analytics-mcp` 가 보이면 된다. 이미 열려 있던 클로드 코드 세션에는 안 보이므로 **새 세션**을 연다. 첫 실행 때 pipx 가 패키지를 내려받아 1~2분 걸린다.

## 3. 윈도우

### 3-1. 키 파일 두기

`C:\Users\<사용자>\.secrets\` 폴더를 만들고 `ga-reader.json` 으로 둔다. 저장소 밖이라 git 에 들어가지 않는다.

### 3-2. pipx 설치

PowerShell 에서:

```bash
python -m pip install --user pipx
```

```bash
python -m pipx ensurepath
```

터미널을 닫았다 연 뒤 `python -m pipx --version` 으로 확인.

### 3-3. 클로드 코드에 등록

`<사용자>` 를 윈도우 계정 이름으로 바꿔 한 줄로:

```bash
claude mcp add analytics-mcp --scope user -e "GOOGLE_APPLICATION_CREDENTIALS=C:\Users\<사용자>\.secrets\ga-reader.json" -e "GOOGLE_PROJECT_ID=seamonster-helper" -e "GOOGLE_CLOUD_PROJECT=seamonster-helper" -- python -m pipx run analytics-mcp
```

`claude mcp list` 로 확인하고 새 세션을 연다. (대표 윈도우 PC 는 이 형태로 등록돼 있다.)

## 4. 동작 확인(공통)

새 세션에서 "GA 속성 목록 보여 줘" 또는 "최근 7일 공식몰 세션 수"라고 묻는다. 도구 `get_account_summaries` 가 "씨몬스터 - GA4"(속성 341594579)를 돌려주면 연결된 것이다.

## 5. 막힐 때(공통)

| 증상 | 원인·조치 |
|---|---|
| `python`/`python3`/`pipx` 를 찾을 수 없음 | PATH 미등록. 맥은 `brew install python pipx` 뒤 터미널 재시작, 윈도우는 파이썬 재설치 때 "Add to PATH" 체크 또는 `py -3` 사용 |
| 도구는 보이는데 403 / permission denied | 키 파일 경로 오타이거나 다른 서비스 계정 키. 경로와 파일명을 다시 본다. 맥에서 `~` 가 안 풀리면 `/Users/<이름>/...` 절대 경로로 |
| 속성 목록이 비어 있음 | 서비스 계정에 GA 속성 뷰어 권한이 없음(계정을 새로 만든 경우). 기존 ga-reader 계정 키를 쓴다 |
| 첫 호출이 오래 걸림 | pipx 가 패키지를 받는 중. 한 번만 그렇다 |
| 세션에 `analytics-mcp` 도구가 없음 | 등록 뒤 세션을 새로 열지 않음. 또는 `--scope user` 를 빼고 등록해 그 폴더에만 붙음 |
| 맥에서 "operation not permitted" | 터미널 앱에 파일 접근 권한이 없음. 시스템 설정 › 개인정보 보호 › 파일 및 폴더에서 터미널 허용 |

## 6. 지우기(공통)

```bash
claude mcp remove analytics-mcp --scope user
```

키 파일은 따로 지운다. 구글 콘솔에서 그 키를 삭제하면 그 PC 만 끊기고 다른 PC·업무도우미는 영향 없다.
