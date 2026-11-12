#!/usr/bin/env bash
# 알리고 설정 입력 — 중계 서버(클라우드웨이즈)에서 한 번 실행한다. 키는 이 서버의 .env.local 에만 저장된다(화면에 찍히지 않음).
#   실행: bash ~/seamonster-sync/bin/aligo-setup.sh
#   다시 실행하면 기존 ALIGO_ 줄을 새 값으로 바꾼다. 시험 발송(ALIGO_TESTMODE)은 처음엔 Y — 실제로 보내려면 마지막 질문에 N.
set -euo pipefail
ENV_FILE="$HOME/seamonster-sync/.env.local"
[ -f "$ENV_FILE" ] || { echo "설정 파일이 없습니다: $ENV_FILE"; exit 1; }

read -rsp "알리고 API 키(입력해도 화면에 보이지 않습니다): " KEY; echo
read -rp  "알리고 아이디: " UID_
read -rp  "발신번호(알리고에 등록한 번호, 숫자만): " SENDER
read -rp  "시험 발송으로 둘까요? 실제로 보내려면 N (기본 Y): " TEST
KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"
UID_="$(printf '%s' "$UID_" | tr -d '[:space:]')"
SENDER="$(printf '%s' "$SENDER" | tr -cd '0-9')"
case "$(printf '%s' "${TEST:-Y}" | tr '[:lower:]' '[:upper:]')" in N) TEST=N ;; *) TEST=Y ;; esac
[ -n "$KEY" ] && [ -n "$UID_" ] && [ -n "$SENDER" ] || { echo "세 값이 모두 있어야 합니다. 바꾸지 않았습니다."; exit 1; }

cp -p "$ENV_FILE" "$ENV_FILE.bak-$(date +%Y%m%d%H%M%S)"
TMP="$(mktemp)"
grep -v '^ALIGO_' "$ENV_FILE" > "$TMP" || true
{
  cat "$TMP"
  printf 'ALIGO_API_KEY=%s\n' "$KEY"
  printf 'ALIGO_USER_ID=%s\n' "$UID_"
  printf 'ALIGO_SENDER=%s\n' "$SENDER"
  printf 'ALIGO_TESTMODE=%s\n' "$TEST"
} > "$ENV_FILE"
rm -f "$TMP"
chmod 600 "$ENV_FILE"
echo "저장했습니다. 시험 발송: $TEST (N 이어야 실제로 나갑니다)"
