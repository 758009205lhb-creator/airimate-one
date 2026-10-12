# tools/qa/move-window.ps1 —— 把本应用窗口移到屏幕内的可见位置（仅测试辅助）
#
# 为什么需要它：验收截图时窗口可能位于屏幕边缘之外（本机实测出现过
# `619x960+1034+213`，右边缘超出 1434 宽的桌面），导致 `CopyFromScreen`
# 只能抓到一部分、或被其它窗口盖住的区域。素材不可读时，截图作为证据就失效了。
#
# 只**移动**窗口，不改尺寸语义（尺寸仍由应用的 applyMode 决定）：
# 传 `-KeepSize` 时按当前尺寸移动；否则按给定宽高移动。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\move-window.ps1 -Pid 12345 -X 60 -Y 40
[CmdletBinding()]
param(
  # ⚠ 参数不能叫 $Pid：那是 PowerShell 的只读自动变量（实测报 "Cannot overwrite variable Pid"）
  [Parameter(Mandatory = $true)][int]$TargetPid,
  [int]$X = 60,
  [int]$Y = 40,
  [int]$Width = 0,
  [int]$Height = 0
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WinMove {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
'@ | Out-Null

[WinMove]::SetProcessDPIAware() | Out-Null

$proc = Get-Process -Id $TargetPid -ErrorAction Stop
$h = $proc.MainWindowHandle
if ($h -eq [IntPtr]::Zero) { throw "进程 $TargetPid 没有主窗口句柄（可能还没有可见窗口）" }

$r = New-Object WinMove+RECT
[WinMove]::GetWindowRect($h, [ref]$r) | Out-Null
$curW = $r.Right - $r.Left
$curH = $r.Bottom - $r.Top
$w = if ($Width -gt 0) { $Width } else { $curW }
$ht = if ($Height -gt 0) { $Height } else { $curH }

[WinMove]::MoveWindow($h, $X, $Y, $w, $ht, $true) | Out-Null
Start-Sleep -Milliseconds 900
[WinMove]::GetWindowRect($h, [ref]$r) | Out-Null

$result = [ordered]@{
  pid    = $TargetPid
  hwnd   = $h.ToInt64()
  before = @{ x = ($r.Left - ($X - $r.Left)); y = $r.Top; w = $curW; h = $curH }
  after  = @{ x = $r.Left; y = $r.Top; w = ($r.Right - $r.Left); h = ($r.Bottom - $r.Top) }
  screen = @{ w = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width; h = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height }
  ok     = $true
}
[WinMove]::SetForegroundWindow($h) | Out-Null
$result | ConvertTo-Json -Depth 5 -Compress
