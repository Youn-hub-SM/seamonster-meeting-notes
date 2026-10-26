# 매뉴얼 사이트 다듬기(2026-10-26): 자리표시 페이지 삭제 · 페이지 설명(lead) · 홈 구성 · 왼쪽 탐색 재구성 · 테마/머리글 재확인
$ErrorActionPreference = "Continue"
$SiteUrl = "https://seamonster2016.sharepoint.com/sites/manual"
$ExportDir = "C:\Users\younh\Desktop\claude\gitbook-export\seamonster guide"
$ClientId = (Get-Content (Join-Path $env:USERPROFILE ".secrets\pnp-clientid.txt") -Raw).Trim()
Import-Module PnP.PowerShell
Connect-PnPOnline -Url $SiteUrl -Interactive -ClientId $ClientId -PersistLogin
function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "   $m" -ForegroundColor Green }
function Warn($m) { Write-Host "   $m" -ForegroundColor Yellow }
function Safe([string]$s) { ($s -replace '[\\/:*?"<>|#%&{}]', '-').Trim() }
function Has-Body([string]$html) { return (($html -replace '<[^>]+>', '') -replace '\s|&nbsp;', '').Length -ge 5 }

$json = Get-Content (Join-Path $ExportDir "pages.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$json.pages = @($json.pages | Where-Object { $_.title -ne "edit" })
# GitBook 원문의 제목 오타·이상한 제목 교정(탐색·홈 링크 글자에만 적용, 페이지 파일 이름은 그대로)
$TitleFix = @{ "자기평가서 작성법기평가서 작성법" = "자기평가서 작성법"; "#1" = "디자이너 OKR 학습 자료 1" }
function FixT([string]$t) { if ($TitleFix[$t]) { $TitleFix[$t] } else { $t } }
function FixTree($nodes) { foreach ($n in $nodes) { $n.title = FixT $n.title; if ($n.children.Count) { FixTree $n.children } } }
FixTree $json.pages

# 페이지 제목(파일명) 계산 — 가져오기 스크립트와 같은 규칙
$pages = @{}   # id → @{ title; name; desc; depth; node }
function Walk($nodes, [string]$parentTitle) {
  foreach ($n in $nodes) {
    $html = if ($n.file) { Get-Content (Join-Path $ExportDir "pages\$($n.file)") -Raw -Encoding UTF8 } else { "" }
    if ($n.file -and (Has-Body $html)) {
      $title = if ($n.depth -ge 2 -and $parentTitle) { "$parentTitle › $($n.title)" } else { $n.title }
      $pages[$n.id] = @{ title = $title; name = (Safe $title); desc = [string]$n.description; node = $n }
    }
    if ($n.children.Count) { Walk $n.children $n.title }
  }
}
Walk $json.pages ""
$known = @{}; foreach ($v in $pages.Values) { $known["$($v.name).aspx"] = $true }

# ── 1. 자리표시 페이지 삭제(구성 스크립트가 만든 빈 틀 — GitBook 에 없는 이름) ──
Step "1. 자리표시 페이지 정리"
$list = Get-PnPList | Where-Object { $_.BaseTemplate -eq 119 } | Select-Object -First 1
$items = Get-PnPListItem -List $list -PageSize 500 -Fields "FileLeafRef","CanvasContent1","FSObjType"
foreach ($it in $items) {
  $f = [string]$it.FieldValues['FileLeafRef']
  if ($it.FieldValues['FSObjType'] -ne 0 -or $f -in @("Home.aspx", "SCHome.aspx", "Template-Manual.aspx") -or $known[$f]) { continue }
  $txt = [regex]::Replace([string]$it.FieldValues['CanvasContent1'], '<[^>]+>', '')
  if ($txt -match '이 매뉴얼이 답하는 질문을 한 문장으로') { try { Remove-PnPPage -Identity $f -Force -ErrorAction Stop; Ok "삭제(휴지통): $f" } catch { Warn "삭제 실패 $f : $($_.Exception.Message)" } }
  else { Warn "GitBook 에 없는 페이지(그대로 둠): $f" }
}

# ── 2. 페이지 설명(lead) — 목록 Description + 본문 첫 줄 ──
Step "2. 페이지 설명"
$n = 0
foreach ($v in $pages.Values) {
  if (-not $v.desc) { continue }
  try {
    $p = Get-PnPPage -Identity $v.name -ErrorAction Stop
    $txt = $p.Controls | Where-Object { $_.Type.Name -eq "PageText" } | Select-Object -First 1
    if ($txt -and $txt.Text -notmatch '^<p class="lead"') {
      $txt.Text = "<p class=`"lead`"><em>$([System.Net.WebUtility]::HtmlEncode($v.desc))</em></p>" + $txt.Text
      Set-PnPPage -Identity $p -Publish | Out-Null
    }
    Set-PnPListItem -List $list -Identity $p.PageId -Values @{ Description = $v.desc } -UpdateType SystemUpdate -ErrorAction SilentlyContinue | Out-Null
    $n++
  } catch { Warn "설명 실패 $($v.title): $($_.Exception.Message)" }
}
Ok "설명 넣은 페이지 $n 개"

# ── 3. 홈 페이지 ──
Step "3. 홈 페이지"
try {
  $groups = @()
  $loose = @()
  foreach ($top in $json.pages) {
    if ($top.children.Count) {
      $kids = @(); $stack = [System.Collections.Generic.List[object]]::new(); foreach ($c in $top.children) { $stack.Add($c) }
      while ($stack.Count) { $c = $stack[0]; $stack.RemoveAt(0); if ($pages[$c.id]) { $kids += $pages[$c.id] }; foreach ($g in $c.children) { $stack.Add($g) } }
      $groups += @{ title = $top.title; self = $pages[$top.id]; kids = $kids }
    } elseif ($pages[$top.id]) { $loose += $pages[$top.id] }
  }
  if ($loose.Count) { $groups = @(@{ title = "소개"; self = $null; kids = $loose }) + $groups }
  function LinkList($g) {
    $head = if ($g.self) { "<h3><a href=`"$SiteUrl/SitePages/$($g.self.name).aspx`">$($g.title)</a></h3>" } else { "<h3>$($g.title)</h3>" }
    $lis = ($g.kids | ForEach-Object { "<li><a href=`"$SiteUrl/SitePages/$($_.name).aspx`">$([System.Net.WebUtility]::HtmlEncode($_.node.title))</a></li>" }) -join ""
    return "$head<ul>$lis</ul>"
  }
  $half = [math]::Ceiling($groups.Count / 2)
  $left = ($groups[0..($half - 1)] | ForEach-Object { LinkList $_ }) -join ""
  $right = if ($groups.Count -gt $half) { ($groups[$half..($groups.Count - 1)] | ForEach-Object { LinkList $_ }) -join "" } else { "" }

  $name = "Manual-Home"
  $h = $null; try { $h = Get-PnPPage -Identity $name -ErrorAction Stop } catch { }
  if ($h) { Remove-PnPPage -Identity $name -Force | Out-Null }
  $h = Add-PnPPage -Name $name -Title "씨몬스터 매뉴얼" -LayoutType Home -HeaderLayoutType NoImage -CommentsEnabled:$false
  Add-PnPPageSection -Page $h -SectionTemplate OneColumn -Order 1 | Out-Null
  Add-PnPPageTextPart -Page $h -Section 1 -Column 1 -Text "<p class=`"lead`"><em>업무 순서는 여기서, 숫자는 업무도우미에서. 같은 기준과 같은 방식으로 일하기 위한 문서입니다.</em></p>" | Out-Null
  Add-PnPPageSection -Page $h -SectionTemplate TwoColumn -Order 2 | Out-Null
  Add-PnPPageTextPart -Page $h -Section 2 -Column 1 -Text $left | Out-Null
  if ($right) { Add-PnPPageTextPart -Page $h -Section 2 -Column 2 -Text $right | Out-Null }
  Set-PnPPage -Identity $h -Publish | Out-Null
  Set-PnPHomePage -RootFolderRelativeUrl "SitePages/$name.aspx"
  Ok "홈 = SitePages/$name.aspx (묶음 $($groups.Count)개)"
} catch { Warn "홈 실패: $($_.Exception.Message)" }

# ── 4. 왼쪽 탐색 재구성(홈 → 소개 → GitBook 순서) ──
Step "4. 왼쪽 탐색"
try {
  Get-PnPNavigationNode -Location QuickLaunch | ForEach-Object { Remove-PnPNavigationNode -Identity $_.Id -Force }
  Add-PnPNavigationNode -Location QuickLaunch -Title "홈" -Url "$SiteUrl/SitePages/Manual-Home.aspx" | Out-Null
  foreach ($g in $groups) {
    $url = if ($g.self) { "$SiteUrl/SitePages/$($g.self.name).aspx" } else { "http://linkless.header/" }
    $label = Add-PnPNavigationNode -Location QuickLaunch -Title $g.title -Url $url
    foreach ($k in $g.kids) { Add-PnPNavigationNode -Location QuickLaunch -Title $k.node.title -Url "$SiteUrl/SitePages/$($k.name).aspx" -Parent $label.Id | Out-Null }
    Ok "$($g.title): $($g.kids.Count)"
  }
} catch { Warn "탐색 실패: $($_.Exception.Message)" }

# ── 5. 테마·머리글 재적용 ──
Step "5. 테마·머리글"
try { Set-PnPWebTheme -Theme "씨몬스터" -ErrorAction Stop; Ok "테마 씨몬스터" } catch { Warn "테마: $($_.Exception.Message)" }
try { Set-PnPWebHeader -HeaderLayout Minimal -HeaderEmphasis None -ErrorAction Stop; Ok "머리글 최소" } catch { Warn "머리글: $($_.Exception.Message)" }
try { Set-PnPFooter -Enabled:$false -ErrorAction Stop; Ok "푸터 끔" } catch { Warn "푸터: $($_.Exception.Message)" }
Write-Host "`n끝: $SiteUrl" -ForegroundColor Green
