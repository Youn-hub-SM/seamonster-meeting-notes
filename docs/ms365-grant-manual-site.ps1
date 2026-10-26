# 업무도우미 서버 앱(seamonster-helper, Sites.Selected)에 매뉴얼 사이트 읽기 허용 — PnP 로(관리자 로그인 지속 토큰 사용)
$ErrorActionPreference = "Continue"
$ClientId = (Get-Content (Join-Path $env:USERPROFILE ".secrets\pnp-clientid.txt") -Raw).Trim()
$AppId = "465468a1-5459-408e-9126-187397b775c2"   # 업무도우미 Entra 앱(seamonster-helper)
$SiteUrl = "https://seamonster2016.sharepoint.com/sites/manual"
Import-Module PnP.PowerShell
Connect-PnPOnline -Url $SiteUrl -Interactive -ClientId $ClientId -PersistLogin
$existing = Get-PnPAzureADAppSitePermission -ErrorAction SilentlyContinue | Where-Object { $_.Apps.Id -contains $AppId -or ($_.Apps | ForEach-Object { $_.Id }) -contains $AppId }
if ($existing) { Write-Host "이미 허용됨: $($existing.Roles -join ',')" }
else {
  try { $r = Grant-PnPAzureADAppSitePermission -AppId $AppId -DisplayName "seamonster-helper" -Permissions Read -Site $SiteUrl -ErrorAction Stop; Write-Host "허용 완료: $($r.Roles -join ',')" }
  catch { Write-Host "허용 실패: $($_.Exception.Message)" }
}
Get-PnPAzureADAppSitePermission -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  앱 권한: $(($_.Apps | ForEach-Object { $_.DisplayName }) -join ',') $($_.Roles -join ',')" }
