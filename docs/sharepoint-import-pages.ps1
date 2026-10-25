# GitBook 내보내기 → SharePoint 매뉴얼 사이트 페이지 생성 (2026-10-26) — 이전 2단계. PowerShell 7 + PnP.
#  입력: docs/gitbook-export.mjs 가 만든 폴더(pages.json · pages/*.html · images/*)
#  하는 일: 이미지를 SiteAssets/manual/ 에 올리고, 페이지마다 '매뉴얼' 틀(왼쪽 본문·오른쪽 목차)로 SharePoint 페이지를 만들고,
#          왼쪽 탐색을 GitBook 트리(2단계)로 다시 구성한다. 같은 이름 페이지가 있으면 본문을 덮어쓴다(다시 실행해도 안전).
#  실행:
#    pwsh
#    Set-ExecutionPolicy -Scope Process Bypass
#    .\docs\sharepoint-import-pages.ps1 -ExportDir "C:\Users\younh\Desktop\claude\gitbook-export\<스페이스제목>"
param(
  [Parameter(Mandatory = $true)][string]$ExportDir,
  [string]$Tenant = "seamonster2016",
  [string]$SiteAlias = "manual",
  [switch]$KeepExistingNav,     # 기존 왼쪽 탐색을 지우지 않고 뒤에 덧붙인다
  [string[]]$Exclude = @("edit") # 건너뛸 최상위 항목 제목(GitBook 의 초안·숨김 묶음 등)
)
$ErrorActionPreference = "Continue"
if ($PSVersionTable.PSVersion.Major -lt 7) { Write-Host "PowerShell 7(pwsh)에서 실행하세요." -ForegroundColor Red; exit 1 }
function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "   $m" -ForegroundColor Yellow }

$SiteUrl = "https://$Tenant.sharepoint.com/sites/$SiteAlias"
$cidFile = Join-Path $env:USERPROFILE ".secrets\pnp-clientid.txt"
if (-not (Test-Path $cidFile)) { Write-Host "로그인 앱 ID 파일이 없습니다: $cidFile (docs/sharepoint-manual-build.ps1 을 먼저 실행)" -ForegroundColor Red; exit 1 }
$ClientId = (Get-Content $cidFile -Raw).Trim()
$json = Get-Content (Join-Path $ExportDir "pages.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$json.pages = @($json.pages | Where-Object { $Exclude -notcontains $_.title })
# 본문이 비어 있는 페이지(GitBook 에서 묶음 머리로만 쓴 것)는 페이지를 만들지 않고 탐색 레이블로만 쓴다
function Has-Body([string]$html) { return (($html -replace '<[^>]+>', '') -replace '\s|&nbsp;', '').Length -ge 5 }

Import-Module PnP.PowerShell
Connect-PnPOnline -Url $SiteUrl -Interactive -ClientId $ClientId

# ── 1. 이미지 ──
Step "1. 이미지 업로드 → SiteAssets/manual"
$imgDir = Join-Path $ExportDir "images"
$imgBase = "$SiteUrl/SiteAssets/manual"
$assets = Get-PnPList -Identity "Site Assets" -ErrorAction SilentlyContinue
if (-not $assets) { $assets = Get-PnPList -Identity "SiteAssets" -ErrorAction SilentlyContinue }
if ($assets -and (Test-Path $imgDir)) {
  try { Resolve-PnPFolder -SiteRelativePath "SiteAssets/manual" | Out-Null } catch { }
  $n = 0
  foreach ($f in Get-ChildItem $imgDir -File) {
    try { Add-PnPFile -Path $f.FullName -Folder "SiteAssets/manual" -ErrorAction Stop | Out-Null; $n++ } catch { Warn "이미지 실패 $($f.Name): $($_.Exception.Message)" }
  }
  Ok "이미지 $n 개"
} else { Warn "이미지 폴더 또는 Site Assets 없음 — 건너뜀" }

# ── 2. 페이지 ──
Step "2. 페이지 생성"
function Safe([string]$s) { ($s -replace '[\\/:*?"<>|#%&{}]', '-').Trim() }
function Ensure-Page([string]$title, [string]$html) {
  $name = Safe $title
  $p = $null
  try { $p = Get-PnPPage -Identity $name -ErrorAction Stop } catch { }
  if ($p) {
    # 기존 페이지: 본문(첫 섹션 첫 칸)만 교체 — 텍스트 웹 파트 전부 지우고 다시
    foreach ($c in @($p.Controls | Where-Object { $_.Type.Name -eq "PageText" })) { try { $p.Controls.Remove($c) | Out-Null } catch { } }
    if (-not $p.Sections.Count) { Add-PnPPageSection -Page $p -SectionTemplate TwoColumnLeft -Order 1 | Out-Null }
  } else {
    $p = Add-PnPPage -Name $name -Title $title -LayoutType Article -HeaderLayoutType NoImage -CommentsEnabled:$false
    Add-PnPPageSection -Page $p -SectionTemplate TwoColumnLeft -Order 1 | Out-Null
    $toc = Get-PnPPageComponent -Page $p -ListAvailable | Where-Object { $_.Name -match "table of contents|목차" } | Select-Object -First 1
    if ($toc) { try { Add-PnPPageWebPart -Page $p -Component $toc -Section 1 -Column 2 | Out-Null } catch { } }
  }
  Add-PnPPageTextPart -Page $p -Section 1 -Column 1 -Text $html | Out-Null
  Set-PnPPage -Identity $p -Publish | Out-Null
  return "$SiteUrl/SitePages/$name.aspx"
}
$urls = @{}   # title → url (탐색용)
function Import-Tree($nodes, [string]$parentTitle) {
  foreach ($n in $nodes) {
    $html = if ($n.file) { Get-Content (Join-Path $ExportDir "pages\$($n.file)") -Raw -Encoding UTF8 } else { "" }
    if ($n.file -and (Has-Body $html)) {
      $html = $html.Replace("@@IMG@@/", "$imgBase/")
      $title = if ($n.depth -ge 2 -and $parentTitle) { "$parentTitle › $($n.title)" } else { $n.title }
      try { $urls[$n.id] = Ensure-Page $title $html; Ok ("  " * $n.depth + $title) } catch { Warn "페이지 실패 '$title': $($_.Exception.Message)" }
    }
    if ($n.children.Count) { Import-Tree $n.children $n.title }
  }
}
Import-Tree $json.pages ""

# ── 3. 왼쪽 탐색(2단계: 상위 = 레이블, 그 아래 = 페이지. 더 깊은 것은 둘째 단계에 '상위 › 제목'으로) ──
Step "3. 왼쪽 탐색"
try {
  if (-not $KeepExistingNav) { Get-PnPNavigationNode -Location QuickLaunch | ForEach-Object { Remove-PnPNavigationNode -Identity $_.Id -Force } }
  Add-PnPNavigationNode -Location QuickLaunch -Title "홈" -Url "$SiteUrl/SitePages/Home.aspx" | Out-Null
  $loose = @()
  foreach ($top in $json.pages) {
    if ($top.children.Count) {
      $label = Add-PnPNavigationNode -Location QuickLaunch -Title $top.title -Url $(if ($urls[$top.id]) { $urls[$top.id] } else { "http://linkless.header/" })
      $flat = @(); $stack = [System.Collections.Generic.List[object]]::new(); foreach ($c in $top.children) { $stack.Add($c) }
      while ($stack.Count) { $c = $stack[0]; $stack.RemoveAt(0); if ($urls[$c.id]) { $flat += $c }; foreach ($g in $c.children) { $stack.Add($g) } }
      foreach ($c in $flat) { Add-PnPNavigationNode -Location QuickLaunch -Title $c.title -Url $urls[$c.id] -Parent $label.Id | Out-Null }
      Ok "$($top.title): $($flat.Count) 페이지"
    } elseif ($urls[$top.id]) { $loose += $top }
  }
  if ($loose.Count) {
    $label = Add-PnPNavigationNode -Location QuickLaunch -Title $json.space -Url "http://linkless.header/"
    foreach ($c in $loose) { Add-PnPNavigationNode -Location QuickLaunch -Title $c.title -Url $urls[$c.id] -Parent $label.Id | Out-Null }
    Ok "$($json.space): $($loose.Count) 페이지"
  }
} catch { Warn "탐색 실패: $($_.Exception.Message)" }

Write-Host "`n끝. $SiteUrl — 페이지 $($urls.Count)개" -ForegroundColor Green
