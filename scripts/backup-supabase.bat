@echo off
chcp 65001 >nul
REM Supabase 데이터 수동 백업 — 더블클릭으로 실행. 설정은 저장소 루트 backup.env.
cd /d "%~dp0.."
echo Supabase 백업을 시작합니다...
node scripts\backup-supabase.mjs
echo.
echo 끝났습니다. 위 결과를 확인하세요. (백업 폴더 경로가 표시됩니다)
pause
