<#
  tools/qa/conversation-shots.ps1 —— 「桌宠对话框 + 语音说话」的**真实桌面截图**取证

  为什么需要它（而不是让探针自己截）：
    探针在进程内只能 `capturePage()`（窗口截图）；而验收要的是**真实桌面截图**
    —— 能看见桌宠压在桌面上的实际观感（透明区域是否吃桌面点击、气泡有没有漂到脸上）。
    桌面截图只能由外面的 PowerShell 用 `CopyFromScreen` 做，但它不知道
    "气泡现在正显示着"这种**时刻**。于是用一对哨兵文件把时间点交给它：

      探针写 `<前缀>-<label>.ready`  →  本脚本截图并写 `<前缀>-<label>.done`  →  探针继续

    探针侧有 12s 超时（没有观察者也不会卡死），本脚本侧有总超时（不会挂住）。

  顺带取证 A2/A3/A4：
    在 pet 窗口出现的第一个时刻跑 `Get-DesktopState.ps1`（只读枚举 + 归属判定），
    拿到 `counts.mineVisibleWindows / legacyKernelVisibleWindows / legacyPetVisibleWindows`。

  纪律：只读；不结束任何进程（除清理**本工程**遗留的 electron 实例）；
        不点击、不移动窗口；截图落在 `docs\evidence\<phase>\screens\`。

  用法（PowerShell 5.1）：
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\conversation-shots.ps1 `
      -OutDir docs\evidence\phase15 -TimeoutSec 420
#>
[CmdletBinding()]
param(
  [string]$OutDir = '',
  [int]$TimeoutSec = 420
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $root 'package.json'))) { $root = 'F:\deepseek harness\AI女友\新工程' }
if (-not $OutDir) { $OutDir = Join-Path $root 'docs\evidence\phase15' }
if (-not [System.IO.Path]::IsPathRooted($OutDir)) { $OutDir = Join-Path $root $OutDir }
$screens = Join-Path $OutDir 'screens'
$null = New-Item -ItemType Directory -Force -Path $screens
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$prefix = Join-Path $screens "conversation-$stamp"
$jsonOut = Join-Path $OutDir 'conversation.json'

$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$appDir = Join-Path $root 'apps\desktop'

# ── DPI 感知：不设的话 CopyFromScreen 在 125% 缩放下会整体偏移（见 Get-DesktopState.ps1 的注释）
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DpiFix2 {
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
[DpiFix2]::Apply()
Add-Type -AssemblyName System.Drawing

# ── 键盘注入 + 前台判定（真实微软拼音验收用；只注入按键，不改任何输入法设置）
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class KbInject {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public const uint KEYUP = 0x0002;
  /**
   * 强行把目标窗口置前。
   * 为什么要 AttachThreadInput：Windows 的前台锁会**静默拒绝**后台进程的
   * SetForegroundWindow（实测：探针里 Electron 的 win.focus() 与 WScript.Shell.AppActivate
   * 都没能把窗口拿到前台）。把本线程的输入队列挂到当前前台线程上，再 SetForegroundWindow，
   * 是标准的可行做法；用完立刻 detach，不留副作用。
   */
  public static bool ForceForeground(IntPtr target) {
    if (target == IntPtr.Zero) return false;
    try {
      ShowWindow(target, 9);            // SW_RESTORE
      IntPtr fg = GetForegroundWindow();
      uint pid;
      uint fgThread = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, out pid);
      uint myThread = GetCurrentThreadId();
      bool attached = false;
      if (fgThread != 0 && fgThread != myThread) attached = AttachThreadInput(fgThread, myThread, true);
      try {
        BringWindowToTop(target);
        SetForegroundWindow(target);
      } finally {
        if (attached) AttachThreadInput(fgThread, myThread, false);
      }
      return GetForegroundWindow() == target;
    } catch { return false; }
  }
}
'@

function Save-DesktopShot {
  param([string]$Path)
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  return (Get-Item $Path).Length
}
Add-Type -AssemblyName System.Windows.Forms

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

# ── 键盘注入与前台判定（真实 IME 验收用）
function Get-ForegroundInfo {
  $h = [KbInject]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 512
  [void][KbInject]::GetWindowTextW($h, $sb, 512)
  $cls = New-Object System.Text.StringBuilder 256
  [void][KbInject]::GetClassNameW($h, $cls, 256)
  $pid2 = 0
  [void][KbInject]::GetWindowThreadProcessId($h, [ref]$pid2)
  $img = $null
  try { $img = (Get-CimInstance Win32_Process -Filter "ProcessId=$pid2" -ErrorAction SilentlyContinue).ExecutablePath } catch { }
  return [pscustomobject]@{
    hwnd = $h.ToInt64(); title = $sb.ToString(); cls = $cls.ToString(); pid = $pid2
    isOurApp = ($img -and $img -like '*新工程*')
  }
}

function Set-Foreground {
  # 找到本应用的主窗口句柄，然后**强行**置前（前置失败时返回 false，调用方据此拒绝敲键）
  $ws = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*新工程*' })
  foreach ($p in $ws) {
    $m = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    if ($m -and $m.MainWindowHandle -ne 0) {
      return [KbInject]::ForceForeground($m.MainWindowHandle)
    }
  }
  return $false
}

function Send-Vk { param([byte]$Vk)
  [KbInject]::keybd_event($Vk, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [KbInject]::keybd_event($Vk, 0, [KbInject]::KEYUP, [UIntPtr]::Zero)
}

<#
  敲 ASCII 字母（用于触发中文输入法的拼音候选）。
  用**真实虚拟键码**（VK_A=0x41 … VK_Z=0x5A）逐键注入，等价于用户真的按了键盘 ——
  这正是"真实微软拼音候选期按 Enter"要考的场景。
#>
function Send-AsciiKeys {
  param([string]$Text, [int]$GapMs = 90)
  foreach ($ch in $Text.ToCharArray()) {
    $up = ([string]$ch).ToUpperInvariant()
    $code = [int][char]$up
    if ($code -lt 65 -or $code -gt 90) { continue }
    Send-Vk -Vk ([byte]$code)
    Start-Sleep -Milliseconds $GapMs
  }
}

Clear-AirimateLeftovers -Self $PID
foreach ($f in @("$prefix-pet-dock-closed.ready", "$prefix-pet-dock-closed.done")) { if (Test-Path $f) { Remove-Item $f -Force } }
Get-ChildItem $screens -Filter 'conversation-*.ready' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
if (Test-Path $jsonOut) { Remove-Item $jsonOut -Force }

Write-Output "[shots] 启动探针 conversation（截图前缀：$prefix）"
$proc = Start-Process -FilePath $electron -PassThru -ArgumentList @(
  "`"$appDir`"", '--dev', '--mode=pet', '--no-dialogs',
  '--probe', 'conversation', '--probe-out', "`"$jsonOut`"", '--probe-shot', "`"$prefix`"", '--probe-exit'
)

$t0 = Get-Date
$handled = @{}
$desktopStateDone = $false
$report = @()

while (-not $proc.HasExited -and ((Get-Date) - $t0).TotalSeconds -lt $TimeoutSec) {
  $readyFiles = @(Get-ChildItem $screens -Filter 'conversation-*.ready' -ErrorAction SilentlyContinue)
  foreach ($rf in $readyFiles) {
    $label = ($rf.BaseName -replace '^conversation-\d{8}-\d{6}-', '')
    if ($handled.ContainsKey($label)) { continue }
    $handled[$label] = $true

    # A2/A3/A4：窗口刚出现的第一个时刻做一次只读枚举（含它自己的截图）
    if (-not $desktopStateDone) {
      $desktopStateDone = $true
      try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'tools\qa\Get-DesktopState.ps1') -OutDir $OutDir -Screenshot 2>&1 | Out-String | Write-Output
      } catch {
        Write-Output "[shots] Get-DesktopState 失败：$($_.Exception.Message)"
      }
    }

    Start-Sleep -Milliseconds 300
    $png = "$prefix-$label-desktop.png"
    $bytes = Save-DesktopShot -Path $png
    $report += [pscustomobject]@{ label = $label; png = $png; bytes = $bytes; at = (Get-Date).ToString('s') }
    Write-Output ("[shots] {0} → {1} ({2} bytes)" -f $label, (Split-Path -Leaf $png), $bytes)

    # ── 真实微软拼音：候选期按 Enter（本轮验收判据 §七.5）
    #    ⚠ 三条安全纪律（都是实测踩出来的）：
    #      ① **只在前台确认是本应用时**才敲键 —— 否则按键会打进别的窗口
    #         （第一次跑就把 "nihao" 敲进了另一个应用的输入框）；
    #      ② **绝不发 Esc** —— 本应用里 Esc 的语义就是"关闭对话框"，
    #         发一次就把后面所有依赖对话框开着的用例全废掉；
    #      ③ 敲击结果写进 `<前缀>-ime-live.json`，探针据此决定"验证"还是"跳过"。
    if ($label -eq 'ime-live') {
      $imeMeta = [pscustomobject]@{
        typed = $false; reason = ''; frontTitleBefore = ''; frontClassBefore = ''
        frontTitleAfter = ''; frontIsOurApp = $false
        keys = 'nihao → Space（选词，提交中文）→ shijie → Enter（候选期，不得发送）'
      }
      $fg = Get-ForegroundInfo
      $imeMeta.frontTitleBefore = $fg.title
      $imeMeta.frontClassBefore = $fg.cls
      Write-Output ("[shots] 前台窗口：{0}（{1}）" -f $fg.title, $fg.cls)

      if (-not $fg.isOurApp) {
        # 最多试 3 次：Windows 的前台锁是**概率性**的（实测同一份代码两次运行一次成功一次失败），
        # 一次失败就放弃会让这条判据变成随机 skipped —— 那等于没验证。
        for ($try = 1; $try -le 3; $try++) {
          $forced = Set-Foreground
          Write-Output ("[shots] 尝试强行置前（第 ${try} 次）：{0}" -f $forced)
          Start-Sleep -Milliseconds 700
          $fg = Get-ForegroundInfo
          if ($fg.isOurApp) { break }
        }
      }
      $imeMeta.frontTitleAfter = $fg.title
      $imeMeta.frontIsOurApp = [bool]$fg.isOurApp

      if ($fg.isOurApp) {
        Send-AsciiKeys -Text 'nihao' -GapMs 90
        Start-Sleep -Milliseconds 400
        Send-Vk -Vk 0x20          # Space：选定第一个候选（提交中文，证明 IME 真的在合成）
        Start-Sleep -Milliseconds 300
        Send-AsciiKeys -Text 'shijie' -GapMs 90
        Start-Sleep -Milliseconds 400
        Send-Vk -Vk 0x0D          # Enter（**候选期**：必须是"选定候选词"，不得发送）
        Start-Sleep -Milliseconds 300
        $imeMeta.typed = $true
        $imeMeta.reason = 'typed'
        Write-Output '[shots] 已敲入 nihao → Space → shijie → Enter（候选期 Enter）'
      } else {
        $imeMeta.reason = 'front-window-not-ours'
        Write-Output '[shots] ✗ 前台不是本应用 → **不敲键**（避免打进别的窗口），本项如实标为 skipped'
      }
      [System.IO.File]::WriteAllText("$prefix-ime-live.json", ($imeMeta | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
    }

    Set-Content -LiteralPath "$prefix-$label.done" -Value $label -Encoding UTF8
  }
  Start-Sleep -Milliseconds 150
}

if (-not $proc.HasExited) {
  Write-Output "[shots] 超时（${TimeoutSec}s）→ 结束探针"
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 800
Clear-AirimateLeftovers -Self $PID

# ⚠ 判定分量**全部在这里**先算好，再放进 JSON 字面量。
#   实测踩到两次：把 `-and` 链、`@()` 与 `Where-Object` 写进 `[pscustomobject]@{...}` 的字面量里，
#   同一个表达式在字面量**外面**求值是 True、在**里面**却是 False（PS 5.1 的解析行为），
#   表现为整条汇总 FAIL 而 JSON 里三个分量看起来都正常。分开算 ⇒ 可判定、可定位。
$requiredLabels = @('pet-dock-closed', 'pet-dock-open', 'panel-dock-overlay', 'bubble-visible', 'bubble-gone')
$missingLabels = @()
foreach ($l in $requiredLabels) {
  $hit = @($report | Where-Object { $_.label -eq $l })
  if ($hit.Count -eq 0) { $missingLabels += $l }
}
$requiredShots = @($report | Where-Object { $requiredLabels -contains $_.label })
$requiredNonEmpty = @($requiredShots | Where-Object { $_.bytes -gt 20480 })
$gateMissing = [bool]($missingLabels.Count -eq 0)
$gateShots = [bool]($requiredNonEmpty.Count -eq $requiredLabels.Count)
$gateJson = [bool](Test-Path $jsonOut)

$summary = [pscustomobject]@{
  id = 'conversation-shots'
  invariant = '五张真实桌面截图（pet 开/关、panel 浮层、气泡显示中/消失后）全部落盘且非空'
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  commandLine = "powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\conversation-shots.ps1 -OutDir $OutDir -TimeoutSec $TimeoutSec"
  prefix = $prefix
  shots = $report
  shotCount = @($report).Count
  # 判据有 5 个必需场景；真实 IME 那一张是**附加**证据，不参与这 5 张的计数
  requiredLabels = $requiredLabels
  missingLabels = $missingLabels
  requiredNonEmptyCount = $requiredNonEmpty.Count
  desktopStateRan = $desktopStateDone
  probeJson = $jsonOut
  probeJsonExists = $gateJson
  gateMissingNone = $gateMissing
  gateRequiredShotsNonEmpty = $gateShots
  gateProbeJsonExists = $gateJson
  pass = [bool]($gateMissing -and $gateShots -and $gateJson)
}
# ⚠ 必须**无 BOM**（验收约定 §1.3）：PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM，
#   而 BOM 会让 `JSON.parse` 直接失败（实测：summarize-probes 报 "Unexpected token ''"）。
[System.IO.File]::WriteAllText((Join-Path $OutDir 'conversation-shots.json'), ($summary | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
# 哨兵文件只用于握手，不留进证据目录（避免和截图混在一起）
Get-ChildItem $screens -Filter 'conversation-*.ready' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Get-ChildItem $screens -Filter 'conversation-*.done' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
Write-Output ("[shots] 共 {0} 张桌面截图；清单：{1}" -f @($report).Count, (Join-Path $OutDir 'conversation-shots.json'))
Write-Output ("[shots] 探针 JSON：{0}（存在={1}）" -f $jsonOut, (Test-Path $jsonOut))
