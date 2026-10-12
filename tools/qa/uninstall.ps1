<#
 tools/qa/uninstall.ps1 —— 按用户卸载（**无需管理员**）

 前置条件（**会检查，不假设**）：
   安装目录里存在 `install-manifest.json`（由 `install.ps1` 写入）。
   没有它就拒绝卸载 —— "照着猜测删文件"是卸载器最常见的事故来源。

 卸载动作（每一步都可逆或有记录）：
   ① 读安装清单（确认这确实是本应用的安装目录）
   ② **先**关自启项（走应用自己的 `--probe a19 --mutate --autostart-value off`）
      —— 顺序很重要：先把"开机自启"摘掉，再删程序。反过来会留下一个指向不存在文件的启动项
   ③ 删快捷方式（启动菜单 + 桌面，按清单里记录的**确切路径**，不靠猜）
   ④ 处理旧自启回滚：若 `%APPDATA%\AiriMateOne\migration\` 下有备份，则调用应用的
      `--restore-legacy`（**这是安装时被迁移掉的旧启动项**，必须还原）
   ⑤ 复制安装目录到日志文件后删除目录
   ⑥ 用户数据（`%APPDATA%\AiriMateOne`）**默认保留** —— 里面是设置、记忆、密钥
      （记忆与密钥是用户资产，不能因为"卸载程序"就抹掉）。要删必须显式 `-PurgeUserData`

 用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\uninstall.ps1
    powershell ... -File tools\qa\uninstall.ps1 -InstallDir D:\x -DryRun
    powershell ... -File tools\qa\uninstall.ps1 -PurgeUserData      # 连用户数据一起删（不可恢复）
    powershell ... -File tools\qa\uninstall.ps1 -KeepShortcuts

 退出码：0 = 成功；1 = 有步骤失败（**不静默成功**）
#>
[CmdletBinding()]
param(
  [string]$InstallDir = '',
  [string]$Root = '',
  [switch]$PurgeUserData,
  [switch]$KeepShortcuts,
  <#
    `-SkipLegacyRollback`：跳过"还原被迁移掉的旧启动项"这一步。
    该步骤要调用应用的 `--restore-legacy`，而三层单实例保护要求**独占**启动应用；
    当另一个实例正在跑时（例如浸泡测试）会拿不到实例。跳过它之后，
    卸载的**文件系统侧**（先关自启=跳过、删快捷方式、删目录、保留用户数据）仍可完整演练。
  #>
  [switch]$SkipLegacyRollback,
  [switch]$DryRun,
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Root)) { $Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
if ([string]::IsNullOrWhiteSpace($InstallDir)) { $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\AiriMateOne' }

$steps = [ordered]@{}
$failures = New-Object System.Collections.Generic.List[string]
function Note([string]$n, $v) { $steps[$n] = $v }
function Fail([string]$m) { $failures.Add($m); Write-Host "  x $m" -ForegroundColor Red }

Write-Host "AiriMate One 卸载程序$(if ($DryRun) { '（干跑：不落盘）' })" -ForegroundColor Cyan
Write-Host "  安装目录 : $InstallDir"
Write-Host ''

# ── ① 安装清单
$manifestPath = Join-Path $InstallDir 'install-manifest.json'
$manifest = $null
if (-not (Test-Path -LiteralPath $InstallDir)) {
  Fail "安装目录不存在：$InstallDir（没有可卸载的内容）"
}
elseif (-not (Test-Path -LiteralPath $manifestPath)) {
  # 拒绝猜测：没有清单就不动它
  Fail "安装目录里没有 install-manifest.json：$InstallDir`n     拒绝继续 —— 照着猜测删文件是卸载器最常见的事故来源。"
}
else {
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  Note 'manifest' @{ path = $manifestPath; schema = $manifest.schema; installedAt = $manifest.installedAt; exePath = $manifest.exePath }
  Write-Host "  [1/6] 安装清单：schema=$($manifest.schema) installedAt=$($manifest.installedAt)"
}

# ── 需要应用本体来执行①③（自启与回滚都走它自己的入口）
$appExe = if ($manifest) { $manifest.exePath } else { '' }
$mainJs = Join-Path $InstallDir 'app\main\index.js'

function Invoke-App([string[]]$AppArgs) {
  <#
    调用已安装的应用。优先用它自己的 AiriMateOne.exe；没有就退回开发树的 electron.exe
    并显式把 app 目录指到安装目录 —— 两种方式都作用于**同一个安装目录**，
    所以演练与真实卸载走的是同一条逻辑路径。
  #>
  if ($appExe -and (Test-Path -LiteralPath $appExe)) {
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { & $appExe @AppArgs 2>&1 | Out-Null } finally { $ErrorActionPreference = $prev }
    return
  }
  $devElectron = Join-Path $Root 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path -LiteralPath $devElectron)) { throw "找不到可执行文件：$appExe 与 $devElectron 都不存在" }
  $appDir = Join-Path $InstallDir 'app'
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & $devElectron $appDir @AppArgs 2>&1 | Out-Null } finally { $ErrorActionPreference = $prev }
}

# ── ② 先关自启项（顺序关键）
if ($SkipLegacyRollback) {
  Note 'autostart' @{ skipped = $true; why = '-SkipLegacyRollback：需要独占启动应用' }
  Write-Host '  [2/6] 自启项：已按 -SkipLegacyRollback 跳过（需独占实例）'
}
elseif ($manifest) {
  if ($DryRun) {
    Note 'autostart' @{ dryRun = $true; wouldRemove = 'HKCU\...\Run\AiriOne' }
    Write-Host '  [2/6] 自启项：将移除 HKCU\...\Run\AiriOne（干跑）'
  }
  else {
    $probeOut = Join-Path $env:TEMP 'airimate-uninstall-autostart.json'
    if (Test-Path -LiteralPath $probeOut) { Remove-Item -LiteralPath $probeOut -Force }
    try {
      Invoke-App @('--probe', 'a19', '--mutate', '--autostart-value', 'off', '--probe-out', $probeOut, '--probe-exit')
      if (Test-Path -LiteralPath $probeOut) {
        $a = Get-Content -LiteralPath $probeOut -Raw | ConvertFrom-Json
        Note 'autostart' @{ ownEntryCount = $a.ownEntryCount; legacyEntryCount = $a.legacyEntryCount; mutation = $a.mutation }
        if ($a.ownEntryCount -ne 0) { Fail "关闭自启后 ownEntryCount=$($a.ownEntryCount)（应为 0）" }
        Write-Host "  [2/6] 自启项：ownEntryCount=$($a.ownEntryCount) legacyEntryCount=$($a.legacyEntryCount)"
      }
      else { Fail "自启探针没有写出结果：$probeOut" }
    }
    catch { Fail "关闭自启失败：$($_.Exception.Message)" }
  }
}

# ── ③ 快捷方式（按清单里的确切路径）
$shortcutScript = Join-Path $Root 'tools\qa\shortcut.ps1'
if ($manifest -and -not $KeepShortcuts) {
  $linkValues = @()
  if ($manifest.links) {
    foreach ($p in $manifest.links.PSObject.Properties) { $linkValues += [string]$p.Value }
  }
  # 补上默认位置（即使清单里没有也尝试一次，因为安装时可能被 -NoDesktopShortcut 跳过）
  $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\AiriMate One.lnk'
  if ($linkValues -notcontains $startMenu) { $linkValues += $startMenu }
  $desktop = [Environment]::GetFolderPath('Desktop')
  if ($desktop) {
    $dl = Join-Path $desktop 'AiriMate One.lnk'
    if ($linkValues -notcontains $dl) { $linkValues += $dl }
  }
  $results = @()
  foreach ($lnk in ($linkValues | Select-Object -Unique)) {
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $shortcutScript, '-Action', 'remove', '-Path', $lnk)
    if ($DryRun) { $a += '-DryRun' }
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $out = & powershell.exe @a 2>&1 } finally { $ErrorActionPreference = $prev }
    $ok = $LASTEXITCODE -eq 0
    $results += @{ path = $lnk; ok = $ok; existedBefore = ($out | Out-String) -match '"existedBefore":true' }
    if (-not $ok -and -not $DryRun) { Fail "删除快捷方式失败：$lnk" }
  }
  Note 'shortcuts' @{ results = $results }
  <#
    ⚠ `Where-Object` 只匹配到**一项**时返回的是**单个对象、不是数组**，
    于是 `.Count` 在 PowerShell 5.1 上会去读那个对象自己的 `Count` 属性；
    `PSCustomObject` 没有该属性 ⇒ 得到 `$null`，字符串拼接后就显示成别的数字。
    实测：安装时确实只存在 **1** 个快捷方式，却打印成"实际存在 3 个" ——
    看起来像卸载器漏删了两个，实际是**纯统计口径的假象**。
    修法：一律用 `@(...)` 强制成数组再取 `.Count`。
  #>
  $checkedCount = @($results).Count
  $existed = @($results | Where-Object { $_.existedBefore }).Count
  $failedRemovals = @($results | Where-Object { -not $_.ok }).Count
  Write-Host "  [3/6] 快捷方式：检查 $checkedCount 个（安装时确实存在 $existed 个），处理失败 $failedRemovals 个"
}
elseif ($KeepShortcuts) { Write-Host '  [3/6] 快捷方式：已按 -KeepShortcuts 跳过' }

# ── ④ 旧自启回滚（安装时被迁移掉的旧启动项必须还原）
$migrationDir = Join-Path $env:APPDATA 'AiriMateOne\migration'
if ($SkipLegacyRollback) {
  Note 'legacyRollback' @{ skipped = $true; why = '-SkipLegacyRollback：需要独占启动应用' }
  Write-Host '  [4/6] 旧自启回滚：已按 -SkipLegacyRollback 跳过（需独占实例）'
}
elseif ($manifest) {
  $backups = @(Get-ChildItem -LiteralPath $migrationDir -Directory -Filter 'backup-*' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending)
  if ($backups.Count -eq 0) {
    Note 'legacyRollback' @{ backups = 0; skipped = $true; reason = '没有备份目录（安装时没有旧启动项被迁移）' }
    Write-Host '  [4/6] 旧自启回滚：无备份，跳过'
  }
  elseif ($DryRun) {
    Note 'legacyRollback' @{ dryRun = $true; backup = $backups[0].FullName }
    Write-Host "  [4/6] 旧自启回滚：将从 $($backups[0].Name) 还原（干跑）"
  }
  else {
    $resultFile = Join-Path $env:TEMP 'airimate-uninstall-restore.json'
    if (Test-Path -LiteralPath $resultFile) { Remove-Item -LiteralPath $resultFile -Force }
    try {
      Invoke-App @('--restore-legacy', $backups[0].FullName, '--restore-legacy-out', $resultFile)
      if (Test-Path -LiteralPath $resultFile) {
        $r = Get-Content -LiteralPath $resultFile -Raw | ConvertFrom-Json
        Note 'legacyRollback' @{ backup = $backups[0].FullName; ok = $r.ok; detail = $r.detail; plan = $r.plan }
        if ($r.ok -ne $true) { Fail "旧自启回滚报告 ok=false：$($r.detail)" }
        Write-Host "  [4/6] 旧自启回滚：ok=$($r.ok)  $($r.detail)"
      }
      else { Fail "回滚没有写出结果文件：$resultFile" }
    }
    catch { Fail "旧自启回滚失败：$($_.Exception.Message)" }
  }
}

# ── ⑤ 删除安装目录（先留一份文件清单到日志，便于事后审计）
if ($manifest) {
  $listing = @(Get-ChildItem -LiteralPath $InstallDir -Recurse -File -ErrorAction SilentlyContinue |
    ForEach-Object { $_.FullName.Substring($InstallDir.Length).TrimStart('\') })
  Note 'installDir' @{ path = $InstallDir; fileCount = $listing.Count; sample = @($listing | Select-Object -First 30) }
  if ($DryRun) {
    Write-Host "  [5/6] 删除安装目录：将删除 $($listing.Count) 个文件（干跑）"
  }
  else {
    try {
      Remove-Item -LiteralPath $InstallDir -Recurse -Force
      $gone = -not (Test-Path -LiteralPath $InstallDir)
      Note 'installDirRemoved' $gone
      if (-not $gone) { Fail "安装目录仍然存在：$InstallDir" }
      Write-Host "  [5/6] 删除安装目录：$($listing.Count) 个文件，已删除=$gone"
    }
    catch { Fail "删除安装目录失败：$($_.Exception.Message)" }
  }
}

# ── ⑥ 用户数据（默认保留）
$userData = Join-Path $env:APPDATA 'AiriMateOne'
$userDataExists = Test-Path -LiteralPath $userData
if ($PurgeUserData) {
  if ($DryRun) {
    Note 'userData' @{ dryRun = $true; path = $userData; purge = $true }
    Write-Host "  [6/6] 用户数据：将删除 $userData（干跑；不可恢复）"
  }
  else {
    try {
      if ($userDataExists) { Remove-Item -LiteralPath $userData -Recurse -Force }
      Note 'userData' @{ path = $userData; purged = $true; gone = -not (Test-Path -LiteralPath $userData) }
      Write-Host "  [6/6] 用户数据：已删除 $userData"
    }
    catch { Fail "删除用户数据失败：$($_.Exception.Message)" }
  }
}
else {
  Note 'userData' @{ path = $userData; purged = $false; kept = $userDataExists; why = '设置/记忆/密钥是用户资产，卸载程序不代为删除' }
  Write-Host "  [6/6] 用户数据：保留 $userData（含设置/记忆/密钥；要删请加 -PurgeUserData）"
}

$result = [ordered]@{
  schema = 'airimate/uninstall-evidence/1'
  at = (Get-Date).ToString('o')
  dryRun = [bool]$DryRun
  installDir = $InstallDir
  purgeUserData = [bool]$PurgeUserData
  steps = $steps
  failures = @($failures)
  pass = ($failures.Count -eq 0)
}
if ($OutFile) {
  $json = $result | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($OutFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

Write-Host ''
if ($result.pass) {
  Write-Host "卸载：PASS$(if ($DryRun) { '（干跑）' })" -ForegroundColor Green
  [Environment]::Exit(0)
}
else {
  Write-Host '卸载：FAIL' -ForegroundColor Red
  $failures | ForEach-Object { Write-Host "  x $_" -ForegroundColor Red }
  [Environment]::Exit(1)
}
