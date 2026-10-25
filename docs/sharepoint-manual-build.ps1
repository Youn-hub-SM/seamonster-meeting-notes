# 매뉴얼 SharePoint 사이트 자동 구성 (2026-10-26) — docs/sharepoint-manual-site.md 설계안을 PnP PowerShell 로 적용.
#  누가: SharePoint 관리자. 내 PC 의 PowerShell 에서 실행. 브라우저 로그인 창이 뜬다(내장 브라우저가 막혀도 이 창은 뜬다).
#  하는 일(없는 것만 만들고 있으면 건너뜀):
#   1 팀 사이트(Microsoft 365 그룹 없음) /sites/manual 생성   2 회사 테마 '씨몬스터' 등록·적용
#   3 머리글 최소 레이아웃·푸터 끄기                          4 왼쪽 탐색 트리(CS·세일즈·물류·관리자)
#   5 페이지 템플릿 '매뉴얼'                                   6 홈 페이지(빠른 연결·최근 바뀐 매뉴얼)
#   7 전 직원 읽기 권한
#  실행 — 반드시 PowerShell 7(pwsh)에서. Windows PowerShell 5.1 에는 최신 PnP 모듈이 안 깔린다(winget install --id Microsoft.PowerShell -e):
#    Set-ExecutionPolicy -Scope Process Bypass
#    .\docs\sharepoint-manual-build.ps1
#  처음 한 번: PnP 모듈 설치(몇 분) + 로그인용 Entra 앱 등록(브라우저에서 관리자 동의 한 번). 앱 ID 는 내 PC 파일에 저장된다.

# ── 여기만 고친다 ─────────────────────────────────────────────
$Tenant    = "seamonster2016"                       # https://<Tenant>.sharepoint.com
$SiteAlias = "manual"                               # 사이트 주소 /sites/<SiteAlias>
$SiteTitle = "씨몬스터 매뉴얼"
$OwnerUpn  = ""                                     # 비우면 로그인한 관리자 본인이 소유자
$Nav = @(                                           # 왼쪽 탐색 — 그룹(레이블) › 페이지. 페이지는 같은 이름으로 빈 페이지를 만든다
  @{ group = "CS";     pages = @("응대 원칙", "주문·배송 문의", "교환·반품", "정기배송") },
  @{ group = "세일즈"; pages = @("쿠폰 등록 요청서", "채널별 프로모션") },
  @{ group = "물류";   pages = @("택배 발주(CNplus)", "송장 스캔", "입고·재고") },
  @{ group = "관리자"; pages = @("업무도우미 설정", "연동 키 관리표") }
)
# ───────────────────────────────────────────────────────────────

$ErrorActionPreference = "Continue"
if ($PSVersionTable.PSVersion.Major -lt 7) {
  Write-Host "PowerShell 7 에서 실행해야 합니다(지금은 $($PSVersionTable.PSVersion)). 최신 PnP 모듈은 Windows PowerShell 5.1 에 설치되지 않습니다." -ForegroundColor Red
  Write-Host "설치: winget install --id Microsoft.PowerShell -e   → 설치 뒤 시작 메뉴의 'PowerShell 7' 을 열어 다시 실행" -ForegroundColor Yellow
  exit 1
}
$AdminUrl = "https://$Tenant-admin.sharepoint.com"
$SiteUrl  = "https://$Tenant.sharepoint.com/sites/$SiteAlias"
function Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "   $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "   $msg" -ForegroundColor Yellow }

# ── 0. 모듈·로그인 앱 ──
Step "준비: PnP.PowerShell 모듈"
if (-not (Get-Module -ListAvailable -Name PnP.PowerShell)) { Install-Module PnP.PowerShell -Scope CurrentUser -Force -AllowClobber }
Import-Module PnP.PowerShell

$secretDir = Join-Path $env:USERPROFILE ".secrets"
if (-not (Test-Path $secretDir)) { New-Item -ItemType Directory $secretDir | Out-Null }
$cidFile = Join-Path $secretDir "pnp-clientid.txt"
if (Test-Path $cidFile) { $ClientId = (Get-Content $cidFile -Raw).Trim() }
if (-not $ClientId) {
  Step "준비: 로그인용 Entra 앱 등록(한 번만) — 브라우저에서 관리자 로그인·동의"
  $reg = $null
  # 기본이 브라우저 로그인(-Interactive 스위치 없음). 사이트 쓰기 + Graph 사이트 쓰기만 요청한다.
  try { $reg = Register-PnPEntraIDAppForInteractiveLogin -ApplicationName "seamonster-pnp-login" -Tenant "$Tenant.onmicrosoft.com" -SharePointDelegatePermissions "AllSites.FullControl" -GraphDelegatePermissions "Sites.FullControl.All","User.Read" -ErrorAction Stop } catch { Warn "앱 등록 호출 실패(이미 있으면 정상): $($_.Exception.Message)" }
  if ($reg) { Write-Host "   등록 결과:" -ForegroundColor DarkGray; $reg | Format-List | Out-String | Write-Host }
  if ($reg) {
    foreach ($prop in @('AzureAppId/ClientId', 'ClientId', 'AppId', 'AzureAppId')) {
      if (-not $ClientId -and $reg.PSObject.Properties[$prop]) { $ClientId = [string]$reg.$prop }
    }
    if (-not $ClientId) { $m = ($reg | Out-String) -match '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})'; if ($m) { $ClientId = $Matches[1] } }
  }
  if (-not $ClientId) {
    Write-Host "앱 ID 를 자동으로 못 읽었습니다. https://entra.microsoft.com → 앱 등록 → 'seamonster-pnp-login' → 개요의 '애플리케이션(클라이언트) ID' 를 복사해 붙여넣으세요." -ForegroundColor Yellow
    $ClientId = (Read-Host "애플리케이션(클라이언트) ID").Trim()
    if ($ClientId -notmatch '^[0-9a-fA-F-]{36}$') { Write-Host "ID 형식이 아닙니다." -ForegroundColor Red; exit 1 }
  }
  Set-Content -Path $cidFile -Value $ClientId -Encoding ascii
  Ok "앱 ID 저장: $cidFile (다음부터는 묻지 않음)"
}

# ── 1. 사이트 ──
Step "1. 사이트 $SiteUrl"
Connect-PnPOnline -Url $AdminUrl -Interactive -ClientId $ClientId
$exists = $null
try { $exists = Get-PnPTenantSite -Identity $SiteUrl -ErrorAction Stop } catch { }
if ($exists) { Ok "이미 있음 — 건너뜀" }
else {
  $owner = if ($OwnerUpn) { $OwnerUpn } else { (Get-PnPConnection).PSCredential.UserName }
  if (-not $owner) { $owner = (Invoke-PnPSPRestMethod -Url "$AdminUrl/_api/web/currentuser").UserPrincipalName }
  New-PnPSite -Type TeamSiteWithoutMicrosoft365Group -Title $SiteTitle -Url $SiteUrl -Lcid 1042 -Owner $owner -TimeZone 32 | Out-Null
  Ok "생성 요청 완료 — 준비될 때까지 잠시 대기"
  Start-Sleep -Seconds 20
}

# ── 2. 테마 ──
Step "2. 회사 테마 '씨몬스터'"
$Palette = @{
  themePrimary="#F15A30"; themeLighterAlt="#FEF7F5"; themeLighter="#FCE0D7"; themeLight="#F9C5B5"; themeTertiary="#F58E6F"; themeSecondary="#F26A44"
  themeDarkAlt="#D94E26"; themeDark="#B84220"; themeDarker="#873118"
  neutralLighterAlt="#FAFAFA"; neutralLighter="#F5F5F5"; neutralLight="#EEEEEE"; neutralQuaternaryAlt="#E3E3E3"; neutralQuaternary="#D6D6D6"
  neutralTertiaryAlt="#C9C9C9"; neutralTertiary="#A6A6A6"; neutralSecondary="#6B6B6B"; neutralPrimaryAlt="#333333"; neutralPrimary="#1A1A1A"; neutralDark="#111111"
  black="#0A0A0A"; white="#FFFFFF"
}
try { Add-PnPTenantTheme -Identity "씨몬스터" -Palette $Palette -IsInverted $false -Overwrite -ErrorAction Stop | Out-Null; Ok "테마 등록" } catch { Warn "테마 등록 실패: $($_.Exception.Message)" }

# ── 사이트 접속 ──
Connect-PnPOnline -Url $SiteUrl -Interactive -ClientId $ClientId
try { Set-PnPWebTheme -Theme "씨몬스터" -ErrorAction Stop; Ok "테마 적용" } catch { Warn "테마 적용 실패(사이트에서 모양 변경 → 테마로 직접): $($_.Exception.Message)" }

# ── 3. 머리글·푸터 ──
Step "3. 머리글 최소 · 푸터 끄기"
try { Set-PnPWebHeader -HeaderLayout Minimal -HeaderEmphasis None -ErrorAction Stop; Ok "머리글 최소/강조 없음" } catch { Warn "머리글 설정 실패: $($_.Exception.Message)" }
try { Set-PnPFooter -Enabled:$false -ErrorAction Stop; Ok "푸터 끔" } catch { Warn "푸터 설정 실패: $($_.Exception.Message)" }

# ── 4·5. 페이지 템플릿 + 빈 페이지 + 왼쪽 탐색 ──
Step "4. 페이지 템플릿 '매뉴얼'"
function New-ManualPage([string]$name, [string]$title, [bool]$asTemplate) {
  $file = ($name -replace '[\\/:*?"<>|#%]', '-')
  $existingPage = $null
  try { $existingPage = Get-PnPPage -Identity $file -ErrorAction Stop } catch { }
  if ($existingPage) { return $existingPage }
  $p = Add-PnPPage -Name $file -Title $title -LayoutType Article -HeaderLayoutType NoImage -CommentsEnabled:$false
  Add-PnPPageSection -Page $p -SectionTemplate TwoColumnLeft -Order 1 | Out-Null
  $body = @"
<p><em>이 매뉴얼이 답하는 질문을 한 문장으로.</em></p>
<h2>하는 법</h2>
<ol><li>첫 번째 동작 — 화면의 실제 버튼명은 [대괄호], 화면명은 「 」</li><li>두 번째 동작</li></ol>
<h2>주의</h2>
<ul><li>자주 틀리는 것 한 줄</li></ul>
<h2>관련 매뉴얼</h2>
<ul><li><a href="#">○○</a></li></ul>
<p>다음: <a href="#">○○ →</a></p>
"@
  Add-PnPPageTextPart -Page $p -Section 1 -Column 1 -Text $body | Out-Null
  # 오른쪽 1/3: 목차 웹 파트(순차 배포 기능 — 테넌트에 없으면 건너뜀)
  $toc = Get-PnPPageComponent -Page $p -ListAvailable | Where-Object { $_.Name -match "table of contents|목차" } | Select-Object -First 1
  if ($toc) { Add-PnPPageWebPart -Page $p -Component $toc -Section 1 -Column 2 | Out-Null } else { Warn "   목차 웹 파트가 이 테넌트에 아직 없음 — 오른쪽 칸 비워 둠" }
  Set-PnPPage -Identity $p -Publish | Out-Null
  if ($asTemplate) { Set-PnPPage -Identity $p -PromoteAs Template | Out-Null }
  return $p
}
try { New-ManualPage "Template-Manual" "매뉴얼" $true | Out-Null; Ok "템플릿 저장(새 페이지 → 템플릿 '매뉴얼')" } catch { Warn "템플릿 실패: $($_.Exception.Message)" }

Step "5. 왼쪽 탐색 트리 + 빈 페이지"
try {
  Get-PnPNavigationNode -Location QuickLaunch | ForEach-Object { Remove-PnPNavigationNode -Identity $_.Id -Force }
  Add-PnPNavigationNode -Location QuickLaunch -Title "홈" -Url "$SiteUrl/SitePages/Home.aspx" | Out-Null
  foreach ($g in $Nav) {
    $label = Add-PnPNavigationNode -Location QuickLaunch -Title $g.group -Url "http://linkless.header/"   # 링크 없는 레이블
    foreach ($pg in $g.pages) {
      $page = New-ManualPage $pg $pg $false
      Add-PnPNavigationNode -Location QuickLaunch -Title $pg -Url "$SiteUrl/SitePages/$($page.Name)" -Parent $label.Id | Out-Null
    }
    Ok "$($g.group): $($g.pages -join ', ')"
  }
} catch { Warn "탐색 구성 실패: $($_.Exception.Message)" }

# ── 6. 홈 페이지 ──
Step "6. 홈 페이지"
try {
  $home = Get-PnPPage -Identity "Home.aspx"
  # 기존 섹션·웹 파트 비우기
  $home.Sections | ForEach-Object { $home.Sections.Remove($_) } 2>$null
  Set-PnPPage -Identity $home -LayoutType Home -HeaderLayoutType NoImage -Title $SiteTitle | Out-Null
  $home = Get-PnPPage -Identity "Home.aspx"
  Add-PnPPageSection -Page $home -SectionTemplate OneColumn -Order 1 | Out-Null
  $links = ($Nav | ForEach-Object { "<li><strong>$($_.group)</strong> — " + (($_.pages | ForEach-Object { "<a href=`"$SiteUrl/SitePages/$(($_ -replace '[\\/:*?""<>|#%]', '-')).aspx`">$_</a>" }) -join " · ") + "</li>" }) -join ""
  Add-PnPPageTextPart -Page $home -Section 1 -Column 1 -Text "<h2>씨몬스터 매뉴얼</h2><p>업무 순서는 여기서, 숫자는 업무도우미에서.</p><ul>$links</ul>" | Out-Null
  Add-PnPPageSection -Page $home -SectionTemplate OneColumn -Order 2 | Out-Null
  Add-PnPPageTextPart -Page $home -Section 2 -Column 1 -Text "<h2>최근 바뀐 매뉴얼</h2>" | Out-Null
  Add-PnPPageWebPart -Page $home -DefaultWebPartType ContentRollup -Section 2 -Column 1 | Out-Null   # 강조 콘텐츠(기본 = 최근 문서) — 화면에서 '사이트 페이지 · 최근순 · 5개'로 조정
  Set-PnPPage -Identity $home -Publish | Out-Null
  Ok "홈 구성(강조 콘텐츠 웹 파트는 화면에서 '이 사이트 › 페이지 · 최근 수정순 · 5개'로 한 번 맞춰 주세요)"
} catch { Warn "홈 구성 실패: $($_.Exception.Message)" }

# ── 7. 권한 ──
Step "7. 전 직원 읽기"
try {
  $tenantId = (Get-PnPTenantId)
  $visitors = Get-PnPGroup -AssociatedVisitorGroup
  Add-PnPGroupMember -Group $visitors -LoginName "c:0-.f|rolemanager|spo-grid-all-users/$tenantId" -ErrorAction Stop
  Ok "방문자 그룹에 '조직의 모든 구성원(외부 제외)' 추가"
} catch { Warn "권한 설정 실패(사이트 → 톱니 → 사이트 권한에서 직접): $($_.Exception.Message)" }

Write-Host "`n끝. 사이트: $SiteUrl" -ForegroundColor Green
Write-Host "남은 손작업: 사이트 로고(톱니 → 사이트 정보), 홈의 '강조 콘텐츠' 웹 파트 범위 조정, 빈 페이지 본문 채우기."
Write-Host "비서가 읽게 하려면 docs/ms365-grant-sites.ps1 의 `$Sites 에 $SiteUrl 추가 → 실행, 업무도우미 설정 › 연결에 등록."
