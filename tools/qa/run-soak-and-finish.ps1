<#
 tools/qa/run-soak-and-finish.ps1 —— 跑完整的 2 小时浸泡，然后自动收尾

 为什么需要它（实测教训）：
   第一次 2 小时浸泡**跑完了**（10338s = 2h52m，远超 7200s 目标），
   但采样间隔里出现两个巨大空洞：3655s 与 4912s，两个空洞后的样本 `fps5s = 0`。
   根因是**本机进入了睡眠**（我在对话轮次之间等待，机器空闲后自动睡眠）。
   睡眠期间应用根本没在跑 ⇒ "连续运行 2 小时"这条判据**并未真正被验证**
   （有效连续数据只有前 1772s ≈ 30 分钟）。

   ⇒ 判据本身要求"连续运行"，所以运行期间**必须阻止系统睡眠**。
     这正是本脚本存在的原因。

 它做的事（顺序固定）：
   ① 用 `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` 阻止睡眠
      （这是 Win32 的标准做法；本脚本进程活着期间生效，退出/被杀后自动失效 ——
       不会给用户机器留下"永久不休眠"的副作用）
   ② 清理残留实例与锁文件
   ③ 跑 `--probe soak`（默认 120 分钟 / 30 秒采样）
   ④ 用 `soak-2h.ps1` 分析（**默认 7200s 门槛**）
   ⑤ 释放睡眠阻止
   ⑥ 若 `-WithDrill`：接着跑**完整**安装演练（含自启两步）

 用法：
   powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\run-soak-and-finish.ps1
   powershell ... -File tools\qa\run-soak-and-finish.ps1 -Minutes 120 -WithDrill
#>
[CmdletBinding()]
param(
  [string]$Root = '',
  [int]$Minutes = 120,
  [int]$SampleSec = 30,
  [string]$Jsonl = 'docs\evidence\phase8\A15-soak-run2.jsonl',
  [switch]$WithDrill
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Root)) { $Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
$jsonlPath = if ([System.IO.Path]::IsPathRooted($Jsonl)) { $Jsonl } else { Join-Path $Root $Jsonl }
$electron = Join-Path $Root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electron)) { throw "找不到 electron：$electron" }

function Log([string]$m) { Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }

# ── ① 阻止睡眠（Win32 SetThreadExecutionState）
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SleepBlock {
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint SetThreadExecutionState(uint esFlags);
  public const uint ES_CONTINUOUS       = 0x80000000;
  public const uint ES_SYSTEM_REQUIRED  = 0x00000001;
  public const uint ES_DISPLAY_REQUIRED = 0x00000002;
  public static void Block()   { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED); }
  public static void Release() { SetThreadExecutionState(ES_CONTINUOUS); }
}
'@ -ErrorAction SilentlyContinue | Out-Null

[SleepBlock]::Block()
Log "已阻止系统睡眠（SetThreadExecutionState; 本进程退出即自动失效）"

try {
  # ── ② 清理
  Get-Process electron -ErrorAction SilentlyContinue | ForEach-Object {
    $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine
    if ($cl -like "*新工程*") { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue; Log "结束残留 electron pid=$($_.Id)" }
  }
  Start-Sleep -Seconds 3
  $lock = Join-Path $env:APPDATA 'AiriMateOne\run\instance.lock'
  if (Test-Path -LiteralPath $lock) { Remove-Item -LiteralPath $lock -Force; Log '已删除 instance.lock' }
  if (Test-Path -LiteralPath $jsonlPath) { Remove-Item -LiteralPath $jsonlPath -Force; Log "已清空旧的浸泡数据" }

  # ── ③ 跑浸泡
  Log "开始浸泡：${Minutes} 分钟，每 ${SampleSec}s 采样 -> $jsonlPath"
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    & $electron (Join-Path $Root 'apps\desktop') --dev --mode=panel --no-dialogs `
      --probe soak --soak-minutes $Minutes --soak-sample-sec $SampleSec `
      --probe-out $jsonlPath --probe-exit 2>&1 | Select-String -Pattern 'PROBE_SOAK' | ForEach-Object { Log $_ }
  } finally { $ErrorActionPreference = $prev }
  Log "浸泡进程已退出"

  if (-not (Test-Path -LiteralPath $jsonlPath)) { throw "浸泡没有产出数据：$jsonlPath" }

  # ── ④ 分析（默认 7200s 门槛 —— 这才是判据 A15 的要求）
  Log '分析浸泡数据...'
  <#
    ⚠ **这里曾经是坏的**（run5 实测踩到，已修）：原写法把"续行反引号 + 注释行"混在一起 ——

      & powershell.exe ... -File (...soak-2h.ps1) `
        # 注释...
        $summaryName = ...'-summary.json'
        -Jsonl $jsonlPath ...

    反引号续行之后紧跟**注释行**，PowerShell 会把 `-Jsonl ...` 当成**新语句**，
    于是报 `Cannot process command because of one or more missing mandatory parameters: Jsonl`
    + `The term '-Jsonl' is not recognized`。后果：浸泡本身跑完了（PROBE_SOAK_DONE 正常），
    **但汇总没生成** —— 2 小时的数据白等一轮。
    修法：把汇总名算在**独立语句**里，命令行只留一行。
  #>
  $summaryName = [System.IO.Path]::GetFileNameWithoutExtension($jsonlPath) + '-summary.json'
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $soakExit = 1
  try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'tools\qa\soak-2h.ps1') -Jsonl $jsonlPath -OutDir 'docs\evidence\phase8' -SummaryName $summaryName 2>&1 | ForEach-Object { Write-Host "  $_" }
    $soakExit = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prev }
  Log "分析退出码 = $soakExit"
}
finally {
  # ── ⑤ 无论成败都释放睡眠阻止（绝不给用户机器留下"永不休眠"）
  [SleepBlock]::Release()
  Log '已释放睡眠阻止'
}

# ── ⑥ 完整安装演练（可选）
$drillExit = $null
if ($WithDrill) {
  Log '运行完整安装演练（含自启两步）...'
  $drillDir = Join-Path $env:TEMP 'airimate-drill-full'
  if (Test-Path -LiteralPath $drillDir) { Remove-Item -LiteralPath $drillDir -Recurse -Force }
  $sm = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\AiriMate One.lnk'
  if (Test-Path -LiteralPath $sm) { Remove-Item -LiteralPath $sm -Force }
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'tools\qa\check-install-cycle.ps1') `
      -InstallDir $drillDir -OutDir 'docs\evidence\phase7' 2>&1 | ForEach-Object { Write-Host "  $_" }
    $drillExit = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prev }
  Log "安装演练退出码 = $drillExit"
}

Log ''
Log "=== 收尾汇总 ==="
Log "浸泡分析：exit=$soakExit  -> docs\evidence\phase8\A15-soak-summary.json"
if ($WithDrill) { Log "安装演练：exit=$drillExit -> docs\evidence\phase7\A19-install-cycle-summary.json" }
$ok = ($soakExit -eq 0) -and ((-not $WithDrill) -or ($drillExit -eq 0))
Log $(if ($ok) { '全部通过' } else { '有步骤未通过 —— 见上面输出' })

# ── ⑦ 把最终状态落盘（含明确的完成标记）
#
# 为什么写这两个文件：本脚本是**无人值守**跑的，跑完时人可能不在看着控制台。
# 一个 A15-RUN2-DONE.json 比"翻日志找最后一行"直观得多；
# 而 status.ps1 的快照给出"整体到哪一步"的全景（含 24 条判据的覆盖读数）。
Log ''
Log '生成状态快照…'
$prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
try {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'tools\qa\status.ps1') -NoAnalyze 2>&1 |
    Tee-Object -FilePath (Join-Path $Root ('docs\evidence\STATUS-after-' + [System.IO.Path]::GetFileNameWithoutExtension($jsonlPath) + '.txt')) | Out-Null
} finally { $ErrorActionPreference = $prev }

$done = [ordered]@{
  schema         = 'airimate/run-soak-and-finish/1'
  finishedAt     = (Get-Date).ToString('o')
  soakExit       = $soakExit
  drillExit      = $drillExit
  withDrill      = [bool]$WithDrill
  pass           = $ok
  soakSummary    = ('docs/evidence/phase8/' + [System.IO.Path]::GetFileNameWithoutExtension($jsonlPath) + '-summary.json')
  drillSummary   = $(if ($WithDrill) { 'docs/evidence/phase7/A19-install-cycle-summary.json' } else { $null })
  statusSnapshot = ('docs/evidence/STATUS-after-' + [System.IO.Path]::GetFileNameWithoutExtension($jsonlPath) + '.txt')
  note           = 'run1 因系统睡眠被打断、不计通过（见 docs/evidence/phase8/A15-soak-run1-sleep.md）'
}
$donePath = Join-Path $Root ('docs\evidence\' + [System.IO.Path]::GetFileNameWithoutExtension($jsonlPath) + '-DONE.json')
[System.IO.File]::WriteAllText($donePath, ($done | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
Log "完成标记：$donePath"

[Environment]::Exit($(if ($ok) { 0 } else { 1 }))