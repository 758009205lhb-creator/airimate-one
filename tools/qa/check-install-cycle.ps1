<#
 tools/qa/check-install-cycle.ps1 —— A19「安装 → 卸载 → 重启」三时点链路演练

 为什么要三时点而不是"装完看一眼"：
   卸载类缺陷几乎都发生在**边界**上 ——
   · 卸载后自启项没删干净 ⇒ 下次开机启动一个不存在的程序（用户看到报错弹窗，而程序"已卸载"）；
   · 卸载时把用户数据一起删了 ⇒ "我记住的事"没了（记忆与密钥是用户资产）；
   · 安装时迁移掉的旧启动项没还原 ⇒ 用户的旧方案静默失去自启能力。
   这三种都**不会在"装完能用"里暴露**，只有把"重启"也当成一个时点才会显形。

 脚本做的事（每一步都留原始证据）：
   时点 1 安装前  ：记录注册表 Run 键与快捷方式现状（基线）
   时点 2 安装后  ：载荷校验 → 复制 → 自启项 → 快捷方式 → 安装清单
   时点 3 卸载后  ：先关自启 → 删快捷方式 → 旧自启回滚 → 删目录
   重启检查       ：**不需要真的重启电脑** —— 重启对启动项的影响可以等价地检验：
                    ① 自启项是否仍在注册表（在 ⇒ 会在开机时被执行）；
                    ② 它指向的文件是否还存在（不存在 ⇒ 会报错）。
                    本脚本按这两条判定，并在证据里写清"这是等价检验而非真实重启"。

 用法（会把程序装到临时目录，不动真实的 %LOCALAPPDATA%\Programs）：
   powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\check-install-cycle.ps1
   powershell ... -File tools\qa\check-install-cycle.ps1 -InstallDir D:\somewhere
 退出码：0 = PASS；1 = FAIL
#>
[CmdletBinding()]
param(
  [string]$InstallDir = '',
  [string]$OutDir = 'docs\evidence\phase7',
  [string]$Root = '',
  <#
    `-SkipAutostart`：跳过依赖"独占启动应用"的那两步（写自启项 / 旧自启回滚），
    只演练**文件系统侧**的安装与卸载（复制 → 快捷方式 → 安装清单 → 删除 → 用户数据保留）。

    为什么需要它（实际约束）：自启那两步要走应用自己的 CLI，而三层单实例保护要求
    **独占**启动应用。当另一个实例正在跑（例如 2 小时浸泡）时，整条演练会被预检挡住 ——
    于是"最容易出错的那部分（文件、快捷方式、清单）"反而一直得不到验证。
    跳过自启后这两步可以**并行**于浸泡完成，自启部分再用完整模式补一次。
  #>
  [switch]$SkipAutostart
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Root)) { $Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
if ([string]::IsNullOrWhiteSpace($InstallDir)) { $InstallDir = Join-Path $env:TEMP 'airimate-install-drill' }
$outFull = if ([System.IO.Path]::IsPathRooted($OutDir)) { $OutDir } else { Join-Path $Root $OutDir }
New-Item -ItemType Directory -Force -Path $outFull | Out-Null

$RUN_KEY = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$failures = New-Object System.Collections.Generic.List[string]
$steps = [ordered]@{}

function Fail([string]$m) { $failures.Add($m); Write-Host "  x $m" -ForegroundColor Red }
function RunValues {
  if (-not (Test-Path $RUN_KEY)) { return @{} }
  $item = Get-ItemProperty -Path $RUN_KEY -ErrorAction SilentlyContinue
  if ($null -eq $item) { return @{} }
  $o = @{}
  foreach ($p in $item.PSObject.Properties) { if ($p.Name -notlike 'PS*') { $o[$p.Name] = [string]$p.Value } }
  return $o
}
function LinkState([string]$p) { [bool](Test-Path -LiteralPath $p) }

# ── ⓪ 预检：写自启项 / 旧自启回滚都要**独占启动应用**（除非显式跳过）
$running = @(Get-Process electron -ErrorAction SilentlyContinue)
if ($running.Count -gt 0 -and -not $SkipAutostart) {
  Write-Host "检测到 $($running.Count) 个 electron 进程正在运行 —— 本演练需要独占启动应用。" -ForegroundColor Yellow
  Write-Host '两种选择：' -ForegroundColor Yellow
  Write-Host '  a) 先结束它们（不要动 MateEngineX / airi / airi-host，那属于旧方案）：' -ForegroundColor Yellow
  Write-Host '     Get-Process electron | Stop-Process -Force' -ForegroundColor Yellow
  Write-Host '     Remove-Item "$env:APPDATA\AiriMateOne\run\instance.lock" -Force' -ForegroundColor Yellow
  Write-Host '  b) 加 -SkipAutostart：只演练文件系统侧（复制/快捷方式/清单/删除/用户数据），' -ForegroundColor Yellow
  Write-Host '     自启那两步再用完整模式补。这样最容易出错的部分不必等实例空闲。' -ForegroundColor Yellow
  [Environment]::Exit(1)
}

$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\AiriMate One.lnk'
$desktop = [Environment]::GetFolderPath('Desktop')
$desktopLnk = if ($desktop) { Join-Path $desktop 'AiriMate One.lnk' } else { '' }

Write-Host '=== 时点 1：安装前基线 ===' -ForegroundColor Cyan
$before = @{ runValues = RunValues; startMenu = (LinkState $startMenu); desktop = if ($desktopLnk) { LinkState $desktopLnk } else { $null }; installDir = (Test-Path -LiteralPath $InstallDir) }
$steps['01-before'] = $before
Write-Host "  Run 键值数=$($before.runValues.Count)  AiriOne 存在=$($before.runValues.ContainsKey('AiriOne'))  安装目录存在=$($before.installDir)"
if ($before.installDir) { Fail "安装目录已存在，演练无法从干净状态开始：$InstallDir" }

Write-Host ''
Write-Host '=== 时点 2：安装 ===' -ForegroundColor Cyan
$installEvidence = Join-Path $outFull 'A19-install-2-installed.json'
$prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
try {
  $installArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Root 'tools\qa\install.ps1'),
    '-InstallDir', $InstallDir, '-NoDesktopShortcut', '-OutFile', $installEvidence)
  if ($SkipAutostart) { $installArgs += '-NoAutostart' }
  & powershell.exe @installArgs 2>&1 | ForEach-Object { Write-Host "  $_" }
} finally { $ErrorActionPreference = $prev }

$afterInstall = @{ runValues = RunValues; startMenu = (LinkState $startMenu); installDir = (Test-Path -LiteralPath $InstallDir) }
$steps['02-afterInstall'] = $afterInstall
if (-not $afterInstall.installDir) { Fail '安装后安装目录不存在' }
if ($SkipAutostart) {
  # 自启项本该**不存在**（我们没写它）—— 断言要跟着模式走，否则会自己把自己判失败
  $steps['02-autostartSkipped'] = @{ expected = '不存在（-SkipAutostart）'; actual = $afterInstall.runValues.ContainsKey('AiriOne') }
  if ($afterInstall.runValues.ContainsKey('AiriOne')) { Fail '-SkipAutostart 模式下不该出现自启项 AiriOne' }
}
elseif (-not $afterInstall.runValues.ContainsKey('AiriOne')) { Fail '安装后自启项 AiriOne 不存在' }
if (-not $afterInstall.startMenu) { Fail '安装后开始菜单快捷方式不存在' }
$manifestPath = Join-Path $InstallDir 'install-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { Fail '安装后没有 install-manifest.json' }
else { $steps['02-manifest'] = (Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json) }

# 装了哪些文件、有没有混入资产
if (Test-Path -LiteralPath $InstallDir) {
  $installed = @(Get-ChildItem -LiteralPath $InstallDir -Recurse -File)
  $assetExt = @('.vrm', '.vrma', '.anim')
  $assets = @($installed | Where-Object { $assetExt -contains $_.Extension.ToLower() })
  $steps['02-installed'] = @{ files = $installed.Count; assets = $assets.Count; hasExe = (Test-Path -LiteralPath (Join-Path $InstallDir 'AiriMateOne.exe')) }
  if ($assets.Count -gt 0) { Fail "安装目录混入了角色资产 $($assets.Count) 个（许可不允许）" }
  if (-not $steps['02-installed'].hasExe) { Fail '安装目录缺少 AiriMateOne.exe' }
}

Write-Host ''
Write-Host '=== 时点 3：卸载 ===' -ForegroundColor Cyan
$uninstallEvidence = Join-Path $outFull 'A19-install-3-uninstalled.json'
$prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
try {
  # `-SkipAutostart` 时卸载也要跳过回滚步骤（它同样需要启动应用）
  $uninstallArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Root 'tools\qa\uninstall.ps1'),
    '-InstallDir', $InstallDir, '-OutFile', $uninstallEvidence)
  if ($SkipAutostart) { $uninstallArgs += '-SkipLegacyRollback' }
  & powershell.exe @uninstallArgs 2>&1 | ForEach-Object { Write-Host "  $_" }
} finally { $ErrorActionPreference = $prev }

$afterUninstall = @{ runValues = RunValues; startMenu = (LinkState $startMenu); installDir = (Test-Path -LiteralPath $InstallDir) }
$steps['03-afterUninstall'] = $afterUninstall
if ($afterUninstall.installDir) { Fail '卸载后安装目录仍存在' }
if ($afterUninstall.runValues.ContainsKey('AiriOne')) { Fail '卸载后自启项 AiriOne 仍存在（开机将启动已删除的程序）' }
if ($afterUninstall.startMenu) { Fail '卸载后开始菜单快捷方式仍存在' }
$userData = Join-Path $env:APPDATA 'AiriMateOne'
$steps['03-userData'] = @{ path = $userData; kept = (Test-Path -LiteralPath $userData); expected = 'kept（记忆/密钥是用户资产）' }
if (-not $steps['03-userData'].kept) { Fail '卸载后用户数据被删除了（默认应保留）' }

Write-Host ''
Write-Host '=== 重启等价检验 ===' -ForegroundColor Cyan
<#
  不真的重启：重启对启动项的作用可以**等价**地检验 ——
  开机时系统会遍历 Run 键并执行其中的命令。因此判据是：
    ① Run 键里是否还有我们的项（有 ⇒ 会被执行）；
    ② 若仍有，它指向的文件是否存在（不存在 ⇒ 必然报错）。
  两者合起来足以判定"卸载后是否会出现开机报错弹窗"。
#>
$finalRun = RunValues
$ownRemains = $finalRun.ContainsKey('AiriOne')
$ownTargetExists = $false
$ownTarget = ''
if ($ownRemains) {
  $ownTarget = $finalRun['AiriOne']
  $m = [regex]::Match($ownTarget, '"([^"]+)"')
  $exe = if ($m.Success) { $m.Groups[1].Value } else { ($ownTarget -split '\s+')[0] }
  $ownTargetExists = Test-Path -LiteralPath $exe
}
$steps['04-rebootEquivalent'] = @{
  method = '等价检验（不真重启）：Run 键是否仍有该项 + 其目标文件是否存在'
  ownEntryRemains = $ownRemains
  ownTarget = $ownTarget
  ownTargetExists = $ownTargetExists
  conclusion = if (-not $ownRemains) { '开机不会执行本应用（已彻底移除）' }
    elseif (-not $ownTargetExists) { '开机仍会执行，但目标不存在 ⇒ 会弹错误提示（缺陷）' }
    else { '开机仍会执行且目标存在 ⇒ 未卸载干净（缺陷）' }
}
Write-Host "  $($steps['04-rebootEquivalent'].conclusion)"
if ($ownRemains) { Fail "重启等价检验不通过：$($steps['04-rebootEquivalent'].conclusion)" }

$result = [ordered]@{
  schema = 'airimate/install-cycle-evidence/1'
  at = (Get-Date).ToString('o')
  installDir = $InstallDir
  steps = $steps
  failures = @($failures)
  pass = ($failures.Count -eq 0)
  evidenceFiles = @($installEvidence, $uninstallEvidence)
}
$summary = Join-Path $outFull 'A19-install-cycle-summary.json'
[System.IO.File]::WriteAllText($summary, ($result | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))

Write-Host ''
if ($result.pass) {
  Write-Host 'A19 安装→卸载→重启（等价）演练：PASS' -ForegroundColor Green
  Write-Host "汇总证据：$summary"
  [Environment]::Exit(0)
}
else {
  Write-Host 'A19 演练：FAIL' -ForegroundColor Red
  $failures | ForEach-Object { Write-Host "  x $_" -ForegroundColor Red }
  Write-Host "汇总证据：$summary"
  [Environment]::Exit(1)
}
