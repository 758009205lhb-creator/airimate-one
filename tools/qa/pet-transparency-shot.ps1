# tools/qa/pet-transparency-shot.ps1
# 一次性取证：**pet 模式下角色窗口是否真的透明**（2026-10-08 返工轮排查用）
#
# 背景：返工轮的五张桌面截图里，角色窗口的区域是一块**深色实心板**，
#       而 2026-10-08 早间的历史截图（phase15 的 pet-dock-open）里角色是**直接压在桌面壁纸上**的。
#       本脚本把其它窗口全部最小化后拍一张干净的 pet 模式截图，用于**目视对照**。
#
# 只读：不结束进程（除清理本工程遗留实例）、不改窗口位置尺寸；拍完把让开的窗口还原。
param(
  [string]$OutFile = '',
  [int]$WaitSec = 24
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $root 'package.json'))) { $root = 'F:\deepseek harness\AI女友\新工程' }
if (-not $OutFile) { $OutFile = Join-Path $root 'docs\evidence\phase16\screens\ISOLATED-pet-clean.png' }

$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$appDir = Join-Path $root 'apps\desktop'

Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic;
public class DpiFix9 { [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
 [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);
 public static void Apply(){ try{ if(SetProcessDpiAwarenessContext(new IntPtr(-4))) return; }catch{} try{ SetProcessDpiAwareness(2); }catch{} } }
public class WinGuard2 {
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
  public static List<Row> Visible() {
    var res = new List<Row>();
    IntPtr shell = GetShellWindow(); IntPtr desk = GetDesktopWindow();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h) || IsIconic(h) || h == shell || h == desk) return true;
      var r = new Row(); r.hwnd = h.ToInt64();
      var t = new StringBuilder(512); GetWindowTextW(h, t, 512); r.title = t.ToString();
      var c = new StringBuilder(256); GetClassNameW(h, c, 256); r.cls = c.ToString();
      uint pid; GetWindowThreadProcessId(h, out pid); r.pid = pid;
      res.Add(r); return true;
    }, IntPtr.Zero);
    return res;
  }
}
'@
[DpiFix9]::Apply()
Add-Type -AssemblyName System.Drawing, System.Windows.Forms

function Hide-Others([int]$Self) {
  $hidden = @()
  foreach ($w in [WinGuard2]::Visible()) {
    if ($w.pid -eq $Self) { continue }
    if ($w.cls -eq 'Progman' -or $w.cls -eq 'Shell_TrayWnd' -or $w.cls -eq 'WorkerW') { continue }
    if ($w.title -like 'AiriMate One*') { continue }
    $null = [WinGuard2]::ShowWindow([IntPtr]$w.hwnd, 6)
    $hidden += $w
  }
  return $hidden
}
function Restore-All($hidden) { foreach ($w in $hidden) { try { $null = [WinGuard2]::ShowWindow([IntPtr]$w.hwnd, 9) } catch { } } }

Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*新工程*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$lock = Join-Path $env:APPDATA 'AiriMateOne\run\instance.lock'
if (Test-Path $lock) { Remove-Item $lock -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

$args = @("`"$appDir`"", '--dev', '--mode=pet', '--no-dialogs', '--no-proactive') -join ' '
$p = Start-Process -FilePath $electron -PassThru -ArgumentList $args
Start-Sleep -Seconds $WaitSec

$hidden = Hide-Others -Self $PID
Start-Sleep -Milliseconds 800
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$g.Dispose()
$bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Restore-All -Hidden $hidden
Write-Output "WROTE $OutFile ($((Get-Item $OutFile).Length) bytes)"
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
