# 홈 페이지 = 홈페이지처럼(2026-10-26): 소개 문단 + 소개 영상(비메오) + 묶음 카드(확장 CSS 가 카드로 그림) + 바로 가기
$ErrorActionPreference = "Continue"
$SiteUrl = "https://seamonster2016.sharepoint.com/sites/manual"
$ExportDir = "C:\Users\younh\Desktop\claude\gitbook-export\seamonster guide"
$VideoUrl = "https://vimeo.com/914596103"     # GitBook '시작하기' 에 있던 소개 영상
$ClientId = (Get-Content (Join-Path $env:USERPROFILE ".secrets\pnp-clientid.txt") -Raw).Trim()
Import-Module PnP.PowerShell
Connect-PnPOnline -Url $SiteUrl -Interactive -ClientId $ClientId -PersistLogin
function Safe([string]$s) { ($s -replace '[\\/:*?"<>|#%&{}]', '-').Trim() }
function Has-Body([string]$html) { return (($html -replace '<[^>]+>', '') -replace '\s|&nbsp;', '').Length -ge 5 }
function Enc([string]$s) { [System.Net.WebUtility]::HtmlEncode($s) }

$json = Get-Content (Join-Path $ExportDir "pages.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$pages = @{}
function Walk($nodes, [string]$parentTitle) {
  foreach ($n in $nodes) {
    $html = if ($n.file) { Get-Content (Join-Path $ExportDir "pages\$($n.file)") -Raw -Encoding UTF8 } else { "" }
    if ($n.file -and (Has-Body $html)) { $title = if ($n.depth -ge 2 -and $parentTitle) { "$parentTitle › $($n.title)" } else { $n.title }; $pages[$n.id] = @{ title = $title; name = (Safe $title); desc = [string]$n.description; node = $n } }
    if ($n.children.Count) { Walk $n.children $n.title }
  }
}
Walk $json.pages ""
$groups = @(); $loose = @()
foreach ($top in $json.pages) {
  if ($top.children.Count) {
    $kids = @(); $stack = [System.Collections.Generic.List[object]]::new(); foreach ($c in $top.children) { $stack.Add($c) }
    while ($stack.Count) { $c = $stack[0]; $stack.RemoveAt(0); if ($pages[$c.id]) { $kids += $pages[$c.id] }; foreach ($g in $c.children) { $stack.Add($g) } }
    $groups += @{ title = $top.title; self = $pages[$top.id]; kids = $kids }
  } elseif ($pages[$top.id]) { $loose += $pages[$top.id] }
}
if ($loose.Count) { $groups = @(@{ title = "소개"; self = $null; kids = $loose }) + $groups }
function LinkList($g) {
  $head = if ($g.self) { "<h3><a href=`"$SiteUrl/SitePages/$($g.self.name).aspx`">$(Enc $g.title)</a></h3>" } else { "<h3>$(Enc $g.title)</h3>" }
  $lis = ($g.kids | ForEach-Object { "<li><a href=`"$SiteUrl/SitePages/$($_.name).aspx`">$(Enc $_.node.title)</a></li>" }) -join ""
  return "$head<ul>$lis</ul>"
}
$third = [math]::Ceiling($groups.Count / 3)
$cols = @(); for ($i = 0; $i -lt 3; $i++) { $slice = $groups | Select-Object -Skip ($i * $third) -First $third; $cols += ,(($slice | ForEach-Object { LinkList $_ }) -join "") }

$name = "Manual-Home"
$h = $null; try { $h = Get-PnPPage -Identity $name -ErrorAction Stop } catch { }
if ($h) { Remove-PnPPage -Identity $name -Force | Out-Null }
$h = Add-PnPPage -Name $name -Title "씨몬스터 매뉴얼" -LayoutType Home -HeaderLayoutType NoImage -CommentsEnabled:$false

# 1단: 소개(왼쪽 2/3) + 영상(오른쪽 1/3 → 넓게 보이도록 2열 균등)
Add-PnPPageSection -Page $h -SectionTemplate TwoColumn -Order 1 | Out-Null
$intro = @"
<h2>씨몬스터 매뉴얼</h2>
<p class="lead"><em>업무 순서는 여기서, 숫자는 업무도우미에서.</em></p>
<p>씨몬스터 직원이 같은 기준과 같은 방식으로 일할 수 있도록 만든 문서입니다. 모든 업무는 이 문서 안의 원칙과 기준을 우선으로 합니다.</p>
<p>처음이면 <a href="$SiteUrl/SitePages/시작하기.aspx">시작하기</a> → <a href="$SiteUrl/SitePages/씨몬스터-.aspx">씨몬스터?</a> → <a href="$SiteUrl/SitePages/2026 씨몬스터 계획.aspx">2026 씨몬스터 계획</a> 순서로 읽습니다. 찾는 매뉴얼은 위 검색창에 핵심어를 넣으면 본문까지 검색됩니다.</p>
"@
Add-PnPPageTextPart -Page $h -Section 1 -Column 1 -Text $intro | Out-Null
try {
  Add-PnPPageWebPart -Page $h -DefaultWebPartType ContentEmbed -Section 1 -Column 2 -WebPartProperties @{ embedCode = $VideoUrl; cachedEmbedCode = ""; shouldScaleWidth = $true; tempState = @{} } | Out-Null
  Write-Host "영상 웹 파트 추가" -ForegroundColor Green
} catch { Write-Host "영상 웹 파트 실패: $($_.Exception.Message)" -ForegroundColor Yellow; Add-PnPPageTextPart -Page $h -Section 1 -Column 2 -Text "<p><a href=`"$VideoUrl`">소개 영상 보기</a></p>" | Out-Null }

# 2단: 묶음 카드 3열
Add-PnPPageSection -Page $h -SectionTemplate ThreeColumn -Order 2 | Out-Null
for ($i = 0; $i -lt 3; $i++) { if ($cols[$i]) { Add-PnPPageTextPart -Page $h -Section 2 -Column ($i + 1) -Text $cols[$i] | Out-Null } }

# 3단: 바로 가기
Add-PnPPageSection -Page $h -SectionTemplate OneColumn -Order 3 | Out-Null
Add-PnPPageTextPart -Page $h -Section 3 -Column 1 -Text "<h3>바로 가기</h3><ul><li><a href=`"https://meeting-notes-beryl.vercel.app`">업무도우미</a> — 매출·재고·발주·AI 비서</li><li><a href=`"https://seamonster2016.sharepoint.com/sites/seamonster117`">공용 문서함(SharePoint)</a></li></ul>" | Out-Null

Set-PnPPage -Identity $h -Publish | Out-Null
Set-PnPHomePage -RootFolderRelativeUrl "SitePages/$name.aspx"
Write-Host "홈 다시 구성: $SiteUrl/SitePages/$name.aspx (묶음 $($groups.Count)개)" -ForegroundColor Green
