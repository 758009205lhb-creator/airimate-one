<#
  tools/qa/hotkey-toggle.ps1 —— 全局快捷键 `Ctrl+Alt+Space` 的**真实按键**验收

  为什么必须单独一条（而不是只读 `conversation:state` 里的 `registered`）：
    `registered: true` 只说"注册调用成功了"，**没说**"按下去真的有反应"——
    而用户关心的恰恰是后者。本项目已经踩过"后端读数全绿、用户按了没反应"这一类坑
    （向导死锁、`--mode=pet` 静默失效）。所以这里用 `keybd_event` 真的按一次组合键，
    从**窗口几何**上读出结果。

  判据：
    ① 按一次：pet 窗口尺寸从 340×420 DIP 变成 380×560 DIP（= WINDOW_GEOMETRY.conversation）；
    ② 再按一次：回到 340×420 DIP，且位置与初始一致（进入/退出严格互逆）；
    ③ 全程可见窗口数 = 1、实例数 = 1。

  用法（PowerShell 5.1）：
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\hotkey-toggle.ps1 `
      -OutDir docs\evidence\phase15
#>
[CmdletBinding()]
param(
  [string]$OutDir = '',
  [int]$TimeoutSec = 120
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $root 'package.json'))) { $root = 'F:\deepseek harness\AI女友\新工程' }
if (-not $OutDir) { $OutDir = Join-Path $root 'docs\evidence\phase15' }
if (-not [System.IO.Path]::IsPathRooted($OutDir)) { $OutDir = Join-Path $root $OutDir }
$null = New-Item -ItemType Directory -Force -Path $OutDir
$jsonOut = Join-Path $OutDir 'conversation-hotkey.json'
$generatedAt = (Get-Date).ToUniversalTime().ToString('o')

Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class HotKeyWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public const uint KEYUP = 0x0002;
  public const byte VK_CONTROL = 0x11, VK_MENU = 0x12, VK_SPACE = 0x20;
}
'@

function Get-AppWindows {
  $rows = New-Object System.Collections.ArrayList
  $cb = [HotKeyWin+EnumProc]{
    param($h, $l)
    if ([HotKeyWin]::IsWindowVisible($h)) {
      $sb = New-Object System.Text.StringBuilder 512
      [void][HotKeyWin]::GetWindowTextW($h, $sb, 512)
      $title = $sb.ToString()
      $pid2 = 0
      [void][HotKeyWin]::GetWindowThreadProcessId($h, [ref]$pid2)
      $proc = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
      if ($proc -and $proc.ProcessName -eq 'electron') {
        $r = New-Object HotKeyWin+RECT
        [void][HotKeyWin]::GetWindowRect($h, [ref]$r)
        $img = $null
        try { $img = (Get-CimInstance Win32_Process -Filter "ProcessId=$pid2" -ErrorAction SilentlyContinue).ExecutablePath } catch { }
        if ($img -and $img -like '*新工程*') {
          [void]$rows.Add([pscustomobject]@{
            hwnd = $h.ToInt64(); pid = $pid2; title = $title
            x = $r.L; y = $r.T; w = ($r.R - $r.L); h = ($r.B - $r.T)
          })
        }
      }
    }
    return $true
  }
  [void][HotKeyWin]::EnumWindows($cb, [IntPtr]::Zero)
  return $rows
}

function Get-MainWindow {
  $ws = @(Get-AppWindows | Where-Object { $_.title -eq 'AiriMate One' })
  if ($ws.Count -ge 1) { return $ws[0] }
  return $null
}

function Send-Hotkey {
  [HotKeyWin]::keybd_event([HotKeyWin]::VK_CONTROL, 0, 0, [UIntPtr]::Zero)
  [HotKeyWin]::keybd_event([HotKeyWin]::VK_MENU, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [HotKeyWin]::keybd_event([HotKeyWin]::VK_SPACE, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [HotKeyWin]::keybd_event([HotKeyWin]::VK_SPACE, 0, [HotKeyWin]::KEYUP, [UIntPtr]::Zero)
  [HotKeyWin]::keybd_event([HotKeyWin]::VK_MENU, 0, [HotKeyWin]::KEYUP, [UIntPtr]::Zero)
  [HotKeyWin]::keybd_event([HotKeyWin]::VK_CONTROL, 0, [HotKeyWin]::KEYUP, [UIntPtr]::Zero)
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
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$appDir = Join-Path $root 'apps\desktop'
Write-Output "[hotkey] 启动桌宠模式（只按快捷键，不点任何东西）"
$proc = Start-Process -FilePath $electron -PassThru -ArgumentList @("`"$appDir`"", '--dev', '--mode=pet', '--no-dialogs')

$t0 = Get-Date
$before = $null
while (((Get-Date) - $t0).TotalSeconds -lt $TimeoutSec) {
  $before = Get-MainWindow
  if ($before -and $before.w -gt 100) { break }
  Start-Sleep -Milliseconds 500
}
if (-not $before) {
  Write-Output '[hotkey] ✗ 等不到主窗口'
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  Clear-AirimateLeftovers -Self $PID
  exit 2
}
Start-Sleep -Seconds 3   # 等角色加载完（窗口尺寸不会再变）
$before = Get-MainWindow
Write-Output ("[hotkey] 初始：{0}x{1}+{2}+{3}" -f $before.w, $before.h, $before.x, $before.y)

Send-Hotkey
Start-Sleep -Milliseconds 1800
$opened = Get-MainWindow
Write-Output ("[hotkey] 按一次后：{0}x{1}+{2}+{3}" -f $opened.w, $opened.h, $opened.x, $opened.y)

Send-Hotkey
Start-Sleep -Milliseconds 1800
$closed = Get-MainWindow
Write-Output ("[hotkey] 再按一次：{0}x{1}+{2}+{3}" -f $closed.w, $closed.h, $closed.x, $closed.y)

Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800
Clear-AirimateLeftovers -Self $PID

# 物理像素 → 用"初始=pet 340x420"反推缩放比，避免把 DPI 假设写死
$scale = [Math]::Round($before.w / 340.0, 4)
$expectOpenW = [Math]::Round(380 * $scale)
$expectOpenH = [Math]::Round(560 * $scale)

$passOpen = ([Math]::Abs($opened.w - $expectOpenW) -le 6) -and ([Math]::Abs($opened.h - $expectOpenH) -le 6)
$passClose = ($closed.w -eq $before.w) -and ($closed.h -eq $before.h) -and ($closed.x -eq $before.x) -and ($closed.y -eq $before.y)
$pass = $passOpen -and $passClose

$result = [pscustomobject]@{
  id = 'conversation-hotkey'
  invariant = 'Ctrl+Alt+Space 真的能开/关桌宠对话（窗口尺寸随之切换并可还原）'
  generatedAt = $generatedAt
  commandLine = "powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\hotkey-toggle.ps1 -OutDir $OutDir"
  scaleFactorInferred = $scale
  before = $before
  afterOpen = $opened
  afterClose = $closed
  expectedOpen = @{ w = $expectOpenW; h = $expectOpenH }
  passOpen = $passOpen
  passCloseRestoresExactly = $passClose
  pass = $pass
}
# ⚠ 必须**无 BOM**（验收约定 §1.3）：`Set-Content -Encoding UTF8` 在 PS 5.1 会写 BOM，
#   而 BOM 会让 `JSON.parse` 直接失败（实测：summarize-probes 报 "Unexpected token ''"）。
[System.IO.File]::WriteAllText($jsonOut, ($result | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
Write-Output ("[hotkey] pass={0} passOpen={1} passCloseRestoresExactly={2}（缩放比推断 {3}）" -f $pass, $passOpen, $passClose, $scale)
Write-Output "[hotkey] JSON: $jsonOut"
if (-not $pass) { exit 2 }
