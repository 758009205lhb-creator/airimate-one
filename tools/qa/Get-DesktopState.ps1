# tools/qa/Get-DesktopState.ps1
# ---------------------------------------------------------------------------
# 采集"当前桌面状态"的只读证据：进程、可见顶层窗口、以及本应用窗口的真实截图。
#
# 用途：验收判据 A1–A4 的**可判定输入**（实例数、可见窗口数、旧窗口数）。
# 纪律：只读。不结束任何进程，不移动任何窗口，不点击任何东西。
#
# 用法（PowerShell 5.1）：
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\qa\Get-DesktopState.ps1 `
#     -OutDir "docs\evidence\phase1" -Screenshot
# ---------------------------------------------------------------------------
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$OutDir,
  [switch]$Screenshot
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# ── 0. DPI 感知：WindowRect 给的是**物理像素**，而 CopyFromScreen 在不感知 DPI 的进程里
#      按逻辑坐标取图 ⇒ 截图会整体偏移（实测：窗口 bounds 996+134 但内容出现在 1010+133）。
#      先把本进程设为 Per-Monitor-V2 DPI 感知，两种坐标才一致。
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DpiFix {
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
[DpiFix]::Apply()

# ── 1. P/Invoke：EnumWindows + 可见性 + 标题 + 归属 PID + 矩形
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinScan {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public class Row {
    public long hwnd; public uint pid; public bool visible; public string cls; public string title;
    public int x; public int y; public int w; public int h; public long exStyle;
  }
  public static List<Row> All() {
    var res = new List<Row>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      var r = new Row();
      r.hwnd = h.ToInt64();
      uint pid; GetWindowThreadProcessId(h, out pid); r.pid = pid;
      r.visible = IsWindowVisible(h);
      var t = new StringBuilder(512); GetWindowTextW(h, t, 512); r.title = t.ToString();
      var c = new StringBuilder(256); GetClassNameW(h, c, 256); r.cls = c.ToString();
      RECT rc; GetWindowRect(h, out rc);
      r.x = rc.L; r.y = rc.T; r.w = rc.R - rc.L; r.h = rc.B - rc.T;
      r.exStyle = GetWindowLongPtr(h, -20).ToInt64();
      res.Add(r);
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
'@

$procs = @{}
Get-CimInstance Win32_Process | ForEach-Object {
  $procs[[int]$_.ProcessId] = [pscustomobject]@{
    pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $_.Name
    path = $_.ExecutablePath; cmd = $_.CommandLine
  }
}

$windows = [WinScan]::All() | ForEach-Object {
  $p = $procs[[int]$_.pid]
  # 根进程判定：本应用里只有 Electron **主进程** 持有 BrowserWindow 的 HWND。
  # 所有窗口都由主进程创建 ⇒ renderer/GPU/utility 子进程（命令行含 `--type=`）不该有顶层窗口。
  # 把这一点显式记下来，才能回答"多出来的那个窗口到底是谁的"。
  $isRoot = [bool]($p -and $p.cmd -and ($p.cmd -notlike '*--type=*'))
  [pscustomobject]@{
    hwnd = $_.hwnd; pid = $_.pid; visible = $_.visible; cls = $_.cls; title = $_.title
    rect = @($_.x, $_.y, $_.w, $_.h); exStyle = ('0x{0:X8}' -f $_.exStyle)
    imagePath = if ($p) { $p.path } else { $null }
    commandLine = if ($p) { $p.cmd } else { $null }
    isRootProcess = $isRoot
  }
}

# 归属谓词（只按**完整路径/命令行标记**判定，禁止只凭进程名）
$mine = $windows | Where-Object { $_.commandLine -like '*新工程*' -or $_.imagePath -like '*新工程*' }
$legacyKernel = $windows | Where-Object { $_.imagePath -like '*MateEngineX.exe' -or $_.commandLine -like '*MateEngineX*' }
$legacyPet = $windows | Where-Object { $_.commandLine -like '*build\pet\app*' -or $_.commandLine -like '*build/pet/app*' }

$out = [pscustomobject]@{
  generatedAt = (Get-Date).ToString('o')
  host = [pscustomobject]@{
    computer = $env:COMPUTERNAME; user = $env:USERNAME
    os = (Get-CimInstance Win32_OperatingSystem).Version
    psVersion = $PSVersionTable.PSVersion.ToString()
  }
  counts = [pscustomobject]@{
    mineVisibleWindows = @($mine | Where-Object { $_.visible }).Count
    mineAllWindows = @($mine).Count
    # ★ 2026-10-08 返工轮新增：**按窗口身份**分出来的计数。
    #
    # 为什么要加（旧口径的直接后果）：`mineVisibleWindows` 是一个**总数**，
    # 而"聊天框与桌宠是两个独立窗口"这条新口径下，正确的总数就是 **2**
    # （chat 打开时）/ **1**（chat 隐藏时）。用总数当判据会把"正确的两个窗口"
    # 读成"多了一个窗口"。
    #
    # 分类谓词：只认**本应用根进程**（非 `--type=` 的 Chromium 子进程）拥有的可见顶层窗口，
    # 再按矩形尺寸区分角色窗口与对话窗口 —— 两者的几何在所有模式下都不会撞车
    # （角色 340×420 / 面板 480×760 / 对话 ≥560×420 且宽度 ≥ 560）。
    # ⚠ 这两个数只是**旁证**：真正的身份判定在探针里按 hwnd 比对（`chat.json`）。
    mineCharacterVisibleWindows = @($mine | Where-Object { $_.visible -and $_.isRootProcess -and $_.rect[2] -le 520 }).Count
    mineChatVisibleWindows = @($mine | Where-Object { $_.visible -and $_.isRootProcess -and $_.rect[2] -ge 560 -and $_.rect[3] -ge 420 }).Count
    legacyKernelVisibleWindows = @($legacyKernel | Where-Object { $_.visible }).Count
    legacyKernelAllWindows = @($legacyKernel).Count
    legacyPetVisibleWindows = @($legacyPet | Where-Object { $_.visible }).Count
    totalVisibleTopLevel = @($windows | Where-Object { $_.visible }).Count
  }
  mineWindows = @($mine)
  legacyKernelWindows = @($legacyKernel)
  legacyPetWindows = @($legacyPet)
  methodology = @(
    'top-level windows via EnumWindows; ownership by full image path + command line markers (never by name alone)',
    'legacy kernel predicate: imagePath ends with MateEngineX.exe OR commandLine contains MateEngineX',
    'this-app predicate: imagePath or commandLine contains 新工程 (workspace root of AiriMate One)',
    'isRootProcess: this app process whose command line does NOT contain --type= (i.e. the Electron main process owns all BrowserWindow HWNDs)',
    'character/chat split (2026-10-08): both owned by the SAME app root process; character width<=520 DIP, chat width>=560 && height>=420 DIP',
    'chat window title changed 2026-10-09: now 和 {persona} 聊天 (was AiriMate One · 对话); enumeration accepts both'
  )
}

$jsonPath = Join-Path $OutDir "desktop-state-$stamp.json"
# ⚠ 必须写**无 BOM** 的 UTF-8：PowerShell 5.1 的 `Set-Content -Encoding UTF8` 总是写 BOM，
#   而 `JSON.parse` 遇 BOM 会直接抛错。本项目的守卫脚本
#   (`tools/qa/check-no-src-artifacts.mjs`) 已抓到本文件产出的 3 份证据 JSON 带 BOM。
$jsonText = $out | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($jsonPath, $jsonText, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "WROTE $jsonPath"
Write-Host ("counts: mineVisible={0} mineAll={1} character={2} chat={3} legacyKernelVisible={4} legacyPetVisible={5} totalVisible={6}" -f `
  $out.counts.mineVisibleWindows, $out.counts.mineAllWindows, $out.counts.mineCharacterVisibleWindows, `
  $out.counts.mineChatVisibleWindows, $out.counts.legacyKernelVisibleWindows, `
  $out.counts.legacyPetVisibleWindows, $out.counts.totalVisibleTopLevel)
foreach ($w in $out.mineWindows) {
  Write-Host ("  mine: pid={0} visible={1} rect={2}x{3}+{4}+{5} title='{6}'" -f $w.pid, $w.visible, $w.rect[2], $w.rect[3], $w.rect[0], $w.rect[1], $w.title)
}
foreach ($w in $out.legacyKernelWindows) {
  Write-Host ("  legacyKernel: pid={0} visible={1} rect={2}x{3}+{4}+{5} title='{6}'" -f $w.pid, $w.visible, $w.rect[2], $w.rect[3], $w.rect[0], $w.rect[1], $w.title)
}

# ── 2. 截图（真实桌面像素，不是代码生成的图）
if ($Screenshot) {
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms
  $shotDir = Join-Path $OutDir 'screens'
  New-Item -ItemType Directory -Force -Path $shotDir | Out-Null

  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $full = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
  $g = [System.Drawing.Graphics]::FromImage($full)
  $g.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $full.Size)
  $g.Dispose()
  $fullPath = Join-Path $shotDir "desktop-full-$stamp.png"
  $full.Save($fullPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $full.Dispose()
  Write-Host "WROTE $fullPath"

  foreach ($w in $out.mineWindows) {
    if (-not $w.visible) { continue }
    if ($w.rect[2] -le 0 -or $w.rect[3] -le 0) { continue }
    # ★ 返工轮：本应用有**两个**窗口了。
    # ⚠ 2026-10-09 完善轮：对话窗口的标题从 `AiriMate One · 对话` 改成
    #   **`和 {角色名} 聊天`**（对齐参考实现 DockPetWin 的 `Title="和爱弥斯聊天"`）
    #   ⇒ 这里的过滤必须同时认两种形态。只认旧的会静默丢掉 chat 窗口的截图，
    #     而"少了一张图"很容易被读成"窗口没开"。
    $isOurs = ($w.title -like 'AiriMate One*') -or ($w.title -match '^和\s*\S+\s*聊天$')
    if (-not $isOurs) { continue }
    $bmp = New-Object System.Drawing.Bitmap([int]$w.rect[2], [int]$w.rect[3], [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g2 = [System.Drawing.Graphics]::FromImage($bmp)
    $g2.CopyFromScreen([int]$w.rect[0], [int]$w.rect[1], 0, 0, (New-Object System.Drawing.Size([int]$w.rect[2], [int]$w.rect[3])))
    $g2.Dispose()
    $kind = if ($w.rect[2] -ge 560) { 'chat' } else { 'character' }
    $p = Join-Path $shotDir ("mine-{0}-pid{1}-{2}x{3}-$stamp.png" -f $kind, $w.pid, $w.rect[2], $w.rect[3])
    $bmp.Save($p, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "WROTE $p"
  }
}
