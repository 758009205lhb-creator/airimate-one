<#
  tools/qa/check-memory-restart.ps1 —— A24 跨进程持久化验收

  为什么需要这个脚本而不是手工敲两条命令：
    "重启后还记得"这个判据的**唯一有效证据**是**两个不同进程**的 bootId 对照。
    手工跑很容易变成"同一个进程跑两遍"，看起来通过、其实什么都没证明。
    脚本强制三趟、三份独立 JSON，并把两趟的 bootId 一起打出来做人工复核。

  三趟：
    ① --probe memory-restart           写入标记记忆（期望 pass=true）
    ② --probe memory-restart           只读：必须读到上一趟的标记（期望 pass=true）
    ③ --probe memory-restart --cleanup 清场（期望 existingMarkerCount=0 且 pass=true）

  用法（本机没有 pwsh，只有 Windows PowerShell 5.1 —— 这是实测环境事实）：
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\check-memory-restart.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\check-memory-restart.ps1 -OutDir docs\evidence\phase2
#>
[CmdletBinding()]
param(
  [string]$OutDir = 'docs\evidence\phase2',
  # ⚠ $PSScriptRoot 在 param 默认值里**求值时机不可靠**（PowerShell 5.1 实测为空串），
  #   所以这里默认留空，进函数体后再解析。
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Root)) {
  $Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
}

$electron = Join-Path $Root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) { throw "找不到 electron：$electron" }

$outFull = Join-Path $Root $OutDir
New-Item -ItemType Directory -Force -Path $outFull | Out-Null

<#
  预检：探针需要**独占**应用实例。
  三层单实例保护会让第二个实例主动退出并聚焦已有窗口（正确行为），
  但那样探针就不会执行、证据文件不会写出 —— 看起来像崩溃，
  实际是"环境没清干净"。这里先查清楚，避免把环境问题误报成代码缺陷。
#>
$running = @(Get-Process electron -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
  Write-Host "检测到 $($running.Count) 个 electron 进程正在运行：" -ForegroundColor Yellow
  $running | ForEach-Object {
    $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine
    Write-Host "  PID $($_.Id) $(if ($cl) { $cl.Substring(0, [Math]::Min(140, $cl.Length)) } else { '(无命令行)' })"
  }
  throw @"
无法开始验收：已有实例在运行（单实例保护会让本次启动直接退出并聚焦旧窗口）。
请先结束它们，例如：
  Get-Process electron | Stop-Process -Force
  Remove-Item "`$env:APPDATA\AiriMateOne\run\instance.lock" -Force
注意：`MateEngineX` / `airi` / `airi-host` 属于**旧方案**，不要动它们。
"@
}

function Invoke-Probe {
  param([string]$Name, [string[]]$ExtraArgs)
  $outFile = Join-Path $outFull "A24-restart-$Name.json"
  $errFile = Join-Path $outFull "A24-restart-$Name.stderr.log"
  # 清掉旧证据：否则"文件存在"不能证明是本趟生成的
  foreach ($f in @($outFile, $errFile)) { if (Test-Path $f) { Remove-Item $f -Force } }

  $args = @('apps\desktop', '--dev', '--mode=panel', '--no-dialogs',
            '--probe', 'memory-restart', '--probe-out', $outFile, '--probe-exit') + $ExtraArgs
  Write-Host "[qa] 运行探针 $Name ..." -ForegroundColor Cyan

  <#
    ⚠ 踩过的两个坑（都实测发生过，写在这里避免下次重犯）：
      ① `& $electron @args 2>&1 | ...`：electron 的应用日志走 **stderr**，在
         `$ErrorActionPreference='Stop'` 下 PowerShell 5.1 把原生命令的 stderr 当成
         **终止性错误**（`NativeCommandError`），脚本当场中断，探针根本没跑完；
      ② `Start-Process -RedirectStandardError`：本机环境同时存在 `NO_PROXY` 与 `no_proxy`
         两个变量，5.1 的 Start-Process 在构造环境块时抛
         `Key in dictionary: 'NO_PROXY'`（已知 bug），直接起不来。
    结论：用调用运算符 + PowerShell 原生文件重定向（`2>`），并把 ErrorActionPreference
    临时设为 Continue —— 只影响这一次调用，且退出码单独记录，判定只认 JSON。
  #>
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $electron @args 2> $errFile | Out-Null
    $exit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevEap
  }

  if (-not (Test-Path $outFile)) {
    $err = if (Test-Path $errFile) { (Get-Content $errFile -Raw) } else { '(无 stderr)' }
    throw "探针 $Name 没有写出证据文件：$outFile（exit=$exit）`n--- stderr ---`n$err"
  }
  $json = Get-Content $outFile -Raw | ConvertFrom-Json
  # 证据文件必须"新鲜"：否则测的是上一次运行的残留
  $age = (Get-Date) - (Get-Item $outFile).LastWriteTime
  if ($age.TotalSeconds -gt 120) { throw "证据文件不是本次生成的（$([int]$age.TotalSeconds)s 前）—— 不能当作本次证据" }
  Write-Host ("  写入 id={0} pass={1} exitCode={2}" -f $json.written.id, $json.pass, $exit)
  return [pscustomobject]@{ Name = $Name; Path = $outFile; Data = $json; ExitCode = $exit }
}

$write = Invoke-Probe -Name '1-write' -ExtraArgs @()
$read  = Invoke-Probe -Name '2-read'  -ExtraArgs @()
$clean = Invoke-Probe -Name '3-cleanup' -ExtraArgs @('--cleanup')

$bootWrite = $write.Data.bootId
$bootRead  = $read.Data.bootId

$results = [ordered]@{
  schema        = 'airimate/memory-restart-evidence/1'
  at            = (Get-Date).ToString('o')
  writePass     = [bool]$write.Data.pass
  readPass      = [bool]$read.Data.pass
  cleanupPass   = [bool]$clean.Data.pass
  bootIdWrite   = $bootWrite
  bootIdRead    = $bootRead
  distinctBoots = ($bootWrite -ne $bootRead) -and ($null -ne $bootWrite) -and ($null -ne $bootRead)
  writtenId     = $write.Data.written.id
  readBackId    = $read.Data.existingMarker.id
  readBackText  = $read.Data.existingMarker.text
  diskWrite     = $write.Data.disk
  markerCountAtRead = $read.Data.existingMarkerCount
  markerCountAfterCleanup = $clean.Data.cleanup.remainingMarkers
  cleanupRemoved = $clean.Data.cleanup.removed
  evidenceFiles = @(
    (Resolve-Path $write.Path).Path
    (Resolve-Path $read.Path).Path
    (Resolve-Path $clean.Path).Path
  )
}

# 判定：三趟都 pass，且**两个进程确实是不同的实例**（bootId 不同），且读回的 id 就是写入的 id
$results.pass = $results.writePass -and $results.readPass -and $results.cleanupPass `
  -and $results.distinctBoots -and ($results.writtenId -eq $results.readBackId) `
  -and ($results.markerCountAfterCleanup -eq 0)

$summary = Join-Path $outFull 'A24-restart-summary.json'
# ⚠ 无 BOM 的 UTF-8（`Set-Content -Encoding UTF8` 在 PS 5.1 下总是写 BOM ⇒ `JSON.parse` 抛错）
[System.IO.File]::WriteAllText($summary, ($results | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
Write-Host "bootId(写) = $bootWrite"
Write-Host "bootId(读) = $bootRead"
Write-Host "写入 id    = $($results.writtenId)"
Write-Host "读回 id    = $($results.readBackId)"
Write-Host "读回正文   = $($results.readBackText)"
Write-Host "清场后残留 = $($results.markerCountAfterCleanup)"
Write-Host ''
if ($results.pass) {
  Write-Host "A24 跨进程持久化：PASS" -ForegroundColor Green
  Write-Host "汇总证据：$summary"
  exit 0
} else {
  Write-Host "A24 跨进程持久化：FAIL" -ForegroundColor Red
  $results | ConvertTo-Json -Depth 8 | Write-Host
  Write-Host "汇总证据：$summary"
  exit 1
}
