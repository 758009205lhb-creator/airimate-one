<#
  tools/qa/chatwindow-shots.ps1 —— 「独立对话窗口」的**真实桌面截图取证**（2026-10-08 返工轮）

  为什么需要它（而不是让探针自己截）：
    探针在进程内只能 `capturePage()`（单窗口截图）；而验收要的是**真实桌面全屏截图**
    —— 必须能一眼看出"桌宠与聊天框是两个各自独立的窗口"（各自有标题栏、能分别拖动）。
    桌面截图只能由进程外的 PowerShell 用 `CopyFromScreen` 做，但它不知道
    "气泡现在正显示着""chat 窗口刚被拖过"这种**时刻**。
    于是用一对哨兵文件把时间点交给它（探针侧有 12s 超时，没有观察者也不会卡死）：

      探针写 `<前缀>-<label>.ready`  →  本脚本截图并写 `<前缀>-<label>.done`  →  探针继续

  五张必需截图（对应验收判据 §7.8）：
    ① pet-running     桌宠运行中（此时 chat 窗口还没创建 ⇒ 窗口内无任何输入框）
    ② chat-centered   chat 窗口刚打开（居中）
    ③ chat-dragged    拖动 chat 窗口之后（位置变了，pet 窗口没动）
    ④ chat-closed     关闭 chat 窗口之后（桌宠仍正常）
    ⑤ bubble-visible  气泡显示中（含「看完整对话 →」入口）

  顺带取证"两个独立窗口"的**桌面枚举**（第 3 方读数，与探针自报互相独立）：
    用 `Get-DesktopState.ps1` 枚举顶层窗口 + 归属判定，拿到
    `counts.mineVisibleWindows / mineCharacterVisibleWindows / mineChatVisibleWindows`。

  纪律：只读；不结束任何进程（除清理**本工程**遗留的 electron 实例）；
        不点击、不移动窗口；截图落在 `<OutDir>\screens\`。

  用法（PowerShell 5.1）：
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\chatwindow-shots.ps1 `
      -OutDir docs\evidence\phase16 -TimeoutSec 420
#>
[CmdletBinding()]
param(
  [string]$OutDir = '',
  [int]$TimeoutSec = 420,
  <#
    `-MinimizeOthers`：截图前把其它可见顶层窗口最小化（拍完还原）。

    ⚠ **默认关闭**（2026-10-08 实测教训，必须留档）：
      我原本让它**默认**让开其它窗口，结果在一次取证时把用户正在跑的游戏
      （`DeltaForceClient-Win64-Shipping` / 三角洲行动）**最小化了**。
      一个 QA 取证脚本去动用户的其它应用，是不可接受的副作用 ——
      哪怕"拍完会还原"，最小化本身就已经打断了他正在做的事。

    ⇒ 改成：默认**什么都不动**，只截真实桌面；确实需要干净桌面时由人显式加这个开关，
      并且**永远不会**去动游戏/全屏类进程（见下面的 `$NeverTouch` 名单）。
  #>
  [switch]$MinimizeOthers,
  # `-RaiseOurWindows`：截图前把**我们自己的**两个窗口抬到最前（截完还原置顶状态）。
  #   默认**关闭**。它只碰标题以 `AiriMate One` 开头的窗口，绝不碰其它进程的窗口。
  #   用途：桌面被别的窗口（含全屏应用）压住时，让"两个独立窗口"这件事在截图里看得见。
  [switch]$RaiseOurWindows
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $root 'package.json'))) { $root = 'F:\deepseek harness\AI女友\新工程' }
if (-not $OutDir) { $OutDir = Join-Path $root 'docs\evidence\phase16' }
if (-not [System.IO.Path]::IsPathRooted($OutDir)) { $OutDir = Join-Path $root $OutDir }
$screens = Join-Path $OutDir 'screens'
$null = New-Item -ItemType Directory -Force -Path $screens
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$prefix = Join-Path $screens "chatwindow-$stamp"
$jsonOut = Join-Path $OutDir 'chatwindow.json'

$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$appDir = Join-Path $root 'apps\desktop'

# ── DPI 感知：不设的话 CopyFromScreen 在 125% 缩放下会整体偏移（见 Get-DesktopState.ps1 的注释）
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DpiFix3 {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static void Apply() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }
    try { if (SetProcessDpiAwareness(2) == 0) return; } catch { }
    try { SetProcessDPIAware(); } catch { }
  }
}
'@
[DpiFix3]::Apply()
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

<#
  ── ★ 把**我们自己的**窗口抬到最前（`-RaiseOurWindows`，2026-10-08 返工轮新增）

  为什么需要它：
    验收要求"五张真实桌面截图，必须能看出是两个独立窗口"。
    而 `CopyFromScreen` 抓的是**屏幕像素** —— 只要我们的窗口被别的窗口压住，
    图里就只有遮挡物。前两次取证分别被 `Deepseek Harness Desktop` 与
    用户的全屏游戏挡住了。

  为什么**不能**靠"最小化其它窗口"解决（已经错过一次）：
    那会动到用户正在用的应用（实测把他在跑的游戏最小化了）。**不可接受**。

  ⇒ 正确做法：**只动我们自己的窗口** —— 把 `AiriMate One*` 两个窗口临时设为
    `HWND_TOPMOST` 并 `SetWindowPos` 提到最前，截完立刻还原成原先的置顶状态。
    全程 ① 只碰标题以 `AiriMate One` 开头的窗口；② 不碰任何其它进程的窗口；
    ③ 不做最小化/移动/改尺寸；④ 还原是必做步骤（`finally`）。

  ⚠ 如实说明它的**能力边界**：独占全屏（exclusive fullscreen）的应用位于
    比 `HWND_TOPMOST` 更高的合成层，这种情况下抬不动 —— 那就如实记为
    "该环境不满足取证条件"，不硬凑、也不去动游戏。
#>
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public class WinRaise {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
  public const uint SWP_NOMOVE = 0x0002, SWP_NOSIZE = 0x0001, SWP_NOACTIVATE = 0x0010, SWP_SHOWWINDOW = 0x0040;
  public const int GWL_EXSTYLE = -20;
  public const int WS_EX_TOPMOST = 0x00000008;
  public class Row { public long hwnd; public string title; public bool wasTopmost; }
  /** 标题以 prefix 开头的可见顶层窗口（只认标题，绝不按进程名动别的应用） */
  public static List<Row> Mine(string prefix) {
    var res = new List<Row>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var t = new StringBuilder(512); GetWindowTextW(h, t, 512);
      string title = t.ToString();
      if (!title.StartsWith(prefix)) return true;
      var r = new Row();
      r.hwnd = h.ToInt64(); r.title = title;
      r.wasTopmost = (GetWindowLong(h, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
      res.Add(r);
      return true;
    }, IntPtr.Zero);
    return res;
  }
  /** 抬到最前（先 TOPMOST 再 NOTOPMOST 可以把它提到**非置顶**窗口之最前） */
  public static void Raise(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
  }
  /** 还原：原先不是置顶的，就退回 NOTOPMOST */
  public static void Restore(long hwnd, bool wasTopmost) {
    IntPtr h = new IntPtr(hwnd);
    if (wasTopmost) SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    else SetWindowPos(h, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  }
  /**
   * ★ 抬完之后**如实核对**：这个 hwnd 到底有没有真的跑到最前？
   *
   * 为什么必须核对（而不是"调了 API 就算抬起来了"）：
   *   ① 独占全屏 / 更高合成层的应用压着时，`SetWindowPos(HWND_TOPMOST)` **会返回成功但抬不动**；
   *   ② `WS_EX_TOPMOST` 只是"置顶层"标志，不等于"在屏幕上可见"。
   *   不核对就会把"没抬起来"写成"拍了但看不到"，归因方向就跑偏了。
   * 这里返回给调用方，最终原样写进证据 JSON（`raiseChecks`）。
   */
  public static string Check(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    var t = new StringBuilder(512); GetWindowTextW(h, t, 512);
    bool topmost = (GetWindowLong(h, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
    RECT r; GetWindowRect(h, out r);
    return string.Format("title='{0}' visible={1} topmost={2} rect={3}x{4}+{5}+{6}",
      t.ToString(), IsWindowVisible(h), topmost, r.R - r.L, r.B - r.T, r.L, r.T);
  }
}
'@

<#
  ── 遮挡问题（2026-10-08 实测，必须留档）

  第一次跑出来的五张截图里**看不到本应用的任何窗口** ——
  不是窗口没显示（桌面枚举证明 `visible=True`、尺寸正确），而是它被
  `Deepseek Harness Desktop`（1294×848，几乎铺满整个工作区）压在了下面。
  `CopyFromScreen` 抓的是**屏幕像素**，被盖住的东西不会出现在图里。

  ⇒ 取证前把其它可见顶层窗口最小化，拍完立刻还原。
    只动这一次会话里的窗口；不结束任何进程，不改任何窗口的位置与尺寸。
#>
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public class WinGuard {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();

  public class Row { public long hwnd; public string title; public string cls; public uint pid; }
  public static List<Row> VisibleTopLevel() {
    var res = new List<Row>();
    IntPtr shell = GetShellWindow(); IntPtr desk = GetDesktopWindow();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      if (h == shell || h == desk) return true;
      if (IsIconic(h)) return true;                     // 已经最小化的不用管
      var r = new Row(); r.hwnd = h.ToInt64();
      var t = new StringBuilder(512); GetWindowTextW(h, t, 512); r.title = t.ToString();
      var c = new StringBuilder(256); GetClassNameW(h, c, 256); r.cls = c.ToString();
      uint pid; GetWindowThreadProcessId(h, out pid); r.pid = pid;
      res.Add(r);
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
'@

<#
  需要让开的窗口 = "其它可见顶层窗口"，但**排除**：
    · 本应用自己的窗口（标题以 AiriMate One 开头）—— 它们才是被拍的对象；
    · 桌面 / 任务栏（`Progman` / `Shell_TrayWnd` / `WorkerW`）；
    · 本脚本自己的进程；
    · ★ **游戏与全屏类进程**（`$NeverTouch`）—— 用户正在玩的东西一律不碰。
  返回被最小化的窗口列表，供还原；同时把清单写进证据，让"动过哪些窗口"可复核。
#>
$NeverTouch = @(
  'DeltaForceClient', 'DeltaForce', 'wegame', 'Tencent', 'steam', 'Steam',
  'EpicGames', 'Battle.net', 'GenshinImpact', 'YuanShen', 'WeGameApps'
)
function Hide-OtherWindows {
  param([int]$SelfPid, [string[]]$KeepTitles = @('AiriMate One'))
  $hidden = @()
  foreach ($w in [WinGuard]::VisibleTopLevel()) {
    if ($w.pid -eq $SelfPid) { continue }
    if ($w.cls -eq 'Progman' -or $w.cls -eq 'Shell_TrayWnd' -or $w.cls -eq 'WorkerW') { continue }
    $keep = $false
    foreach ($k in $KeepTitles) { if ($w.title -like "$k*") { $keep = $true } }
    if ($keep) { continue }
    # 不碰游戏/全屏类进程
    $pname = ''
    try { $pname = (Get-Process -Id $w.pid -ErrorAction Stop).ProcessName } catch { $pname = '' }
    $isGame = $false
    foreach ($n in $NeverTouch) { if ($pname -like "*$n*") { $isGame = $true } }
    if ($isGame) { continue }
    # 无标题的（多为工具窗口）也一起让开
    $null = [WinGuard]::ShowWindow([IntPtr]$w.hwnd, 6)   # SW_MINIMIZE
    $hidden += $w
  }
  return $hidden
}

function Restore-Windows {
  param($Hidden)
  foreach ($w in $Hidden) {
    try { $null = [WinGuard]::ShowWindow([IntPtr]$w.hwnd, 9) } catch { }   # SW_RESTORE
  }
}

function Save-DesktopShot {
  param([string]$Path, [int]$SelfPid, [bool]$ClearOthers = $true, [bool]$RaiseOurs = $false)
  $restore = @()
  $raised = @()
  if ($ClearOthers) {
    $restore = Hide-OtherWindows -SelfPid $SelfPid
    Start-Sleep -Milliseconds 450          # 等 DWM 把最小化动画画完，避免拍到半透明残影
  }
  if ($RaiseOurs) {
    # ★ 只抬我们自己的窗口（标题前缀），并记下原置顶状态以便还原
    foreach ($w in [WinRaise]::Mine('AiriMate One')) {
      [WinRaise]::Raise($w.hwnd)
      $raised += $w
    }
    Start-Sleep -Milliseconds 350          # 等 DWM 重排 z 序
    # 如实核对：抬完之后每个窗口的真实状态（会写进证据 JSON）
    $script:raiseChecks += @($raised | ForEach-Object { [WinRaise]::Check($_.hwnd) })
  }
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $g.Dispose()
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  if ($raised.Count -gt 0) {
    foreach ($w in $raised) { try { [WinRaise]::Restore($w.hwnd, $w.wasTopmost) } catch { } }
  }
  if ($ClearOthers) { Restore-Windows -Hidden $restore }
  return (Get-Item $Path).Length
}

function Clear-AirimateLeftovers {
  param([int]$Self)
  $targets = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*新工程*' -and $_.ProcessId -ne $Self })
  foreach ($p in $targets) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  $keepers = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*MutexKeeper*' -and $_.ProcessId -ne $Self })
  foreach ($p in $keepers) {
    $alive = $false
    try { $null = Get-Process -Id $p.ParentProcessId -ErrorAction Stop; $alive = $true } catch { $alive = $false }
    if (-not $alive) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  $lock = Join-Path $env:APPDATA 'AiriMateOne\run\instance.lock'
  if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue }
}

Clear-AirimateLeftovers -Self $PID
Get-ChildItem $screens -Filter 'chatwindow-*.ready' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem $screens -Filter 'chatwindow-*.done' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
if (Test-Path $jsonOut) { Remove-Item $jsonOut -Force }

Write-Output "[chatwindow-shots] 启动探针 chatwindow（截图前缀：$prefix）"
<#
  ⚠ 参数拼成**一个字符串**交给 `Start-Process`（与 run-probe.ps1 同一个坑）：
  逐元素传数组时 PowerShell 会再解析一次，`--no-proactive` 会变成 `-no-proactive`，
  应用侧白名单校验直接拒绝启动 —— 探针不产出任何东西。
#>
$argList = @(
  "`"$appDir`"", '--dev', '--mode=pet', '--no-dialogs', '--no-proactive',
  '--probe', 'chatwindow', '--probe-out', "`"$jsonOut`"", '--probe-shot', "`"$prefix`"", '--probe-exit'
)
$proc = Start-Process -FilePath $electron -PassThru -ArgumentList ($argList -join ' ')

$t0 = Get-Date
$handled = @{}
$desktopStateDone = $false
$desktopStateFile = ''
$report = @()
# ★ `-RaiseOurWindows` 的核对读数（每次抬起后实测的真实状态，原样进证据）
$script:raiseChecks = @()

while (-not $proc.HasExited -and ((Get-Date) - $t0).TotalSeconds -lt $TimeoutSec) {
  $readyFiles = @(Get-ChildItem $screens -Filter 'chatwindow-*.ready' -ErrorAction SilentlyContinue)
  foreach ($rf in $readyFiles) {
    $label = ($rf.BaseName -replace '^chatwindow-\d{8}-\d{6}-', '')
    if ($handled.ContainsKey($label)) { continue }
    $handled[$label] = $true

    # 「两个独立窗口」的第三方桌面枚举：在 chat 可见的那几张上各做一次（只读，含自己的截图）
    if (-not $desktopStateDone -and ($label -eq 'chat-centered' -or $label -eq 'chat-dragged')) {
      $desktopStateDone = $true
      try {
        $before = @(Get-ChildItem $OutDir -Filter 'desktop-state-*.json' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
        # 枚举与截图同样遵守 -MinimizeOthers（默认不动任何其它窗口）
        $hidden = @()
        if ($MinimizeOthers) { $hidden = Hide-OtherWindows -SelfPid $PID }
        try {
          & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'tools\qa\Get-DesktopState.ps1') -OutDir $OutDir -Screenshot 2>&1 | Out-String | Write-Output
        } finally {
          if ($hidden.Count -gt 0) { Restore-Windows -Hidden $hidden }
        }
        $after = @(Get-ChildItem $OutDir -Filter 'desktop-state-*.json' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
        $new = @($after | Where-Object { $before -notcontains $_ })
        if ($new.Count -gt 0) { $desktopStateFile = $new[-1] }
      } catch {
        Write-Output "[chatwindow-shots] Get-DesktopState 失败：$($_.Exception.Message)"
      }
    }

    Start-Sleep -Milliseconds 350
    $png = "$prefix-$label-desktop.png"
    # ⚠ 默认**不动**其它窗口（见 -MinimizeOthers 的说明：曾经把用户的游戏最小化过）。
    #   于是截图是**真实桌面**：可能被别的窗口压住一部分，但那是用户当时的真实桌面状态。
    #   `-RaiseOurWindows` 只抬我们自己的窗口，用来对抗遮挡（不动别人的窗口）。
    $bytes = Save-DesktopShot -Path $png -SelfPid $PID -ClearOthers ([bool]$MinimizeOthers) -RaiseOurs ([bool]$RaiseOurWindows)
    $report += [pscustomobject]@{ label = $label; png = (Split-Path -Leaf $png); bytes = $bytes; at = (Get-Date).ToString('s') }
    Write-Output ("[chatwindow-shots] {0} → {1} ({2} bytes)" -f $label, (Split-Path -Leaf $png), $bytes)

    Set-Content -LiteralPath "$prefix-$label.done" -Value $label -Encoding UTF8
  }
  Start-Sleep -Milliseconds 150
}

if (-not $proc.HasExited) {
  Write-Output "[chatwindow-shots] 超时（${TimeoutSec}s）→ 结束探针"
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 900
Clear-AirimateLeftovers -Self $PID

# ⚠ 判定分量全部先算好再放进 JSON 字面量（PS 5.1 在字面量里求值 `-and` 链有实测坑，
#   本项目已在上一个截图脚本里记过：同一个表达式内外求值不同）。
$requiredLabels = @('pet-running', 'chat-centered', 'chat-dragged', 'chat-closed', 'bubble-visible')
$missingLabels = @()
foreach ($l in $requiredLabels) {
  if (@($report | Where-Object { $_.label -eq $l }).Count -eq 0) { $missingLabels += $l }
}
$requiredShots = @($report | Where-Object { $requiredLabels -contains $_.label })
$requiredNonEmpty = @($requiredShots | Where-Object { $_.bytes -gt 20480 })
$gateMissing = [bool]($missingLabels.Count -eq 0)
$gateShots = [bool]($requiredNonEmpty.Count -eq $requiredLabels.Count)
$gateJson = [bool](Test-Path $jsonOut)

$desktopStateCounts = $null
if ($desktopStateFile) {
  try {
    $ds = Get-Content (Join-Path $OutDir $desktopStateFile) -Raw | ConvertFrom-Json
    $desktopStateCounts = $ds.counts
  } catch { $desktopStateCounts = $null }
}

$summary = [pscustomobject]@{
  id = 'chatwindow-shots'
  invariant = '五张真实桌面截图（桌宠 / chat 居中 / chat 拖动后 / chat 关闭后 / 气泡显示中）全部落盘且非空'
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  commandLine = "powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\chatwindow-shots.ps1 -OutDir $OutDir -TimeoutSec $TimeoutSec"
  prefix = $prefix
  shots = $report
  shotCount = @($report).Count
  requiredLabels = $requiredLabels
  missingLabels = $missingLabels
  requiredNonEmptyCount = $requiredNonEmpty.Count
  desktopStateFile = $desktopStateFile
  desktopStateCounts = $desktopStateCounts
  # `-RaiseOurWindows` 的核对读数：每次抬起后实测的"标题 / 可见 / 置顶 / 矩形"。
  #   默认关时为 null，如实反映「没抬过」。
  raiseChecks = if ($script:raiseChecks.Count -gt 0) { @($script:raiseChecks | Select-Object -Unique) } else { $null }
  minimizeOthersEnabled = [bool]$MinimizeOthers
  raiseOurWindowsEnabled = [bool]$RaiseOurWindows
  probeJson = $jsonOut
  probeJsonExists = $gateJson
  gateMissingNone = $gateMissing
  gateRequiredShotsNonEmpty = $gateShots
  gateProbeJsonExists = $gateJson
  pass = [bool]($gateMissing -and $gateShots -and $gateJson)
}
# ⚠ 必须**无 BOM**（验收约定 §1.3）：PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM，
#   而 BOM 会让 `JSON.parse` 直接失败。
[System.IO.File]::WriteAllText((Join-Path $OutDir 'chatwindow-shots.json'), ($summary | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
Get-ChildItem $screens -Filter 'chatwindow-*.ready' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem $screens -Filter 'chatwindow-*.done' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Write-Output ("[chatwindow-shots] 共 {0} 张桌面截图；清单：{1}" -f @($report).Count, (Join-Path $OutDir 'chatwindow-shots.json'))
Write-Output ("[chatwindow-shots] 探针 JSON：{0}（存在={1}）" -f $jsonOut, (Test-Path $jsonOut))
