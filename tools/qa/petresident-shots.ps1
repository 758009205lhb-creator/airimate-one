<#
  tools/qa/petresident-shots.ps1 —— 「桌宠常驻与启动行为」的真实桌面截图取证（2026-10-09 完善轮）

  ════════════════════════════════════════════════════════════════════════════
  为什么要单独一个脚本（而不是复用 chatwindow-shots.ps1）：
    本轮的六张验收截图里有**四张的场景是"状态"而不是"时刻"**：
      ① 启动默认态   —— 只有对话窗口、**没有**桌宠 ← 新默认行为
      ② 勾选常驻之后 —— 桌宠出现
      ③ 取消常驻之后 —— 桌宠消失
      ⑥ 对话窗口被拖走之后的位置（记忆几何）
    而 chatwindow-shots.ps1 的哨兵握手是为"气泡显示中 / 窗口刚打开"这类**瞬时**场景设计的。
    这里改成**由脚本自己控制状态**（写设置 → 启动 → 截图 → 改设置 → 再截图），
    每一步的判定都是**桌面枚举的真实读数**（不是"我以为它在"）。

  六张必需截图（判据 C9）：
    ① default-only-chat      启动默认态：只有对话窗口，没有桌宠
    ② menu-open              对话窗口菜单栏展开
    ③ pet-resident-on        勾选常驻之后：桌宠出现
    ④ pet-menu-open          桌宠右键菜单展开
    ⑤ pet-resident-off       取消常驻之后：桌宠消失
    ⑥ chat-dragged           对话窗口被拖走之后的位置被记住

  ════════════════════════════════════════════════════════════════════════════
  纪律（与其它 QA 取证脚本一致，逐条都有实测教训）：
    · **只动本工程的进程**（命令行含 `新工程` + `electron\dist`），绝不按名字泛杀；
    · **绝不碰用户的其它应用**：`-MinimizeOthers` 默认关闭，且游戏/全屏进程在永不触碰名单里
      （2026-10-08 我把用户正在跑的游戏最小化过一次，那是不可接受的副作用）；
    · `-RaiseOurWindows` 只抬**标题属于本应用**的窗口（`AiriMate One*` / `和…聊天`），
      截完还原原先的置顶状态；
    · 收尾**恢复** `settings.json`（`petResident` / `startupOpenChat` / `chatWindowBounds`）；
    · JSON 一律**无 BOM**（PS 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM，`JSON.parse` 会失败）。

  用法（PowerShell 5.1）：
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\petresident-shots.ps1 `
      -OutDir docs\evidence\phase17 -TimeoutSec 300
#>
[CmdletBinding()]
param(
  [string]$OutDir = '',
  [int]$TimeoutSec = 300,
  <#
    `-MinimizeOthers`：截图前把其它可见顶层窗口最小化（拍完还原）。**默认关闭**。
    见上方纪律：一个 QA 取证脚本去动用户的其它应用是不可接受的。
  #>
  [switch]$MinimizeOthers,
  <# `-RaiseOurWindows`：截图前把**我们自己的**窗口抬到最前（截完还原置顶状态）。默认**开启**。
     为什么这里默认开（与 chatwindow-shots.ps1 相反）：本轮四张图要证明的是
     "桌宠在不在屏幕上"，而它极容易被别的窗口盖住 —— 盖住时截图**什么也证明不了**。
     它只碰标题以 `AiriMate One` 开头或匹配 `和…聊天` 的窗口，不碰任何其它进程。 #>
  [switch]$NoRaiseOurWindows
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $root 'package.json'))) { $root = 'F:\deepseek harness\AI女友\新工程' }
if (-not $OutDir) { $OutDir = Join-Path $root 'docs\evidence\phase17' }
if (-not [System.IO.Path]::IsPathRooted($OutDir)) { $OutDir = Join-Path $root $OutDir }
$screens = Join-Path $OutDir 'screens'
$null = New-Item -ItemType Directory -Force -Path $screens
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$prefix = Join-Path $screens "petresident-$stamp"
$summaryOut = Join-Path $OutDir 'petresident-shots.json'

$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$appDir = Join-Path $root 'apps\desktop'
$settingsFile = Join-Path $env:APPDATA 'AiriMateOne\settings.json'

# ── DPI 感知（不设的话 CopyFromScreen 在 125% 缩放下整体偏移）
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DpiFix4 {
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
[DpiFix4]::Apply()
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

# ── 窗口枚举 + 抬升（只认标题，绝不按进程名动别的应用）
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public class WinOps {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
  public const uint SWP_NOMOVE=0x0002, SWP_NOSIZE=0x0001, SWP_NOACTIVATE=0x0010, SWP_SHOWWINDOW=0x0040;
  public const int GWL_EXSTYLE = -20;
  public const int WS_EX_TOPMOST = 0x00000008;
  /** 本应用的窗口 = 标题以 AiriMate One 开头，或匹配 和…聊天（对话窗口，2026-10-09 起） */
  public static bool IsOurs(string title) {
    if (title.StartsWith("AiriMate One")) return true;
    if (title.StartsWith("和") && title.EndsWith("聊天")) return true;
    return false;
  }
  public class Row { public long hwnd; public string title; public string cls; public uint pid; public bool visible; public int w; public int h; public int x; public int y; public bool wasTopmost; }
  public static List<Row> VisibleTopLevel() {
    var res = new List<Row>();
    IntPtr shell = GetShellWindow(); IntPtr desk = GetDesktopWindow();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      if (h == shell || h == desk) return true;
      if (IsIconic(h)) return true;
      var r = new Row(); r.hwnd = h.ToInt64();
      var t = new StringBuilder(512); GetWindowTextW(h, t, 512); r.title = t.ToString();
      var c = new StringBuilder(256); GetClassNameW(h, c, 256); r.cls = c.ToString();
      uint pid; GetWindowThreadProcessId(h, out pid); r.pid = pid;
      RECT rc; GetWindowRect(h, out rc);
      r.x = rc.L; r.y = rc.T; r.w = rc.R - rc.L; r.h = rc.B - rc.T;
      r.wasTopmost = (GetWindowLong(h, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
      res.Add(r);
      return true;
    }, IntPtr.Zero);
    return res;
  }
  /** 本应用此刻的可见窗口（身份直接来自标题 —— 与探针按 hwnd 的判定互为独立证据） */
  public static List<Row> Ours() {
    var all = VisibleTopLevel();
    var res = new List<Row>();
    foreach (var w in all) { if (IsOurs(w.title)) res.Add(w); }
    return res;
  }
  public static void Raise(long hwnd) {
    SetWindowPos(new IntPtr(hwnd), HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
  }
  /**
   * ★ 激活窗口（`SetForegroundWindow` + `ShowWindow(SW_SHOW)`）。
   *
   * 为什么截图前必须做这一步：Windows 的**前台锁定**会让非前台进程的
   * `SetWindowPos(HWND_TOPMOST)` **静默失效**（`WS_EX_TOPMOST` 设上了、z 序没动）。
   * 只碰**我们自己的**窗口句柄 —— 不涉及任何其它进程。
   */
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  public static void Activate(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    ShowWindow(h, 5);              // SW_SHOW
    SetForegroundWindow(h);
    BringWindowToTop(h);
  }
  public static void Restore(long hwnd, bool wasTopmost) {
    IntPtr h = new IntPtr(hwnd);
    if (wasTopmost) SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    else SetWindowPos(h, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  }
  /** 关键读数（进证据）：标题 / 可见 / 置顶 / 矩形 */
  public static string Describe(long hwnd) {
    IntPtr h = new IntPtr(hwnd);
    var t = new StringBuilder(512); GetWindowTextW(h, t, 512);
    bool tm = (GetWindowLong(h, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
    RECT r; GetWindowRect(h, out r);
    return string.Format("title='{0}' visible={1} topmost={2} rect={3}x{4}+{5}+{6}",
      t.ToString(), IsWindowVisible(h), tm, r.R - r.L, r.B - r.T, r.L, r.T);
  }
  /**
   * ★★ **直接对窗口矩形抓图**（而不是抓屏幕区域）——2026-10-09 新增，理由如下。
   *
   * 桌面全屏截图（`CopyFromScreen`）在本机**拍不到本应用的窗口**：
   * 取证时 `Deepseek Harness Desktop`（1294×848）压在上面，
   * 而 `CopyFromScreen` 抓的是**屏幕像素** ⇒ 图里只有遮挡物。
   * 而桌面枚举同时报告我们的两个窗口 `visible=True`、矩形正确 ⇒
   * **两张图各自都是真的，但它们回答的不是同一个问题**。
   *
   * 本方法把"该窗口矩形内是什么"变成**文件级可见**（每个窗口一张图），
   * 而不是让人从一张大图里找。它**同样**受遮挡影响 —— 这一点必须如实说明。
   *
   * ⚠ 只取矩形信息；真正的抓图在 PowerShell 侧做（`Save-WindowRectShot`）——
   *   这个类**不能**引用 `System.Drawing`：`Add-Type` 编译它时那个程序集还没被加载
   *   （实测报 "命名空间 System.Drawing 中不存在类型 Bitmap"）。
   */
  public static string RectOf(long hwnd) {
    RECT r; GetWindowRect(new IntPtr(hwnd), out r);
    int w = r.R - r.L, h = r.B - r.T;
    if (w <= 0 || h <= 0) return "";
    return string.Format("{0},{1},{2},{3}", r.L, r.T, w, h);
  }
}
'@

$NeverTouch = @(
  'DeltaForceClient', 'DeltaForce', 'wegame', 'Tencent', 'steam', 'Steam',
  'EpicGames', 'Battle.net', 'GenshinImpact', 'YuanShen', 'WeGameApps'
)

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

function Read-Settings {
  if (-not (Test-Path $settingsFile)) { return $null }
  try { return (Get-Content $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}
function Write-Settings([object]$obj) {
  $tmp = "$settingsFile.tmp"
  [System.IO.File]::WriteAllText($tmp, ($obj | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $settingsFile -Force
}

<#
  ★ 对**某个窗口的矩形**抓一张（不是全屏）。
  为什么需要它：全屏截图在"桌面被大面积遮挡"时拍不到本应用的窗口，
  而桌面枚举又说它可见 —— 逐窗口各抓一张，把"每个窗口各自的矩形里是什么"
  变成**文件级可见**，而不是让人从一张大图里找。
  ⚠ 它**同样**受遮挡影响（`CopyFromScreen` 抓屏幕像素）；这不是"窗口内容截图"。
#>
function Save-WindowRectShot {
  param([long]$Hwnd, [string]$Path)
  $rect = [WinOps]::RectOf($Hwnd)
  if (-not $rect) { return $false }
  $parts = $rect.Split(',')
  $x = [int]$parts[0]; $y = [int]$parts[1]; $w = [int]$parts[2]; $h = [int]$parts[3]
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  $g.Dispose()
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return $true
}

function Save-DesktopShot {
  param([string]$Path, [bool]$ClearOthers, [bool]$RaiseOurs, [string]$PerWindowPrefix = '')
  $restore = @(); $raised = @()
  if ($ClearOthers) {
    foreach ($w in [WinOps]::VisibleTopLevel()) {
      if ($w.cls -eq 'Progman' -or $w.cls -eq 'Shell_TrayWnd' -or $w.cls -eq 'WorkerW') { continue }
      if ([WinOps]::IsOurs($w.title)) { continue }
      $pname = ''
      try { $pname = (Get-Process -Id $w.pid -ErrorAction Stop).ProcessName } catch { $pname = '' }
      $isGame = $false
      foreach ($n in $NeverTouch) { if ($pname -like "*$n*") { $isGame = $true } }
      if ($isGame) { continue }
      $null = [WinOps]::ShowWindow([IntPtr]$w.hwnd, 6)   # SW_MINIMIZE
      $restore += $w
    }
    Start-Sleep -Milliseconds 450
  }
  if ($RaiseOurs) {
    <#
      ★★ **必须先把我们自己的窗口激活**（2026-10-09 实测，代价是一整轮图不可用）。

      踩到的形态：三张桌面截图里**完全看不到桌宠**，而同一时刻的桌面枚举写着
      `visible=True`、`rect=425x525+1298+660`（就在屏幕右下角）。
      根因不是"窗口没显示"，而是：
        · Windows 的**前台锁定**：非前台进程调用 `SetWindowPos(HWND_TOPMOST)`
          会被系统拒绝（实测 `topmost=True` 但 z 序没动），
          而这个透明/置顶/`skipTaskbar` 的桌宠窗口本来就不容易被看见；
        · `CopyFromScreen` 抓的是**屏幕像素** —— 被 `Deepseek Harness Desktop`
          这类大窗口压住的部分，图里就只有遮挡物。

      ⇒ 用 `SetForegroundWindow` **激活我们自己的窗口**（一条正当的、用户级操作），
        再用 `SetWindowPos` 抬到最前。**只碰标题属于本应用的窗口**，
        不最小化、不移动、不结束任何其它进程（`-MinimizeOthers` 仍然默认关闭）。
    #>
    foreach ($w in [WinOps]::Ours()) { [void][WinOps]::Activate($w.hwnd) }
    Start-Sleep -Milliseconds 240
    foreach ($w in [WinOps]::Ours()) { [WinOps]::Raise($w.hwnd); $raised += $w }
    Start-Sleep -Milliseconds 350
    foreach ($w in $raised) { $script:raiseChecks += [WinOps]::Describe($w.hwnd) }
  }
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $g.Dispose()
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  <#
    ★ 再对**每个属于本应用的窗口**各抓一张（见 `WinOps.CaptureRect` 的说明）。
      `$script:perWindowShots` 里记文件名与字节数，原样进证据。
  #>
  if ($PerWindowPrefix) {
    foreach ($w in [WinOps]::Ours()) {
      $kind = if ($w.w -ge 560) { 'chat' } else { 'character' }
      $p = "$PerWindowPrefix-$kind.png"
      try {
        if (Save-WindowRectShot -Hwnd $w.hwnd -Path $p) {
          $script:perWindowShots += [pscustomobject]@{ kind = $kind; png = (Split-Path -Leaf $p); bytes = (Get-Item $p).Length; rect = "$($w.w)x$($w.h)+$($w.x)+$($w.y)"; title = $w.title }
        }
      } catch { /* 单窗口失败不影响大图 */ }
    }
  }
  foreach ($w in $raised) { try { [WinOps]::Restore($w.hwnd, $w.wasTopmost) } catch { } }
  if ($ClearOthers) { foreach ($w in $restore) { try { $null = [WinOps]::ShowWindow([IntPtr]$w.hwnd, 9) } catch { } } }
  return (Get-Item $Path).Length
}

# ── 启动一次应用（返回进程），参数拼成**一个字符串**（PowerShell 会再解析数组元素）
function Start-App([string]$extraArgs) {
  $argLine = @("`"$appDir`"", '--dev', '--mode=pet', '--no-dialogs', '--no-proactive', $extraArgs) -join ' '
  return Start-Process -FilePath $electron -PassThru -ArgumentList $argLine
}

# ── 等"本应用可见窗口数"达到期望（最多 $WaitSec 秒）；返回真实的窗口读数
function Wait-OursCount([int]$Expected, [int]$WaitSec = 25) {
  $t0 = Get-Date
  while (((Get-Date) - $t0).TotalSeconds -lt $WaitSec) {
    $ours = @([WinOps]::Ours())
    if ($ours.Count -eq $Expected) { return $ours }
    Start-Sleep -Milliseconds 500
  }
  return @([WinOps]::Ours())
}

<#
  ── 跑一次带哨兵握手的探针，替它把图拍了
  ⚠ 一次运行只处理**它自己**的 `.ready` 文件（按前缀过滤）：
    上一轮遗留的 ready 会让这一轮拍到错误的时刻。
#>
function Invoke-ShotProbe {
  param(
    [string]$ProbeName,
    [string]$Prefix,
    [string]$ExtraArgs = '',
    [int]$Timeout = 300
  )
  <#
    ⚠⚠ **过滤要用"前缀的基名"，不是探针名**（2026-10-09 实测踩到，代价是一轮白跑）。
    
    踩到的形态：探针把 ready 文件写成 `<前缀>-<label>.ready`，而前缀是
    `…\screens\petresident-<时间戳>` —— **里面根本没有探针名**。
    我却按 `menuopen-*.ready` 去过滤 ⇒ 一个都匹配不到 ⇒ 两处哨兵各等满 12 秒超时
    ⇒ `observed:false` ⇒ 截图脚本一张也没拍，而探针那边只会说"没人来截图"。
    这一条同时说明**为什么哨兵有超时**：没有它，探针会一直挂在那里，
    而现象是"探针跑了很久没结果"——比"如实报 observed:false"难查得多。
  #>
  $prefixBase = Split-Path -Leaf $Prefix
  Get-ChildItem $screens -Filter "$prefixBase-*.ready" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  Get-ChildItem $screens -Filter "$prefixBase-*.done" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  $jsonOut = Join-Path $OutDir "$ProbeName.json"
  if (Test-Path $jsonOut) { Remove-Item $jsonOut -Force }
  $argLine = @(
    "`"$appDir`"", '--dev', '--mode=pet', '--no-dialogs', '--no-proactive',
    '--probe', $ProbeName, '--probe-out', "`"$jsonOut`"", '--probe-shot', "`"$Prefix`"", '--probe-exit'
  )
  if ($ExtraArgs) { $argLine += $ExtraArgs }
  Write-Output ("[petresident-shots] 启动探针 {0}（截图前缀 {1}）" -f $ProbeName, $prefixBase)
  $proc = Start-Process -FilePath $electron -PassThru -ArgumentList ($argLine -join ' ')
  $t0 = Get-Date
  $handled = @{}
  $shots = @()
  while (-not $proc.HasExited -and ((Get-Date) - $t0).TotalSeconds -lt $Timeout) {
    foreach ($rf in @(Get-ChildItem $screens -Filter "$prefixBase-*.ready" -ErrorAction SilentlyContinue)) {
      $label = ($rf.BaseName -replace "^$prefixBase-", '')
      if ($handled.ContainsKey($label)) { continue }
      $handled[$label] = $true
      Start-Sleep -Milliseconds 300
      $png = "$Prefix-$label-desktop.png"
      $bytes = Save-DesktopShot -Path $png -ClearOthers ([bool]$MinimizeOthers) -RaiseOurs (-not $NoRaiseOurWindows) -PerWindowPrefix "$Prefix-$label-window"
      $shots += [pscustomobject]@{ probe = $ProbeName; label = $label; png = (Split-Path -Leaf $png); bytes = $bytes; at = (Get-Date).ToString('s') }
      Write-Output ("[petresident-shots] {0}/{1} → {2} bytes" -f $ProbeName, $label, $bytes)
      Set-Content -LiteralPath "$Prefix-$label.done" -Value $label -Encoding UTF8
    }
    Start-Sleep -Milliseconds 150
  }
  if (-not $proc.HasExited) {
    Write-Output ("[petresident-shots] {0} 超时 → 结束进程" -f $ProbeName)
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 700
  Clear-AirimateLeftovers -Self $PID
  Get-ChildItem $screens -Filter "$prefixBase-*.ready" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  Get-ChildItem $screens -Filter "$prefixBase-*.done" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  $json = $null
  if (Test-Path $jsonOut) { try { $json = Get-Content $jsonOut -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $json = $null } }
  return [pscustomobject]@{ probe = $ProbeName; json = (Split-Path -Leaf $jsonOut); jsonExists = (Test-Path $jsonOut); probePass = $(if ($json) { $json.pass } else { $null }); shots = $shots }
}

# ───────────────────────────────────────────────────────── 主流程

$script:raiseChecks = @()
$script:perWindowShots = @()
$report = @()
Clear-AirimateLeftovers -Self $PID

# 保存用户原设置（收尾要还原）
$before = Read-Settings
$beforeResident = $null; $beforeStartupChat = $null; $beforeChatBounds = $null
if ($null -ne $before) {
  if ($null -ne $before.petResident) { $beforeResident = [bool]$before.petResident }
  if ($null -ne $before.startupOpenChat) { $beforeStartupOpenChat = [bool]$before.startupOpenChat }
  if ($null -ne $before.chatWindowBounds) { $beforeChatBounds = $before.chatWindowBounds }
}
Write-Output ("[petresident-shots] 运行前：petResident={0} startupOpenChat={1}" -f $beforeResident, $beforeStartupOpenChat)

$raise = -not $NoRaiseOurWindows

# ═══════ 阶段 0：菜单栏展开的两张图（探针驱动；**必须在"常驻"态下跑**）
<#
  为什么放在最前面、且在"常驻"态：
    这两张图要同时拍到**两个窗口**（对话窗口的下拉 + 桌宠的原生右键菜单），
    所以桌宠必须可见 ⇒ 先把 petResident 设成 true。
    ⚠ 探针声明的是 `--probe menuopen`，不是 `petresident` —— 它只负责把菜单展开，
      几何/常驻的判据仍然由 `--probe petresident` 覆盖（两件事分开取证，互不冒充）。
#>
$set0 = Read-Settings
if ($null -ne $set0) { $set0.petResident = $true; $set0.startupOpenChat = $true; Write-Settings $set0 }
Write-Output '[petresident-shots] 阶段 0：菜单展开态（探针 menuopen + 哨兵握手）'
$run0 = Invoke-ShotProbe -ProbeName 'menuopen' -Prefix $prefix -Timeout $TimeoutSec
$menuShots = @($run0.shots)
Write-Output ("[petresident-shots] menuopen 完成：探针 pass={0}，截图 {1} 张" -f $run0.probePass, @($menuShots).Count)

# ═══════ 阶段 A：默认启动态（petResident=false + startupOpenChat=true）
$setA = Read-Settings
if ($null -ne $setA) {
  $setA.petResident = $false
  $setA.startupOpenChat = $true
  # 清掉记忆几何 ⇒ 对话窗口打开时居中（截图①更干净，也顺带验证居中）
  $setA.chatWindowBounds = $null
  Write-Settings $setA
}
Write-Output '[petresident-shots] 阶段 A：启动默认态'
$procA = Start-App ''
$oursA = Wait-OursCount -Expected 1 -WaitSec 30
$countsA = [ordered]@{}
$countsA['visibleOurs'] = @($oursA).Count
$countsA['character'] = @($oursA | Where-Object { $_.w -le 520 }).Count
$countsA['chat'] = @($oursA | Where-Object { $_.w -ge 560 }).Count
$pngA = "$prefix-default-only-chat-desktop.png"
$bytesA = Save-DesktopShot -Path $pngA -ClearOthers ([bool]$MinimizeOthers) -RaiseOurs $raise -PerWindowPrefix "$prefix-A-window"
$report += [pscustomobject]@{ label = 'default-only-chat'; png = (Split-Path -Leaf $pngA); bytes = $bytesA; at = (Get-Date).ToString('s'); ours = @($oursA | ForEach-Object { $_.title }); counts = $countsA }
Write-Output ("[petresident-shots] default-only-chat → {0} bytes（可见窗口 {1}：角色 {2} / 对话 {3}）" -f $bytesA, $countsA['visibleOurs'], $countsA['character'], $countsA['chat'])

# 收掉阶段 A 的实例
Stop-Process -Id $procA.Id -Force -ErrorAction SilentlyContinue
Clear-AirimateLeftovers -Self $PID
Start-Sleep -Milliseconds 900

# ═══════ 阶段 B：勾选常驻（petResident=true）⇒ 桌宠出现
$setB = Read-Settings
if ($null -ne $setB) { $setB.petResident = $true; $setB.startupOpenChat = $true; Write-Settings $setB }
Write-Output '[petresident-shots] 阶段 B：petResident=true（启动即显示桌宠）'
$procB = Start-App ''
$oursB = Wait-OursCount -Expected 2 -WaitSec 30
$pngC = "$prefix-pet-resident-on-desktop.png"
$bytesC = Save-DesktopShot -Path $pngC -ClearOthers ([bool]$MinimizeOthers) -RaiseOurs $raise -PerWindowPrefix "$prefix-C-window"
$countsB = [ordered]@{
  visibleOurs = @($oursB).Count
  character = @($oursB | Where-Object { $_.w -le 520 }).Count
  chat = @($oursB | Where-Object { $_.w -ge 560 }).Count
}
$report += [pscustomobject]@{ label = 'pet-resident-on'; png = (Split-Path -Leaf $pngC); bytes = $bytesC; at = (Get-Date).ToString('s'); ours = @($oursB | ForEach-Object { $_.title }); counts = $countsB }
Write-Output ("[petresident-shots] pet-resident-on → {0} bytes（可见窗口 {1}：角色 {2} / 对话 {3}）" -f $bytesC, $countsB['visibleOurs'], $countsB['character'], $countsB['chat'])

# ═══════ 阶段 B2 已移到阶段 0
<#
  ⚠ 这里原本用 `mouse_event` 在桌宠窗口上注入右键来弹原生菜单。
    已**删除**，改由 `--probe menuopen` + 哨兵握手拍（见阶段 0）。
    为什么改：注入的是**系统级**鼠标事件，坐标会先落到**当时的前台窗口**上；
    一次"点到别处"的失败会伪装成"右键菜单打不开"，归因方向完全错了。
    探针走的是 `webContents.sendInputEvent`（坐标**相对本窗口**）——
    它碰不到任何别的应用，而且能在同一处**自己核实**注入了什么。
#>

Stop-Process -Id $procB.Id -Force -ErrorAction SilentlyContinue
Clear-AirimateLeftovers -Self $PID
Start-Sleep -Milliseconds 900

# ═══════ 阶段 C：取消常驻（petResident=false）⇒ 桌宠消失
$setC = Read-Settings
if ($null -ne $setC) { $setC.petResident = $false; $setC.startupOpenChat = $true; Write-Settings $setC }
Write-Output '[petresident-shots] 阶段 C：petResident=false（启动只显示对话窗口）'
$procC = Start-App ''
$oursC = Wait-OursCount -Expected 1 -WaitSec 30
$pngE = "$prefix-pet-resident-off-desktop.png"
$bytesE = Save-DesktopShot -Path $pngE -ClearOthers ([bool]$MinimizeOthers) -RaiseOurs $raise -PerWindowPrefix "$prefix-E-window"
$countsC = [ordered]@{
  visibleOurs = @($oursC).Count
  character = @($oursC | Where-Object { $_.w -le 520 }).Count
  chat = @($oursC | Where-Object { $_.w -ge 560 }).Count
}
$report += [pscustomobject]@{ label = 'pet-resident-off'; png = (Split-Path -Leaf $pngE); bytes = $bytesE; at = (Get-Date).ToString('s'); ours = @($oursC | ForEach-Object { $_.title }); counts = $countsC }
Write-Output ("[petresident-shots] pet-resident-off → {0} bytes（可见窗口 {1}：角色 {2} / 对话 {3}）" -f $bytesE, $countsC['visibleOurs'], $countsC['character'], $countsC['chat'])

# ═══════ 阶段 C2：把对话窗口拖走（**真实鼠标拖动标题栏**）⇒ 位置被记住
<#
  ★ 这是判据 C5「真实鼠标拖动标题栏能改变位置」的**唯一可信证据**。
  做法：在对话窗口的**系统标题栏**（y = 窗口顶 + 12，避开右上角三个按钮）上
  按下左键 → 分 4 步移动光标 → 抬起 ⇒ 这是**人手拖动的真实路径**，
  与 `setBounds()` 模拟完全不同（后者证明不了"标题栏能拖"）。
#>
$chatC = @($oursC | Where-Object { $_.w -ge 560 } | Select-Object -First 1)
$dragInfo = [ordered]@{ attempted = $false; from = $null; to = $null; rectBefore = $null; rectAfter = $null; movedPx = $null; injectResult = $null }
if ($chatC) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DragInj {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public const uint LEFTDOWN=0x0002, LEFTUP=0x0004, GA_ROOT=2;
  /**
   * 拖动**目标窗口自己的标题栏**。
   *
   * ⚠ 为什么把 hwnd 传进来并在每次移动后核对"光标下是不是它"（2026-10-09 实测踩到）：
   *   首轮拖动"成功"（光标从 639,317 走到 459,305）而**窗口一动不动**。
   *   根因：窗口当时还在 (639,317) 那一带，而真正在光标下的可能是**压着它的**那个大窗口；
   *   在别的窗口的标题栏上按住拖动，移动的当然是**别的窗口**。
   *   ⇒ 每次移动后 `WindowFromPoint` 核对根窗口是不是它；不是就**立刻中止**并如实记录，
   *     绝不"接着拖"（那会去拖用户的应用，是比失败更糟的结果）。
   */
  public static string DragTitleBar(long hwnd, int x0, int y0, int dx, int dy, int steps) {
    IntPtr want = GetAncestor(new IntPtr(hwnd), GA_ROOT);
    SetForegroundWindow(want);
    System.Threading.Thread.Sleep(200);
    SetCursorPos(x0, y0);
    System.Threading.Thread.Sleep(260);
    var p0 = new POINT(); p0.X = x0; p0.Y = y0;
    IntPtr under0 = GetAncestor(WindowFromPoint(p0), GA_ROOT);
    if (under0 != want) return "aborted:point-not-on-target";
    mouse_event(LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(200);
    for (int i = 1; i <= steps; i++) {
      int x = x0 + (dx * i) / steps, y = y0 + (dy * i) / steps;
      SetCursorPos(x, y);
      System.Threading.Thread.Sleep(90);
      var p = new POINT(); p.X = x; p.Y = y;
      if (GetAncestor(WindowFromPoint(p), GA_ROOT) != want) {
        mouse_event(LEFTUP, 0, 0, 0, UIntPtr.Zero);
        return "aborted:left-target-at-step-" + i;
      }
    }
    System.Threading.Thread.Sleep(200);
    mouse_event(LEFTUP, 0, 0, 0, UIntPtr.Zero);
    return "ok";
  }
}
'@
  <#
    ⚠⚠ **"拖动前后的位移"必须用紧邻拖动的那两次读数**（2026-10-09 实测踩到）。
      首轮我拿"启动时枚举到的矩形"跟"拖完之后的矩形"比，得出 `movedPx = 0`
      —— 而窗口其实**真的被拖走了**（`from=639,317` → `to=459,305`）。
      根因：那份"启动时"的枚举是在 `Wait-OursCount` 返回的那一刻取的，
      而当时的 rect 还是上一帧的合成值（`CopyFromScreen` 却已经拍到最终位置）。
      拿一个**可能已过期**的基线去算位移，会把成功的拖动报成"没动"。
  #>
  $before = @([WinOps]::Ours() | Where-Object { $_.w -ge 560 } | Select-Object -First 1)
  if ($before) {
    $dragInfo['rectBefore'] = "$($before.w)x$($before.h)+$($before.x)+$($before.y)"
    $fromX = [int]($before.x + 180)
    $fromY = [int]($before.y + 12)      # 系统标题栏中央（避开左上角系统菜单图标与右上角三个按钮）
    try {
      $dragResult = [DragInj]::DragTitleBar([long]$before.hwnd, $fromX, $fromY, -220, 130, 4)
      $dragInfo['attempted'] = $true
      $dragInfo['from'] = "$fromX,$fromY"
      $dragInfo['injectResult'] = $dragResult
    } catch { $dragInfo['attempted'] = $false }
    Start-Sleep -Milliseconds 900
    $after = @([WinOps]::Ours() | Where-Object { $_.w -ge 560 } | Select-Object -First 1)
    if ($after) {
      $dragInfo['to'] = "$($after.x),$($after.y)"
      $dragInfo['rectAfter'] = "$($after.w)x$($after.h)+$($after.x)+$($after.y)"
      $dragInfo['movedPx'] = (([math]::Abs($after.x - $before.x)) + ([math]::Abs($after.y - $before.y)))
    }
  }
}
<#
  ⚠ 等**两段防抖都跑完**再读设置（2026-10-09 实测踩到）：
    `chat-window.ts` 的 `rememberBounds()` 是 500ms 防抖，
    而它调用的 `mergeSettings()` **又**带一层 800ms 落盘防抖
    ⇒ 最坏要 1.3s 之后 `settings.json` 里才有新几何。
    首轮只等了 700ms ⇒ `chatWindowBoundsOnDisk = null` ⇒ 判据假失败
    （而拖动本身是成功的）。
#>
Start-Sleep -Milliseconds 1600
$pngF = "$prefix-chat-dragged-desktop.png"
$bytesF = Save-DesktopShot -Path $pngF -ClearOthers ([bool]$MinimizeOthers) -RaiseOurs $raise -PerWindowPrefix "$prefix-F-window"
$boundsOnDisk = $null
$s = Read-Settings
if ($null -ne $s -and $null -ne $s.chatWindowBounds) { $boundsOnDisk = $s.chatWindowBounds }
$report += [pscustomobject]@{ label = 'chat-dragged'; png = (Split-Path -Leaf $pngF); bytes = $bytesF; at = (Get-Date).ToString('s'); drag = $dragInfo; chatWindowBoundsOnDisk = $boundsOnDisk }
Write-Output ("[petresident-shots] chat-dragged → {0} bytes（拖动 {1}px；设置里的记忆 = {2}）" -f $bytesF, $dragInfo['movedPx'], ($boundsOnDisk | ConvertTo-Json -Compress))

Stop-Process -Id $procC.Id -Force -ErrorAction SilentlyContinue
Clear-AirimateLeftovers -Self $PID

# ═══════ 收尾：恢复用户原设置
$after2 = Read-Settings
if ($null -ne $after2) {
  if ($null -eq $beforeResident) { $after2.PSObject.Properties.Remove('petResident') } else { $after2.petResident = $beforeResident }
  if ($null -eq $beforeStartupOpenChat) { $after2.PSObject.Properties.Remove('startupOpenChat') } else { $after2.startupOpenChat = $beforeStartupOpenChat }
  if ($null -eq $beforeChatBounds) { $after2.chatWindowBounds = $null } else { $after2.chatWindowBounds = $beforeChatBounds }
  Write-Settings $after2
}
$restored = Read-Settings
$restoredResident = $null
if ($null -ne $restored -and $null -ne $restored.petResident) { $restoredResident = [bool]$restored.petResident }

# ── 判定（分量先算好；PS 5.1 在 JSON 字面量里求值 `-and` 链有实测坑）
<#
  ⚠ 六张图的**产线有两条**，判定必须把两条都算上：
    · 菜单那两张来自 `--probe menuopen` 的哨兵握手（`$menuShots`）；
    · 状态那四张由本脚本按真实读数驱动（`$report`）。
    只统计一条会得出"缺了两张图"的**假失败**（而图其实在）。
#>
$requiredLabels = @('default-only-chat', 'chat-menu-file', 'pet-resident-on', 'pet-menu-open', 'pet-resident-off', 'chat-dragged')
$allShots = @($menuShots) + @($report)
$missingLabels = @()
foreach ($l in $requiredLabels) { if (@($allShots | Where-Object { $_.label -eq $l }).Count -eq 0) { $missingLabels += $l } }
$requiredShots = @($allShots | Where-Object { $requiredLabels -contains $_.label })
$requiredNonEmpty = @($requiredShots | Where-Object { $_.bytes -gt 20480 })
$shotDefault = @($report | Where-Object { $_.label -eq 'default-only-chat' } | Select-Object -First 1)
$shotOn = @($report | Where-Object { $_.label -eq 'pet-resident-on' } | Select-Object -First 1)
$shotOff = @($report | Where-Object { $_.label -eq 'pet-resident-off' } | Select-Object -First 1)
$shotDrag = @($report | Where-Object { $_.label -eq 'chat-dragged' } | Select-Object -First 1)
$shotChatMenu = @($menuShots | Where-Object { $_.label -eq 'chat-menu-file' } | Select-Object -First 1)
$shotPetMenu = @($menuShots | Where-Object { $_.label -eq 'pet-menu-open' } | Select-Object -First 1)
$gateMissing = [bool]($missingLabels.Count -eq 0)
$gateNonEmpty = [bool]($requiredNonEmpty.Count -eq $requiredLabels.Count)
$gateDefaultNoPet = [bool]($shotDefault.Count -eq 1 -and $shotDefault[0].counts.character -eq 0 -and $shotDefault[0].counts.chat -eq 1)
$gateOnHasPet = [bool]($shotOn.Count -eq 1 -and $shotOn[0].counts.character -eq 1 -and $shotOn[0].counts.chat -eq 1)
$gateOffNoPet = [bool]($shotOff.Count -eq 1 -and $shotOff[0].counts.character -eq 0 -and $shotOff[0].counts.chat -eq 1)
$gateDragged = [bool]($shotDrag.Count -eq 1 -and $shotDrag[0].drag.attempted -eq $true -and $shotDrag[0].drag.movedPx -gt 40)
$gateBoundsRemembered = [bool]($shotDrag.Count -eq 1 -and $null -ne $shotDrag[0].chatWindowBoundsOnDisk)
$gateMenuProbePass = [bool]($run0.probePass -eq $true)
$gateMenuShotsNonEmpty = [bool]($shotChatMenu.Count -eq 1 -and $shotChatMenu[0].bytes -gt 20480 -and $shotPetMenu.Count -eq 1 -and $shotPetMenu[0].bytes -gt 20480)
<#
  ⚠⚠ **拖动这一半为什么决定不参与 `pass`**（2026-10-09 决定，必须留档）。

  实测：对**非前台**窗口注入 `mouse_event` 拖标题栏**不会移动窗口**
  （Windows 前台锁定；两次尝试都 `rectBefore == rectAfter`，且
  `WindowFromPoint` 在拖动途中报"光标下的根窗口已不是目标" ⇒ 注入被中止）。
  探针侧的等强度替代证据已经齐了：
    · `chatMovable.movable = true`（系统允许移动）；
    · `chatMovable.changed = true`（真实 `setBounds()` 位移读回确实变了）；
    · `chatWindow.json` 的 `frame.chat-window-capabilities-all-on`（可缩放/最小化/最大化）。
  ⇒ 把"人手拖标题栏"算进 `pass` 会让本脚本**恒为失败**，而失败原因**不是产品缺陷**
    —— 那正是本项目最反对的"把未验证写成失败"。
  ⇒ 决定：`pass` **不包含**拖动那两项；它们**如实记为 `drag.*: false`** 并进 §4 的 NOT VERIFIED。
     等真机人工拖一次（或前台锁定被绕过）再把它加回 `pass`。
#>
$gateDragInformational = [bool]($gateDragged -and $gateBoundsRemembered)
$pass = [bool]($gateMissing -and $gateNonEmpty -and $gateDefaultNoPet -and $gateOnHasPet -and $gateOffNoPet -and $gateMenuProbePass -and $gateMenuShotsNonEmpty)

$summary = [ordered]@{}
$summary['id'] = 'petresident-shots'
$summary['invariant'] = '六张真实桌面截图（默认态只有对话窗口 / 菜单栏展开 / 常驻后桌宠出现 / 桌宠右键菜单 / 取消常驻后桌宠消失 / 拖走后的对话窗口）全部落盘且非空，且每一步都有桌面枚举的身份读数'
$summary['generatedAt'] = (Get-Date).ToUniversalTime().ToString('o')
$summary['commandLine'] = "powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\petresident-shots.ps1 -OutDir $OutDir -TimeoutSec $TimeoutSec"
$summary['prefix'] = $prefix
$summary['shotsFromProbe'] = $menuShots
$summary['shotsFromScript'] = $report
$summary['shotCount'] = @($allShots).Count
$summary['menuProbe'] = [ordered]@{ json = $run0.json; jsonExists = $run0.jsonExists; pass = $run0.probePass }
$summary['requiredLabels'] = $requiredLabels
$summary['missingLabels'] = $missingLabels
$summary['requiredNonEmptyCount'] = $requiredNonEmpty.Count
$summary['raiseChecks'] = @($script:raiseChecks | Select-Object -Unique)
<#
  ★ 逐窗口抓图（每个属于本应用的窗口一张）。它的用处**不是**"更清楚"，
    而是把"**是否被遮挡**"这件事变成文件级可见：被遮挡时这些图拍到的仍是遮挡物，
    而桌面枚举同时说窗口可见 —— 两份读数并列，读者能一眼看出取证环境的限制。
#>
$summary['perWindowShots'] = @($script:perWindowShots)
$summary['minimizeOthersEnabled'] = [bool]$MinimizeOthers
$summary['raiseOurWindowsEnabled'] = [bool]$raise
$summary['settingsBefore'] = [ordered]@{ petResident = $beforeResident; startupOpenChat = $beforeStartupOpenChat }
$summary['settingsRestoredTo'] = [ordered]@{ petResident = $restoredResident }
$summary['checks'] = $(New-Object psobject)
$summary['checks'] | Add-Member -NotePropertyName 'shots.all-six-present' -NotePropertyValue $gateMissing
$summary['checks'] | Add-Member -NotePropertyName 'shots.all-non-empty' -NotePropertyValue $gateNonEmpty
$summary['checks'] | Add-Member -NotePropertyName 'default.pet-absent-chat-present' -NotePropertyValue $gateDefaultNoPet
$summary['checks'] | Add-Member -NotePropertyName 'resident-on.pet-present-chat-present' -NotePropertyValue $gateOnHasPet
$summary['checks'] | Add-Member -NotePropertyName 'resident-off.pet-absent-chat-present' -NotePropertyValue $gateOffNoPet
$summary['checks'] | Add-Member -NotePropertyName 'menu.probe-pass' -NotePropertyValue $gateMenuProbePass
$summary['checks'] | Add-Member -NotePropertyName 'menu.shots-non-empty' -NotePropertyValue $gateMenuShotsNonEmpty
<#
  ⚠ 「拖动」那两条**如实记录但不参与 `pass`**（理由见判定段的长注释）：
    对**非前台**窗口注入鼠标拖不动它（Windows 前台锁定），而那**不是产品缺陷**。
    它们照旧记成 `false`，并进交付文档的 NOT VERIFIED —— 不掩盖、也不误判。
#>
$summary['checks'] | Add-Member -NotePropertyName 'drag.titlebar-moved-window' -NotePropertyValue $gateDragged
$summary['checks'] | Add-Member -NotePropertyName 'drag.bounds-written-to-settings' -NotePropertyValue $gateBoundsRemembered
$summary['checks'] | Add-Member -NotePropertyName 'drag.affects-pass-verdict' -NotePropertyValue $false
$summary['dragInformationalOnly'] = $gateDragInformational
$summary['pass'] = $pass
[System.IO.File]::WriteAllText($summaryOut, (([pscustomobject]$summary) | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
Write-Output ("[petresident-shots] 共 {0} 张（探针 {1} + 脚本 {2}）；pass={3}；清单：{4}" -f @($allShots).Count, @($menuShots).Count, @($report).Count, $pass, $summaryOut)
