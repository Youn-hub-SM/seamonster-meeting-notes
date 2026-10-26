# 매뉴얼 사이트 서식 확장 설치/업데이트 (2026-10-26) — pwsh 7 + PnP. 앱 카탈로그가 있어야 한다.
#  하는 일: docs/spfx/sm-manual-style.sppkg 를 테넌트 앱 카탈로그에 올리고(게시), 매뉴얼 사이트에 설치(또는 업데이트).
param(
  [string]$Tenant = "seamonster2016",
  [string]$SiteAlias = "manual",
  [string]$Package = (Join-Path $PSScriptRoot "spfx\sm-manual-style.sppkg")
)
$ErrorActionPreference = "Continue"
if ($PSVersionTable.PSVersion.Major -lt 7) { Write-Host "PowerShell 7(pwsh)에서 실행하세요." -ForegroundColor Red; exit 1 }
$ClientId = (Get-Content (Join-Path $env:USERPROFILE ".secrets\pnp-clientid.txt") -Raw).Trim()
$SiteUrl = "https://$Tenant.sharepoint.com/sites/$SiteAlias"
Import-Module PnP.PowerShell
Connect-PnPOnline -Url "https://$Tenant-admin.sharepoint.com" -Interactive -ClientId $ClientId -PersistLogin
$cat = $null; try { $cat = Get-PnPTenantAppCatalogUrl -ErrorAction Stop } catch { }
if (-not $cat) {
  # 방금 만든 카탈로그는 URL 조회가 잠시 비어 있을 수 있다 — 사이트가 APPCATALOG 템플릿이면 그 주소를 쓴다
  $guess = "https://$Tenant.sharepoint.com/sites/appcatalog"
  try { $s = Get-PnPTenantSite -Identity $guess -ErrorAction Stop; if ($s.Template -like "APPCATALOG*") { $cat = $guess } } catch { }
}
if (-not $cat) { Write-Host "테넌트 앱 카탈로그가 없습니다. 먼저 만드세요(관리자: Register-PnPAppCatalogSite)." -ForegroundColor Red; exit 1 }
Write-Host "앱 카탈로그: $cat"
Connect-PnPOnline -Url $cat -Interactive -ClientId $ClientId -PersistLogin
$app = Add-PnPApp -Path $Package -Scope Tenant -Overwrite -Publish -SkipFeatureDeployment:$false
Write-Host "올림: $($app.Title) v$($app.AppCatalogVersion) id=$($app.Id)" -ForegroundColor Green

Connect-PnPOnline -Url $SiteUrl -Interactive -ClientId $ClientId -PersistLogin
$installed = Get-PnPApp -Scope Tenant | Where-Object { $_.Id -eq $app.Id }
if ($installed.InstalledVersion) {
  Update-PnPApp -Identity $app.Id -Scope Tenant
  Write-Host "업데이트: $($installed.InstalledVersion) → $($app.AppCatalogVersion)" -ForegroundColor Green
} else {
  Install-PnPApp -Identity $app.Id -Scope Tenant -Wait
  Write-Host "설치 완료: $SiteUrl" -ForegroundColor Green
}
Write-Host "확인: 사이트 페이지를 새로고침(Ctrl+F5)하면 줄 간격·표·소제목 서식이 바뀌어 보인다. 사용자 지정 작업: " -NoNewline
(Get-PnPCustomAction -Scope Web | Where-Object { $_.Location -eq "ClientSideExtension.ApplicationCustomizer" } | Select-Object -ExpandProperty Title) -join ", "
