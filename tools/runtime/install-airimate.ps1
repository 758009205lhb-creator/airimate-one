<#
  tools/runtime/install-airimate.ps1 —— 一键安装 AiriMate One（**安装时自动创建快捷启动方式**）

  这个脚本存在的理由（与 `tools/qa/install.ps1` 的分工，别混用）：
    · `tools/qa/install.ps1` 是**验收探针**：它会为了验证 A19 判据而真去写注册表自启项、
      并要求"独占启动应用"。它跑一次就改一次系统状态，不适合日常装机。
    · 本脚本是**装给自己用**的：只做三件事 —— 复制程序、补齐私有动作资产、创建快捷方式。
      **不碰注册表、不改开机自启、不需要管理员**。要开机自启请在应用里开（托盘/设置），
      那时的写入走应用自己的 `setAutoStart()`，与卸载器的回滚是同一套代码路径。

  安装布局（全部在用户目录内，可用现有 `uninstall.ps1` 逆操作）：
    <安装目录>\                     默认 %LOCALAPPDATA%\Programs\AiriMateOne
      AiriMateOne.exe               Electron 运行时（载荷自带）
      app\                          主进程 / preload / renderer 产物
      workspace\assets\             角色清单 + 动作资产（**本机私有，随安装一起放**）
      install-manifest.json         安装清单（schema 与 install.ps1 一致）
      LAUNCH.cmd / LAUNCH-诊断.cmd  免参数启动入口（不想点快捷方式时用）
    桌面\AiriMate One.lnk            ← 用户要的"点图标就打开"
    开始菜单\AiriMate One.lnk        （-ShortcutTarget both 时）

  ★ 为什么快捷方式必须带 `--workspace`：
    载荷是"裸工作区形态"，`app.isPackaged` 判定的依据是"可执行文件是否叫 electron"，
    而我们只是把 electron.exe 改名成 AiriMateOne.exe ⇒ 不传 `--workspace` 时
    `resolveRuntimeProfile()` 会落到 `packaged` 分支，私有 VRM **被许可闸门机械拒绝**
    ⇒ 症状是"装好了、能打开、但没有角色"。带上它 profile = `development`，正常加载。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\runtime\install-airimate.ps1 -DryRun
    powershell ... -File tools\runtime\install-airimate.ps1                 # 真装
    powershell ... -File tools\runtime\install-airimate.ps1 -ShortcutTarget both
    powershell ... -File tools\runtime\install-airimate.ps1 -NoVerify        # 装完不启动应用
    powershell ... -File tools\runtime\install-airimate.ps1 -InstallDir D:\x # 换个位置（演练）
    powershell ... -File tools\runtime\install-airimate.ps1 -SkipMotionAssets # 不带 .vrma

  退出码：0 = 装好了（且 -Verify 时应用真的起来了）；1 = 有步骤失败（**不静默成功**）
#>
[CmdletBinding()]
param(
  [string]$PayloadDir = '',
  [string]$InstallDir = '',
  [string]$Root = '',
  [ValidateSet('desktop', 'startmenu', 'both', 'none')][string]$ShortcutTarget = 'desktop',
  [string]$ShortcutName = 'AiriMate One',
  <#
    `-WorkspaceMode`：快捷方式里的 `--workspace` 指向哪里。
      · `install`（默认）：指向**安装目录内的 workspace** ⇒ 与开发树解耦，
        搬走/重装开发树都不影响图标。动作资产与 renderer 由本脚本复制进去。
      · `project`：指向**工程根** ⇒ 永远用最新的开发树产物（改完代码重新构建即可，
        不必重装），代价是图标与工程目录绑在一起。
  #>
  [ValidateSet('install', 'project')][string]$WorkspaceMode = 'install',
  [switch]$SkipMotionAssets,
  [switch]$NoVerify,
  [switch]$DryRun,
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Root)) { $Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
if ([string]::IsNullOrWhiteSpace($PayloadDir)) {
  $PayloadDir = Join-Path $Root 'dist-package'
  if (-not (Test-Path -LiteralPath $PayloadDir)) {
    throw "找不到载荷目录：$PayloadDir（先跑 `npm run build:dist` 组装）"
  }
}
$PayloadDir = (Resolve-Path -LiteralPath $PayloadDir).Path
if ([string]::IsNullOrWhiteSpace($InstallDir)) { $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\AiriMateOne' }

$steps = [ordered]@{}
$failures = New-Object System.Collections.Generic.List[string]
$dryWarnings = New-Object System.Collections.Generic.List[string]
$startedAt = Get-Date
function Note([string]$n, $v) { $steps[$n] = $v }
function Fail([string]$m) { $failures.Add($m); Write-Host "  x $m" -ForegroundColor Red }
function Ok([string]$m) { Write-Host "  + $m" -ForegroundColor Green }

Write-Host "AiriMate One 安装$(if ($DryRun) { '（干跑：不落盘）' })" -ForegroundColor Cyan
Write-Host "  载荷     : $PayloadDir"
Write-Host "  安装目录 : $InstallDir"
Write-Host "  快捷方式 : $ShortcutTarget"
Write-Host ''

# ── ⓪ 预检
$stagedExe = Join-Path $PayloadDir 'AiriMateOne.exe'
$stagedApp = Join-Path $PayloadDir 'app\main\index.js'
$running = @(Get-Process AiriMateOne -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.Path.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase) })
if ($running.Count -gt 0) {
  Fail "安装目录里的应用正在运行（PID: $($running.Id -join ', ')）—— 先退出它再装（托盘右键退出）。"
}
if (-not (Test-Path -LiteralPath $stagedExe)) { Fail "载荷缺少 AiriMateOne.exe：$stagedExe" }
if (-not (Test-Path -LiteralPath $stagedApp)) { Fail "载荷缺少 app\main\index.js：$stagedApp" }

# ── ① 复制程序本体
if ($failures.Count -eq 0) {
  if ($DryRun) {
    $size = (Get-ChildItem -LiteralPath $PayloadDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
    Note 'copy' @{ dryRun = $true; from = $PayloadDir; to = $InstallDir; totalMB = [math]::Round($size, 1) }
    Write-Host ("  [1/7] 复制：将写入 $InstallDir（{0:N1} MB；干跑，未执行）" -f $size)
  }
  else {
    try {
      # 就地覆盖而不是先删：`app\` 与运行时 DLL 都是可以整体替换的，
      # 而"先删再拷"在这台机器上有过中途失败留下半个安装目录的先例。
      if (-not (Test-Path -LiteralPath $InstallDir)) { New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null }
      <#
        ⚠ 这里**不能**写 `Copy-Item -LiteralPath (Join-Path $PayloadDir '*')`。
        `-LiteralPath` 的语义就是"把 `*` 当**字面星号**"（不展开通配），于是源被解析成
        一个名叫 `*` 的条目 ⇒ PowerShell 既不报错也不复制，**一个字节都不会落盘**，
        而外层 try 完全正常。实测后果：安装目录被建出来、里面空的，
        报错却是"复制后安装目录里没有 AiriMateOne.exe"——看起来像 exe 的问题，
        实际是复制根本没发生。所以显式枚举子项，逐项按字面路径复制。
      #>
      $top = @(Get-ChildItem -LiteralPath $PayloadDir -Force)
      foreach ($item in $top) {
        Copy-Item -LiteralPath $item.FullName -Destination $InstallDir -Recurse -Force
      }
      $copied = (Get-ChildItem -LiteralPath $InstallDir -Recurse -File | Measure-Object).Count
      $ok = Test-Path -LiteralPath (Join-Path $InstallDir 'AiriMateOne.exe')
      Note 'copy' @{ to = $InstallDir; files = $copied; topLevelItems = $top.Count; exePresent = $ok }
      if (-not $ok) { Fail '复制后安装目录里没有 AiriMateOne.exe' } else { Ok "复制 $copied 个文件 -> $InstallDir" }
    }
    catch { Fail "复制失败：$($_.Exception.Message)" }
  }
}

# ── ①b 补 workspace 包清单（**载荷自带的一处真实缺口**）
#
#   ★ 为什么必须有这一步（实测事故，不是理论）：
#     `dist-package\app\node_modules\@airimate\<pkg>\` 里**只有 `dist\`，没有 `package.json`**
#     （`tools/qa/stage-dist.mjs` 的 INCLUDE 只列了 `packages/*/dist`）。
#     而 Node 解析一个包的第一步就是读它的 `package.json` 取 `main`/`exports`
#     ⇒ 载荷一旦**离开开发树**（安装到 %LOCALAPPDATA% 之后就是这样），
#     `require('@airimate/shared')` 直接抛
#     `Cannot find module '@airimate/shared'`（应用**秒退**，连窗口都不创建）。
#
#     在 `dist-package\` 原地跑是**看不出**这个缺口的：那三个目录能从开发树的
#     `node_modules\@airimate\*`（npm workspaces 的 Junction，指向 `packages\*`）解析到真正的清单。
#     一句"开发能跑、装了就跑不起来"背后就是这个。
#
#   ⚠ 这里**读取并复制**源包的 `package.json`（保留 `type: module` / `exports` / `dependencies`），
#     不手抄字段 —— 手抄一份"清单真源"正是本项目反复吃亏的做法。
$manifestJson = 'package.json'
$wsPackages = @('shared', 'security', 'companion-kit')
if ($failures.Count -eq 0 -and -not $DryRun) {
  $fixed = @()
  foreach ($pkg in $wsPackages) {
    $srcPkg = Join-Path $Root "packages\$pkg\$manifestJson"
    $dstDir = Join-Path $InstallDir "app\node_modules\@airimate\$pkg"
    if (-not (Test-Path -LiteralPath $srcPkg)) { Fail "缺源包清单：$srcPkg"; continue }
    if (-not (Test-Path -LiteralPath $dstDir)) { Fail "载荷里没有这个 workspace 包：$dstDir"; continue }
    try {
      Copy-Item -LiteralPath $srcPkg -Destination (Join-Path $dstDir $manifestJson) -Force
      $fixed += $pkg
    }
    catch { Fail "补写 $pkg\package.json 失败：$($_.Exception.Message)" }
  }
  Note 'workspaceManifests' @{ patched = $fixed; why = '载荷只带了 packages/*/dist，没带 package.json' }
  if ($fixed.Count -eq $wsPackages.Count) { Ok "已补 workspace 包清单：$($fixed -join ', ')" }

  # 补完立刻**实测**能不能解析 —— 不看"文件复制了没有"，看 Node 能不能 require 到。
  # 用 node 在安装目录里解析（PATH 上的 node 与 Electron 内置的 Node 解析规则一致）。
  $resolveProbe = Join-Path $env:TEMP 'airimate-resolve-probe.cjs'
  $probeBody = @"
const path = require('node:path');
const base = path.join(process.argv[2], 'app');
const mods = ['@airimate/shared', '@airimate/security', '@airimate/companion-kit', 'zod'];
let bad = 0;
for (const m of mods) {
  try { require.resolve(m, { paths: [base] }); console.log('OK   ' + m); }
  catch (e) { bad++; console.log('FAIL ' + m + ' :: ' + e.code); }
}
process.exit(bad === 0 ? 0 : 1);
"@
  [System.IO.File]::WriteAllText($resolveProbe, $probeBody, (New-Object System.Text.UTF8Encoding($false)))
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $probeOut = & node $resolveProbe $InstallDir 2>&1; $probeRc = $LASTEXITCODE } finally { $ErrorActionPreference = $prev }
  Note 'resolveProbe' @{ exitCode = $probeRc; output = @($probeOut) }
  if ($probeRc -ne 0) { Fail "安装副本仍解析不到运行期依赖：`n     $($probeOut -join "`n     ")" }
  else { Ok 'require 解析自检通过（@airimate/shared、security、companion-kit、zod）' }
}

# ── ② 私有动作资产（.vrma）——载荷按许可是**不含**它们的，这里从本机工作区补
#      ⚠ 只在本机复制，不产生任何对外分发；少了它们角色会站着不动（clips=0）。
$motionSrc = Join-Path $Root 'assets\motion'
$motionDst = Join-Path $InstallDir 'workspace\assets\motion'
$vrmaSrc = @(Get-ChildItem -LiteralPath $motionSrc -Recurse -File -Filter '*.vrma' -ErrorAction SilentlyContinue)
if ($failures.Count -eq 0) {
  if ($SkipMotionAssets) {
    Note 'motion' @{ skipped = $true; why = '-SkipMotionAssets' }
    Write-Host '  [2/7] 动作资产：已按 -SkipMotionAssets 跳过（角色将没有动作）'
  }
  elseif ($vrmaSrc.Count -eq 0) {
    Fail "工程里找不到 .vrma：$motionSrc（动作资产缺失 ⇒ 角色不会动）"
  }
  elseif ($DryRun) {
    Note 'motion' @{ dryRun = $true; count = $vrmaSrc.Count; to = $motionDst }
    Write-Host "  [2/7] 动作资产：将复制 $($vrmaSrc.Count) 个 .vrma（干跑）"
  }
  else {
    try {
      if (-not (Test-Path -LiteralPath $motionDst)) { New-Item -ItemType Directory -Force -Path $motionDst | Out-Null }
      foreach ($f in $vrmaSrc) { Copy-Item -LiteralPath $f.FullName -Destination $motionDst -Force }
      # 清单与接触表也一起带（动作选择器要读 manifests/）
      foreach ($sub in 'manifests', 'contact-sheets', 'reports') {
        $s = Join-Path $motionSrc $sub
        if (Test-Path -LiteralPath $s) { Copy-Item -LiteralPath $s -Destination $motionDst -Recurse -Force }
      }
      $got = @(Get-ChildItem -LiteralPath $motionDst -Recurse -File -Filter '*.vrma' -ErrorAction SilentlyContinue).Count
      Note 'motion' @{ to = $motionDst; expected = $vrmaSrc.Count; copied = $got }
      if ($got -ne $vrmaSrc.Count) { Fail "动作资产数量不符：期望 $($vrmaSrc.Count)，实到 $got" }
      else { Ok "动作资产 $got 个 .vrma -> workspace\assets\motion" }
    }
    catch { Fail "复制动作资产失败：$($_.Exception.Message)" }
  }
}

# ── ②b 把 renderer 产物也放进安装工作区
#
#   ★ 为什么：`paths.ts` 的 `rendererDist = <工作区>\apps\renderer\dist`。
#     安装形态的工作区是 `<安装目录>\workspace`，里面**没有** `apps\renderer\dist`
#     ⇒ 不补这一步，应用起来是**白屏**（窗口在、界面加载不出来）。
#     `app\renderer`（载荷里的那份）只服务于"exe 直接吃 app 目录"的路径，
#     与 `--workspace` 派生的 `rendererDist` 是**两个不同的位置**。
$rendererSrc = Join-Path $PayloadDir 'app\renderer'
$rendererDst = Join-Path $InstallDir 'workspace\apps\renderer\dist'
if ($failures.Count -eq 0) {
  if (-not (Test-Path -LiteralPath (Join-Path $rendererSrc 'index.html'))) {
    Fail "载荷里没有 renderer 产物：$rendererSrc\index.html"
  }
  elseif ($DryRun) {
    Note 'workspaceRenderer' @{ dryRun = $true; to = $rendererDst }
    Write-Host '  [3/7] 安装工作区 renderer：将复制（干跑）'
  }
  else {
    try {
      if (-not (Test-Path -LiteralPath $rendererDst)) { New-Item -ItemType Directory -Force -Path $rendererDst | Out-Null }
      foreach ($item in @(Get-ChildItem -LiteralPath $rendererSrc -Force)) {
        Copy-Item -LiteralPath $item.FullName -Destination $rendererDst -Recurse -Force
      }
      $hasIndex = Test-Path -LiteralPath (Join-Path $rendererDst 'index.html')
      Note 'workspaceRenderer' @{ to = $rendererDst; indexPresent = $hasIndex }
      if (-not $hasIndex) { Fail "renderer 复制后仍缺 index.html：$rendererDst" }
      else { Ok "安装工作区 renderer -> $rendererDst" }
    }
    catch { Fail "复制 renderer 到工作区失败：$($_.Exception.Message)" }
  }
}

# ── ③ 快捷方式（**本脚本的核心交付物**：装了就有图标可点）
$shortcutScript = Join-Path $Root 'tools\qa\shortcut.ps1'
$exePath = Join-Path $InstallDir 'AiriMateOne.exe'
$workspaceDir = if ($WorkspaceMode -eq 'project') { $Root } else { Join-Path $InstallDir 'workspace' }
$links = @{}
$linkResults = @()
if ($failures.Count -eq 0 -and $ShortcutTarget -ne 'none') {
  $targets = @()
  if ($ShortcutTarget -in 'desktop', 'both') {
    $desktop = [Environment]::GetFolderPath('Desktop')
    if ($desktop) { $targets += (Join-Path $desktop "$ShortcutName.lnk"); $links['desktop'] = (Join-Path $desktop "$ShortcutName.lnk") }
    else { Fail '拿不到桌面目录（[Environment]::GetFolderPath("Desktop") 返回空）' }
  }
  if ($ShortcutTarget -in 'startmenu', 'both') {
    $sm = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$ShortcutName.lnk"
    $targets += $sm; $links['startMenu'] = $sm
  }
  <#
    ★ 参数必须**三段齐全**，缺一段就是一个"双击弹错误框"的图标。实测踩到的正是这个：

      `AiriMateOne.exe` 只是被改名的 `electron.exe`，它按 Electron 的规矩把
      **第一个非开关参数**当"应用目录"。少了它，Electron 就退而把
      `--workspace` 的**值**当应用去加载 ⇒ 弹一个标题为 `[Error]` 的 Win32 对话框：

        Error launching app
        Unable to find Electron app at <workspace>
        Cannot find module '<workspace>'

      也就是说：`app 目录` 是**必需**的第一段参数，`--workspace` 是第二段。
      用启动器（`launch-airimate.ps1`）跑时这两段都在，所以"脚本能起、图标不能起"——
      这种差异最难查，因为两边看起来在做同一件事。
  #>
  $appDir = Join-Path $InstallDir 'app'
  $lnkArgs = "`"$appDir`" --workspace `"$workspaceDir`""
  foreach ($lnk in $targets) {
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $shortcutScript, '-Action', 'create',
      '-Path', $lnk, '-Target', $exePath, '-Arguments', $lnkArgs, '-WorkDir', $InstallDir,
      '-Icon', $exePath, '-Description', $ShortcutName)
    if ($DryRun) { $a += '-DryRun' }
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $out = & powershell.exe @a 2>&1 } finally { $ErrorActionPreference = $prev }
    $rc = $LASTEXITCODE
    $exists = Test-Path -LiteralPath $lnk
    $linkResults += @{ path = $lnk; exitCode = $rc; created = $exists; output = ($out | Out-String).Trim() }
    <#
      ⚠ 干跑时**不能**用"文件存不存在"判成功 —— `-DryRun` 的语义就是"不落盘"，
      于是 .lnk 必然不存在，那条判据会把干跑永远判成失败（实测：第一次干跑就报
      "创建快捷方式失败（exit=1）"，而退出码其实是 0，纯属判定写错）。

      更进一步：`tools/qa/shortcut.ps1` **自己**在 create 的第一行就要求
      `Test-Path -LiteralPath $Target`，而干跑时安装目录还没建 ⇒ 它必然返回
      `ok:false / 目标不存在`。所以干跑时这一项只降级成**警告**，
      不冒充"干跑成功"，也不把干跑判成 FAIL —— 真装的判定不受影响。
    #>
    $stepOk = if ($DryRun) { $rc -eq 0 } else { ($rc -eq 0) -and $exists }
    if (-not $stepOk) {
      if ($DryRun) {
        $dryWarnings.Add("干跑：快捷方式未创建（$lnk）—— 目标 $exePath 尚未存在，属预期；真装时会创建。")
        Write-Host "  ~ 干跑：快捷方式（$lnk）因目标尚未存在而未预演" -ForegroundColor Yellow
      }
      else { Fail "创建快捷方式失败：$lnk（exit=$rc, exists=$exists）" }
    }
    else { Ok "$(if ($DryRun) { '[5/7] 将创建' } else { '[5/7] 已创建' })快捷方式：$lnk" }
  }
  Note 'shortcuts' @{ target = $ShortcutTarget; name = $ShortcutName; arguments = $lnkArgs; results = $linkResults }
  <#
    ★ 读回 .lnk 的**真实参数**做核对（不是核对我们"打算写什么"）。
    为什么必须读回：快捷方式的参数是经 COM 落盘的，写错一段就是"双击弹错误框"；
    而这种情况在安装日志里完全看不出来 —— 日志只会说"已创建"。
    实测事故：快捷方式只写了 `--workspace`、漏了 `app` 目录那一段，双击弹出
    `Unable to find Electron app at <workspace>`，而安装报了 PASS。
    判据（三段齐全）：目标文件存在 + 参数里同时有 `<安装目录>\app` 与 `--workspace` 及其值。
  #>
  if (-not $DryRun -and $failures.Count -eq 0 -and @($targets).Count -gt 0) {
    try {
      $shCheck = New-Object -ComObject WScript.Shell
      $lnkCheck = @()
      foreach ($lnk in $targets) {
        $sc = $shCheck.CreateShortcut($lnk)
        $argsText = [string]$sc.Arguments
        $hasAppDir = $argsText -like "*$appDir*"
        $hasWsFlag = $argsText -like '*--workspace*'
        $hasWsValue = $argsText -like "*$workspaceDir*"
        $targetOk = ($sc.TargetPath -ieq $exePath)
        $lnkCheck += @{ path = $lnk; targetOk = $targetOk; hasAppDir = $hasAppDir; hasWorkspaceFlag = $hasWsFlag; hasWorkspaceValue = $hasWsValue; arguments = $argsText }
        if (-not ($targetOk -and $hasAppDir -and $hasWsFlag -and $hasWsValue)) {
          Fail "快捷方式参数不合格：$lnk（targetOk=$targetOk appDir=$hasAppDir wsFlag=$hasWsFlag wsValue=$hasWsValue）`n     实际参数：$argsText"
        }
      }
      Note 'shortcutVerify' $lnkCheck
      if ($failures.Count -eq 0) { Ok '快捷方式自检通过（目标 + app 目录 + --workspace 三段齐全）' }
    }
    catch { Fail "读回快捷方式校验失败：$($_.Exception.Message)" }
  }
}
elseif ($ShortcutTarget -eq 'none') {
  Note 'shortcuts' @{ target = 'none'; skipped = $true }
  Write-Host '  [5/7] 快捷方式：已按 -ShortcutTarget none 跳过'
}

# ── ④ 免参数启动入口（捷径不点图标时用；也是排障时的第一步）
#      两个 .cmd：一个正常启动，一个带日志重定向 —— 用户报障时只要把日志文件发过来。
$launchCmd = Join-Path $InstallDir 'LAUNCH.cmd'
$launchDiagCmd = Join-Path $InstallDir 'LAUNCH-诊断.cmd'
if ($failures.Count -eq 0 -and -not $DryRun) {
  try {
    $exeName = Split-Path $exePath -Leaf
    <#
      ⚠ `%~dp0app` 这一段**不可省**：`AiriMateOne.exe` 是改名的 electron.exe，
      Electron 把第一个非开关参数当"应用目录"。少了它就会弹 `[Error]
      Unable to find Electron app at ...` —— 与快捷方式上踩的是同一个坑，
      所以两个入口（.lnk 与 .cmd）在这里必须写**同一套**参数。
    #>
    $cmdBody = "@echo off`r`nrem AiriMate One 启动入口（由 tools/runtime/install-airimate.ps1 生成）`r`nrem 参数两段都必需：app 目录（Electron 应用入口）+ --workspace（工作区根）。`r`ncd /d `"%~dp0`"`r`nstart `"`" `"%~dp0$exeName`" `"%~dp0app`" --workspace `"%~dp0workspace`"`r`n"
    [System.IO.File]::WriteAllText($launchCmd, $cmdBody, (New-Object System.Text.UTF8Encoding($false)))
    $runLine = '"%~dp0' + $exeName + '" "%~dp0app" --workspace "%~dp0workspace"'
    $diagBody = "@echo off`r`nrem 诊断入口：把控制台输出写到本目录 launch-console.log（用户报障时直接发这个文件）。`r`ncd /d `"%~dp0`"`r`n$runLine > `"%~dp0launch-console.log`" 2>&1`r`n"
    [System.IO.File]::WriteAllText($launchDiagCmd, $diagBody, (New-Object System.Text.UTF8Encoding($false)))
    Note 'launchers' @{ cmd = $launchCmd; diagCmd = $launchDiagCmd; args = $runLine }
    Write-Host '  [6/7] 启动入口'
    Ok '已写 LAUNCH.cmd / LAUNCH-诊断.cmd'
  }
  catch { Fail "写启动入口失败：$($_.Exception.Message)" }
}

# ── ⑤ 安装清单（schema 与 install.ps1 一致 ⇒ 现有卸载器能安全逆操作）
$manifestPath = Join-Path $InstallDir 'install-manifest.json'
if ($failures.Count -eq 0 -and -not $DryRun) {
  try {
    $payload = [ordered]@{
      schema = 'airimate/install-manifest/1'
      installedAt = $startedAt.ToString('o')
      installer = 'tools/runtime/install-airimate.ps1'
      installKind = 'private-self-use'
      installDir = $InstallDir
      payloadDir = $PayloadDir
      exePath = $exePath
      # 本安装**不写**开机自启（见脚本头）。留 null 而不是编一个值，
      # 卸载器的 `-SkipLegacyRollback` 与自启步骤都按这个字段的缺失正常工作。
      autostart = $null
      links = $links
      workspace = $workspaceDir
      launchArgs = "--workspace `"$workspaceDir`""
      userDataDir = (Join-Path $env:APPDATA 'AiriMateOne')
      note = '角色资产（VRM）与动作资产（VRMA）均不在分发载荷内，属于本机私有；本安装只在本机复制，不对外分发。'
    }
    [System.IO.File]::WriteAllText($manifestPath, ($payload | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
    Note 'manifest' @{ path = $manifestPath; bytes = (Get-Item -LiteralPath $manifestPath).Length; bom = $false }
    Write-Host '  [7/7] 安装清单'
    Ok "安装清单 -> $manifestPath"
  }
  catch { Fail "写安装清单失败：$($_.Exception.Message)" }
}

# ── ⑥ 验证：真的启动一次，读回"有没有角色、有几个动作"
$verify = [ordered]@{ ran = $false }
if (-not $NoVerify -and -not $DryRun -and $failures.Count -eq 0) {
  $launcher = Join-Path $Root 'tools\runtime\launch-airimate.ps1'
  $verifyOut = Join-Path $env:TEMP 'airimate-install-verify.json'
  if (Test-Path -LiteralPath $verifyOut) { Remove-Item -LiteralPath $verifyOut -Force }
  Write-Host ''
  Write-Host '验证：启动一次应用并读回适配层读数…' -ForegroundColor Cyan
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $launcher `
      -PayloadDir $InstallDir -Workspace $workspaceDir -WaitSec 45 -OutFile $verifyOut 2>&1 | Out-Null
    $verifyRc = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prev }
  if (Test-Path -LiteralPath $verifyOut) {
    $v = Get-Content -LiteralPath $verifyOut -Raw | ConvertFrom-Json
    $verify.ran = $true; $verify.exitCode = $verifyRc
    $verify.profile = $v.evidence.profile; $verify.avatarId = $v.evidence.avatarId
    $verify.clips = $v.evidence.clips; $verify.mode = $v.evidence.mode
    $verify.pid = $v.pid; $verify.windowVisible = $v.checks.windowVisible
    if ($v.evidence.profile -ne 'development') { Fail "启动读数 profile=$($v.evidence.profile)（应为 development）—— 快捷键方式的 --workspace 可能没生效" }
    if ($null -eq $v.evidence.clips -or [int]$v.evidence.clips -le 0) { Fail "启动读数 clips=$($v.evidence.clips)（应 >0）—— 动作资产没到位，角色不会动" }
    if (-not $v.evidence.avatarId) { Fail '启动读数里没有角色 id —— 角色清单没被解析到' }
    if ($failures.Count -eq 0) { Ok "启动验证通过：profile=$($v.evidence.profile) 角色=$($v.evidence.avatarId) 动作=$($v.evidence.clips) 窗口可见=$($v.checks.windowVisible)" }
  }
  else { Fail "验证没写出结果文件：$verifyOut" }
}
elseif ($NoVerify) { Write-Host '验证：已按 -NoVerify 跳过'; $verify.skipped = $true }
Note 'verify' $verify

# ── 结果
$result = [ordered]@{
  schema = 'airimate/runtime-install-evidence/1'
  at = (Get-Date).ToString('o')
  dryRun = [bool]$DryRun
  payloadDir = $PayloadDir
  installDir = $InstallDir
  shortcutTarget = $ShortcutTarget
  shortcutName = $ShortcutName
  workspaceMode = $WorkspaceMode
  steps = $steps
  failures = @($failures)
  dryRunWarnings = @($dryWarnings)
  pass = ($failures.Count -eq 0)
}
if ($OutFile) {
  [System.IO.File]::WriteAllText($OutFile, ($result | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
}

Write-Host ''
if ($result.pass) {
  Write-Host "安装：PASS$(if ($DryRun) { '（干跑）' })" -ForegroundColor Green
  if ($dryWarnings.Count -gt 0) {
    Write-Host '干跑提示（非失败，真装时会真做）：' -ForegroundColor Yellow
    $dryWarnings | ForEach-Object { Write-Host "  ~ $_" -ForegroundColor Yellow }
  }
  if (-not $DryRun -and $ShortcutTarget -ne 'none') {
    Write-Host "桌面图标：$ShortcutName.lnk —— 点它就能打开。" -ForegroundColor Green
  }
  [Environment]::Exit(0)
}
else {
  Write-Host '安装：FAIL' -ForegroundColor Red
  $failures | ForEach-Object { Write-Host "  x $_" -ForegroundColor Red }
  [Environment]::Exit(1)
}
