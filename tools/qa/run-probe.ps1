<#
  tools/qa/run-probe.ps1 —— 跑一个 Electron 验收探针，落盘 JSON，并做**收尾清理**。

  为什么要单独写这个脚本（本轮实测踩到的坑，逐条对应）：
    ① 探针进程**不会**把 stdout 交给调用者（GUI 子系统 + Electron 会 detach stdio）
       ⇒ 必须靠 `--probe-out <json>` 落盘，读 JSON 而不是读控制台；
    ② 探针失败/超时会**留下实例**（持有命名互斥体 + `instance.lock`），
       下一次启动就会命中单实例逻辑、静默不干活
       ⇒ 每次跑之前与跑之后都必须清理（只清**本工程**的进程，绝不按名字乱杀）；
    ③ 我自己在 shell 里写过含 "MutexKeeper" 字样的命令，
       `Where-Object { $_.CommandLine -like '*MutexKeeper*' }` 会**匹配到自己**
       ⇒ 必须排除 `$PID`。

  用法：
    pwsh -File tools/qa/run-probe.ps1 -Name a11
    pwsh -File tools/qa/run-probe.ps1 -Name idleAnchor60s -Mode pet -TimeoutSec 200
#>
# `-ExtraArgs` 的说明（**不能写在 param() 内部**：PowerShell 5.1 的
# 参数列表里只允许 `#` 行注释，块注释会让解析器直接报 MissingExpressionAfterToken）：
#
#   额外的 electron 参数（原样透传）。
#   为什么需要：探针要在**确定性环境**里跑，而 M2 的主动陪伴引擎会自己采样活动、
#   可能朗读、会写提醒 —— 一次突然的"久坐提醒"足以让窗口焦点或帧率读数失效。
#   用法：`-ExtraArgs '-no-proactive'`。
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$Mode = 'panel',
  [int]$TimeoutSec = 180,
  [string]$OutDir = '',
  [switch]$SkipCleanupBefore,
  [string[]]$ExtraArgs = @()
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $root 'package.json'))) { $root = 'F:\deepseek harness\AI女友\新工程' }
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$appDir = Join-Path $root 'apps\desktop'
if (-not $OutDir) { $OutDir = Join-Path $root 'docs\evidence\phase3\round-interaction' }
$null = New-Item -ItemType Directory -Force -Path $OutDir
$out = Join-Path $OutDir "$Name.json"

function Clear-AirimateLeftovers {
  param([int]$Self)
  # 只杀**本工程路径**下的 electron（命令行里带 新工程 + electron\dist）
  $targets = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*新工程*' -and $_.ProcessId -ne $Self })
  foreach ($p in $targets) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  # 孤儿互斥体持有者：父进程已死才算孤儿（绝不误杀活着的实例）
  $keepers = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*MutexKeeper*' -and $_.ProcessId -ne $Self })
  foreach ($p in $keepers) {
    $alive = $false
    try { $null = Get-Process -Id $p.ParentProcessId -ErrorAction Stop; $alive = $true } catch { $alive = $false }
    if (-not $alive) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  $lock = Join-Path $env:APPDATA 'AiriMateOne\run\instance.lock'
  if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue }
  return $targets.Count
}

if (-not $SkipCleanupBefore) {
  $n = Clear-AirimateLeftovers -Self $PID
  if ($n -gt 0) { Write-Output "[run-probe] 清理了 $n 个遗留实例" }
}
if (Test-Path $out) { Remove-Item $out -Force }

Write-Output "[run-probe] 启动 $Name（mode=$Mode，超时 ${TimeoutSec}s）"
<#
  ⚠ **不要加 `-WindowStyle Hidden`**。
  `STARTUPINFO.wShowWindow = SW_HIDE` 会让 Windows 把进程创建的**第一个窗口**也隐藏，
  于是 `BrowserWindow.isVisible()` 恒为 false —— 实测把 `petmode` 探针的
  "全程只有 1 个可见窗口"判据打成失败（三个采样点 visibleWindows 都是 0），
  而窗口/渲染其实完全正常。这是**测量工具的假失败**，必须消除。
#>
<#
  ⚠ 参数必须**拼成一个字符串**交给 `Start-Process`（实测踩到，代价是几轮白跑）。

  `Start-Process -ArgumentList @('--dev', '--no-proactive')` 会把每个元素**再解析一次**，
  结果 `--no-proactive` 变成 `-no-proactive`（少一个连字符）：
    · PowerShell 认为 `-no` 是参数前缀，于是 `--x` → `-x`；
    · 应用侧的启动参数白名单校验随即报"无法识别的启动参数"并**直接退出**，
      探针一个字节都不产出 —— 表现是"探针跑了但 JSON 不存在"，极难归因。
  拼成单个字符串时 PowerShell 把它整串交给 CreateProcess，不再逐元素解析。
  需要引号的地方（路径带空格）在这里手工加，与原来 `"`"…`""` 的写法等价。
#>
$argList = @(
  "`"$appDir`"", '--dev', "--mode=$Mode", '--no-dialogs', '--probe', $Name, '--probe-out', "`"$out`"", '--probe-exit'
)
if ($ExtraArgs.Count -gt 0) { $argList += $ExtraArgs }
$argLine = ($argList -join ' ')
$proc = Start-Process -FilePath $electron -PassThru -ArgumentList $argLine
$exited = $proc.WaitForExit($TimeoutSec * 1000)
if (-not $exited) {
  Write-Output "[run-probe] 超时（${TimeoutSec}s）→ 强制结束"
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}
$null = Clear-AirimateLeftovers -Self $PID

if (-not (Test-Path $out)) {
  Write-Output "[run-probe] ✗ 未生成 JSON：$out"
  exit 2
}
$json = Get-Content $out -Raw | ConvertFrom-Json
$passField = $null
foreach ($f in @('pass', 'allPass')) { if ($null -ne $json.$f) { $passField = $json.$f; break } }
Write-Output ("[run-probe] {0} pass={1} error={2}" -f $Name, $passField, $json.error)
Write-Output "[run-probe] JSON: $out"
exit 0
