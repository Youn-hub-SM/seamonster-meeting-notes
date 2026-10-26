# Sites.Selected — 업무도우미 앱에 SharePoint 사이트 읽기 권한을 한 번에 부여 (2026-10-25)
#  누가: Microsoft 365 전역 관리자(또는 SharePoint 관리자). 내 PC 의 PowerShell 에서 실행.
#  하는 일: 아래 $Sites 목록의 사이트마다 앱(seamonster-helper-docs)에 'read' 권한을 준다. 목록에 없는 사이트(급여 등)는 앱이 아예 못 본다.
#  준비: Entra 앱 등록에 Microsoft Graph 애플리케이션 권한 Sites.Selected 가 있고 관리자 동의가 된 상태(docs/ms365-setup.md 1단계).
#
#  실행 (관리자 권한 PowerShell 아니어도 됨):
#    Set-ExecutionPolicy -Scope Process Bypass
#    .\docs\ms365-grant-sites.ps1
#  처음엔 Microsoft.Graph 모듈 설치(몇 분)와 브라우저 로그인 창이 뜬다. 로그인은 관리자 계정으로.

# ── 여기만 고친다 ─────────────────────────────────────────────
$AppId       = "465468a1-5459-408e-9126-187397b775c2"
$AppName     = "seamonster-helper"
$Sites = @(
  "https://seamonster2016.sharepoint.com/sites/seamonster117"
  # 읽게 할 사이트 주소를 한 줄에 하나씩(줄 사이는 쉼표, 마지막 줄은 쉼표 없음). 급여처럼 막을 사이트는 적지 않는다.
)
# ───────────────────────────────────────────────────────────────

if ($AppId -like "<*") { Write-Host "AppId 를 먼저 채우세요." -ForegroundColor Red; exit 1 }

foreach ($m in @("Microsoft.Graph.Authentication", "Microsoft.Graph.Sites")) {
  if (-not (Get-Module -ListAvailable -Name $m)) { Install-Module $m -Scope CurrentUser -Force -AllowClobber }
  Import-Module $m
}

# 관리자 본인의 위임 권한으로 로그인(앱 자격이 아님) — 사이트 권한을 쓰려면 Sites.FullControl.All 이 필요하다
Connect-MgGraph -Scopes "Sites.FullControl.All" -NoWelcome

foreach ($url in $Sites) {
  try {
    $u = [Uri]$url
    $path = ($u.AbsolutePath.Trim("/").Split("/") | Select-Object -First 2) -join "/"   # sites/xxx 또는 personal/xxx
    $siteId = if ($path) { "$($u.Host):/$path" } else { $u.Host }
    $site = Get-MgSite -SiteId $siteId -ErrorAction Stop
    $existing = Get-MgSitePermission -SiteId $site.Id -ErrorAction SilentlyContinue | Where-Object { $_.GrantedToIdentitiesV2.Application.Id -eq $AppId -or $_.GrantedToIdentities.Application.Id -eq $AppId }
    if ($existing) { Write-Host "이미 허용됨: $($site.DisplayName) ($url)" -ForegroundColor Yellow; continue }
    $body = @{
      roles = @("read")
      grantedToIdentities = @(@{ application = @{ id = $AppId; displayName = $AppName } })
    }
    New-MgSitePermission -SiteId $site.Id -BodyParameter $body -ErrorAction Stop | Out-Null
    Write-Host "허용: $($site.DisplayName) ($url)" -ForegroundColor Green
  } catch {
    Write-Host "실패: $url — $($_.Exception.Message)" -ForegroundColor Red
  }
}

Write-Host "`n끝. 업무도우미 관리자 › 설정 › 연결 › Microsoft 365 문서에 같은 주소를 넣고 [연결 확인]을 누르세요."
