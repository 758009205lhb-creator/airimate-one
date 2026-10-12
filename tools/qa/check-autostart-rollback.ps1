<#
  tools/qa/check-autostart-rollback.ps1 —— A19「回滚路径」真实演练

  为什么必须单做一个脚本：
    回滚（`restoreLegacyAutostart`）是**只在卸载时跑一次**的代码路径，
    平时永远不会被执行到，所以它的缺陷只会在"用户真的要卸载"那一刻暴露 —— 那时已经无法挽回。
    单测只覆盖了纯函数 `planRestoreFromBackup()`，**覆盖不到真正写注册表的那几行**。

  为什么不需要管理员、也不会碰到用户真实启动项：
    演练把注册表位置改到一个**沙箱键**
    `HKCU\Software\AiriMateOneQA\Run`（由 `AIRIMATE_AUTOSTART_RUNKEY` 覆盖）。
    `autostart.ts` 的 `resolveRunKey()` 会机械校验覆盖值**必须以 HKCU 开头**且不含 `..`，
    非法值会被忽略并告警（绝不静默回退到真键）。用户真实的 `Run` 键**不被触碰**。

  演练步骤（每一步都留证据）：
    ① 沙箱键里造 3 个"旧项"：MateEngineX、airi-brain、AI女友
    ② `--mutate` 打开自启 ⇒ 期望：旧项被备份后移除、只留 AiriOne
    ③ 只读盘点 ⇒ 期望：ownEntryCount=1、legacyEntryCount=0
    ④ 关掉自启（`setAutoStart(false)`）⇒ 期望：AiriOne 消失
    ⑤ 从备份回滚 ⇒ 期望：3 个旧项**全部原样恢复**、AiriOne 不回来
    ⑥ 清理沙箱键

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\check-autostart-rollback.ps1
#>
[CmdletBinding()]
param(
  [string]$OutDir = 'docs\evidence\phase7',
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Root)) {
  $Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}

$outFull = Join-Path $Root $OutDir
New-Item -ItemType Directory -Force -Path $outFull | Out-Null

<#
  预检：必须在**没有其它实例运行**时才能跑探针。
  为什么：三层单实例保护会让第二个实例**主动退出并聚焦已有窗口**（这是正确行为），
  但探针就永远不会执行，表现为"证据文件没写出来"，看起来像崩溃 ——
  会把"环境没清干净"误报成"代码有 bug"。所以这里先查清楚并给出可操作的提示。
#>
$running = @(Get-Process electron -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
  $cases = $running | ForEach-Object {
    $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine
    "  PID $($_.Id) $(if ($cl) { $cl.Substring(0, [Math]::Min(140, $cl.Length)) } else { '(无命令行)' })"
  }
  Write-Host "检测到 $($running.Count) 个 electron 进程正在运行：" -ForegroundColor Yellow
  $cases | ForEach-Object { Write-Host $_ }
  throw @"
无法开始演练：已有实例在运行（单实例保护会让本次启动直接退出并聚焦旧窗口）。
请先结束它们，例如：
  Get-Process electron | Stop-Process -Force
  Remove-Item "`$env:APPDATA\AiriMateOne\run\instance.lock" -Force
注意：`MateEngineX` / `airi` / `airi-host` 属于**旧方案**，不要动它们（归属未证明前不得结束其进程）。
"@
}

$electron = Join-Path $Root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) { throw "找不到 electron：$electron" }

$SandboxPs = 'HKCU:\Software\AiriMateOneQA\Run'
$SandboxWin = 'HKCU\Software\AiriMateOneQA\Run'
$env:AIRIMATE_AUTOSTART_RUNKEY = $SandboxWin

function Get-SandboxValues {
  if (-not (Test-Path $SandboxPs)) { return @{} }
  $item = Get-ItemProperty -Path $SandboxPs -ErrorAction SilentlyContinue
  if ($null -eq $item) { return @{} }
  $out = @{}
  foreach ($p in $item.PSObject.Properties) {
    if ($p.Name -like 'PS*') { continue }
    $out[$p.Name] = [string]$p.Value
  }
  return $out
}

function Invoke-Probe {
  param([string]$Name, [string[]]$Extra)
  $outFile = Join-Path $outFull "A19-rollback-$Name.json"
  $errFile = Join-Path $outFull "A19-rollback-$Name.stderr.log"
  foreach ($f in @($outFile, $errFile)) { if (Test-Path $f) { Remove-Item $f -Force } }

  $argv = @('apps\desktop', '--dev', '--mode=panel', '--no-dialogs',
            '--probe', 'a19', '--probe-out', $outFile, '--probe-exit') + $Extra
  Write-Host "[qa] $Name ..." -ForegroundColor Cyan

  # 见 check-memory-restart.ps1 的注释：electron 日志走 stderr，
  # 在 ErrorActionPreference=Stop 下会把原生命令的 stderr 当终止性错误 ⇒ 临时降级。
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $electron @argv 2> $errFile | Out-Null } finally { $ErrorActionPreference = $prev }

  if (-not (Test-Path $outFile)) {
    $err = if (Test-Path $errFile) { Get-Content $errFile -Raw } else { '(无 stderr)' }
    throw "探针 $Name 未写出证据文件：$outFile`n--- stderr ---`n$err"
  }
  return [pscustomobject]@{ Name = $Name; Path = $outFile; Data = (Get-Content $outFile -Raw | ConvertFrom-Json) }
}

$steps = [ordered]@{}
$failures = New-Object System.Collections.Generic.List[string]

try {
  # ① 造沙箱"旧项"（模拟迁移前的现状）
  if (-not (Test-Path $SandboxPs)) { New-Item -Path $SandboxPs -Force | Out-Null }
  New-ItemProperty -Path $SandboxPs -Name 'MateEngineX'   -Value '"C:\Mate\MateEngineX.exe"'            -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $SandboxPs -Name 'airi-brain'    -Value 'node C:\old\start-airi-brain.mjs'      -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $SandboxPs -Name 'AI女友'         -Value '"C:\old\build\pet\app.exe"'           -PropertyType String -Force | Out-Null
  $seed = Get-SandboxValues
  $steps['01-seed'] = $seed
  Write-Host "  沙箱键已就绪：$($seed.Keys -join ', ')"

  # ② 只读审计（迁移前）—— 期望识别出 3 个旧项
  $before = Invoke-Probe -Name '1-audit-before' -Extra @()
  $steps['02-auditBefore'] = $before.Data
  if ($before.Data.legacyEntryCount -ne 3) { $failures.Add("迁移前应识别 3 个旧项，实测 $($before.Data.legacyEntryCount)") }

  # ③ 真实打开自启 ⇒ 备份 + 迁移旧项 + 写 AiriOne
  $set = Invoke-Probe -Name '2-set-enabled' -Extra @('--mutate')
  $afterSet = Get-SandboxValues
  $steps['03-afterEnable'] = $afterSet
  Write-Host "  启用后沙箱键内容：$($afterSet.Keys -join ', ')"
  if (-not $afterSet.ContainsKey('AiriOne')) { $failures.Add('启用后应存在 AiriOne 值') }
  foreach ($legacyName in @('MateEngineX', 'airi-brain', 'AI女友')) {
    if ($afterSet.ContainsKey($legacyName)) { $failures.Add("启用后旧项 '$legacyName' 应已被移除") }
  }

  # ④ 找备份目录
  $migrationDir = Join-Path $env:APPDATA 'AiriMateOne\migration'
  $backup = Get-ChildItem $migrationDir -Directory -Filter 'backup-*' -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $backup) { throw "没有找到备份目录：$migrationDir\backup-*" }
  $beforeFile = Join-Path $backup.FullName 'autostart-before.json'
  $steps['04-backupDir'] = $backup.FullName
  $steps['05-backupExists'] = @{
    beforeJson = (Test-Path $beforeFile)
    regExport  = (Test-Path (Join-Path $backup.FullName 'hkcu-run.reg'))
    manifest   = (Test-Path (Join-Path $backup.FullName 'migration-manifest.json'))
  }
  Write-Host "  备份目录：$($backup.FullName)"
  if (-not (Test-Path $beforeFile)) { $failures.Add('备份目录缺少 autostart-before.json') }

  # ⑤ 先关掉自启（模拟卸载流程的第一步）
  # ⚠ 方向必须显式传：探针默认 `on`，早先写死了 `setAutoStart(true)`，
  #   于是这一步实际上又打开了一次 ⇒ "关闭后 AiriOne 应已移除"假失败（实测踩到）。
  $off = Invoke-Probe -Name '3-set-disabled' -Extra @('--mutate', '--autostart-value', 'off')
  $afterOff = Get-SandboxValues
  $steps['06-afterDisable'] = $afterOff
  Write-Host "  关闭后沙箱键内容：$(if ($afterOff.Keys.Count) { $afterOff.Keys -join ', ' } else { '(空)' })"
  if ($afterOff.ContainsKey('AiriOne')) { $failures.Add('关闭自启后 AiriOne 应已移除') }

  # ⑥ **真实回滚**：走应用的 `--restore-legacy <备份目录>` 入口
  #    为什么必须走这个入口而不是调内部函数：卸载器能用的只有这个入口。
  #    只调内部函数等于"证明了函数对，没证明用户够得着" —— 而 autostart.ts 的文件头
  #    一度承诺了 `--restore-legacy`，CLI 里却**根本没有实现**（本轮补上）。
  #
  #    ⚠ 结果**从文件读**，不读控制台：实测 `--restore-legacy` 这条路径下 Electron
  #      会把 stdio 从父 shell 摘掉（重定向文件 0 字节、`$LASTEXITCODE` 为空），
  #      而回滚其实成功了。卸载器依赖"读控制台输出"会拿到一片空白。
  $resultFile = Join-Path $outFull 'A19-rollback-4-restore-result.json'
  $errFile2 = Join-Path $outFull 'A19-rollback-4-restore.stderr.log'
  foreach ($f in @($resultFile, $errFile2)) { if (Test-Path $f) { Remove-Item $f -Force } }
  $prevEap2 = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $electron apps\desktop --restore-legacy $backup.FullName --restore-legacy-out $resultFile 2> $errFile2 | Out-Null
  } finally {
    $ErrorActionPreference = $prevEap2
  }
  Write-Host "  回滚入口：--restore-legacy"
  if (Test-Path $resultFile) {
    $restoreResult = Get-Content $resultFile -Raw | ConvertFrom-Json
    Write-Host "  回滚结果文件：ok=$($restoreResult.ok) detail=$($restoreResult.detail)"
    $steps['07a-restoreViaCli'] = $restoreResult
    if ($restoreResult.ok -ne $true) { $failures.Add("回滚结果文件报告 ok=false：$($restoreResult.detail)") }
  } else {
    $steps['07a-restoreViaCli'] = @{ resultFileMissing = $true; backupDir = $backup.FullName }
    $failures.Add("--restore-legacy 未写出结果文件：$resultFile")
  }

  $afterRestore = Get-SandboxValues
  $steps['08-afterRestore'] = $afterRestore
  Write-Host "  回滚后沙箱键内容：$(if ($afterRestore.Keys.Count) { $afterRestore.Keys -join ', ' } else { '(空)' })"

  foreach ($legacyName in @('MateEngineX', 'airi-brain', 'AI女友')) {
    if (-not $afterRestore.ContainsKey($legacyName)) { $failures.Add("回滚后旧项 '$legacyName' 应已恢复") }
  }
  if ($afterRestore.ContainsKey('AiriOne')) { $failures.Add('回滚后 AiriOne 不应存在（卸载后不得仍自启）') }

  $result = [ordered]@{
    schema        = 'airimate/autostart-rollback-evidence/1'
    at            = (Get-Date).ToString('o')
    sandboxKey    = $SandboxWin
    realKeyTouched = $false
    steps         = $steps
    failures      = @($failures)
    pass          = ($failures.Count -eq 0)
  }
} catch {
  $result = [ordered]@{
    schema = 'airimate/autostart-rollback-evidence/1'
    at     = (Get-Date).ToString('o')
    error  = $_.Exception.Message
    steps  = $steps
    pass   = $false
  }
} finally {
  # 清理沙箱键（无论成败）
  Remove-Item -Path $SandboxPs -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -Path 'HKCU:\Software\AiriMateOneQA' -Recurse -Force -ErrorAction SilentlyContinue
}

$summary = Join-Path $outFull 'A19-rollback-summary.json'
# ⚠ 无 BOM 的 UTF-8（`Set-Content -Encoding UTF8` 在 PS 5.1 下总是写 BOM ⇒ `JSON.parse` 抛错）
[System.IO.File]::WriteAllText($summary, ($result | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
if ($result.pass) {
  Write-Host "A19 回滚演练：PASS" -ForegroundColor Green
  Write-Host "证据：$summary"
  exit 0
} else {
  Write-Host "A19 回滚演练：FAIL" -ForegroundColor Red
  if ($result.failures) { $result.failures | ForEach-Object { Write-Host "  ✗ $_" -ForegroundColor Red } }
  if ($result.error) { Write-Host "  错误：$($result.error)" -ForegroundColor Red }
  Write-Host "证据：$summary"
  exit 1
}
