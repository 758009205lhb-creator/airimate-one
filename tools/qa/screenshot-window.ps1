# tools/qa/screenshot-window.ps1 —— 把指定窗口提到最前并按 DPI 感知截取它自己
#
# 为什么需要它：`Get-DesktopState.ps1 -Screenshot` 用 `CopyFromScreen` 抓屏幕区域，
# 如果目标窗口被别的窗口盖住，抓到的就是**别人**（本机实测：抓到的是 ChatGPT 桌面端）。
# 而验收截图要求"看到的是这个应用"。所以这里：
#   ① 先把目标窗口 `SetWindowPos(HWND_TOPMOST)` + `SetForegroundWindow` 顶到最前；
#   ② 再等若干毫秒让它重绘（3D 渲染需要时间出一帧）；
#   ③ 用 `CopyFromScreen` 抓它的矩形。
#
# 注意：这只影响**截图那一刻**的 z 序；应用自身不会变成常驻置顶
#（是否置顶由应用的窗口模式决定：panel 不置顶、pet 置顶）。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\screenshot-window.ps1 -TargetPid 1234 -OutFile out.png
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [int]$WaitMs = 2500
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing -ErrorAction SilentlyContinue
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WinShot {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
  public const uint SWP_NOMOVE = 0x0002, SWP_NOSIZE = 0x0001, SWP_SHOWWINDOW = 0x0040;
}
'@ | Out-Null

[WinShot]::SetProcessDPIAware() | Out-Null

$proc = Get-Process -Id $TargetPid -ErrorAction Stop
$h = $proc.MainWindowHandle
if ($h -eq [IntPtr]::Zero) { throw "进程 $TargetPid 没有主窗口句柄" }

# 顶到最前：先恢复（若最小化）、再置顶、再激活
[WinShot]::ShowWindow($h, 9) | Out-Null   # SW_RESTORE
[WinShot]::SetWindowPos($h, [WinShot]::HWND_TOPMOST, 0, 0, 0, 0,
  ([WinShot]::SWP_NOMOVE -bor [WinShot]::SWP_NOSIZE -bor [WinShot]::SWP_SHOWWINDOW)) | Out-Null
[WinShot]::BringWindowToTop($h) | Out-Null
[WinShot]::SetForegroundWindow($h) | Out-Null

# 等它真的画出内容（3D 场景需要至少一帧 + 可能的合成延迟）
Start-Sleep -Milliseconds $WaitMs

$r = New-Object WinShot+RECT
[WinShot]::GetWindowRect($h, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$ht = $r.Bottom - $r.Top
if ($w -le 0 -or $ht -le 0) { throw "窗口矩形无效：$w x $ht" }

$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size $w, $ht))
$dir = Split-Path -Parent $OutFile
if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

# 截图后撤销"常驻置顶"，避免改变应用的窗口语义
[WinShot]::SetWindowPos($h, [WinShot]::HWND_NOTOPMOST, 0, 0, 0, 0,
  ([WinShot]::SWP_NOMOVE -bor [WinShot]::SWP_NOSIZE)) | Out-Null

[ordered]@{
  pid = $TargetPid; hwnd = $h.ToInt64()
  rect = @{ x = $r.Left; y = $r.Top; w = $w; h = $ht }
  outFile = $OutFile
  bytes = (Get-Item -LiteralPath $OutFile).Length
  ok = $true
} | ConvertTo-Json -Depth 4 -Compress
