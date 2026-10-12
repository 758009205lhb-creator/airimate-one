<#
 tools/qa/shortcut.ps1 —— 创建 / 删除 .lnk 快捷方式（安装器与卸载器共用）
 
 为什么用 WScript.Shell 而不是第三方模块：
   `.lnk` 的 COM 接口（`WScript.Shell`）是 Windows 自带的，**不需要额外依赖**，
   而本项目所在环境**无法访问 GitHub / npm 主站**（只有镜像可用）。
   引入一个快捷方式库只为这点功能，是把供应链风险换成了便利。
 
 为什么把"创建快捷方式"单独抽一个文件：
   安装器与卸载器都要用它，而两边的行为必须**互逆**——
   抽出来才能保证"装的时候建的路径"与"卸的时候删的路径"是同一套规则。
 
 用法：
   powershell -File tools\qa\shortcut.ps1 -Action create -Path <lnk> -Target <exe> -Arguments "<args>" -WorkDir <dir> -Icon <ico> -Description "..." -DryRun
   powershell -File tools\qa\shortcut.ps1 -Action remove -Path <lnk> -DryRun
 退出码：0 = 成功（含 DryRun）；1 = 失败（**不静默成功**）
 #>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('create', 'remove')][string]$Action,
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Target = '',
  [string]$Arguments = '',
  [string]$WorkDir = '',
  [string]$Icon = '',
  [string]$Description = 'AiriMate One',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$result = [ordered]@{ action = $Action; path = $Path; dryRun = [bool]$DryRun; target = $Target }

try {
  if ($Action -eq 'create') {
    if ([string]::IsNullOrWhiteSpace($Target)) { throw 'create 需要 -Target' }
    if (-not (Test-Path -LiteralPath $Target)) { throw "目标不存在：$Target" }
    $result.targetExists = $true
    if ($DryRun) {
      $result.wouldCreate = $true
      $result.ok = $true
      $result | ConvertTo-Json -Depth 4 -Compress
      # 用 [Environment]::Exit 而不是 exit：在 `-File` 脚本里 `exit` *不保证**把退出码
      # 传给调用方（实测：调用方拿到 0），于是 DryRun 的成功被误判成"创建失败"。
      [Environment]::Exit(0)
    }
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($Path)
    $lnk.TargetPath = $Target
    if ($Arguments) { $lnk.Arguments = $Arguments }
    if ($WorkDir) { $lnk.WorkingDirectory = $WorkDir }
    if ($Icon -and (Test-Path -LiteralPath $Icon)) { $lnk.IconLocation = $Icon }
    $lnk.Description = $Description
    $lnk.Save()
    $result.created = Test-Path -LiteralPath $Path
    if (-not $result.created) { throw "创建后文件仍不存在：$Path" }
    $result.ok = $true
  }
  else {
    $existed = Test-Path -LiteralPath $Path
    $result.existedBefore = $existed
    if ($DryRun) {
      $result.wouldRemove = $existed
      $result.ok = $true
      $result | ConvertTo-Json -Depth 4 -Compress
      [Environment]::Exit(0)
    }
    if ($existed) { Remove-Item -LiteralPath $Path -Force }
    $result.removed = -not (Test-Path -LiteralPath $Path)
    if (-not $result.removed) { throw "删除失败：$Path" }
    $result.ok = $true
  }
}
catch {
  $result.ok = $false
  $result.error = $_.Exception.Message
}

$result | ConvertTo-Json -Depth 4 -Compress
if ($result.ok) { [Environment]::Exit(0) } else { [Environment]::Exit(1) }
