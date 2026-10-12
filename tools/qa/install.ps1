<#
  tools/qa/install.ps1 —— 按用户安装（**无需管理员**）

  ⚠ 先说清楚这个安装器**不做**什么（本项目的许可现实，不能含糊）：
    · **不复制角色资产**（VRM）。Mate Engine 是 *MateEngine Pro License v2.1*，
      其 DLC 资产**没有独立许可** ⇒ 不得再分发。因此安装**只装程序本体**，
      角色模型仍由使用者自己提供，通过 `assets/models/catalog.json` 的**路径引用**指定。
      首次启动若找不到模型，应用会给出明确提示，而不是假装成功。
    · **不做机器级安装**（不写 HKLM、不写公共启动文件夹、不需要 UAC）。
      理由：机器级安装会触碰所有用户，风险与收益不成比例；且本机环境的
      UAC 交互式提权无法在自动化里可靠演练 —— 而"没演练过的提权路径"不该交付。

  安装布局（全部在用户目录内，卸载时整体可逆）：
    %LOCALAPPDATA%\Programs\AiriMateOne\        程序本体（由 tools/qa/stage-dist.mjs 产出）
    %APPDATA%\AiriMateOne\                      用户数据（**卸载默认保留**）
    HKCU\...\Run\AiriOne                        自启项（值名避开旧卸载器删除前缀）
    %APPDATA%\Microsoft\Windows\Start Menu\Programs\AiriMate One.lnk
    <桌面>\AiriMate One.lnk

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\install.ps1
    powershell ... -File tools\qa\install.ps1 -NoAutostart -NoDesktopShortcut
    powershell ... -File tools\qa\install.ps1 -DryRun            # 只报告计划，不落盘
    powershell ... -File tools\qa\install.ps1 -InstallDir D:\x   # 装到别处（演练用）

  退出码：0 = 成功；1 = 有步骤失败（**不静默成功**）
#>
[CmdletBinding()]
param(
  [string]$PayloadDir = '',
  [string]$InstallDir = '',
  [string]$Root = '',
  [switch]$NoAutostart,
  [switch]$NoDesktopShortcut,
  [switch]$DryRun,
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Root)) { $Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
if ([string]::IsNullOrWhiteSpace($PayloadDir)) { $PayloadDir = Join-Path $Root 'dist-package' }
if ([string]::IsNullOrWhiteSpace($InstallDir)) { $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\AiriMateOne' }

$steps = [ordered]@{}
$failures = New-Object System.Collections.Generic.List[string]
$startedAt = Get-Date

function Note([string]$name, $value) { $steps[$name] = $value }
function Fail([string]$msg) { $failures.Add($msg); Write-Host "  x $msg" -ForegroundColor Red }

Write-Host "AiriMate One 安装程序$(if ($DryRun) { '（干跑：不落盘）' })" -ForegroundColor Cyan
Write-Host "  载荷目录 : $PayloadDir"
Write-Host "  安装目录 : $InstallDir"
Write-Host ''

# ── ⓪ 预检：安装过程要**用应用自己的 CLI** 去写自启项，因此需要能独占启动应用。
#      若已有实例在跑，三层单实例保护会让本次启动直接退出并聚焦旧窗口
#      （那是**正确行为**，但探针不会执行）⇒ 自启步骤会拿到空结果。
#      与其让它在第 4 步莫名其妙地失败，不如**在这里就说清楚**。
$running = @(Get-Process electron -ErrorAction SilentlyContinue)
if ($running.Count -gt 0 -and -not $NoAutostart) {
  Write-Host "检测到 $($running.Count) 个 electron 进程正在运行 —— 安装的第 4 步（写自启项）需要独占启动应用。" -ForegroundColor Yellow
  $running | Select-Object -First 5 | ForEach-Object {
    $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine
    Write-Host "  PID $($_.Id) $(if ($cl) { $cl.Substring(0, [Math]::Min(120, $cl.Length)) } else { '(无命令行)' })"
  }
  Write-Host '请先结束它们，或加 -NoAutostart 跳过自启步骤。例如：' -ForegroundColor Yellow
  Write-Host '  Get-Process electron | Stop-Process -Force' -ForegroundColor Yellow
  Write-Host '  Remove-Item "$env:APPDATA\AiriMateOne\run\instance.lock" -Force' -ForegroundColor Yellow
  Write-Host '注意：`MateEngineX` / `airi` / `airi-host` 属于**旧方案**，不要动它们。' -ForegroundColor Yellow
  exit 1
}

# ── ① 载荷检查
if (-not (Test-Path -LiteralPath $PayloadDir)) {
  Fail "载荷目录不存在：$PayloadDir（请先运行 node tools/qa/stage-dist.mjs --clean）"
}
else {
  $manifestPath = Join-Path $PayloadDir 'MANIFEST.json'
  $manifest = $null
  if (Test-Path -LiteralPath $manifestPath) { $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json }
  $fileCount = (Get-ChildItem -LiteralPath $PayloadDir -Recurse -File | Measure-Object).Count
  Note 'payload' @{ dir = $PayloadDir; files = $fileCount; manifest = [bool]$manifest; manifestFiles = if ($manifest) { $manifest.fileCount } else { $null } }
  # 清单里的 fileCount 不含 MANIFEST.json 自身（它是写清单之后才产生的），所以允许差 1
  Write-Host "  [1/6] 载荷：$fileCount 个文件$(if ($manifest) { "（清单声明 $($manifest.fileCount)，清单自身另计）" })"
  <#
    载荷里**不应**有角色资产（Mate 许可约束），但**必须**有许可声明。

    ⚠ 这里不能用 `Get-ChildItem -Include *.vrm,*.vrma,*.anim`：
      `-Include` 只在配合 `-Recurse` **且路径以通配符结尾**时才按预期工作，
      否则它会**匹配全部文件**（实测：65 个文件全被判成"角色资产"，
      安装器因此拒绝安装 —— 一个纯粹由参数语义造成的假失败）。
      改为按扩展名过滤，语义明确、不受这个坑影响。
  #>
  $assetExt = @('.vrm', '.vrma', '.anim')
  $assets = @(Get-ChildItem -LiteralPath $PayloadDir -Recurse -File | Where-Object { $assetExt -contains $_.Extension.ToLower() })
  if ($assets.Count -gt 0) { Fail "载荷里出现了角色资产（$($assets.Count) 个）—— Mate 许可不允许再分发" }
  if (-not (Test-Path -LiteralPath (Join-Path $PayloadDir 'THIRD-PARTY-NOTICES.md'))) { Fail '载荷里缺少 THIRD-PARTY-NOTICES.md（合规必需）' }
}

# ── ② 复制到安装目录
if ($failures.Count -eq 0) {
  if ($DryRun) {
    Note 'copy' @{ dryRun = $true; to = $InstallDir; wouldOverwrite = (Test-Path -LiteralPath $InstallDir) }
    Write-Host "  [2/6] 复制：将写入 $InstallDir（干跑，未执行）"
  }
  else {
    try {
      if (-not (Test-Path -LiteralPath $InstallDir)) { New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null }
      <#
        ⚠ 用调用运算符而不是 `Start-Process`。
        实测踩到：本机环境同时存在 `NO_PROXY` 与 `no_proxy` 两个变量，
        PowerShell 5.1 的 `Start-Process` 在构造子进程环境块时抛
        `Item has already been added. Key in dictionary: 'NO_PROXY'`（已知 bug），
        于是**整个复制步骤失败**、安装中断在一个与复制毫无关系的地方。
        调用运算符没有这个问题；配合临时降级 ErrorActionPreference，
        robocopy 的进度输出也不会被当成终止性错误。

        robocopy 退出码语义：0 = 无需复制；1 = 有文件被复制；≥8 = 失败。
      #>
      $prevEap = $ErrorActionPreference
      $ErrorActionPreference = 'Continue'
      try {
        & robocopy.exe $PayloadDir $InstallDir /MIR /NFL /NDL /NJH /NJS /NP /R:2 /W:1 2>&1 | Out-Null
        $rc = $LASTEXITCODE
      } finally { $ErrorActionPreference = $prevEap }

      if ($rc -ge 8) { Fail "robocopy 失败，退出码 $rc" }
      $copied = (Get-ChildItem -LiteralPath $InstallDir -Recurse -File | Measure-Object).Count
      Note 'copy' @{ to = $InstallDir; files = $copied; robocopyExit = $rc }
      Write-Host "  [2/6] 复制：$copied 个文件 -> $InstallDir（robocopy exit=$rc）"
    }
    catch { Fail "复制失败：$($_.Exception.Message)" }
  }
}

# ── ③ 可执行文件
$exePath = Join-Path $InstallDir 'AiriMateOne.exe'
$electronExe = Join-Path $Root 'node_modules\electron\dist\electron.exe'
$stagedExe = Join-Path $PayloadDir 'AiriMateOne.exe'
if ($failures.Count -eq 0) {
  if ($DryRun) {
    Note 'exe' @{ dryRun = $true; target = $exePath; stagedExe = (Test-Path -LiteralPath $stagedExe); devFallback = $electronExe }
    Write-Host "  [3/6] 可执行文件：$(if (Test-Path -LiteralPath $stagedExe) { '载荷自带 AiriMateOne.exe' } else { '将从开发树复制（仅够演练）' })（干跑）"
  }
  elseif (Test-Path -LiteralPath $stagedExe) {
    # 载荷自带运行时（`stage-dist.mjs --with-runtime`）——这条路径才是**可交付**的安装
    Note 'exe' @{ target = $exePath; source = 'payload'; bytes = (Get-Item -LiteralPath $exePath).Length; runtimeBundled = $true }
    Write-Host "  [3/6] 可执行文件：载荷自带运行时 -> $exePath"
  }
  elseif (Test-Path -LiteralPath $electronExe) {
    try {
      Copy-Item -LiteralPath $electronExe -Destination $exePath -Force
      Note 'exe' @{ target = $exePath; copiedFrom = $electronExe; bytes = (Get-Item -LiteralPath $exePath).Length; runtimeBundled = $false }
      Write-Host "  [3/6] 可执行文件：从开发树复制 -> $exePath（**仅够演练**：载荷未带运行时）"
    }
    catch { Fail "复制可执行文件失败：$($_.Exception.Message)" }
  }
  else {
    Fail "载荷与开发树都没有可用的可执行文件（请用 node tools/qa/stage-dist.mjs --clean --with-runtime 组装）"
  }
}

# ── ③b 工作区根：安装形态必须显式告知应用 renderer/assets 在哪
#       为什么需要：`app.isPackaged` 的依据是"可执行文件是否叫 electron"，
#       而安装形态只是把 electron.exe 改名成 AiriMateOne.exe ⇒ 它不会变 true，
#       `paths.ts` 里"打包形态"那条分支走不到，rendererDist/motionDir 会全部指错。
#       安装器知道自己把 workspace 放在哪，写进清单与快捷方式参数最可靠。
$workspaceDir = Join-Path $InstallDir 'workspace'
if ($failures.Count -eq 0) {
  $hasWorkspace = Test-Path -LiteralPath (Join-Path $workspaceDir 'assets')
  Note 'workspace' @{ dir = $workspaceDir; assetsPresent = $hasWorkspace }
  if (-not $hasWorkspace -and -not $DryRun) {
    Write-Host '  [3b] 工作区：载荷未包含 workspace/assets（用 --with-runtime 组装才会有）' -ForegroundColor Yellow
  }
  else { Write-Host "  [3b] 工作区：$workspaceDir（assets=$hasWorkspace）" }
}

# ── ④ 自启项（走应用自己的 CLI 入口，保证与卸载回滚同一套代码路径）
$autostartResult = $null
if (-not $NoAutostart -and $failures.Count -eq 0) {
  <#
    自启参数里带上 `--workspace`：安装形态下 `app.isPackaged` **不会**为 true
    （它的依据是"可执行文件是否叫 electron"，而我们是把 electron.exe 改名的），
    应用只能靠这个参数找到 renderer 产物与动作清单。放进取注册表的命令行里，
    排障时能直接看到路径，不用去猜环境变量有没有传进去。
  #>
  $autostartArgs = '--autostart --workspace "' + $InstallDir + '"'
  $args = @('apps\desktop', '--probe', 'a19', '--mutate',
    '--autostart-exe', $exePath, '--autostart-args', $autostartArgs,
    '--probe-out', (Join-Path $env:TEMP 'airimate-install-autostart.json'), '--probe-exit')
  if ($DryRun) {
    Note 'autostart' @{ dryRun = $true; wouldWrite = 'HKCU\...\Run\AiriOne'; target = $exePath }
    Write-Host '  [4/6] 自启项：将写 HKCU\...\Run\AiriOne（干跑）'
  }
  else {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      & (Join-Path $Root 'node_modules\electron\dist\electron.exe') @args 2>&1 | Out-Null
    }
    finally { $ErrorActionPreference = $prev }
    $probeOut = Join-Path $env:TEMP 'airimate-install-autostart.json'
    if (Test-Path -LiteralPath $probeOut) {
      $autostartResult = Get-Content -LiteralPath $probeOut -Raw | ConvertFrom-Json
      Note 'autostart' @{
        ownEntryCount = $autostartResult.ownEntryCount
        legacyEntryCount = $autostartResult.legacyEntryCount
        mutation = $autostartResult.mutation
        runKey = $autostartResult.runKey
      }
      if ($autostartResult.ownEntryCount -ne 1) { Fail "自启项写入后 ownEntryCount=$($autostartResult.ownEntryCount)（应为 1）" }
      if ($autostartResult.legacyEntryCount -ne 0) { Fail "自启项审计发现旧项残留：$($autostartResult.legacyEntryCount)" }
      Write-Host "  [4/6] 自启项：ownEntryCount=$($autostartResult.ownEntryCount) legacyEntryCount=$($autostartResult.legacyEntryCount)（目标 $($autostartResult.mutation.targetExe)）"
    }
    else { Fail "自启探针没有写出结果：$probeOut" }
  }
}
elseif ($NoAutostart) { Write-Host '  [4/6] 自启项：已按 -NoAutostart 跳过' }

# ── ⑤ 快捷方式
$shortcutScript = Join-Path $Root 'tools\qa\shortcut.ps1'
$linkPaths = @{}
if ($failures.Count -eq 0) {
  $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\AiriMate One.lnk'
  $linkPaths['startMenu'] = $startMenu
  $toCreate = @($startMenu)
  if (-not $NoDesktopShortcut) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    if ($desktop) { $linkPaths['desktop'] = (Join-Path $desktop 'AiriMate One.lnk'); $toCreate += $linkPaths['desktop'] }
  }
  $created = @()
  foreach ($lnk in $toCreate) {
    $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $shortcutScript, '-Action', 'create',
      '-Path', $lnk, '-Target', $exePath, '-Arguments', '--mode=panel', '-WorkDir', $InstallDir,
      '-Icon', $exePath, '-Description', 'AiriMate One')
    if ($DryRun) { $a += '-DryRun' }
    $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    try { $out = & powershell.exe @a 2>&1 } finally { $ErrorActionPreference = $prev }
    $ok = $LASTEXITCODE -eq 0
    $created += @{ path = $lnk; ok = $ok; output = ($out | Out-String).Trim() }
    if (-not $ok -and -not $DryRun) { Fail "创建快捷方式失败：$lnk" }
  }
  Note 'shortcuts' @{ links = $linkPaths; results = $created }
  $okCount = @($created | Where-Object { $_.ok }).Count
  $totalCount = @($created).Count
  Write-Host "  [5/6] 快捷方式：$okCount/$totalCount 成功"
}

# ── ⑥ 安装清单（记下"装了什么"，卸载器据此逆操作）
$installManifest = Join-Path $InstallDir 'install-manifest.json'
if ($failures.Count -eq 0) {
  $payload = [ordered]@{
    schema = 'airimate/install-manifest/1'
    installedAt = $startedAt.ToString('o')
    installDir = $InstallDir
    payloadDir = $PayloadDir
    exePath = $exePath
    autostart = if ($autostartResult) { @{ valueName = $autostartResult.ownValueName; target = $autostartResult.mutation.targetExe } } else { $null }
    links = $linkPaths
    userDataDir = (Join-Path $env:APPDATA 'AiriMateOne')
    note = '角色资产（VRM）不在安装内容里：Mate Engine DLC 无独立许可，需使用者自行提供路径'
  }
  if ($DryRun) {
    Note 'manifest' @{ dryRun = $true; wouldWrite = $installManifest }
    Write-Host "  [6/6] 安装清单：将写入 $installManifest（干跑）"
  }
  else {
    try {
      # 用 .NET 写 UTF-8 **无 BOM**：PowerShell 的 Set-Content -Encoding UTF8 会带 BOM，
      # 而 JSON.parse 遇 BOM 会直接抛错（本项目已因此踩过两次）。
      $json = $payload | ConvertTo-Json -Depth 6
      [System.IO.File]::WriteAllText($installManifest, $json, (New-Object System.Text.UTF8Encoding($false)))
      Note 'manifest' @{ path = $installManifest; bytes = (Get-Item -LiteralPath $installManifest).Length; bom = $false }
      Write-Host "  [6/6] 安装清单：$installManifest"
    }
    catch { Fail "写安装清单失败：$($_.Exception.Message)" }
  }
}

$result = [ordered]@{
  schema = 'airimate/install-evidence/1'
  at = (Get-Date).ToString('o')
  dryRun = [bool]$DryRun
  payloadDir = $PayloadDir
  installDir = $InstallDir
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
  Write-Host "安装：PASS$(if ($DryRun) { '（干跑）' })" -ForegroundColor Green
  exit 0
}
else {
  Write-Host '安装：FAIL' -ForegroundColor Red
  $failures | ForEach-Object { Write-Host "  x $_" -ForegroundColor Red }
  exit 1
}
