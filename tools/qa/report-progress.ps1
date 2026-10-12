<#
  tools/qa/report-progress.ps1 —— 进度报告一条命令（把"现在到底到哪一步"变成可复跑脚本）

  为什么需要它：
    进度结论此前只存在于**手写的报告文档**里（`进度总报告-2026-10-03.md` §3.1 那张表）。
    手写报告的问题是：它能复现一次，但**不能在代码变化后再复现一次** ——
    于是"最新代码"与"最新证据"之间会悄悄拉开天数差，而读者看不出来。

    本脚本把那张表**变成可执行的**：跑同一批门禁、输出同一批读数，
    并且**显式标注每一类读数的基准日**与**它是否对得上当前代码**（这是最容易被骗过的地方）。

  设计取舍（三条硬规则，都来自本项目踩过的坑）：

    ① **默认只读**。不带 `-Tests` / `-Typecheck` 时，它只复算「便宜且决定性」的项
       （验收审计 / 交付物完整性 / 静态断言 / 守卫）。跑测试与探针要显式要。
       理由：2 小时浸泡期间**禁止**跑 typecheck/单测/构建，一个"顺手全跑"的脚本会毁掉浸泡。

    ② **判据只认 JSON 里的 `pass*` 与 `checks{}` 计数，绝不看退出码**，
       且 `ok:false` **不得**当失败（本项目大量"拒绝即正确"语义）。
       本脚本把这条规则**写进代码**，而不是写进注释靠人记得。
       同理：**跑不动/解析不出读数 ≠ 通过**，一律标 `未跑` 并计入"不得当通过"。

    ③ **零第三方依赖**。只用 node + 本工程自己的工具；
       `node --test` 的人类可读摘要格式会随 Node 版本漂移，所以测试读数一律走
       `--test-reporter=tap` 解析确定计数，而不是正则抓屏。

  ⚠ **两个新鲜度锚点必须分开**（本脚本第一版就在这里做出过假结论，实测踩到）：
       · `应用代码`（apps/packages）—— 决定**分发包**是否落后；
       · `全部源码`（apps/packages/tools）—— 决定**探针证据**是否落后。
     只改 `tools/qa/` 下的脚本**不会**让分发包失效；用"最新源码 mtime"一把量会把
     "改了 QA 脚本"误报成"分发包落后于代码"。

  ⚠ 证据新鲜度 `STALE` **不是失败** —— 它是"这条结论对不上当前代码"的提示，必须让人看见，
    但不得被读成"门禁不通过"。本脚本把两者分成不同的退出条件与不同的颜色。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\report-progress.ps1
      → 只读汇报（便宜项实跑，贵项读已有证据）

    ... -Tests        → 额外真跑 4 套单测（**不得**在浸泡期间跑）
    ... -Typecheck    → 额外真跑全仓类型检查（同上）
    ... -Full         → -Tests -Typecheck（= 重建基线）
    ... -Json <path>  → 把结构化结果落盘（供后续 diff）
    ... -EvidenceDir <dir> → 换一份探针证据目录（默认当日基线）

  退出码：0 = 所有"已实跑"的门禁通过；1 = 有门禁不通过（**不静默成功**）
#>
[CmdletBinding()]
param(
  [string]$Root = '',
  [switch]$Tests,
  [switch]$Typecheck,
  [switch]$Full,
  [string]$Json = '',
  [string]$EvidenceDir = ''
)

$ErrorActionPreference = 'Continue'
if ($Full) { $Tests = $true; $Typecheck = $true }
if ([string]::IsNullOrWhiteSpace($Root)) {
  $Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}
Set-Location -LiteralPath $Root

# ─────────────────────────────────────────────────────────────────────────────
# 默认证据目录 = **磁盘上最新的那份探针汇总**。
#
# ⚠ 为什么不能写死一个目录（本脚本第二版就栽在这里）：
#   写死 `baseline-20261003` 之后，我另跑了一批探针到 `baseline-20261003-b6`，
#   脚本仍然读旧目录 ⇒ 报「探针证据落后于代码」——
#   那是**假 STALE**，而且方向恰好相反（最新证据就在旁边，它看不见）。
#   "证据过期"这条结论一旦会假报，整个新鲜度机制就没人信了。
#
# 选法：在 `docs/evidence/**` 里找 `_summary.json`，取 **mtime 最新**的那个目录。
# 找不到就退回 `docs/evidence/phase14/baseline-20261003`（历史基准）。
# ─────────────────────────────────────────────────────────────────────────────
function Find-NewestProbeEvidence {
  param([string]$EvRoot)
  if (-not (Test-Path -LiteralPath $EvRoot)) { return $null }
  $newest = $null
  try {
    $sums = @(Get-ChildItem -LiteralPath $EvRoot -Recurse -File -Filter '_summary.json' -ErrorAction SilentlyContinue)
    foreach ($s in $sums) {
      if (-not $newest -or $s.LastWriteTime -gt $newest.LastWriteTime) { $newest = $s }
    }
  } catch { return $null }
  if (-not $newest) { return $null }
  return $newest.Directory.FullName
}

$autoPicked = $false
if ([string]::IsNullOrWhiteSpace($EvidenceDir)) {
  $picked = Find-NewestProbeEvidence -EvRoot (Join-Path $Root 'docs\evidence')
  if ($picked) {
    # ⚠ 自动挑选给的是**绝对路径**，而下面一律按"相对工程根"拼接 ——
    #   不在这里归一化就会拼出 `<root>\<root>\...` 这种不存在的路径（实测踩到）。
    $EvidenceDir = $picked.Replace("$Root\", '')
    $autoPicked = $true
  }
  else { $EvidenceDir = 'docs\evidence\phase14\baseline-20261003' }
}

$EV = Join-Path $Root $EvidenceDir
$rows = New-Object System.Collections.ArrayList
$problems = New-Object System.Collections.ArrayList

function Head([string]$t) { Write-Host ''; Write-Host "== $t ==" -ForegroundColor Cyan }
function Line([string]$label, $value) { Write-Host ("  {0,-24} {1}" -f $label, $value) }
function Bad([string]$t) { Write-Host "  ! $t" -ForegroundColor Yellow }
function Good([string]$t) { Write-Host "  ✓ $t" -ForegroundColor Green }

function Add-Row {
  param([string]$Name, [string]$Verdict, [string]$Detail, [string]$Evidence = '', [string]$BasisDate = '')
  $null = $rows.Add([pscustomobject]@{
      name      = $Name
      verdict   = $Verdict       # PASS / FAIL / STALE / SKIP / INFO
      detail    = $Detail
      evidence  = $Evidence
      basisDate = $BasisDate
    })
}

# ─────────────────────────────────────────────────────────────────────────────
# 通用：跑一个 node 工具，读它的 JSON 结论（**不看退出码**）
# ─────────────────────────────────────────────────────────────────────────────
function Invoke-NodeTool {
  param([string]$Script, [string[]]$ToolArgs = @())
  $tmp = Join-Path $env:TEMP ("airimate-progress-" + [guid]::NewGuid().ToString('N') + ".json")
  $all = @($Script) + $ToolArgs + @('--json', $tmp)
  $out = & node @all 2>&1
  $obj = $null
  if (Test-Path -LiteralPath $tmp) {
    try { $obj = Get-Content -LiteralPath $tmp -Raw | ConvertFrom-Json } catch { $obj = $null }
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
  return [pscustomobject]@{ output = @($out); json = $obj }
}

# ─────────────────────────────────────────────────────────────────────────────
# 通用：跑一个 node:test 套件，用 TAP 报告器解析出确定读数
# ─────────────────────────────────────────────────────────────────────────────
function Invoke-TestSuite {
  param([string]$Label, [string[]]$Files, [int]$Expected)
  $tap = Join-Path $env:TEMP ("airimate-tap-" + [guid]::NewGuid().ToString('N') + ".tap")
  # ⚠ `--test-timeout` 是**兜底**，不是可选项：
  #   `node --test` 默认**没有**每用例超时 ⇒ 一个 await 永不 resolve 的用例
  #   会把整个套件**永久挂住**（实测踩到：A4 闭环测试一开始就挂死，
  #   跑满 600 秒被外层杀掉，且**看不到是哪一个用例**）。
  #   60 s 远大于任何正常用例（本项目最慢的在 10 s 量级），只兜真挂。
  $all = @('--test', '--test-timeout=60000', '--test-reporter=tap', '--test-reporter-destination', $tap) + $Files
  $null = & node @all 2>&1
  $pass = -1; $fail = -1; $tests = -1; $skipped = -1; $plan = $null
  if (Test-Path -LiteralPath $tap) {
    $txt = Get-Content -LiteralPath $tap -Raw
    Remove-Item -LiteralPath $tap -Force -ErrorAction SilentlyContinue
    foreach ($pair in @(@('pass', 'pass'), @('fail', 'fail'), @('tests', 'tests'), @('skipped', 'skipped'))) {
      $m = [regex]::Match($txt, "(?m)^#\s*$($pair[0])\s+(\d+)\s*$")
      if ($m.Success) { Set-Variable -Name $pair[1] -Value ([int]$m.Groups[1].Value) }
    }
    $m = [regex]::Match($txt, '(?m)^1\.\.(\d+)\s*$'); if ($m.Success) { $plan = [int]$m.Groups[1].Value }
  }
  if ($tests -lt 0 -and $null -ne $plan) { $tests = $plan }
  # ⚠ 读到 -1（没解析出来）**不得**当成"0 个失败"：那正是本项目反复强调的假结论
  $ok = ($fail -eq 0) -and ($tests -gt 0) -and ($tests -eq $Expected)
  $detail = "tests=$tests pass=$pass fail=$fail skipped=$skipped（期望 $Expected）"
  if ($fail -lt 0 -or $tests -le 0) { $detail += '  ← TAP 读数没解析出来（不得当通过）' }
  elseif ($tests -ne $Expected) { $detail += '  ← 与期望条数不一致' }
  return [pscustomobject]@{ label = $Label; ok = $ok; detail = $detail; tests = $tests; fail = $fail }
}

# ─────────────────────────────────────────────────────────────────────────────
# 0. 工程自述 —— 两个新鲜度锚点
# ─────────────────────────────────────────────────────────────────────────────
Head '0. 代码基准（新鲜度的两个锚点）'
$allSrc = @(Get-ChildItem -Recurse -File -Include *.ts, *.tsx, *.mjs, *.cjs -Path apps, packages, tools -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\node_modules\\|\\dist\\|\\out\\' })
$appSrc = @($allSrc | Where-Object { $_.FullName -match '\\apps\\|\\packages\\' })
# ★ 探针证据的新鲜度锚点 = **应用代码 + 探针脚本本身**（不含其它 QA 脚本）。
#
# ⚠ 与"分发包锚点"同一个道理（见脚本头）：锚点范围必须与"它到底影响什么"对齐。
#   探针结果由 `apps/` `packages/` 的代码与 `tools/qa/run-probe.ps1` / `soak-2h.ps1` 决定；
#   改 `check-claims.mjs` / `report-progress.ps1` / 文档**不会**让 11 条探针读数失效。
#   用"全部源码"当锚点会把这类无关改动误报成"探针证据落后"——
#   实测踩到：2026-10-06 改完 `check-claims.mjs` 后它立刻报 probe STALE，
#   而那一改**一行应用代码都没碰**。假 STALE 会让真 STALE 失去意义。
$probeSrc = @($allSrc | Where-Object {
    $_.FullName -match '\\apps\\|\\packages\\' -or $_.FullName -match '\\tools\\qa\\(run-probe|soak-2h)\.ps1$'
  })
$allNewest = if ($allSrc.Count) { ($allSrc | Sort-Object LastWriteTime -Descending)[0] } else { $null }
$appNewest = if ($appSrc.Count) { ($appSrc | Sort-Object LastWriteTime -Descending)[0] } else { $null }
$probeNewest = if ($probeSrc.Count) { ($probeSrc | Sort-Object LastWriteTime -Descending)[0] } else { $null }
$codeTime = if ($allNewest) { $allNewest.LastWriteTime } else { $null }
$appTime = if ($appNewest) { $appNewest.LastWriteTime } else { $null }
$probeTime = if ($probeNewest) { $probeNewest.LastWriteTime } else { $null }
Line '源文件数' ("apps+packages+tools = $($allSrc.Count)（其中应用代码 apps/packages = $($appSrc.Count)）")
Line '最新应用代码' ("{0:yyyy-MM-dd HH:mm}  {1}" -f $appTime, $(if ($appNewest) { $appNewest.FullName.Replace("$Root\", '') } else { '(无)' }))
Line '最新探针相关' ("{0:yyyy-MM-dd HH:mm}  {1}" -f $probeTime, $(if ($probeNewest) { $probeNewest.FullName.Replace("$Root\", '') } else { '(无)' }))
Line '最新全部源码' ("{0:yyyy-MM-dd HH:mm}  {1}" -f $codeTime, $(if ($allNewest) { $allNewest.FullName.Replace("$Root\", '') } else { '(无)' }))
Add-Row -Name 'code-baseline' -Verdict 'INFO' -Detail "应用代码 $($appTime.ToString('yyyy-MM-dd HH:mm')) / 探针相关 $($probeTime.ToString('yyyy-MM-dd HH:mm'))" -BasisDate $appTime.ToString('yyyy-MM-dd')

# ─────────────────────────────────────────────────────────────────────────────
# 1. 便宜且决定性：静态断言 / 守卫
# ─────────────────────────────────────────────────────────────────────────────
Head '1. 静态门禁（便宜、决定性）'
$today = Get-Date -Format 'yyyy-MM-dd'

# 1.1 静态断言 check-claims —— 判据只看 JSON 的 pass 字段
$r = Invoke-NodeTool -Script 'tools/qa/check-claims.mjs'
if ($r.json) {
  $failed = @($r.json.failed)
  $ok = [bool]$r.json.pass
  Line '静态断言' ("{0}（不成立：{1}）" -f $(if ($ok) { '全部成立' } else { '存在不成立项' }), $(if ($failed.Count) { $failed -join ', ' } else { '无' }))
  if (-not $ok) { Bad "静态断言不成立：$($failed -join ', ')"; $null = $problems.Add("check-claims: $($failed -join ', ')") }
  Add-Row -Name 'check-claims' -Verdict $(if ($ok) { 'PASS' } else { 'FAIL' }) -Detail ("failed=" + $(if ($failed.Count) { $failed -join ',' } else { '[]' })) -Evidence 'tools/qa/check-claims.mjs' -BasisDate $today
}
else { Line '静态断言' '跑失败（无 JSON）'; Add-Row -Name 'check-claims' -Verdict 'FAIL' -Detail '无 JSON 输出' }

# 1.2 src 产物 / BOM 守卫 —— ⚠ 判定读它**自己的结论文本**，不看退出码
$guardOut = @(& node tools/qa/check-no-src-artifacts.mjs 2>&1 | ForEach-Object { "$_" })
$guardText = $guardOut -join "`n"
$guardOk = ($guardText -match '\[guard\] OK') -and ($guardText -notmatch '\[guard\] 发现')
Line 'src 产物/BOM 守卫' $(if ($guardOk) { 'OK（两项都干净）' } else { 'FAIL' })
if (-not $guardOk) {
  $guardOut | Where-Object { $_ -match '\[guard\] 发现|^  - ' } | Select-Object -First 10 | ForEach-Object { Bad $_ }
  $null = $problems.Add('check-no-src-artifacts')
}
Add-Row -Name 'check-no-src-artifacts' -Verdict $(if ($guardOk) { 'PASS' } else { 'FAIL' }) -Detail $(if ($guardOk) { 'src 下无编译产物且无 BOM JSON' } else { '见上方明细' }) -BasisDate $today

# ─────────────────────────────────────────────────────────────────────────────
# 2. 验收覆盖审计（产证据 × 判据的机械对账）
# ─────────────────────────────────────────────────────────────────────────────
Head '2. 验收覆盖审计'
$r = Invoke-NodeTool -Script 'tools/qa/audit-acceptance.mjs'
if ($r.json) {
  # ⚠ 审计报告里**没有** `pass` 字段；结论要自己按它打印的同一口径合成：
  #   无证据 / 证据为失败 / 有证据无结论 / 进行中 —— 四者全空才算每条都有明确结论
  $noEv = @($r.json.noEvidence)
  $failedIds = @($r.json.failed)
  $noVerdict = @($r.json.evidenceWithoutVerdict)
  $pend = @($r.json.pending)
  # ⚠ `byVerdict` 是哈希表：某个结论**一条都没有**时该键**不存在**，
  #   直接插值会得到空串（实测踩到：打印出 `FAIL=`）。取不到就当 0，并显式转 int。
  $by = $r.json.byVerdict
  $nPass = [int]($by.PSObject.Properties['PASS'].Value)
  $nFail = [int]($by.PSObject.Properties['FAIL'].Value)
  $total = @($r.json.rows).Count
  Line '判据' ("共 $total 条：PASS=$nPass FAIL=$nFail 进行中=$($pend.Count) 无证据=$($noEv.Count) 有证据无结论=$($noVerdict.Count)")
  $clean = ($noEv.Count -eq 0) -and ($failedIds.Count -eq 0) -and ($noVerdict.Count -eq 0) -and ($pend.Count -eq 0)
  if ($clean) { Good '每条判据都有明确结论的证据' }
  else {
    if ($noEv.Count) { Bad "无证据：$($noEv -join ', ')" }
    if ($failedIds.Count) { Bad "证据为失败：$($failedIds -join ', ')" }
    if ($pend.Count) { Bad "进行中（不得算通过）：$($pend -join ', ')" }
    if ($noVerdict.Count) { Bad "有证据无结论（不得算通过）：$($noVerdict -join ', ')" }
    $null = $problems.Add('audit-acceptance 存在缺口')
  }
  $docRefs = $r.json.docRefs
  if ($docRefs) { Line '交付文档引用' ("$($docRefs.checked) 个，缺失 $(@($docRefs.missing).Count) 个") }
  Add-Row -Name 'audit-acceptance' -Verdict $(if ($clean) { 'PASS' } else { 'FAIL' }) -Detail "PASS=$nPass FAIL=$nFail 进行中=$($pend.Count) 无证据=$($noEv.Count)" -Evidence 'tools/qa/audit-acceptance.mjs' -BasisDate $today
}
else { Line '审计' '跑失败（无 JSON）'; Add-Row -Name 'audit-acceptance' -Verdict 'FAIL' -Detail '无 JSON 输出' }

# ─────────────────────────────────────────────────────────────────────────────
# 3. 交付物完整性（复算 = 不看清单自述，自己重算 sha256）
# ─────────────────────────────────────────────────────────────────────────────
Head '3. 交付物完整性（复算）'
$distManifest = Join-Path $Root 'dist-package\MANIFEST.json'
if (Test-Path -LiteralPath $distManifest) {
  $r = Invoke-NodeTool -Script 'tools/qa/verify-dist-integrity.mjs'
  if ($r.json) {
    $ok = [bool]$r.json.pass
    $distTime = (Get-Item -LiteralPath $distManifest).LastWriteTime
    Line '完整性' $(if ($ok) { 'PASS' } else { 'FAIL' })
    Line '载荷' ("{0} 文件 / {1} MB（清单记录 {2} 个，暂存于 {3}）" -f $r.json.hashedFiles, $r.json.payloadMB, $r.json.manifestFiles, $r.json.stagedAt)
    Line '总摘要' ("{0}…" -f ([string]$r.json.payloadDigest).Substring(0, 16))
    if (-not $ok) { @($r.json.problems) | ForEach-Object { Bad "[$($_.code)] $($_.detail)" }; $null = $problems.Add('verify-dist-integrity') }
    # ⚠ 分发包只关心**应用代码**：tools/qa 下的脚本改动不影响包内容
    $distNewer = $distTime -ge $appTime
    Line '包 vs 应用代码' ("包 {0:yyyy-MM-dd HH:mm} {1} 应用代码 {2:yyyy-MM-dd HH:mm} ⇒ {3}" -f $distTime, $(if ($distNewer) { '≥' } else { '<' }), $appTime, $(if ($distNewer) { '一致（包不比应用代码旧）' } else { '**包落后** ⇒ 需重新 build:dist' }))
    if (-not $distNewer) { Bad '分发包落后于最新应用代码 —— 当前包的读数不代表当前代码'; $null = $problems.Add('dist-package 落后于应用代码') }
    Add-Row -Name 'dist-integrity' -Verdict $(if ($ok) { 'PASS' } else { 'FAIL' }) -Detail ("files=$($r.json.hashedFiles) digest=" + ([string]$r.json.payloadDigest).Substring(0, 8)) -Evidence 'dist-package/MANIFEST.json' -BasisDate $distTime.ToString('yyyy-MM-dd')
    Add-Row -Name 'dist-vs-appcode' -Verdict $(if ($distNewer) { 'PASS' } else { 'STALE' }) -Detail ("包 $($distTime.ToString('yyyy-MM-dd HH:mm')) / 应用代码 $($appTime.ToString('yyyy-MM-dd HH:mm'))") -BasisDate $distTime.ToString('yyyy-MM-dd')
  }
  else { Line '完整性' '跑失败（无 JSON）'; Add-Row -Name 'dist-integrity' -Verdict 'FAIL' -Detail '无 JSON 输出' }
}
else { Line '完整性' 'dist-package\MANIFEST.json 不存在（尚未组装分发包）'; Add-Row -Name 'dist-integrity' -Verdict 'SKIP' -Detail '无分发包' }

# ─────────────────────────────────────────────────────────────────────────────
# 4. 单测 / 类型检查（**贵**，默认不跑 —— 浸泡期间禁止）
# ─────────────────────────────────────────────────────────────────────────────
Head '4. 单测与类型检查'
if ($Tests) {
  $desktopDir = Join-Path $Root 'apps\desktop\test'
  $desktopFiles = @(Get-ChildItem -LiteralPath $desktopDir -Filter '*.test.cjs' | Sort-Object Name | ForEach-Object { $_.FullName })
  $suites = @(
    @{ label = 'desktop'; files = $desktopFiles; expect = 418 },
    @{ label = 'avatar-stage'; files = @((Join-Path $Root 'packages\avatar-stage\test\motion-runtime.test.mjs')); expect = 35 },
    @{ label = 'motion-director'; files = @((Join-Path $Root 'packages\motion-director\test\director.test.mjs'), (Join-Path $Root 'packages\motion-director\test\no-three-import.test.mjs')); expect = 44 },
    @{ label = 'companion-kit'; files = @((Join-Path $Root 'packages\companion-kit\test\kit.test.mjs')); expect = 55 }
  )
  foreach ($s in $suites) {
    $res = Invoke-TestSuite -Label $s.label -Files $s.files -Expected $s.expect
    Line $res.label $res.detail
    if (-not $res.ok) { Bad "$($res.label) 单测不通过"; $null = $problems.Add("unit:$($res.label)") }
    Add-Row -Name "unit-$($res.label)" -Verdict $(if ($res.ok) { 'PASS' } else { 'FAIL' }) -Detail $res.detail -BasisDate $today
  }
}
else {
  Line '状态' '未跑（默认不跑 —— 浸泡期间禁止；要跑加 -Tests）'
  Add-Row -Name 'unit-suites' -Verdict 'SKIP' -Detail '未跑（-Tests 才跑）'
}

if ($Typecheck) {
  $tcOut = @(& npm run typecheck 2>&1 | ForEach-Object { "$_" })
  $errs = @($tcOut | Where-Object { $_ -match 'error TS' })
  $tcOk = ($errs.Count -eq 0)
  Line '类型检查' ("错误 $($errs.Count) 条")
  if (-not $tcOk) { $errs | Select-Object -First 5 | ForEach-Object { Bad $_ }; $null = $problems.Add('typecheck') }
  Add-Row -Name 'typecheck' -Verdict $(if ($tcOk) { 'PASS' } else { 'FAIL' }) -Detail "errors=$($errs.Count)" -BasisDate $today
}
else {
  Line '类型检查' '未跑（加 -Typecheck 才跑）'
  Add-Row -Name 'typecheck' -Verdict 'SKIP' -Detail '未跑（-Typecheck 才跑）'
}

# ─────────────────────────────────────────────────────────────────────────────
# 5. 探针证据（读落盘 JSON 汇总；探针本身另跑，见 run-probe.ps1）
# ─────────────────────────────────────────────────────────────────────────────
Head '5. 探针证据（读落盘 JSON，不重跑）'
# 报相对路径而不是绝对路径 —— 诊断输出里不出现盘符是本工程的一条纪律
$evRel = $EvidenceDir.Replace("$Root\", '').Replace('\', '/')
if ($autoPicked) { Line '证据目录来源' "自动选取（磁盘上最新的 _summary.json）" }
if (Test-Path -LiteralPath $EV) {
  $sumFile = Join-Path $EV '_summary.json'
  if (Test-Path -LiteralPath $sumFile) {
    try {
      $sum = Get-Content -LiteralPath $sumFile -Raw | ConvertFrom-Json
      $sumDate = ([datetime]$sum.summarizedAt).ToLocalTime()
      Line '证据目录' $evRel
      Line '汇总时间' ("{0:yyyy-MM-dd HH:mm}" -f $sumDate)
      Line '探针' ("$($sum.passed) / $($sum.probeCount) 通过")
      # ⚠ 探针证据的新鲜度锚点是**应用代码 + 探针脚本本身**（不含其它 QA 脚本）——
      #   改 check-claims / report-progress 不会让 11 条探针读数失效。
      $stale = $sumDate -lt $probeTime
      Line 'vs 当前代码' $(if ($stale) { "**落后**（探针相关代码已改到 $($probeTime.ToString('yyyy-MM-dd HH:mm'))）" } else { '不落后（晚于最新应用代码与探针脚本改动）' })
      foreach ($row in $sum.rows) {
        if (-not $row.pass) { Bad "$($row.file) FAIL：$($row.reason)$($row.passFieldsFalse -join ',')" }
      }
      if (-not [bool]$sum.pass) { $null = $problems.Add('探针证据存在失败项') }
      Add-Row -Name 'probes' -Verdict $(if ([bool]$sum.pass) { 'PASS' } else { 'FAIL' }) -Detail "$($sum.passed)/$($sum.probeCount)" -Evidence "$evRel/_summary.json" -BasisDate $sumDate.ToString('yyyy-MM-dd')
      Add-Row -Name 'probes-vs-code' -Verdict $(if ($stale) { 'STALE' } else { 'PASS' }) -Detail ("证据 {0:yyyy-MM-dd HH:mm} / 探针相关代码 {1:yyyy-MM-dd HH:mm}" -f $sumDate, $probeTime) -BasisDate $sumDate.ToString('yyyy-MM-dd')
    }
    catch { Line '汇总' '存在但解析失败'; Add-Row -Name 'probes' -Verdict 'FAIL' -Detail '_summary.json 解析失败' }
  }
  else { Line '汇总' "_summary.json 不存在（生成：node tools\qa\summarize-probes.mjs $evRel）"; Add-Row -Name 'probes' -Verdict 'SKIP' -Detail '无汇总文件' }
}
else { Line '证据目录' "不存在：$evRel"; Add-Row -Name 'probes' -Verdict 'SKIP' -Detail '无证据目录' }

# ─────────────────────────────────────────────────────────────────────────────
# 6. 长稳浸泡（A15/A16）—— 唯一"需要独占机器"的证据
#
# ⚠ 这里**不能写死轮次**（本脚本第一版写死 run5，run7 跑完后它仍在报 09-28 的旧数据）。
#   与第 5 节同一个道理：写死就会**默默报旧结论**，而"默默报旧"正是本脚本要消灭的东西。
#   选法：取 `A15-soak-run*-summary.json` 里 **mtime 最新**的那一份，并**把轮次名打出来**。
# ─────────────────────────────────────────────────────────────────────────────
Head '6. 长稳浸泡 A15/A16'
$soakCandidates = @(Get-ChildItem -LiteralPath (Join-Path $Root 'docs\evidence\phase8') -File -Filter 'A15-soak-run*-summary.json' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending)
$soak = if ($soakCandidates.Count) { $soakCandidates[0].FullName } else { $null }
if ($soak) {
  try {
    $s = Get-Content -LiteralPath $soak -Raw | ConvertFrom-Json
    $soakTime = (Get-Item -LiteralPath $soak).LastWriteTime
    $soakRel = $soak.Replace("$Root\", '').Replace('\', '/')
    Line '证据（最新轮次）' (Split-Path $soak -Leaf)
    Line '结论' ("passA15=$($s.passA15)  passA16=$($s.passA16)")
    Line '实跑时长' ("{0}s / 门槛 {1}s" -f $s.actualSoakSec, $s.targetSoakSec)
    Line '不变量违规' $s.invariantViolationCount
    Line '可见样本占比' $(if ($null -ne $s.visibleRatio) { "$([math]::Round([double]$s.visibleRatio*100,1))%（门槛 ≥95%）" } else { '(老数据未记录)' })
    Line '动画时钟' $(if ($null -ne $s.clockChangeRatio) { "相异率 $([math]::Round([double]$s.clockChangeRatio*100,2))%（门槛 ≥95%）/ 最长连续相同 $($s.clockMaxStuckRun) 样本（上限 3）" } else { "(老口径：advancing=$($s.clockAdvancing))" })
    Line '证据基准日' ("{0:yyyy-MM-dd}" -f $soakTime)
    # ⚠ 浸泡证据的新鲜度同样看**应用代码 + 探针脚本**（浸泡探针在 bootstrap.ts 里）
    $stale = $soakTime -lt $probeTime
    $vsText = if ($stale) { "**落后**（相关代码已改到 $($probeTime.ToString('yyyy-MM-dd HH:mm'))）" } else { '不落后' }
    Line 'vs 当前代码' $vsText
    Add-Row -Name 'soak-A15A16' -Verdict $(if ($stale) { 'STALE' } else { 'PASS' }) -Detail ("$(Split-Path $soak -Leaf)：passA15=$($s.passA15) passA16=$($s.passA16) 实跑 $($s.actualSoakSec)s") -Evidence $soakRel -BasisDate $soakTime.ToString('yyyy-MM-dd')
  }
  catch { Line '结论' '存在但解析失败'; Add-Row -Name 'soak-A15A16' -Verdict 'FAIL' -Detail '汇总解析失败' }
}
else { Line '结论' '尚未跑（需独占机器的 2 小时时间窗）'; Add-Row -Name 'soak-A15A16' -Verdict 'SKIP' -Detail '无浸泡证据' }

# ─────────────────────────────────────────────────────────────────────────────
# 汇总
# ─────────────────────────────────────────────────────────────────────────────
Head '汇总'
$counts = @{}
foreach ($v in @('PASS', 'FAIL', 'STALE', 'SKIP', 'INFO')) { $counts[$v] = @($rows | Where-Object { $_.verdict -eq $v }).Count }
Line '门禁' ("PASS=$($counts['PASS'])  FAIL=$($counts['FAIL'])  STALE=$($counts['STALE'])  SKIP=$($counts['SKIP'])")

if ($counts['FAIL'] -gt 0) {
  Write-Host ''
  Write-Host '  不通过项（**这才是失败**）：' -ForegroundColor Red
  $rows | Where-Object { $_.verdict -eq 'FAIL' } | ForEach-Object { Write-Host "    ✗ $($_.name)：$($_.detail)" -ForegroundColor Red }
}
if ($counts['STALE'] -gt 0) {
  Write-Host ''
  Write-Host '  证据落后于代码（**不是失败**，但这些结论对不上当前代码）：' -ForegroundColor Yellow
  $rows | Where-Object { $_.verdict -eq 'STALE' } | ForEach-Object { Write-Host "    ! $($_.name)：$($_.detail)" -ForegroundColor Yellow }
}
if ($counts['SKIP'] -gt 0) {
  Write-Host ''
  Write-Host '  未跑（**不得当通过**）：' -ForegroundColor DarkGray
  $rows | Where-Object { $_.verdict -eq 'SKIP' } | ForEach-Object { Write-Host "    … $($_.name)：$($_.detail)" -ForegroundColor DarkGray }
}

$pass = ($counts['FAIL'] -eq 0)

$result = [pscustomobject]@{
  schema       = 'airimate/progress-report/1'
  generatedAt  = (Get-Date).ToUniversalTime().ToString('o')
  root         = $Root
  codeBaseline = [pscustomobject]@{
    sourceFiles   = $allSrc.Count
    appFiles      = $appSrc.Count
    newestAny     = $(if ($allNewest) { $allNewest.FullName.Replace("$Root\", '') } else { $null })
    newestAnyAt   = $(if ($codeTime) { $codeTime.ToString('o') } else { $null })
    newestApp     = $(if ($appNewest) { $appNewest.FullName.Replace("$Root\", '') } else { $null })
    newestAppAt   = $(if ($appTime) { $appTime.ToString('o') } else { $null })
  }
  evidenceDir  = $evRel
  # 证据目录是自动挑的（磁盘上最新）还是显式传的 —— 结论复核时这一点必须可知
  evidenceDirAuto = $autoPicked
  rows         = @($rows)
  counts       = $counts
  problems     = @($problems)
  pass         = $pass
}
if ($Json) {
  $jsonPath = if ([System.IO.Path]::IsPathRooted($Json)) { $Json } else { Join-Path $Root $Json }
  $dir2 = Split-Path -Parent $jsonPath
  if ($dir2 -and -not (Test-Path -LiteralPath $dir2)) { $null = New-Item -ItemType Directory -Force -Path $dir2 }
  # ⚠ 无 BOM 的 UTF-8（`Set-Content -Encoding UTF8` 在 PS 5.1 下总是写 BOM ⇒ `JSON.parse` 抛错）
  [System.IO.File]::WriteAllText($jsonPath, ($result | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
  Write-Host ''
  Write-Host "  结构化结果：$jsonPath" -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '（判据只认 JSON 的 pass* 与 checks{}；不看退出码；ok:false 常是"拒绝即正确"）' -ForegroundColor DarkGray
Write-Host $(if ($pass) { '[progress] PASS' } else { '[progress] FAIL' })
exit $(if ($pass) { 0 } else { 1 })
