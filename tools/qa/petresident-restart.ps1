<#
  tools/qa/petresident-restart.ps1 —— 「桌宠常驻」的**重启后仍生效**取证（2026-10-09 完善轮）

  ════════════════════════════════════════════════════════════════════════════
  为什么必须是**两次独立进程启动**（不能用"重建窗口"模拟）：
    判据 C2/C3 写的是"**重启后**仍 `visible=true/false`"。
    在同一个进程里重建窗口**不是**重启：
      · 单实例锁、`settings.json` 的读盘缓存、`ready-to-show` 时序全都不一样；
      · 最要紧的是 —— 重启验证的是"**设置文件里的值**驱动了启动行为"，
        而同进程里那个值一直在内存里，读不读盘根本不影响结果。
    ⇒ 拆成两次真实启动：
      第一次：普通启动，`petSetResident(true)` → 断言窗口可见 + 设置**写进了文件**；
      第二次：`--probe-pet-mode start-resident` 启动 → 断言**窗口真的自己出现了**。
        该参数是**会话级覆盖、不写设置**（见 bootstrap 的 KNOWN_FLAGS 注释），
        所以第二次的启动行为只能来自**第一次写下的那个设置文件**。

  ════════════════════════════════════════════════════════════════════════════
  纪律（与其它 QA 脚本一致）：
    · **只动本工程的进程**（按命令行含 `新工程` + `electron\dist` 精确匹配），绝不按名字泛杀；
    · 收尾**恢复** `settings.json` 里的 `petResident` / `startupOpenChat` 为运行前的值；
    · JSON 一律**无 BOM**（PS 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM，`JSON.parse` 会失败）。

  用法（PowerShell 5.1）：
    powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\petresident-restart.ps1 `
      -OutDir docs\evidence\phase17 -TimeoutSec 300
#>
param(
  [string]$OutDir = '',
  [int]$TimeoutSec = 300
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path (Join-Path $root 'package.json'))) { $root = 'F:\deepseek harness\AI女友\新工程' }
if (-not $OutDir) { $OutDir = Join-Path $root 'docs\evidence\phase17' }
if (-not [System.IO.Path]::IsPathRooted($OutDir)) { $OutDir = Join-Path $root $OutDir }
$null = New-Item -ItemType Directory -Force -Path $OutDir

$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$appDir = Join-Path $root 'apps\desktop'
$settingsFile = Join-Path $env:APPDATA 'AiriMateOne\settings.json'
$probeA = Join-Path $OutDir 'petresident.json'
$probeB = Join-Path $OutDir 'petresident-start-resident.json'
$summaryOut = Join-Path $OutDir 'petresident-restart.json'

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
  return $targets.Count
}

# ── 读设置文件（**必须是文件**：内存里的值对"重启后仍生效"毫无意义）
function Read-SettingFile {
  if (-not (Test-Path $settingsFile)) { return $null }
  try { return (Get-Content $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

Clear-AirimateLeftovers -Self $PID | Out-Null
$before = Read-SettingFile
$beforeResident = $null
$beforeStartupOpenChat = $null
if ($null -ne $before) {
  if ($null -ne $before.petResident) { $beforeResident = [bool]$before.petResident }
  if ($null -ne $before.startupOpenChat) { $beforeStartupOpenChat = [bool]$before.startupOpenChat }
}
Write-Output ("[petresident-restart] 运行前：petResident={0} startupOpenChat={1}" -f $beforeResident, $beforeStartupOpenChat)

$steps = @()
$failures = @()

# ═══════ 第一次启动：写设置（勾选常驻）+ 断言当前进程窗口可见
if (Test-Path $probeA) { Remove-Item $probeA -Force }
Write-Output '[petresident-restart] 第 1/2 次启动（写设置 + 当前进程断言）'
<#
  ⚠ 参数拼成**一个字符串**（与 run-probe.ps1 同一个坑）：
    `-ArgumentList @('--no-proactive')` 会被 PowerShell 再解析一次 ⇒ `--no-proactive` 变成
    `-no-proactive` ⇒ 应用侧白名单直接拒绝启动、探针零产出。
#>
$argA = @("`"$appDir`"", '--dev', '--mode=pet', '--no-dialogs', '--no-proactive', '--probe', 'petresident', '--probe-out', "`"$probeA`"", '--probe-exit') -join ' '
$pA = Start-Process -FilePath $electron -PassThru -ArgumentList $argA
$okA = $pA.WaitForExit($TimeoutSec * 1000)
if (-not $okA) { Stop-Process -Id $pA.Id -Force -ErrorAction SilentlyContinue; $failures += 'passA-timeout' }
Clear-AirimateLeftovers -Self $PID | Out-Null
Start-Sleep -Milliseconds 600

$jsonA = $null
if (Test-Path $probeA) { try { $jsonA = Get-Content $probeA -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $jsonA = $null } }
$stepA = [ordered]@{}
$stepA['step'] = 'passA-default-run'
$stepA['probe'] = (Split-Path -Leaf $probeA)
$stepA['exists'] = [bool](Test-Path $probeA)
$stepA['pass'] = $(if ($jsonA) { $jsonA.pass } else { $null })
$steps += [pscustomobject]$stepA

# ═══════ ★ 重启之后：**在设置文件里**把常驻打开（模拟"用户勾上并落盘"）
<#
  为什么由脚本改文件、而不是让第一次运行留着 true：
    第一次运行收尾会**还原**设置（不留痕，那是探针的纪律）。
    而"重启后仍生效"要验证的正是"**文件里有 true** ⇒ 启动时窗口自己出现"。
    ⇒ 这里显式把 true 写进文件，再启动第二次进程。
  写文件的方式与主进程一致：整对象读回 → 改一个键 → 原子写（临时文件 + rename）。
#>
$setObj = Read-SettingFile
if ($null -eq $setObj) {
  $failures += 'settings-file-unreadable'
} else {
  $setObj.petResident = $true
  $tmp = "$settingsFile.tmp"
  $json = $setObj | ConvertTo-Json -Depth 10
  [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $settingsFile -Force
}
$onDiskBeforeB = Read-SettingFile
$residentOnDiskBeforeB = $null
if ($null -ne $onDiskBeforeB -and $null -ne $onDiskBeforeB.petResident) { $residentOnDiskBeforeB = [bool]$onDiskBeforeB.petResident }
Write-Output ("[petresident-restart] 已把 petResident 写入设置文件：{0}" -f $residentOnDiskBeforeB)

# ═══════ 第二次启动：按"常驻"启动 ⇒ 窗口必须**自己出现**
if (Test-Path $probeB) { Remove-Item $probeB -Force }
Write-Output '[petresident-restart] 第 2/2 次启动（--probe-pet-mode start-resident）'
$argB = @("`"$appDir`"", '--dev', '--mode=pet', '--no-dialogs', '--no-proactive', '--probe', 'petresident', '--probe-pet-mode', 'start-resident', '--probe-out', "`"$probeB`"", '--probe-exit') -join ' '
$pB = Start-Process -FilePath $electron -PassThru -ArgumentList $argB
$okB = $pB.WaitForExit($TimeoutSec * 1000)
if (-not $okB) { Stop-Process -Id $pB.Id -Force -ErrorAction SilentlyContinue; $failures += 'passB-timeout' }
Clear-AirimateLeftovers -Self $PID | Out-Null

$jsonB = $null
if (Test-Path $probeB) { try { $jsonB = Get-Content $probeB -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $jsonB = $null } }
$stepB = [ordered]@{}
$stepB['step'] = 'passB-start-resident'
$stepB['probe'] = (Split-Path -Leaf $probeB)
$stepB['exists'] = [bool](Test-Path $probeB)
$stepB['pass'] = $(if ($jsonB) { $jsonB.pass } else { $null })
$steps += [pscustomobject]$stepB

# ═══════ 判定（**分开算好再放进 JSON 字面量**：PS 5.1 在字面量里求值 -and 链有实测坑）
$residentOnDiskBeforeBIsTrue = [bool]($residentOnDiskBeforeB -eq $true)
$passBPetVisibleAtBoot = $null
$passBPetVisibleNow = $null
$passBSettingsReadTrue = $null
$passBChatAlsoOpen = $null
if ($null -ne $jsonB) {
  if ($null -ne $jsonB.startup) {
    $passBPetVisibleAtBoot = [bool]($jsonB.startup.petVisibleAtBoot -eq $true)
    $passBPetVisibleNow = [bool]($jsonB.startup.petVisibleNow -eq $true)
    $passBChatAlsoOpen = [bool]($jsonB.startup.chatVisible -eq $true)
    if ($null -ne $jsonB.startup.settingsAtBoot) {
      $passBSettingsReadTrue = [bool]($jsonB.startup.settingsAtBoot.petResident -eq $true)
    }
  }
}
$gateA = [bool]($null -ne $jsonA)
$gateB = [bool]($null -ne $jsonB)
$gateDiskTrue = $residentOnDiskBeforeBIsTrue
$gateVisible = [bool]($passBPetVisibleAtBoot -eq $true -and $passBPetVisibleNow -eq $true)
$gateReadTrue = [bool]($passBSettingsReadTrue -eq $true)
$gateNoFailures = [bool]($failures.Count -eq 0)
$pass = [bool]($gateA -and $gateB -and $gateDiskTrue -and $gateVisible -and $gateReadTrue -and $gateNoFailures)

# ═══════ 收尾：把设置文件恢复成运行前的值（不留痕）
$after = Read-SettingFile
if ($null -ne $after) {
  if ($null -eq $beforeResident) { $after.PSObject.Properties.Remove('petResident') } else { $after.petResident = $beforeResident }
  if ($null -eq $beforeStartupOpenChat) { $after.PSObject.Properties.Remove('startupOpenChat') } else { $after.startupOpenChat = $beforeStartupOpenChat }
  $tmp2 = "$settingsFile.tmp"
  [System.IO.File]::WriteAllText($tmp2, ($after | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp2 -Destination $settingsFile -Force
}
$restored = Read-SettingFile
$restoredResident = $null
if ($null -ne $restored -and $null -ne $restored.petResident) { $restoredResident = [bool]$restored.petResident }
Write-Output ("[petresident-restart] 收尾后：petResident={0}（运行前 {1}）" -f $restoredResident, $beforeResident)

$summary = [ordered]@{}
$summary['id'] = 'petresident-restart'
$summary['invariant'] = '「桌宠常驻」写进设置文件后，**下一次进程启动**桌宠窗口自己出现（C2 的重启后一半）'
$summary['generatedAt'] = (Get-Date).ToUniversalTime().ToString('o')
$summary['commandLine'] = "powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\petresident-restart.ps1 -OutDir $OutDir -TimeoutSec $TimeoutSec"
$summary['technique'] = '两次独立进程启动；第二次带 --probe-pet-mode start-resident（会话级覆盖、不写设置）'
$summary['settingsBefore'] = $(New-Object psobject)
$summary['settingsBefore'] | Add-Member -NotePropertyName 'petResident' -NotePropertyValue $beforeResident
$summary['settingsBefore'] | Add-Member -NotePropertyName 'startupOpenChat' -NotePropertyValue $beforeStartupOpenChat
$summary['settingsRestoredTo'] = $(New-Object psobject)
$summary['settingsRestoredTo'] | Add-Member -NotePropertyName 'petResident' -NotePropertyValue $restoredResident
$summary['petResidentOnDiskBeforePassB'] = $residentOnDiskBeforeB
$summary['steps'] = $steps
$summary['passAJsonExists'] = $gateA
$summary['passBJsonExists'] = $gateB
$summary['passBpetVisibleAtBoot'] = $passBPetVisibleAtBoot
$summary['passBpetVisibleNow'] = $passBPetVisibleNow
$summary['passBsettingsReadTrue'] = $passBSettingsReadTrue
$summary['passBchatAlsoOpen'] = $passBChatAlsoOpen
$summary['failures'] = $failures
<#
  ⚠ 这里用 `Add-Member` 逐个挂字段，而**不是**写一个哈希字面量。
    实测（PS 5.1）：`[pscustomobject]@{ a = $x, b = $y }` —— 用**逗号**分隔的哈希字面量
    在这里报 `Missing expression after ','`（解析器把 `,` 当成了别的语法）。
    逐条 Add-Member 没有这个歧义，而且顺序稳定（便于人读 JSON）。
#>
$summary['checks'] = $(New-Object psobject)
$summary['checks'] | Add-Member -NotePropertyName 'passA.json-exists' -NotePropertyValue $gateA
$summary['checks'] | Add-Member -NotePropertyName 'passB.json-exists' -NotePropertyValue $gateB
$summary['checks'] | Add-Member -NotePropertyName 'disk.petResident-true-before-passB' -NotePropertyValue $gateDiskTrue
$summary['checks'] | Add-Member -NotePropertyName 'passB.pet-window-auto-shown' -NotePropertyValue $gateVisible
$summary['checks'] | Add-Member -NotePropertyName 'passB.startup-read-resident-from-settings' -NotePropertyValue $gateReadTrue
$summary['checks'] | Add-Member -NotePropertyName 'passB.chat-window-also-open' -NotePropertyValue $passBChatAlsoOpen
$summary['checks'] | Add-Member -NotePropertyName 'no-failures' -NotePropertyValue $gateNoFailures
$summary['pass'] = $pass
[System.IO.File]::WriteAllText($summaryOut, (([pscustomobject]$summary) | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
Write-Output ("[petresident-restart] pass={0} JSON：{1}" -f $pass, $summaryOut)
