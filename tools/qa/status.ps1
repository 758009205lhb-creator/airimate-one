<#
 tools/qa/status.ps1 —— 交付状态一览（**一条命令看清现在到底到哪一步**）

 为什么需要它：
   本项目的验收证据分散在 `docs/evidence/**`，而"现在到底完成到什么程度"这个问题
   此前只能靠读交接文档 + 若干 JSON 拼出来。更麻烦的是有**长时任务**（2 小时浸泡）
   在后台跑，它的进度和结论需要单独看。

   这个脚本把所有"当前状态"集中到一处输出，并在浸泡**跑完但还没分析**时
   自动触发分析 —— 这样收尾不需要人记得去跑哪条命令。

 它**只读**，唯一的写操作是：浸泡已跑完但缺汇总时，调用分析器生成汇总。

 用法：
   powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\status.ps1
   powershell ... -File tools\qa\status.ps1 -NoAnalyze    # 纯只读，不触发分析
#>
[CmdletBinding()]
param(
  [string]$Root = '',
  [switch]$NoAnalyze
)

$ErrorActionPreference = 'Continue'
if ([string]::IsNullOrWhiteSpace($Root)) { $Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
$EV = Join-Path $Root 'docs\evidence'

function Line([string]$label, $value) { Write-Host ("  {0,-26} {1}" -f $label, $value) }
function Head([string]$t) { Write-Host ''; Write-Host "== $t ==" -ForegroundColor Cyan }

Head 'A15/A16 浸泡（2 小时连续运行）'

$runs = @(
  @{ name = 'run1（被系统睡眠打断，已归档）'; jsonl = 'phase8\A15-soak-sleep-interrupted.jsonl'; summary = 'phase8\A15-soak-summary-sleep-interrupted.json' },
  @{ name = 'run2（阻止睡眠后重跑）'; jsonl = 'phase8\A15-soak-run2.jsonl'; summary = 'phase8\A15-soak-run2-summary.json' }
)

$needsAnalyze = $null
foreach ($r in $runs) {
  $jp = Join-Path $EV $r.jsonl
  Write-Host "  — $($r.name)" -ForegroundColor White
  if (-not (Test-Path -LiteralPath $jp)) { Line '数据' '不存在'; continue }

  $lines = Get-Content -LiteralPath $jp
  $samples = @(); $ended = $null
  foreach ($l in $lines) {
    if ([string]::IsNullOrWhiteSpace($l)) { continue }
    try { $o = $l | ConvertFrom-Json } catch { continue }
    if ($o.kind -eq 'sample') { $samples += $o }
    if ($o.kind -eq 'end') { $ended = $o }
  }
  $last = if ($samples.Count) { $samples[-1] } else { $null }
  Line '样本数' $samples.Count
  if ($last) { Line '已运行' ("{0:N1} 分钟 / 120 分钟" -f ($last.tSec / 60)) }
  Line '状态' $(if ($ended) { "已结束（soakSec=$($ended.soakSec)）" } else { '进行中' })
  # 采样连续性：这是 run1 失败的根因，必须每次都报
  if ($samples.Count -ge 2) {
    $gaps = @(); for ($i = 1; $i -lt $samples.Count; $i++) { $gaps += [math]::Round($samples[$i].tSec - $samples[$i - 1].tSec, 1) }
    $maxGap = ($gaps | Measure-Object -Maximum).Maximum
    Line '最大采样间隔' ("{0}s（上限 90s）{1}" -f $maxGap, $(if ($maxGap -gt 90) { '  ← 有空洞！' } else { '' }))
  }
  $sp = Join-Path $EV $r.summary
  if (Test-Path -LiteralPath $sp) {
    try {
      $j = Get-Content -LiteralPath $sp -Raw | ConvertFrom-Json
      Line '汇总 A15/A16' ("passA15=$($j.passA15)  passA16=$($j.passA16)  (时长 {0}s / 门槛 {1}s)" -f $j.actualSoakSec, $j.targetSoakSec)
      Line '不变量违规' $j.invariantViolationCount
      Line '轮换周期估计' ("{0}s（区间 {1}）" -f $j.rotationPeriodFromAliasSec, ($j.rotationPeriodIntervalSec -join ' .. '))
    } catch { Line '汇总' '存在但解析失败' }
  }
  else {
    Line '汇总' '缺失'
    if ($ended -and -not $NoAnalyze) { $needsAnalyze = $r }
  }
}

# 跑完但没汇总 ⇒ 自动补分析（否则"收尾"要靠人记得）
if ($needsAnalyze) {
  Write-Host ''
  Write-Host "  检测到 $($needsAnalyze.name) 已结束但缺汇总 → 自动分析…" -ForegroundColor Yellow
  $summaryName = Split-Path -Leaf $needsAnalyze.summary
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'tools\qa\soak-2h.ps1') `
    -Jsonl (Join-Path $EV $needsAnalyze.jsonl) -OutDir 'docs\evidence\phase8' -SummaryName $summaryName 2>&1 |
    ForEach-Object { Write-Host "    $_" }
}

Head 'A19 安装 → 卸载 → 重启（等价）演练'
$drill = Join-Path $EV 'phase7\A19-install-cycle-summary.json'
if (Test-Path -LiteralPath $drill) {
  try {
    $d = Get-Content -LiteralPath $drill -Raw | ConvertFrom-Json
    Line '结论' $(if ($d.pass) { 'PASS' } else { "FAIL（$($d.failures.Count) 项）" })
    Line '时间' $d.at
    Line '模式' $(if ($d.steps.'02-autostartSkipped') { '跳过自启（-SkipAutostart，需独占实例）' } else { '完整（含自启两步）' })
    if ($d.failures.Count) { $d.failures | ForEach-Object { Line '  失败项' $_ } }
  } catch { Line '结论' '存在但解析失败' }
} else { Line '结论' '尚未运行' }

Head '验收覆盖审计'
$audit = Join-Path $EV 'ACCEPTANCE-AUDIT.md'
if (Test-Path -LiteralPath $audit) {
  # 直接问审计器要最新结论（比读 md 可靠）
  $json = Join-Path $EV 'ACCEPTANCE-AUDIT.json'
  & node (Join-Path $Root 'tools\qa\audit-acceptance.mjs') --json $json 2>&1 |
    Select-String -Pattern 'PASS=|进行中|无证据|证据为失败|交付文档' | ForEach-Object { Write-Host "  $($_.Line.Trim())" }
} else { Line '审计' '尚未运行' }

Head '卫生检查'
foreach ($t in @(
    @{ n = '类型检查'; c = { & npm run typecheck 2>&1 | Select-String 'error TS' } },
    @{ n = 'src 产物/BOM 守卫'; c = { & node (Join-Path $Root 'tools\qa\check-no-src-artifacts.mjs') 2>&1 } },
    @{ n = '静态断言'; c = { & node (Join-Path $Root 'tools\qa\check-claims.mjs') 2>&1 | Select-Object -Last 1 } }
  )) {
  $out = & $t.c 2>&1
  $txt = ($out | Out-String).Trim()
  Line $t.n $(if ([string]::IsNullOrWhiteSpace($txt)) { 'OK（无输出）' } else { $txt })
}

Write-Host ''
Write-Host '（本脚本只读；唯一写操作是"浸泡已结束但缺汇总时自动分析"）' -ForegroundColor DarkGray
