# 씨몬스터 SharePoint 테마 등록 (2026-10-26) — 매뉴얼 사이트용. 실행: SharePoint 관리자.
#  가이드라인(seamonster-manual/CLAUDE.md): 코랄 #F15A30 은 강조에만, 텍스트 #1A1A1A, 배경 흰색, 회색 한 톤 #6B6B6B.
#  등록 뒤 사이트에서 톱니 → 모양 변경 → 테마 → 회사 테마 '씨몬스터' 를 고른다.
#
#  실행:
#    Set-ExecutionPolicy -Scope Process Bypass
#    .\docs\sharepoint-theme.ps1
#  처음엔 Microsoft.Online.SharePoint.PowerShell 모듈 설치와 관리자 로그인 창이 뜬다.

$Tenant = "seamonster2016"   # https://<Tenant>-admin.sharepoint.com
$ThemeName = "씨몬스터"

if (-not (Get-Module -ListAvailable -Name Microsoft.Online.SharePoint.PowerShell)) {
  Install-Module Microsoft.Online.SharePoint.PowerShell -Scope CurrentUser -Force -AllowClobber
}
Import-Module Microsoft.Online.SharePoint.PowerShell -DisableNameChecking
Connect-SPOService -Url "https://$Tenant-admin.sharepoint.com"

# 팔레트: Fluent UI 테마 규칙대로 코랄 계열 9단계 + 중립색. 코랄은 링크·활성 메뉴·버튼에만 자동 적용된다.
$Palette = @{
  themePrimary        = "#F15A30"
  themeLighterAlt     = "#FEF7F5"
  themeLighter        = "#FCE0D7"
  themeLight          = "#F9C5B5"
  themeTertiary       = "#F58E6F"
  themeSecondary      = "#F26A44"
  themeDarkAlt        = "#D94E26"
  themeDark           = "#B84220"
  themeDarker         = "#873118"
  neutralLighterAlt   = "#FAFAFA"
  neutralLighter      = "#F5F5F5"
  neutralLight        = "#EEEEEE"
  neutralQuaternaryAlt = "#E3E3E3"
  neutralQuaternary   = "#D6D6D6"
  neutralTertiaryAlt  = "#C9C9C9"
  neutralTertiary     = "#A6A6A6"
  neutralSecondary    = "#6B6B6B"
  neutralPrimaryAlt   = "#333333"
  neutralPrimary      = "#1A1A1A"
  neutralDark         = "#111111"
  black               = "#0A0A0A"
  white               = "#FFFFFF"
}

$existing = Get-SPOTheme | Where-Object { $_.Name -eq $ThemeName }
if ($existing) { Remove-SPOTheme -Identity $ThemeName -Confirm:$false }
Add-SPOTheme -Identity $ThemeName -Palette $Palette -IsInverted $false
Write-Host "테마 '$ThemeName' 등록 완료. 사이트 → 톱니 → 모양 변경 → 테마에서 고르세요." -ForegroundColor Green
