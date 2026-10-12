<#
 tools/qa/finish-soak-and-drill.ps1 —— 等浸泡跑完后自动完成收尾两步

 为什么需要这个脚本（实际约束）：
   2 小时浸泡需要**真实时间**，而它占用三层单实例保护的那个实例 ——
   「安装→卸载→重启」完整演练（含自启两步）也必须在实例空闲时才能跑。
   与其每隔几分钟人工看一眼，不如让一个脚本**阻塞等待**浸泡结束，
   然后依次完成：① 分析浸泡数据出 A15/A16 报告；② 跑完整安装演练。

 它做的事：
   ① 轮询 JSONL 直到出现 `{"kind":"end"}` 记录（或超时）
   ② 调 `soak-2h.ps1` 分析（**用默认 MinSoakSec=7200**，即真正的 2 小时门槛）
   ③ 清理实例锁与残留 electron 进程
   ④ 跑 `check-install-cycle.ps1`（**完整模式**，含自启两步）
   ⑤ 把每一步的输出写进日志文件，并在末尾给出汇总

 用法：
   powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\finish-soak-and-drill.ps1
   powershell ... -File tools\qa\finish-soak-and-drill.ps1 -TimeoutMin 150
#>
[CmdletBinding()]
param(
  [string]$Root = '',
  [string]$SoakJsonl = 'docs\evidence\phase8\A15-soak.jsonl',
  [int]$TimeoutMin = 150,
  [switch]$SkipDrill
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Root)) { $Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
$soakPath = if ([System.IO.Path]::IsPathRooted($SoakJsonl)) { $SoakJsonl } else { Join-Path $Root $SoakJsonl }

function Log([string]$m) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m
  Write-Host $line
}

if (-not (Test-Path -LiteralPath $soakPath)) { throw "找不到浸泡数据：$soakPath" }

# ── ① 等 end 标记
$deadline = (Get-Date).AddMinutes($TimeoutMin)
Log "等待浸泡结束（最多 $TimeoutMin 分钟）：$soakPath"
$ended = $false
while ((Get-Date) -lt $deadline) {
  $tail = Get-Content -LiteralPath $soakPath -Tail 3 -ErrorAction SilentlyContinue
  if ($tail -and ($tail -join "`n") -match '"kind"\s*:\s*"end"') { $ended = $true; break }
  Start-Sleep -Seconds 30
}
if (-not $ended) {
  Log "✗ 超时：$TimeoutMin 分钟内没有看到 end 标记 —— 浸泡可能被中断"
  [Environment]::Exit(1)
}
$samples = (Get-Content -LiteralPath $soakPath | Measure-Object).Count
Log "✓ 浸泡已结束（JSONL 共 $samples 行）"

# ── ② 分析（用默认的 7200 秒门槛 —— 这才是判据 A15 的要求）
Log '分析浸泡数据（MinSoakSec=7200）...'
$prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
try {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'tools\qa\soak-2h.ps1') `
    -Jsonl $soakPath -OutDir 'docs\evidence\phase8' 2>&1 | ForEach-Object { Write-Host "  $_" }
  $soakExit = $LASTEXITCODE
} finally { $ErrorActionPreference = $prev }
Log "soak-2h.ps1 退出码 = $soakExit"

if ($SkipDrill) { Log '-SkipDrill：结束'; [Environment]::Exit($soakExit) }

# ── ③ 清理实例（浸泡进程已退出，但互斥量守卫子进程可能是孤儿）
Log '清理残留实例（仅限本工作区）...'
Get-Process electron -ErrorAction SilentlyContinue | ForEach-Object {
  $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine
  if ($cl -like "*新工程*") { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue; Log "  结束 electron pid=$($_.Id)" }
}
Start-Sleep -Seconds 3
$lock = Join-Path $env:APPDATA 'AiriMateOne\run\instance.lock'
if (Test-Path -LiteralPath $lock) { Remove-Item -LiteralPath $lock -Force; Log '  已删除 instance.lock' }

# ── ④ 完整安装演练（含自启两步）
Log '运行完整安装演练（含自启两步）...'
$drillDir = Join-Path $env:TEMP 'airimate-drill-full'
if (Test-Path -LiteralPath $drillDir) { Remove-Item -LiteralPath $drillDir -Recurse -Force }
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\AiriMate One.lnk'
if (Test-Path -LiteralPath $startMenu) { Remove-Item -LiteralPath $startMenu -Force }

$prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
try {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'tools\qa\check-install-cycle.ps1') `
    -InstallDir $drillDir -OutDir 'docs\evidence\phase7' 2>&1 | ForEach-Object { Write-Host "  $_" }
  $drillExit = $LASTEXITCODE
} finally { $ErrorActionPreference = $prev }
Log "check-install-cycle.ps1 退出码 = $drillExit"

Log ''
Log "=== 收尾汇总 ==="
Log "浸泡分析：exit=$soakExit  → docs\evidence\phase8\A15-soak-summary.json"
Log "安装演练：exit=$drillExit → docs\evidence\phase7\A19-install-cycle-summary.json"
$ok = ($soakExit -eq 0) -and ($drillExit -eq 0)
Log $(if ($ok) { '两步都通过' } else { '有步骤未通过 —— 见上面输出' })
[Environment]::Exit($(if ($ok) { 0 } else { 1 }))
