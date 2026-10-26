# 매뉴얼 사이트 서식 확장 (SPFx 애플리케이션 커스터마이저, 2026-10-26)

SharePoint 페이지 본문은 인라인 스타일을 지우므로, 줄 간격·표·소제목·안내 상자 서식은 이 확장이 `<style>` 을 끼워 넣어 적용한다.
대상: https://seamonster2016.sharepoint.com/sites/manual (사이트 단위 설치, 다른 사이트 영향 없음).

- 서식 원본: `sm-manual-style/manual-style.css` → 빌드 전에 `src/extensions/manualStyle/manualStyleCss.ts` 로 문자열 복사(아래 명령이 한다).
- 패키지: `sm-manual-style.sppkg`(빌드 산출물, 앱 카탈로그에 올리는 파일).

## 다시 만들기(서식을 바꿨을 때)

Node 22 가 필요하다(SPFx 1.23). 설치된 Node 24 대신 `npx -p node@22` 로 띄운다.

```bash
cd docs/spfx/sm-manual-style
node -e "const fs=require('fs');fs.writeFileSync('src/extensions/manualStyle/manualStyleCss.ts','export const MANUAL_CSS: string = '+JSON.stringify(fs.readFileSync('manual-style.css','utf8'))+';\n')"
npx -y -p node@22 npm install --no-audit --no-fund
npx -y -p node@22 npm run build          # → sharepoint/solution/sm-manual-style.sppkg
```

`config/package-solution.json` 의 `solution.version` 을 올리고(예: 1.0.0.1) 앱 카탈로그에 다시 올린 뒤 사이트에서 업데이트.

## 설치

`docs/sharepoint-install-style.ps1`(PnP, pwsh 7): 테넌트 앱 카탈로그에 올리고 매뉴얼 사이트에 설치. 앱 카탈로그가 없으면 먼저 만든다(관리자).
