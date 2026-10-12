# tools/qa/activity-probe.ps1 —— 活动/阻断状态的**只读**采样器（M2）
#
# 为什么单独写成一个脚本而不是内联在 TS 里：
#   ① 主进程（Electron/Node）拿不到"全局空闲时间"与"前台窗口"，必须走 Win32；
#   ② 只在**采样时**起一次子进程、用完即退 —— 不驻留、不钩键盘、不录内容；
#   ③ 脚本可被单独跑、单独验（本项目的纪律：判据要可复现）。
#
# 隐私边界（硬约束，本脚本的全部对外字段如下）：
#   · idleMs        —— 距离上次键鼠输入的毫秒数（系统计数器，**不含内容**）
#   · inputEvents   —— 该计数器自身的增减（只用来判断"有没有在动"）
#   · fullscreen    —— 前台窗口是否覆盖整个显示器
#   · titleDigest   —— 前台窗口标题的 SHA256 前 8 位（**不输出原文**）
#   · titleChars    —— 标题长度
#   · focusAssist   —— 系统"助手专注/免打扰"是否开启（注册表只读枚举）
#   · foregroundPid —— 前台窗口所属进程 id（用于判断是不是本应用自己）
#   · gameProcess   —— 进程名（**不含路径**），命中预设的游戏进程名才输出
#   · meeting       —— 会议占用（摄像头/麦克风被占用，或会议进程在跑）
#
# 输出：单行 JSON。任何异常都必须仍然输出合法 JSON（available=false + reason），
#       调用方据此如实显示"采样不可用"，**不允许**把它当成"没有阻断"。

[CmdletBinding()]
param(
  [string[]]$GameProcessNames = @('dota2','cs2','csgo','valorant','league of legends','genshinimpact','yuanshen','starrail','wutheringwaves','minecraft','javaw','steam','overwatch','pubg','apex_legends','gta5','rdr2','eldenring','hollowknight','stardew valley','terraria','ffxiv_dx11','honkaiimpact3','zenlesszonezero'),
  [string[]]$MeetingProcessNames = @('zoom','teams','ms-teams','webexmta','wemeetapp','dingtalk','feishu','lark','slack','tencentmeeting'),
  [switch]$SkipProcessScan,
  [switch]$IncludeTitle
)

$ErrorActionPreference = 'Stop'

function Emit($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 6
  [Console]::Out.Write($json)
  exit 0
}

try {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AiriActivity {
  [StructLayout(LayoutKind.Sequential)]
  public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
  public static uint IdleMs() {
    LASTINPUTINFO li = new LASTINPUTINFO();
    li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
    if (!GetLastInputInfo(ref li)) return 0;
    // 用 int64 相减再取模：Environment.TickCount 会在 49.7 天后回绕，
    // 直接做 uint 减法会在回绕点给出一个巨大的空闲值（把"刚动过"判成"闲置一个月"）。
    long diff = (long)(uint)Environment.TickCount - (long)li.dwTime;
    if (diff < 0) diff += 4294967296L;
    if (diff < 0 || diff > 4294967295L) return 0;
    return (uint)diff;
  }
  public static string Title() {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return "";
    var sb = new System.Text.StringBuilder(512);
    GetWindowTextW(h, sb, sb.Capacity);
    return sb.ToString();
  }
  public static string ClassName() {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return "";
    var sb = new System.Text.StringBuilder(256);
    GetClassNameW(h, sb, sb.Capacity);
    return sb.ToString();
  }
  public static int[] Rect() {
    IntPtr h = GetForegroundWindow();
    RECT r;
    if (h == IntPtr.Zero || !GetWindowRect(h, out r)) return new int[] {0,0,0,0};
    return new int[] { r.Left, r.Top, r.Right, r.Bottom };
  }
  public static uint ForegroundPid() {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return 0;
    uint pid = 0;
    GetWindowThreadProcessId(h, out pid);
    return pid;
  }
  public static bool ForegroundIsShell() {
    IntPtr h = GetForegroundWindow();
    return h != IntPtr.Zero && h == GetShellWindow();
  }
  public static bool ForegroundVisible() {
    IntPtr h = GetForegroundWindow();
    return h != IntPtr.Zero && IsWindowVisible(h);
  }
}
'@ -ErrorAction Stop
} catch {
  Emit @{ available = $false; reason = "PInvoke 初始化失败：$($_.Exception.Message)" }
}

try {
  $idle = [int][AiriActivity]::IdleMs()
  $title = ''
  try { $title = [AiriActivity]::Title() } catch { $title = '' }
  $cls = ''
  try { $cls = [AiriActivity]::ClassName() } catch { $cls = '' }
  $rect = @(0, 0, 0, 0)
  try { $rect = [AiriActivity]::Rect() } catch { $rect = @(0, 0, 0, 0) }
  $fgPid = 0
  try { $fgPid = [int][AiriActivity]::ForegroundPid() } catch { $fgPid = 0 }
  $isShell = $false
  try { $isShell = [AiriActivity]::ForegroundIsShell() } catch { $isShell = $false }
  $visible = $false
  try { $visible = [AiriActivity]::ForegroundVisible() } catch { $visible = $false }

  # 光标所在显示器的边界（多屏时用光标位置判断"全屏在哪块屏上"）
  $mon = $null
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    $p = [System.Windows.Forms.Cursor]::Position
    $s = [System.Windows.Forms.Screen]::FromPoint($p)
    $mon = @{ x = $s.Bounds.X; y = $s.Bounds.Y; w = $s.Bounds.Width; h = $s.Bounds.Height }
  } catch { $mon = $null }

  # 全屏判定：前台窗口矩形覆盖（允许 2px 误差）光标所在显示器；排除桌面/任务栏壳窗口
  $fullscreen = $false
  if ($mon -ne $null -and -not $isShell -and $visible) {
    $w = $rect[2] - $rect[0]
    $h = $rect[3] - $rect[1]
    if ($w -ge ($mon.w - 2) -and $h -ge ($mon.h - 2)) { $fullscreen = $true }
  }

  # 标题摘要：**默认只输出哈希与长度**，原文永不出这个脚本
  $digest = $null
  $titleChars = 0
  if ($title) {
    $titleChars = $title.Length
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      $bytes = [System.Text.Encoding]::UTF8.GetBytes($title)
      $hash = $sha.ComputeHash($bytes)
      $digest = ([System.BitConverter]::ToString($hash) -replace '-', '').Substring(0, 8).ToLowerInvariant()
    } finally { $sha.Dispose() }
  }

  # 专注/免打扰：注册表**只读**枚举（读不到就 null，不猜）
  $focus = $null
  try {
    $key = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Notifications\Settings'
    if (Test-Path $key) {
      $v = Get-ItemProperty -Path $key -Name 'NOC_GLOBAL_SETTING_TOASTS_ENABLED' -ErrorAction SilentlyContinue
      if ($null -ne $v) { $focus = ([int]$v.NOC_GLOBAL_SETTING_TOASTS_ENABLED -eq 0) }
    }
  } catch { $focus = $null }

  # 摄像头/麦克风占用（会议检测的强信号）
  #
  # ⚠ 这里有一处**实测踩到的假阳性**：`LastUsedTimeStop = 0` 只表示"没写回停止时间"，
  #   进程被强杀（直播伴侣 `webcast_mate` 被任务管理器结束）后这个 0 会**永久留着**，
  #   于是"摄像头正在使用"永远为真 —— 那会让所有提醒被永久静音（比漏报更糟）。
  #   因此把"注册表说在用"与"那个可执行文件真的在跑"**同时**满足才算数（见 *Strong）。
  $camInUse = $false
  $micInUse = $false
  $camStrong = $false
  $micStrong = $false
  $running = @{}
  try {
    foreach ($p in (Get-Process -ErrorAction SilentlyContinue)) {
      if ($p.ProcessName) { $running[$p.ProcessName.ToLowerInvariant()] = $true }
    }
  } catch { }

  function Test-CapabilityInUse {
    param([string]$Root)
    $state = @{ reading = $false; strong = $false }
    try {
      if (-not (Test-Path $Root)) { return $state }
      $top = Get-ItemProperty -Path $Root -ErrorAction SilentlyContinue
      $entries = @()
      if ($null -ne $top -and $null -ne $top.LastUsedTimeStop) { $entries += @{ exe = $null; stop = $top.LastUsedTimeStop } }
      foreach ($sub in (Get-ChildItem -Path $Root -ErrorAction SilentlyContinue)) {
        $k = Get-Item $sub.PSPath -ErrorAction SilentlyContinue
        if ($null -eq $k) { continue }
        $stop = $k.GetValue('LastUsedTimeStop')
        if ($null -eq $stop) { continue }
        # 键名是路径把反斜杠换成 # 的形式（如 `E:#obs-studio#bin#64bit#obs64.exe`）
        $leaf = ($sub.PSChildName -split '#')[-1]
        $entries += @{ exe = $leaf; stop = $stop }
      }
      foreach ($e in $entries) {
        if ([int64]$e.stop -ne 0) { continue }
        $state.reading = $true
        if ($e.exe) {
          $name = $e.exe.ToLowerInvariant() -replace '\.exe$', ''
          if ($running.ContainsKey($name)) { $state.strong = $true }
        }
      }
    } catch { }
    return $state
  }

  $camState = Test-CapabilityInUse 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\webcam\NonPackaged'
  $micState = Test-CapabilityInUse 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged'
  $camInUse = [bool]$camState.reading
  $micInUse = [bool]$micState.reading
  $camStrong = [bool]$camState.strong
  $micStrong = [bool]$micState.strong

  $game = $null
  $meeting = $null
  if (-not $SkipProcessScan) {
    try {
      $procs = @(Get-Process -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName)
      $set = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
      foreach ($p in $procs) { if ($p) { $null = $set.Add($p) } }
      foreach ($g in $GameProcessNames) { if ($set.Contains($g)) { $game = $g; break } }
      foreach ($m in $MeetingProcessNames) { if ($set.Contains($m)) { $meeting = $m; break } }
    } catch { }
  }
  if ($camStrong -or $micStrong) {
    # 只有"注册表说在用" + "那个程序真的在跑"同时成立才当作会议信号（见上面的假阳性说明）
    if (-not $meeting) { $meeting = $(if ($camStrong) { 'camera-in-use' } else { 'microphone-in-use' }) }
  }

  $out = @{
    available = $true
    reason = $null
    idleMs = $idle
    fullscreen = $fullscreen
    foregroundPid = $fgPid
    foregroundIsShell = $isShell
    foregroundVisible = $visible
    windowClass = $cls
    titleDigest = $digest
    titleChars = $titleChars
    monitor = $mon
    focusAssist = $focus
    cameraInUse = $camInUse
    microphoneInUse = $micInUse
    cameraInUseStrong = $camStrong
    microphoneInUseStrong = $micStrong
    gameProcess = $game
    meeting = $meeting
    at = [int64]([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
  }
  if ($IncludeTitle) { $out.title = $title }   # 仅本地排查用；主进程**不会**传这个开关
  Emit $out
} catch {
  Emit @{ available = $false; reason = "采样失败：$($_.Exception.Message)" }
}
