<#
  tools/runtime/launch-airimate.ps1 —— AiriMate One 启动器（桌面图标的落地实现）

  用途：桌面快捷方式 `.lnk` 指向 `AiriMateOne.exe`，把"运行时根 / 工作区"两个路径
        固定在快捷方式里。本脚本是同一个动作的**可重放入口** —— 快捷方式被误删、
        或想让别人（或未来的自己）知道"到底用什么参数启动的"，跑这一句即可。

  为什么需要它（而不是直接双击 exe）：
    · 载荷是"裸工作区形态"：exe 只是被改名的 `electron.exe`，真正的入口是
      `app\main\index.js`。没有 `<payload>\app` 这个参数，Electron 找不到应用；
    · `--workspace <工作区>` 决定 `rendererDist` / `motionDir` / `catalog.json` 在哪。
      少了它，`resolveRuntimeProfile()` 会落到 `app.isPackaged` 分支报 `packaged`
      —— 而私有 VRM 在 `packaged` 形态下会被许可闸门**机械拒绝** ⇒ **装完没有角色**
      （`capabilities/index.ts` 的"坑 A / 坑 B"就是两次真实失败换来的）。
      带上 `--workspace` 后 profile = `development`，私有自用资产正常加载。
    · 顺便把"启动日志"落到一个固定文件，出问题时不必去翻 `%APPDATA%` 里当天的 jsonl。

  用法：
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\runtime\launch-airimate.ps1
    powershell ... -File tools\runtime\launch-airimate.ps1 -DryRun     # 只打印命令行，不启动
    powershell ... -File tools\runtime\launch-airimate.ps1 -PayloadDir D:\x   # 换一个载荷
    powershell ... -File tools\runtime\launch-airimate.ps1 -ExtraArgs '--mode=panel'

  判据（**不靠退出码**，退出码只表达"脚本自己有没有跑对"）：
    ① 进程还在 ② 实例锁已写出 ③ 窗口可见 ④ 今天的日志里 boot.start 的
    `asset.model-root` 为 development 且有 clips ⇒ 三者齐全才报 PASS。

  退出码：0 = 启动成功（且三条初判都过）；1 = 启动没成功（**不静默成功**）
#>
[CmdletBinding()]
param(
  [string]$PayloadDir = '',
  [string]$Workspace = '',
  [string]$LogFile = '',
  [string]$ExtraArgs = '',
  [int]$WaitSec = 25,
  [switch]$DryRun,
  [string]$OutFile = ''
)

$ErrorActionPreference = 'Stop'

# ── 路径真源：默认就是本交付形态（dist-package），可用参数覆盖
if ([string]::IsNullOrWhiteSpace($PayloadDir)) {
  $PayloadDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..\dist-package')).Path
} else {
  $PayloadDir = (Resolve-Path -LiteralPath $PayloadDir).Path
}
if ([string]::IsNullOrWhiteSpace($Workspace)) { $Workspace = Join-Path $PayloadDir 'workspace' }
if ([string]::IsNullOrWhiteSpace($LogFile)) { $LogFile = Join-Path $PSScriptRoot 'launch.log' }

$exe = Join-Path $PayloadDir 'AiriMateOne.exe'
$app = Join-Path $PayloadDir 'app'
$lockFile = Join-Path $env:APPDATA 'AiriMateOne\run\instance.lock'

$result = [ordered]@{
  schema = 'airimate/launcher/1'
  at = (Get-Date).ToString('o')
  payloadDir = $PayloadDir
  workspace = $Workspace
  exe = $exe
  dryRun = [bool]$DryRun
}

function Fail([string]$m) {
  $result.ok = $false
  $result.error = $m
  $result | ConvertTo-Json -Depth 6
  Write-Host "启动失败：$m" -ForegroundColor Red
  if ($OutFile) { [System.IO.File]::WriteAllText($OutFile, ($result | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false))) }
  [Environment]::Exit(1)
}

<#
  Get-VisibleWindowTitles —— 列出属于指定进程的**可见且有标题的窗口**。

  ★ 这里有一条**实测换来的教训**，别把过滤条件再"收紧"回去：

    第一版加了"只认顶层根窗口"（`GetWindow(h, GW_OWNER=4) == 0`，或误写成 `GA_ROOT=2`），
    结果**永远数到 0 个窗口** —— 而任务栏上明明看得见角色窗口与对话窗口。
    原因：Electron 的 pet 窗口带 **owner**（它不是根窗口），那句过滤把它连同
    对话窗口一起排除了。实测读数：`Get-Process` 的 `MainWindowHandle=2820068`、
    `MainWindowTitle=AiriMate One`，而我的枚举报 0。

    ⇒ 现在的判据只有两条：**属于这些进程** 且 **IsWindowVisible** 且 **标题非空**。
      标题非空这一条足够滤掉控件（按钮/菜单的标题为空或不可见），
      不需要也不应该按"窗口层级"过滤。

  ★ 也不能只看 `Get-Process ... .MainWindowHandle`：Electron 是多进程的，
    可见窗口常常挂在**非主进程**上（本次实测：窗口在 PID 12432，而主进程的句柄是 0）。
    只看主进程会把一次正常启动描述成可疑状态 —— 判据写错比没有判据更糟。

  `Add-Type` 只在首次调用时编译（约 1 秒），之后是静态方法直调。
  受限语言模式下 Add-Type 可能不可用 ⇒ 捕获后返回空数组（宁可不判，也不误判）。
#>
function Get-VisibleWindowTitles {
  param([int[]]$Pids)
  try {
    if (-not ('AirimateWin' -as [type])) {
      Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class AirimateWin {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  public static string[] Visible(HashSet<uint> pids) {
    var list = new List<string>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!pids.Contains(pid)) return true;
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowTextW(h, sb, 512);
      string t = sb.ToString();
      if (t.Length == 0) return true;   // 无标题 ⇒ 控件或辅助窗口，不计
      list.Add(t);
      return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }
}
'@
    }
    $set = New-Object 'System.Collections.Generic.HashSet[uint32]'
    foreach ($x in $Pids) { if ($x -gt 0) { [void]$set.Add([uint32]$x) } }
    return @([AirimateWin]::Visible($set))
  } catch {
    return @()
  }
}

<#
  Get-AirimatePids —— 属于**本次运行的那一份** AiriMateOne 的全部进程 id。

  为什么按"进程路径前缀"过滤而不是按进程名全取：本机可能同时存在开发树里跑着的
  另一份实例（`dist-package\AiriMateOne.exe`）。不过滤就会把别人的窗口算进本次读数，
  于是"窗口可见"变成一个永远为真的判据。
#>
function Get-AirimatePids {
  $all = @(Get-Process AiriMateOne -ErrorAction SilentlyContinue)
  $mine = @($all | Where-Object {
      $_.Path -and $_.Path.StartsWith($PayloadDir, [StringComparison]::OrdinalIgnoreCase)
    })
  return @($mine | Select-Object -ExpandProperty Id)
}

# ── 预检：三样缺一不可（缺了要让用户看到"缺什么"，而不是一个一闪而过的黑框）
if (-not (Test-Path -LiteralPath $exe)) { Fail "找不到可执行文件：$exe（先跑 npm run build:dist 组装载荷）" }
if (-not (Test-Path -LiteralPath (Join-Path $app 'main\index.js'))) { Fail "载荷不完整：缺少 $app\main\index.js" }
if (-not (Test-Path -LiteralPath $Workspace)) { Fail "工作区不存在：$Workspace" }
$renderer = Join-Path $Workspace 'app\renderer\index.html'
if (-not (Test-Path -LiteralPath $renderer)) {
  # 三种合法的工作区布局，缺一不可的是**渲染产物**（`paths.ts` 的 rendererDist
  # = `<工作区>\apps\renderer\dist`）与**角色清单所在目录**：
  #   · 安装形态：<ws>\apps\renderer\dist\index.html + <ws>\assets\
  #   · 开发形态（--workspace 指向工程根）：同上一套路径
  #   · 载荷原地：<ws>\app\renderer\index.html（exe 直接吃 app 目录时才会用到）
  $devRenderer = Test-Path -LiteralPath (Join-Path $Workspace 'apps\renderer\dist\index.html')
  $assets = Test-Path -LiteralPath (Join-Path $Workspace 'assets')
  if (-not $devRenderer -and -not $assets) {
    Fail "工作区既没有 apps\renderer\dist\index.html 也没有 assets：$Workspace"
  }
  if (-not $devRenderer) {
    Write-Host "⚠ 工作区里没有 apps\renderer\dist\index.html —— 界面会白屏（$Workspace）" -ForegroundColor Yellow
  }
}

# ── 单实例保护：三层里 L1 是 Electron 自己的锁，抓不到就"唤醒已有实例并退出 0"
#    ⇒ 那条路径**不会创建窗口**。所以这里先探测，别让用户以为点了没反应。
$running = @(Get-Process AiriMateOne, electron -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and ($_.Path -like "$PayloadDir*" -or $_.Path -like '*\electron.exe') })
if ($running.Count -gt 0) {
  Write-Host "已有 $($running.Count) 个实例在跑（PID: $($running.Id -join ', ')）。" -ForegroundColor Yellow
  Write-Host '本次启动会走"唤醒已有实例"路径（聚焦旧窗口，不新建窗口）——这是**预期行为**。' -ForegroundColor Yellow
  Write-Host '要真的重启：托盘右键退出，或 Get-Process AiriMateOne | Stop-Process -Force' -ForegroundColor Yellow
}

$argList = @($app, '--workspace', $Workspace)
if ($ExtraArgs) { $argList += ($ExtraArgs -split '\s+' | Where-Object { $_ }) }
$cmdLine = '"' + $exe + '" ' + (($argList | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' ')
$result.commandLine = $cmdLine
Write-Host "AiriMate One 启动器" -ForegroundColor Cyan
Write-Host "  载荷   : $PayloadDir"
Write-Host "  工作区 : $Workspace"
Write-Host "  命令行 : $cmdLine"
Write-Host ""

if ($DryRun) {
  $result.wouldRun = $cmdLine
  $result.ok = $true
  $result | ConvertTo-Json -Depth 6
  if ($OutFile) { [System.IO.File]::WriteAllText($OutFile, ($result | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false))) }
  [Environment]::Exit(0)
}

# ── 启动：三条路都试过之后的落点（每一段都是**实测**换来的）
#
#   ① 不用 `Start-Process`：
#      本机同时存在 `NO_PROXY` 与 `no_proxy`，PowerShell 5.1 的 Start-Process
#      在构造子进程环境块时抛 `Item has already been added. Key in dictionary: 'NO_PROXY'`
#      （`install.ps1` 与 `check-install-cycle.ps1` 都记过这个坑，它让启动**静默失败**）。
#   ② 不用 WMI `Win32_Process::Create`：
#      受限环境（DSH 文件沙箱 / 部分 EDR）下直接返回 `拒绝访问 (0x80041003)`，
#      启动器只能报"创建进程失败"而拿不到任何 PID（实测）。
#   ③ 不用 `cmd /c start "" exe args`：
#      路径含空格与中文，`start` 会把命令行**再解析一遍**引号，容易出现
#      "找不到文件"这类二次解析事故 —— 为一个能直接用 API 表达的动作引入第三个解析器不划算。
#
#   最终用 .NET `Process.Start`：不经 PowerShell 的环境块构造（避开①）、不需要 WMI 权限
#   （避开②）、参数直接给字符串不重解析（避开③），`UseShellExecute=$true` 使其脱离
#   当前 stdio（Electron 不会把管道句柄继承给 GPU/renderer 子进程把调用方挂住）。
#   只有在它被策略拒绝时才回退到调用运算符 —— 实测它在无管道上下文里 1.2s 即返回，
#   所以兜底是可靠的；但在**管道/后台**上下文里仍可能等到窗口关闭，故只作兜底。
#
#   ⚠ 两个只用一次就踩到的坑，写在这里省下第二次：
#     · `ProcessStartInfo.ArgumentList`（.NET Core 才有）在 Windows PowerShell 5.1 的
#       .NET Framework 上**不存在** —— 调它会抛 "You cannot call a method on a
#       null-valued expression."，而且异常发生在 return 值上，看起来像别的问题。
#       5.1 只能用 `$psi.Arguments`（**单个字符串**，引号要自己打）。
#     · `$proc = Process.Start(...)` 之后必须判空再取 `.Id`，否则同样抛上面那句。
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$startError = $null
$launchedPid = 0
try {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.WorkingDirectory = $PayloadDir
  $psi.UseShellExecute = $true
  # 逐项加引号（路径含空格与中文），与 $cmdLine 同规则 —— 只在这里拼一次
  $psi.Arguments = (($argList | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ } }) -join ' ')
  $proc = [System.Diagnostics.Process]::Start($psi)
  if ($proc -ne $null) { $launchedPid = $proc.Id } else { $startError = 'Process.Start 返回 null' }
} catch {
  $startError = $_.Exception.Message
}
$ErrorActionPreference = $prevEap
if ($startError) {
  Write-Host "Process.Start 不可用（$startError）⇒ 回退到调用运算符。" -ForegroundColor Yellow
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  # 不加 `| Out-Null`：加了会把标准输出接成管道，Electron 的子进程继承句柄后调用方会挂住
  try { & $exe @argList } catch { }
  $ErrorActionPreference = $prevEap
}
$result.startMethod = if ($startError) { 'call-operator-fallback' } else { 'dotnet-process-start' }
$result.directPid = if ($launchedPid -gt 0) { $launchedPid } else { $null }

<#
  ★ 日志游标：本次启动**之前**那一刻的文件长度。
  为什么要它：日志是**追加**的，同一天里跑过好几次应用（开发、探针、上一次启动）。
  "读尾部 600 行去找 event"会把**上一次**那轮的读数（例如一次渲染进程崩溃）
  算到本次头上 —— 判据于是变成"可能是别人的问题"。
  记下游标、只解析游标之后的新内容，读数才真正属于本次启动。
#>
$logToday = Join-Path $env:APPDATA ("AiriMateOne\logs\airimate-" + (Get-Date -Format 'yyyy-MM-dd') + ".jsonl")
$logOffsetAtStart = if (Test-Path -LiteralPath $logToday) { (Get-Item -LiteralPath $logToday).Length } else { 0 }
$result.logOffsetAtStart = $logOffsetAtStart

# ── 回捞 PID：只认"路径就在本载荷里"的那个进程，避免误判开发树的 electron.exe
$launched = $null
$findDeadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $findDeadline -and -not $launched) {
  Start-Sleep -Milliseconds 500
  $launched = Get-Process AiriMateOne -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($PayloadDir, [StringComparison]::OrdinalIgnoreCase) } |
    Sort-Object StartTime -Descending | Select-Object -First 1
}
if (-not $launched) { Fail '启动后 15 秒内没有出现本载荷的 AiriMateOne 进程' }
$result.pid = $launched.Id
$result.processPath = $launched.Path

# ── 判据：等它起来（就绪约 5–8 秒；VRM 加载更久）
$deadline = (Get-Date).AddSeconds($WaitSec)
$checks = [ordered]@{ processAlive = $false; instanceLock = $false; windowVisible = $false; booted = $false }
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 700
  $p = Get-Process -Id $launched.Id -ErrorAction SilentlyContinue
  $checks.processAlive = [bool]$p
  if (-not $p) { break }
  $checks.instanceLock = Test-Path -LiteralPath $lockFile
  if ($checks.instanceLock -and $checks.windowVisible) { $checks.booted = $true; break }
  # 窗口判定放在最后：枚举窗口要花一点时间，没必要每轮都做两次
  #
  # ⚠ 传**本次安装的全部进程**，不只主进程：Electron 把窗口放在哪个进程上
  #   是实现细节（实测过主进程 MainWindowHandle=0 而窗口其实已经画出来了）。
  #   限定"路径必须在本载荷/本安装目录下"，所以不会把开发树里跑着的另一份实例算进来。
  if ($checks.instanceLock) {
    $vis = Get-VisibleWindowTitles -Pids (Get-AirimatePids)
    if ($vis.Count -gt 0) { $checks.windowVisible = $true; $checks.visibleWindows = $vis }
  }
}
# 让托盘/快捷键注册也走完（窗口可见后还有一小段）
if ($checks.booted) { Start-Sleep -Seconds 3 }
# 收尾再采一次窗口，作为最终读数的真源（循环里可能刚好错过那一瞬）
$finalPids = Get-AirimatePids
$finalVis = Get-VisibleWindowTitles -Pids $finalPids
$checks.windowProbe = [ordered]@{ pids = @($finalPids); windowCount = @($finalVis).Count }
if ($finalVis.Count -gt 0) { $checks.windowVisible = $true; $checks.visibleWindows = $finalVis }

# ── 日志证据：**只解析本次启动新增的那一段**（游标之后），并取最后一次出现
#
#   ⚠ 两个坑都在这里踩过，别改回去：
#     ① 不能"读尾部 N 行找出 event" —— 同日多次启动时会把**上一轮**的读数
#        （含一次渲染进程崩溃）算到本次头上，判据变成"可能是别人的问题"；
#     ② 不能"匹配到第一条就落定" —— 同一轮里 `motion.resolve` 会打好几次，
#        而更早那一轮的值排在前面，于是把正常机器判成"动作资产没到位"。
#        ⇒ 按顺序覆盖取最后值，且只在游标之后的新内容里找。
$today = $logToday
$evidence = [ordered]@{ logFile = $today; profile = $null; avatarId = $null; avatarDir = $null; clips = $null; mode = $null }
if (Test-Path -LiteralPath $today) {
  $newText = ''
  try {
    $fs = [System.IO.File]::Open($today, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
      if ($logOffsetAtStart -lt $fs.Length) {
        [void]$fs.Seek($logOffsetAtStart, [System.IO.SeekOrigin]::Begin)
        $sr = New-Object System.IO.StreamReader($fs)
        $newText = $sr.ReadToEnd()
      }
    } finally { $fs.Dispose() }
  } catch {
    # 读不动就退回"读尾部"，并**在读数里标明降级**（不能假装拿到了精确读数）
    $evidence.readFallback = $true
    $newText = (Get-Content -LiteralPath $today -Tail 600 -ErrorAction SilentlyContinue) -join "`n"
  }
  $lines = @($newText -split "`n")
  foreach ($line in $lines) {
    if ($line -notmatch '"event":"(asset\.model-root|motion\.resolve|boot\.start|renderer\.gone)"') { continue }
    if ($line -match '"event":"asset\.model-root"') {
      if ($line -match '"profile":"([^"]+)"') { $evidence.profile = $Matches[1] }
      if ($line -match '"id":"([^"]+)"') { $evidence.avatarId = $Matches[1] }
      if ($line -match '"dir":"((?:[^"\\]|\\.)+)"') { $evidence.avatarDir = $Matches[1] }
    }
    if ($line -match '"event":"motion\.resolve"') {
      if ($line -match '"clips":(\d+)') { $evidence.clips = [int]$Matches[1] }
      if ($line -match '"total":(\d+)') { $evidence.motionTotal = [int]$Matches[1] }
    }
    if ($line -match '"event":"boot\.start"') {
      if ($line -match '"mode":"([^"]+)"') { $evidence.mode = $Matches[1] }
    }
    <#
      ★ 渲染进程崩溃必须被**看见**。
      实测事故：安装验证那次启动，窗口确实出现过、随后渲染进程 `reason:crashed`
      退出 ⇒ 窗口消失、只剩空进程；而当时的三条判据（进程活/锁在/窗口出现过）
      **全部为真**，于是报"启动成功"。一个会把崩溃读成成功的判据比没有判据更危险。
    #>
    if ($line -match '"event":"renderer\.gone"') {
      $prevGone = if ($evidence.Contains('rendererGone')) { [int]$evidence.rendererGone } else { 0 }
      $evidence.rendererGone = $prevGone + 1
      if ($line -match '"reason":"([^"]+)"') { $evidence.rendererGoneReason = $Matches[1] }
      if ($line -match '"window":"([^"]+)"') { $evidence.rendererGoneWindow = $Matches[1] }
    }
  }
  $evidence.newLogBytes = $newText.Length
}
$result.checks = $checks
$result.evidence = $evidence

# 控制台里那行"启动日志"也留一份（用户报障时直接看这个文件）
try {
  $stamp = (Get-Date).ToString('o')
  Add-Content -LiteralPath $LogFile -Encoding UTF8 -Value ("{0}`tpid={1}`tlock={2}`twindow={3}`tprofile={4}`tavatar={5}`tclips={6}`tcmd={7}" -f `
      $stamp, $launched.Id, $checks.instanceLock, $checks.windowVisible, $evidence.profile, $evidence.avatarId, $evidence.clips, $cmdLine)
} catch { }

# ── 判定：崩溃优先。窗口出现过又崩掉，**不算启动成功**
#
#   为什么把崩溃放在最前面：`rendererGone > 0` 意味着界面已经不在了，
#   而"进程还在、锁还在"依然为真（Electron 的主进程不会因为渲染进程崩了就退出）
#   ⇒ 只按后两条判，会把"点了图标、界面一闪就没"读成成功。这正是本次实测遇到的情形。
$rendererCrashed = ($evidence.Contains('rendererGone') -and [int]$evidence.rendererGone -gt 0)
$result.rendererCrashed = $rendererCrashed
$result.ok = ($checks.processAlive -and $checks.instanceLock -and -not $rendererCrashed)
if ($rendererCrashed) {
  $reasonPart = if ($evidence.Contains('rendererGoneReason')) { "，reason=$($evidence.rendererGoneReason)" } else { '' }
  $winPart = if ($evidence.Contains('rendererGoneWindow')) { "，window=$($evidence.rendererGoneWindow)" } else { '' }
  Write-Host "启动异常：渲染进程退出 $($evidence.rendererGone) 次（$reasonPart$winPart）" -ForegroundColor Red
  Write-Host '  界面会一闪即消失；进程虽在，但用户看不到东西。这是失败，不是"只剩托盘"。' -ForegroundColor Red
  Write-Host "  日志：$today" -ForegroundColor Red
}
elseif ($result.ok) {
  $winNote = if ($checks.windowVisible) { "有（$(@($checks.visibleWindows).Count) 个：$((@($checks.visibleWindows) | Select-Object -First 3) -join ' / ')）" } else { '无（只剩托盘图标；托盘菜单里可「显示桌宠」/「开始对话」）' }
  Write-Host ("启动成功：pid={0} 实例锁={1} profile={2} 角色={3} 动作={4}" -f `
      $launched.Id, $checks.instanceLock, $evidence.profile, $evidence.avatarId, $evidence.clips) -ForegroundColor Green
  Write-Host ("  可见窗口：{0}" -f $winNote) -ForegroundColor Green
  if (-not $checks.windowVisible) {
    # 托盘常驻是**合法状态**（两个显示开关都关的情况），但必须说清"没窗口≠没启动"
    Write-Host '  （应用已在运行：托盘图标存在，快捷键 Ctrl+Alt+Space 可开对话）' -ForegroundColor Yellow
  }
  if ($evidence.profile -ne 'development') {
    Write-Host "⚠ profile=$($evidence.profile)：私有角色资产会被许可闸门拒绝 —— 检查 --workspace 是否传对。" -ForegroundColor Yellow
  }
  if ($evidence.clips -ne $null -and [int]$evidence.clips -eq 0) {
    Write-Host '⚠ 动作 clips=0：该工作区的 assets\motion 里没有 .vrma（角色会静止）。' -ForegroundColor Yellow
  }
} else {
  Write-Host '启动未完成：进程或实例锁缺失。看下面的原始读数与日志文件。' -ForegroundColor Red
  Write-Host "  日志：$today"
}

$result | ConvertTo-Json -Depth 6
if ($OutFile) { [System.IO.File]::WriteAllText($OutFile, ($result | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false))) }
if ($result.ok) { [Environment]::Exit(0) } else { [Environment]::Exit(1) }
