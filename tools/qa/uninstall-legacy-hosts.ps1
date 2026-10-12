# tools/qa/uninstall-legacy-hosts.ps1
# 卸载上一代宿主：AIRI 0.12.0-beta.5（F:\AIRI）与 Mate Engine X3.3.0-HOTFIX-1（E:\EdGe下载\...）
# 以及它们留下的注册表卸载项、快捷方式、%APPDATA% / %LOCALAPPDATA% 残留。
#
# ⚠ 纪律：**绝不去 kill `node` / `electron`**
#    上一版脚本里的 `Get-Process node | Stop-Process` 把 DSH harness 自己的 node 进程
#    一起杀了（job runner exit 4294967295）—— 只按精确进程名杀目标宿主。
#
# 全程不启动卸载器 UI（避免卡在交互窗口）：直接删目录 + 清注册表 + 清快捷方式，
# 对 Electron/独立目录型安装体与 `Uninstall *.exe` 等价。

$ErrorActionPreference = 'Continue'
$log = Join-Path $PSScriptRoot '..\..\docs\evidence\uninstall-legacy-hosts.log'
$log = [System.IO.Path]::GetFullPath($log)
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
Set-Content -LiteralPath $log -Value "=== $(Get-Date -Format o) 卸载上一代宿主 ===" -Encoding UTF8

function W([string]$m) {
  $line = "$(Get-Date -Format 'HH:mm:ss')  $m"
  Write-Output $line
  Add-Content -LiteralPath $log -Value $line -Encoding UTF8
}

# ── 0) 只杀精确目标进程名（AIRI / MateEngineX），不碰 node / electron ──────────
foreach ($n in @('airi', 'MateEngineX')) {
  $ps = Get-Process -Name $n -ErrorAction SilentlyContinue
  if (-not $ps) { W "no running process named '$n'" ; continue }
  foreach ($p in $ps) {
    try { Stop-Process -Id $p.Id -Force -ErrorAction Stop; W "killed $n pid=$($p.Id)" }
    catch { W "kill $n pid=$($p.Id) failed: $($_.Exception.Message)" }
  }
}
Start-Sleep -Seconds 2

# ── 1) AIRI ────────────────────────────────────────────────────────────────────
$airiDir = 'F:\AIRI'
if (Test-Path -LiteralPath $airiDir) {
  try {
    Remove-Item -LiteralPath $airiDir -Recurse -Force -ErrorAction Stop
    W "deleted $airiDir"
  } catch {
    W "delete $airiDir FAILED: $($_.Exception.Message)"
  }
} else { W "$airiDir already absent" }
W "F:\AIRI exists after delete = $(Test-Path -LiteralPath $airiDir)"

# 注册表卸载项（HKCU + HKLM + WOW6432）
$uninstallRoots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)
foreach ($root in $uninstallRoots) {
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
    $name = ''
    try { $name = (Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction Stop).DisplayName } catch { }
    if ($name -match '^(AIRI|Mate Engine|MateEngine)') {
      try { Remove-Item -LiteralPath $_.PSPath -Recurse -Force -ErrorAction Stop; W "removed registry uninstall key: $name ($($_.PSChildName))" }
      catch { W "registry key removal failed for '$name': $($_.Exception.Message)" }
    }
  }
}

# ── 2) Mate Engine ─────────────────────────────────────────────────────────────
$mateDirs = @(
  'E:\EdGe下载\Public.Release.X3.3.0-HOTFIX-1'
)
foreach ($d in $mateDirs) {
  if (Test-Path -LiteralPath $d) {
    try { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction Stop; W "deleted $d" }
    catch { W "delete $d FAILED: $($_.Exception.Message)" }
  } else { W "$d already absent" }
}

# ── 3) 残留配置目录（用户已确认一并清理） ──────────────────────────────────────
$dataDirs = @(
  "$env:APPDATA\ai.moeru.airi",
  "$env:APPDATA\airi-mate-pet",
  "$env:APPDATA\@airimate",
  "$env:APPDATA\AiriMateOne",
  "$env:LOCALAPPDATA\MateEngine-AIRI",
  "$env:LOCALAPPDATA\AiriMate"
)
foreach ($d in $dataDirs) {
  if (Test-Path -LiteralPath $d) {
    try { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction Stop; W "deleted data dir $d" }
    catch { W "delete data dir $d FAILED: $($_.Exception.Message)" }
  } else { W "data dir absent: $d" }
}
# 注意：**不删** %APPDATA%\webcast_mate —— 名字里带 mate 但与两套宿主无关，不属于本次范围。

# ── 4) 快捷方式 ───────────────────────────────────────────────────────────────
$lnks = @(
  "$env:USERPROFILE\Desktop\AIRI.lnk",
  "$env:USERPROFILE\Desktop\Mate Engine.lnk",
  "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\AIRI.lnk"
)
foreach ($l in $lnks) {
  if (Test-Path -LiteralPath $l) {
    try { Remove-Item -LiteralPath $l -Force -ErrorAction Stop; W "deleted shortcut $l" }
    catch { W "delete shortcut $l FAILED: $($_.Exception.Message)" }
  } else { W "shortcut absent: $l" }
}

# ── 5) 结果复核 ───────────────────────────────────────────────────────────────
W "---- 复核 ----"
W "F:\AIRI exists = $(Test-Path -LiteralPath 'F:\AIRI')"
W "Mate dir exists = $(Test-Path -LiteralPath 'E:\EdGe下载\Public.Release.X3.3.0-HOTFIX-1')"
$still = @()
foreach ($root in $uninstallRoots) {
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object {
    $n = ''
    try { $n = (Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction Stop).DisplayName } catch { }
    if ($n -match '^(AIRI|Mate Engine|MateEngine)') { $still += $n }
  }
}
W ("remaining uninstall registry entries = [" + ($still -join ', ') + "]")
$procs = @()
foreach ($n in @('airi', 'MateEngineX')) { if (Get-Process -Name $n -ErrorAction SilentlyContinue) { $procs += $n } }
W ("running legacy host processes = [" + ($procs -join ', ') + "]")
W "=== 卸载结束 ==="
