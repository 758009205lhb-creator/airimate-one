# E0 — Legacy desktop-pet audit (read-only forensics)

**Purpose.** Give the new app (codename **AiriMate One**) the facts it needs to (a) detect the legacy
`AI女友 / Mate Engine × AIRI` stack before it starts, and (b) migrate the autostart surface — without
ever guessing ownership from a process name.

**Mode.** Strictly read-only. No process was killed, suspended, or started; no registry value was
written; no file was created, modified, renamed, or deleted outside the three report files.
`F:\AIRI` and `E:\EdGe下载\Public.Release.X3.3.0-HOTFIX-1` were **read-only inspected** (existence,
size, SHA256, PE version) and never written. The legacy launcher scripts were read, not executed.

| Item | Value |
|---|---|
| Host | `666AMCN` / `666AMCN\shiqian` / `C:\Users\shiqian` |
| OS | Microsoft Windows 11 专业版, version `10.0.28000`, build `28000`, AMD64 |
| Shell used | Windows PowerShell `5.1.28000.2952` (Desktop edition), 64-bit process |
| Last boot | `2026-09-26T09:45:49.5000000+08:00` |
| Capture timestamps | window chain `2026-09-27T00:06:37.5194900+08:00`; autostart `2026-09-27T00:07:09.7989538+08:00` |
| Machine evidence files | `E0-legacy-window-chain.json` (1 621 989 B), `E0-autostart-inventory.json` (1 315 777 B) |

Raw evidence for every statement below is in the two JSON files next to this document. Where a number
appears here it was re-derived from those JSON files after they were written, so the Markdown and the
JSON cannot disagree.

---

## 1. Inventory summary

### 1.1 Live processes and windows

`293` processes were captured via `Get-CimInstance Win32_Process`, and `193` top-level windows via
`Add-Type` P/Invoke `EnumWindows` (`18` of them visible). `14` processes were classified as belonging
to the legacy stack, plus `19` processes in the related tree (ancestors/descendants/helpers).

**Which of items 1–5 are RUNNING right now:**

| # | Legacy item | Running? | PIDs |
|---|---|---|---|
| 1 | `MateEngineX.exe` (Unity kernel / character) | **YES** | `22984` |
| 2 | Legacy standalone Electron pet `build\pet\app` (`main.mjs`) | **NO** | — |
| 3 | Legacy launcher scripts (`start-airi-brain.ps1`, `airi-brain.mjs`, `mate-engine-airi-bridge.mjs`, `llm-capture-proxy.mjs`, `tools\*`) | **PARTIAL — YES** | `18840` (`tools\host\airi-host.mjs`), `3488`, `19924`, `15028`, `5192` (`tools\host\win32-probe.ps1`) |
| 4 | Installed AIRI app `F:\AIRI\airi.exe` | **YES** | `12820` + 6 children `20080, 26708, 15948, 5492, 23768, 19964` |
| 5 | Installed shortcuts | n/a — they are files, not processes (see §4) | — |

The currently running legacy instance is **not** the old `start-airi-brain.ps1` architecture. It is the
newer headless host: `node.exe tools\host\airi-host.mjs --start --config %LOCALAPPDATA%\AiriMate\config.json`.
That single node process (`18840`) is the **root** of the live instance — it is the direct parent of
both `MateEngineX.exe` (`22984`) and `airi.exe` (`12820`), and it owns the listening ports.

```
node.exe 18840  tools\host\airi-host.mjs --start --config C:\Users\shiqian\AppData\Local\AiriMate\config.json
├── airi.exe 12820        F:\AIRI\airi.exe
│   ├── airi.exe 20080    --type=gpu-process
│   ├── airi.exe 26708    --type=utility --utility-sub-type=network.mojom.NetworkService
│   ├── airi.exe 15948    --type=renderer  --remote-debugging-port=9222
│   ├── airi.exe 5492     --type=renderer  --remote-debugging-port=9222
│   ├── airi.exe 23768    --type=utility --utility-sub-type=video_capture.mojom.VideoCaptureService
│   └── airi.exe 19964    --type=utility --utility-sub-type=audio.mojom.AudioService
├── MateEngineX.exe 22984 "…\build\workcopy\MateEngineX.exe" --airi-kernel-endpoint=127.0.0.1:61966
│   │                                                        --airi-kernel-token=2750c260…(32 hex)
│   │                                                        --airi-kernel-contract=1
│   └── UnityCrashHandler64.exe 25032  --attach 22984 2252916133888
├── powershell.exe 3488   tools\host\win32-probe.ps1 -Action cursor  -Hwnd 329144
├── powershell.exe 19924  tools\host\win32-probe.ps1 -Action workarea
├── powershell.exe 15028  tools\host\win32-probe.ps1 -Action findwindow -Name MateEngineX
└── powershell.exe 5192   tools\host\win32-probe.ps1 -Action processes
```

Parent `18840` is **parented to PID 18688, which no longer exists** ⇒ the legacy host is an orphan
(its launcher has already exited). Nothing will clean it up on its own. Its own lock file agrees:

```json
// C:\Users\shiqian\AppData\Local\AiriMate\host.lock.json
{ "pid": 18840, "startedAt": "2026-09-26T15:37:11.680Z", "heartbeat": 1790438927969,
  "controlPort": 6199, "version": "1.0.0", "host": "airi-host" }
```
`pid=18840 alive=True` — the lock is **live, not stale**.

**Visible top-level windows owned by legacy processes** (the only visible legacy window on the machine):

| PID | Process | HWND | Title | Class | Ex-style | Rect (L,T,R,B) | Size |
|---|---|---|---|---|---|---|---|
| 22984 | `MateEngineX.exe` | `0xC0606` | `MateEngineX` | `UnityWndClass` | `0x000800B0` = `WS_EX_LAYERED \| WS_EX_TOOLWINDOW \| WS_EX_TRANSPARENT \| 0x10` | `1113, 675, 1429, 995` | 316 × 320 |

`visible=true, enabled=true, minimized=false`; style `0x94000000` (`WS_POPUP|WS_VISIBLE|WS_CLIPSIBLINGS`).
No `WS_EX_TOPMOST` and no `WS_EX_APPWINDOW` at capture time ⇒ it is a borderless, layered,
alt-tab-hidden character window — consistent with a desktop pet plus its right-click wheel.
Its two sibling windows are `Default IME` (`0xB0692`) and `MSCTFIME UI` (`0xE065C`), both invisible
and both **owned by** `0xC0606` — i.e. they are not independent windows.

`airi.exe 12820` owns **9 top-level windows, all currently `visible=false`** — but two of them are the
real character surfaces and would show if unhidden:

| HWND | Title | Class | Visible | Ex-style | Rect |
|---|---|---|---|---|---|
| `0x505B8` | `AIRI` | `Chrome_WidgetWin_1` | false | `0x00280020` (`LAYERED\|TRANSPARENT\|0x200000`) | `1113, 485, 1433, 965` (320 × 480) |
| `0xD0530` | `BeatSync - AIRI` | `Chrome_WidgetWin_1` | false | `0x00200100` (`WINDOWEDGE\|0x200000`) | `317, 214, 1118, 815` |
| `0x1705D2` | (no title) | `Chrome_WidgetWin_0` | false | `0x00000100` | `230, 230, 1305, 980` |
| `0x10064C` | (no title) | `Electron_NotifyIconHostWindow` | false | — | tray icon host |
| `0x2B0510` | (no title) | `Electron_SystemPreferencesHostWindow` | false | — | — |
| `0x70904` | (no title) | `Base_PowerMessageWindow` | false | `0x08000000` (`NOACTIVATE`) | — |
| `0xE068C`, `0x30608`, `0x1C05E2` | — | `Chrome_WidgetWin_0` / `IME` / `MSCTFIME UI` | false | — | — |

Note the geometry overlap: the kernel's visible pet window (`1113,675 → 1429,995`) sits **inside** the
AIRI window's rectangle (`1113,485 → 1433,965`). Two live pets would occupy the same pixels.

**Listening sockets owned by the legacy chain** (this is the strongest, cheapest liveness signal):

| Endpoint | Owner PID | Meaning |
|---|---|---|
| `127.0.0.1:61966` | 18840 (`airi-host.mjs`) | kernel endpoint the game was launched against |
| `127.0.0.1:18190`, `127.0.0.1:18191` | 18840 | host control / gateway |
| `127.0.0.1:6199` | 18840 | host control port (matches `host.lock.json` `controlPort`) |
| `127.0.0.1:9222` | 12820 (`airi.exe`) | AIRI CDP debug port |
| `127.0.0.1:6121` | 12820 | AIRI/kernel RPC |
| `127.0.0.1:51350` | 12820 | AIRI ephemeral |
| `127.0.0.1:18181`, `127.0.0.1:13333` | — | **not listening** ⇒ the old `llm-capture-proxy.mjs` / `mate-engine-airi-bridge.mjs` node services are **not** running |

`ESTABLISHED 127.0.0.1:50030 → 127.0.0.1:61966 pid=22984` confirms the kernel is **linked to and driven by**
the legacy host right now, not merely resident.

### 1.2 Autostart surface

Proving commands are recorded in `E0-autostart-inventory.json#commands`; per-category proof counters are
in `#emptyCategoriesProof`.

| Mechanism | Enumerated | Legacy hits |
|---|---|---|
| `HKCU\…\CurrentVersion\Run` | key exists, **5** values | **0** |
| `HKCU\…\CurrentVersion\RunOnce` | key exists, **0** values | **0** |
| `HKLM\…\CurrentVersion\Run` | key exists, **3** values | **0** |
| `HKLM\…\CurrentVersion\RunOnce` | key exists, **0** values | **0** |
| `HKLM\Software\Wow6432Node\…\Run` | key exists, **1** value | **0** |
| `HKLM\Software\Wow6432Node\…\RunOnce` | key exists, **0** values | **0** |
| `HKCU\Software\Wow6432Node\…\Run` | **key does not exist** | **0** |
| `HKLM\…\RunOnceEx` | **key does not exist** | **0** |
| `HKCU`/`HKLM\…\Policies\Explorer\Run` | **both keys do not exist** | **0** |
| Per-user Startup folder | **1** file (`desktop.ini`, 174 B) | **0** |
| `C:\ProgramData\…\StartUp` | **1** file (`desktop.ini`, 174 B) | **0** |
| Scheduled tasks | **186** tasks, all actions/triggers/principal captured | **0** (two independent checks) |
| Windows services | **302** services | **0** (patterns also fail on service *names*) |
| Start Menu + Desktop + Public Desktop shortcuts | **81** `.lnk`/`.url` | **7** (manual launch points, not autostart) |

**Every autostart entry that currently exists** (complete, not a sample):

| Hive | Name | Raw value | Resolved target | Exists | Class |
|---|---|---|---|---|---|
| HKCU | `Steam` | `"D:\steam\steam.exe" -silent` | `D:\steam\steam.exe` | yes | unrelated |
| HKCU | `BaiduYunDetect` | `"E:\百度网盘\BaiduNetdisk\YunDetectService.exe"` | `E:\百度网盘\BaiduNetdisk\YunDetectService.exe` | yes | unrelated |
| HKCU | `QuarkUpdaterTaskUser1.0.0.21` | `"…\QuarkUpdater\1.0.0.21\updater.exe" --wake --enable-logging --vmodule=…` | `C:\Users\shiqian\AppData\Local\QuarkUpdater\QuarkUpdater\1.0.0.21\updater.exe` | yes | unrelated |
| HKCU | `QuarkCloudDriveUpdaterTaskUser1.0.0.11` | `"…\QuarkCloudDriveUpdater\1.0.0.11\updater.exe" --wake --enable-logging --vmodule=…` | `C:\Users\shiqian\AppData\Local\QuarkCloudDriveUpdater\QuarkCloudDriveUpdater\1.0.0.11\updater.exe` | yes | unrelated |
| HKCU | `kaixinbizhi` | `E:\obsstudio\obs-sh_main-min-0.7.3-soft\..\kaixinbizhi\kaixin.exe /hb:5 /from:2` | `…\kaixinbizhi\kaixin.exe` | yes | unrelated |
| HKLM | `SecurityHealth` | `%windir%\system32\SecurityHealthSystray.exe` | `C:\WINDOWS\system32\SecurityHealthSystray.exe` | yes | unrelated |
| HKLM | `RtkAudUService` | `"…\realtekservice.inf_amd64_26f0df01c9da165d\RtkAudUService64.exe" -background` | same | yes | unrelated |
| HKLM | `ACE-Tray` | `C:\Program Files\AntiCheatExpert\ACE-Tray.exe` | same | yes | unrelated |
| HKLM-Wow6432Node | `delta_force_launcher` | `F:\Delta Force\launcher\startup_runner.exe` | same | yes | unrelated |

`StartupApproved` state (Task Manager → Startup tab backing store, read-only):

| Key | Entries |
|---|---|
| `HKCU\…\Explorer\StartupApproved\Run` | `MicrosoftEdgeAutoLaunch_C666D5D4C8998C1BDB79FF1570C3CD18 = 02 00 …` → enabled; `Steam = 03 00 00 00 34 B6 22 9B D0 EA DC 01` → **disabled**; `QuarkCloudDriveUpdaterTaskUser1.0.0.7 = 02 00 …` → enabled; `BaiduYunDetect = 02 00 …` → enabled |
| `HKCU\…\StartupApproved\Run32` | 0 entries |
| `HKCU\…\StartupApproved\StartupFolder` | key exists, **0 entries** |
| `HKLM\…\Explorer\StartupApproved\Run` | `SecurityHealth = 06 00…`, `RtkAudUService = 02 00…`, `ACE-Tray = 02 00…` → all enabled |

Two facts worth recording: (a) `MicrosoftEdgeAutoLaunch_…` has a StartupApproved blob but **no**
corresponding `Run` value — an orphan blob, harmless, not ours to clean; (b) `Steam` is disabled in the
Startup tab while still present in `Run`, so "value present" ≠ "will start".

Classification rule actually applied (from `#classificationTaxonomy`), in priority order:
`legacy-pet` = resolved command text contains `F:\deepseek harness\AI女友`, or `build\pet\app`/`main.mjs`,
or a `MateEngineX` token with no other resolvable owner → `legacy-airi` = contains `\AIRI\` or app id
`ai.moeru.airi` → `unrelated` = target exists and matched nothing → `unknown` = matched nothing **and**
existence unproven. Legacy patterns are tested **before** existence, so a legacy reference can never be
downgraded to `unrelated`/`unknown`.

Scheduled tasks: 0 `legacy-pet`, 0 `legacy-airi`, 69 `unrelated`, 117 `unknown`. The 117 `unknown`
are tasks whose action has no resolvable file (empty `Execute`, e.g. `.NET Framework NGEN`; COM-handler
tasks; or a quoted `Execute` with an embedded quote such as
`'"C:\Program Files\NVIDIA Corporation\NVIDIA App\CEF\NVIDIA App.exe"'`). Because the legacy patterns are
evaluated first, none of the 117 can hide a legacy path; an independent second check over
`Execute` + `Arguments` + `WorkingDirectory` with the regex
`(?i)(MateEngineX|airi|start-airi-brain|build[\\/]pet)` also returned **0**. Only 3 tasks use an
interpreter-style action at all, and all three are Microsoft's:
`\Microsoft\Windows\Hotpatch\Monitoring` (`cmd.exe /d /c …\hpatchmonTask.cmd`),
`\Microsoft\Windows\Workplace Join\Automatic-Device-Join` (disabled, `dsregcmd.exe`),
`\Microsoft\Windows\Workplace Join\Recovery-Check` (disabled, `dsregcmd.exe`). **No task invokes `node.exe`.**

Services: 302 enumerated, `matchingServices = 0` for the pattern
`(?i)(MateEngineX|deepseek harness|AI女友|\\AIRI\\|ai\.moeru\.airi|start-airi-brain|airi-brain|mate-engine-airi|llm-capture-proxy|airi-host|build\\pet|build/pet)`.
A separate name/display-name match for `(?i)(mate|airi|brain|pet)` also returned **0** — the only
name hit anywhere was Microsoft's `AD RMS Rights Policy Template Management (Automated)` scheduled task,
which matched on the substring "Rights". **No service autostarts the legacy pet or kernel.**

---

## 2. Legacy artifact inventory (ownership facts)

All hashes are SHA256 of the file contents. `PE` values come from
`[System.Diagnostics.FileVersionInfo]::GetVersionInfo()`; `SIG` from `Get-AuthenticodeSignature`.

### 2.1 The Unity kernel — five byte-identical copies, one hash

| Path | Size | SHA256 | PE FileVersion / ProductVersion | SIG |
|---|---|---|---|---|
| `F:\deepseek harness\AI女友\build\workcopy\MateEngineX.exe` ← **the running one** | 667 648 | `ADFF90320ABCF78236E79B87211A38552C846778D37527587C1B9622CB696783` | `6000.2.6.4869578` / `6000.2.6f2 (4a4dcaec6541)` | NotSigned |
| `F:\deepseek harness\AI女友\build\workcopy\_baseline_backup\20260921-123414-baseline\MateEngineX.exe` | 667 648 | `ADFF9032…696783` (identical) | same | NotSigned |
| `F:\deepseek harness\AI女友\build\workcopy-airi\MateEngineX.exe` | 667 648 | `ADFF9032…696783` (identical) | same | NotSigned |
| `F:\deepseek harness\AI女友\build\workcopy-airi\_baseline_backup\20260921-124341-baseline\MateEngineX.exe` | 667 648 | `ADFF9032…696783` (identical) | same | NotSigned |
| `E:\EdGe下载\Public.Release.X3.3.0-HOTFIX-1\MateEngineX.exe` (**official standalone install**, per `C:\Users\shiqian\Desktop\Mate Engine.lnk`) | 667 648 | `ADFF9032…696783` (identical) | same | NotSigned |

All five share mtime `2025-10-26T13:34:36+08:00`. A whole-disk search
(`Get-ChildItem -LiteralPath <C:,D:,E:,F:> -Recurse -Force -File -Filter 'MateEngineX.exe'`) found
**no other copy**, and a parallel search for `airi.exe` found only `F:\AIRI\airi.exe`.

**This hash is the single ownership token for the kernel**: `ProductName`/`CompanyName`/`FileDescription`
are all empty (it is a Unity player bootstrap), and the file is unsigned, so there is **no** metadata-based
or signature-based fallback. Note the official install and the patched working copies are the *same bytes* —
the "patch" lives in `MateEngineX_Data\Managed\*.dll`, not in the executable (confirmed by
`start-airi-brain.ps1` `$script:Pairs`, which manages `undream.llmunity.Runtime.dll` /
`Assembly-CSharp.dll` and their `.baseline` / `.g3baseline` counterparts).

### 2.2 Unity crash handler

| Path | Size | SHA256 | PE | SIG |
|---|---|---|---|---|
| `F:\deepseek harness\AI女友\build\workcopy\UnityCrashHandler64.exe` | 1 559 472 | `7C4B4E3810B8D95C64458193693C13DA47B59FA295DE57E4948AB576803AED0B` | empty FileVersion/ProductName | **Valid** — `CN=Unity Technologies SF, O=Unity Technologies SF, L=San Francisco, S=California, C=US` |

### 2.3 The installed AIRI app

| Path | Size | SHA256 | PE | SIG |
|---|---|---|---|---|
| `F:\AIRI\airi.exe` | 235 537 920 | `BF42992109222621748E71A232902CE2B6FE7E6351428CEE1F8FB998065C33CB` | `FileVersion=0.12.0-beta.5`, `ProductVersion=0.12.0.0`, `ProductName=AIRI`, `CompanyName=Moeru AI`, `FileDescription=AIRI` | NotSigned |
| `F:\AIRI\resources\app.asar` | 1 367 911 043 | `F7F9867219AAF11E8EA5198E889B01E9BDC355AB1F93EBF0E3153ED6DC5A6C2B` | n/a | n/a |

This one *does* carry `ProductName`/`CompanyName`, so a metadata predicate is available as a secondary
check. The version string `0.12.0-beta.5` matches the requirement's `ai.moeru.airi/0.12.0-beta.5`.

### 2.4 The legacy standalone Electron pet (`build\pet\app`) — NOT running

| Path | Size | SHA256 |
|---|---|---|
| `F:\deepseek harness\AI女友\build\pet\app\main.mjs` | 33 066 | `FC9139EC456166E8781876DDB4E5879C70B3F7B3EDC2E4CC098C33BEA4AA7D52` |
| `F:\deepseek harness\AI女友\build\pet\app\package.json` | 252 | `8EBEBDE8D0D5B1DFCF0F90D3C262C4D856B1FA2E1904AF66C56E90EFB716F3C7` |
| `F:\deepseek harness\AI女友\build\pet\app\preload.mjs` | 3 834 | `BCCC8386F5F5C07F18F1EA1251EAE9E7E8E8DC0A0A5EA9FC036E5EE66781A6C0` |
| `F:\deepseek harness\AI女友\build\pet\app\index.html` | 1 887 | `394F04CC8B9819B6A5376C99D3A54CD37515C889011C53D1373E6B5070C5414C` |

**Project marker (this is what the new app should match on):** `build\pet\app\package.json` declares

```json
{ "name": "airi-mate-pet", "version": "0.1.0", "private": true, "type": "module",
  "description": "桌宠窗口（方案 B：替换 AIRI 窗口）—— 透明/无边框/置顶/点击穿透 + VRM 角色 + 右击轮盘",
  "main": "main.mjs" }
```

Sibling directories that also exist and are **not** the pet (do not confuse them):
`build\pet\probe-app\{main.js,package.json}`, `build\pet\probe-setposition\{main.cjs,package.json,setposition-result.json}`,
`build\pet\cursor-helper\cursor.cs`, `build\pet\logs\{pet.err.log (5 007 B), pet.out.log (75 515 B)}`,
`build\pet\assets\*.vrma` (13 motion files), `build\pet\app\pet-debug.json` (6 645 B).
The repo root `package.json` is a *different* project with `"name": "mate-engine-airi-bridge"`,
`"version": "1.0.0"`, devDependency `electron ^44.4.5` — the pet's Electron comes from there.

### 2.5 Legacy launcher scripts and helpers

| Path | Size | SHA256 |
|---|---|---|
| `F:\deepseek harness\AI女友\start-airi-brain.ps1` | 24 255 | `1E01168897F079A2DCFB61812AE8B827F0A0106C7BAED65B117C017FFA0F75FA` |
| `F:\deepseek harness\AI女友\autostart-airi-brain.ps1` | 923 | `412D9635B3584ED84B18CF5D9B27C635895125CB8909638B52FFC3B979C7285D` |
| `F:\deepseek harness\AI女友\install-shortcuts.ps1` | 1 923 | `D4EFEABE7A76EA068FE9A15865FC67BE8759288D0B4301EC0B68AECF3AE8BF6B` |
| `F:\deepseek harness\AI女友\airi-brain.mjs` | 12 753 | `36190B8002384123797562DE18B50CDC08C526350D2C3884D101FD427EA6527F` |
| `F:\deepseek harness\AI女友\mate-engine-airi-bridge.mjs` | 26 114 | `B6E20226098E26C629FB41E8C3093539AC55AA17EC396B0080EE2BF4E837C65E` |
| `F:\deepseek harness\AI女友\llm-capture-proxy.mjs` | 24 948 | `8C4C50B4848339D4267D746C4E552A9BBDAE2FB117BAE9325FB0D49F25C42DC3` |
| `F:\deepseek harness\AI女友\tools\host\airi-host.mjs` ← **running (18840)** | 1 261 | `BF89B9CCDDBE575B84F1DCA52CE01834B9EF573C6FFAF1190F0F81DD4DE5D2B1` |
| `F:\deepseek harness\AI女友\tools\host\win32-probe.ps1` ← **running ×4** | 35 034 | `5914CFF2D6B8804CC6D21AB07B9D95FF2C4F7814948E12820E66558F6711FD85` |
| `F:\deepseek harness\AI女友\tools\ui\tray.ps1` | 32 992 | `2C237BD5D92D30B7D2083C662547B4D4985E2D6122B6DAC3C00072ACD6699B70` |
| `F:\deepseek harness\AI女友\tools\bridge\Start-AiriStack.ps1` | 5 844 | `AD8E869AD2DA75438515F91C3FF0D8075E3D84674651482B1605CDAAB55965CF` |
| `F:\deepseek harness\AI女友\tools\restart-services.ps1` | 12 848 | `4D93C9028F08ED02003CF9AF0E7CED3893C892979F928808A0C0F6AAB0A08F39` |
| `F:\deepseek harness\AI女友\tools\spawn-service.mjs` | 3 333 | `C02DD20A699AD95CB13BF8AFF2AC4157F5B022174B692E18C7756D91CBD685C2` |
| `F:\deepseek harness\AI女友\tools\register-runtime-init.ps1` | 10 171 | `14E3797F7D99A5E406EA1909864BC2FFE7743EEF83C4E552F82650956D540271` |
| `F:\deepseek harness\AI女友\tools\dist\uninstall.ps1` (legacy uninstaller) | 5 585 | `643BB7F1CB971AB097B78FC263F62953FB476FC5821ED0FBD6ACF19ECB242E86` |
| `F:\deepseek harness\AI女友\package.json` | 331 | `1402D5B4B9E88720B305AF951BA1A815EB76CF8885131FCD8BA8AB168A448764` |

`tools\` contains ~200 further files across `bridge, csharp, dist, gateway, host, kernel, lib, link,
model-swap, stage, ui, verify, vrma`. The ones that can spawn the pet or the kernel are
`tools\host\airi-host.mjs` (the CLI entry — `node tools\host\airi-host.mjs --start|--stop|--restart|--status`,
dispatching into `src/host/cli.mjs`), `tools\host\win32-probe.ps1`, `tools\ui\tray.ps1`,
`tools\bridge\Start-AiriStack.ps1`, `tools\restart-services.ps1`, `tools\spawn-service.mjs`,
`tools\model-swap\hostctl.mjs`, `tools\model-swap\petctl.mjs`, `tools\verify\lib\host-up.mjs`.
`start-airi-brain.ps1` itself is the classic orchestrator: it reads `.airi-upstream.env`, launches
`F:\AIRI\airi.exe --remote-debugging-port=9222` (`Start-Airi`), launches the two node services
`llm-capture-proxy.mjs` (port 18181) and `mate-engine-airi-bridge.mjs` (port 13333) via
`Start-Process node` with **manual quoting** for the space-containing path, and finally
`Start-Process -FilePath $GameExe -WorkingDirectory $WorkCopy` (or the official `$OfficialExe`).
Its `-Stop` path does `Get-Process -Name MateEngineX | Kill` — that is why a second supervisor is
dangerous. `autostart-airi-brain.ps1` is the 21-line boot entry that calls `start-airi-brain.ps1 -Headless`.

### 2.6 Legacy shortcuts (the 7 files, with hashes)

| Path | Size | SHA256 | Target | Arguments | WorkingDir | Class |
|---|---|---|---|---|---|---|
| `C:\Users\shiqian\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\AIRI.lnk` | 715 | `C638996283BB4D95C36108FAAFD2D11B25255693E92D526D6BEB845213A58CE2` | `F:\AIRI\airi.exe` | — | `F:\AIRI` | legacy-airi |
| `C:\Users\shiqian\Desktop\AIRI.lnk` | 715 | `AF6B92FA1403294667C5BDEBBFEDA5C6A8AE4CA354F3D4804C740C07CCD62368` | `F:\AIRI\airi.exe` | — | `F:\AIRI` | legacy-airi |
| `C:\Users\shiqian\Desktop\启动 AI女友（Mate Engine × AIRI）.lnk` | 1 226 | `E731226064ACE8F695D41E60B479DF749E546C6B3EC264166C1738B23C23A151` | `powershell.exe` | `-NoProfile -ExecutionPolicy Bypass -File "F:\deepseek harness\AI女友\start-airi-brain.ps1" ` | `F:\deepseek harness\AI女友` | legacy-pet |
| `C:\Users\shiqian\Desktop\AI女友-链路自检.lnk` | 1 238 | `9DBAEA99D8A88DE2302D2EFC050E0C3D9176FB03A490E9549DF8706C1B0DAD2C` | `powershell.exe` | `… -File "…\start-airi-brain.ps1" -PreflightOnly` | `F:\deepseek harness\AI女友` | legacy-pet |
| `C:\Users\shiqian\Desktop\AI女友-停止服务.lnk` | 1 228 | `A87CF67EA4E54B2ED18D4C7006A27447A007B45E068D64084A790D38AC9F9DE9` | `powershell.exe` | `… -File "…\start-airi-brain.ps1" -Stop` | `F:\deepseek harness\AI女友` | legacy-pet |
| `C:\Users\shiqian\Desktop\AI女友-一键还原游戏.lnk` | 1 230 | `13169651C3298C9A8FA053252998698988E2DEA422972757156D2FA4242DF880` | `powershell.exe` | `… -File "…\start-airi-brain.ps1" -Restore` | `F:\deepseek harness\AI女友` | legacy-pet |
| `C:\Users\shiqian\Desktop\Mate Engine.lnk` | 912 | `563A16FCE718776FF2F13091602BC7CEE864844318805A8724878486965192C2` | `E:\EdGe下载\Public.Release.X3.3.0-HOTFIX-1\MateEngineX.exe` | — | `E:\EdGe下载\Public.Release.X3.3.0-HOTFIX-1` | legacy-pet |

These four desktop shortcuts are exactly what `install-shortcuts.ps1` creates (names, arguments, icon
`powershell.exe,0`, `WorkingDirectory = $root` all match its `New-Lnk` calls) — the legacy tree's own
documentation calls `.lnk` deletion "不会影响其它任何东西". They are **manual launch points, not autostart**.

### 2.7 Legacy user data and state (never delete, but detection-relevant)

| Path / key | Relevance |
|---|---|
| `C:\Users\shiqian\AppData\Local\AiriMate\host.lock.json` (160 B) | Live host lock: `pid 18840`, `controlPort 6199`, `heartbeat 1790438927969`. A **live** lock — the new app must not assume it is stale. |
| `C:\Users\shiqian\AppData\Local\AiriMate\config.json` (2 139 B) + `config.json.bak-t15*` (4 backups) | Legacy host config, passed by the running process. |
| `C:\Users\shiqian\AppData\Local\AiriMate\gateway-token.txt` (33 B), `control-token.txt` (49 B), `airi-provider-backup-deepseek.json` (588 B), `run-state.json` (24 786 B), `ui-state.json` (28 856 B), `ui-tray-*.json/ndjson`, `ui-bridge.log`, `logs\host-*.jsonl` (4 files, 7 MB) | Legacy runtime state. User data → keep. |
| `C:\Users\shiqian\AppData\Roaming\ai.moeru.airi` | AIRI's own Electron `--user-data-dir`. |
| `C:\Users\shiqian\AppData\LocalLow\Shinymoon\MateEngineX\settings.json` (1 571 B) | Game prefs. **`"startWithWindows": false`** — see §4.2. |
| `HKCU\Software\Shinymoon\MateEngineX` | Unity PlayerPrefs only (window position `X=1392 Y=884`, resolution `400×400`, `FPSLimit=60`, `UnityGraphicsQuality=1`, fullscreen mode 3). **No autostart semantics.** |
| `HKCU\Software\AiriMate`, `HKLM\Software\AiriMate`, `HKCU\Software\MateEngineX` | **do not exist** (`False`) — the legacy stack registers no product key of its own. |

---

## 3. Detection specification for the AiriMate One startup pre-check

### 3.1 The rule that is not negotiable

**Never decide ownership from a process name.** This audit is itself the counter-example: an early
capture flagged 4–6 of *the auditor's own* `node.exe`/`powershell.exe` wrapper processes as legacy,
because their command lines literally contained the strings `MateEngineX`, `airi`, and `build\pet\app`
(the audit script text). Those were excluded by an explicit audit-self-match control
(`inAuditHarnessSubtree`, recorded in `E0-legacy-window-chain.json#auditHarnessSelfMatchesExcluded`).
Any new app whose pre-check greps its own command line, cache, or log will reproduce the same false
positive. Ownership must come from **full image path + hash**, optionally corroborated by a project
marker file or a signature — never from the image name, and never from a bare token match.

### 3.2 Detection predicates and dispositions

Legend for *When found running*: **BLOCK** = refuse to continue silently; show an actionable message
(name the PID, the path, the reason, and the exact command to stop it) and offer "quit legacy stack and
continue" only as an explicit user action. **IGNORE** = harmless leftover, take no action.

| # | Artifact | Detection predicate (all clauses must hold) | When running | Why |
|---|---|---|---|---|
| D1 | Unity kernel `MateEngineX.exe` | image path ends `\MateEngineX.exe` **AND** `SHA256 == ADFF90320ABCF78236E79B87211A38552C846778D37527587C1B9622CB696783`; corroborate with `FileVersion == 6000.2.6.4869578` | **BLOCK** | It is the character body. Proven live: PID 22984 owns the only visible legacy window (`UnityWndClass "MateEngineX"`, 316×320 at `1113,675`). A second kernel contends for the same kernel endpoint and the new app's link would attach to the wrong instance. All 5 on-disk copies share one hash, so a single-hash test covers the project copy, the baseline backups, and the official install. |
| D2 | Unity crash handler | image path ends `\UnityCrashHandler64.exe` **AND** its parent PID is a D1 process | **IGNORE** | Proven harmless: PID 25032 (`--attach 22984 …`) is a child of the kernel with no window, no ports, and it exits with its parent. It is *the* thing a name-based cleanup gets wrong: it lives under the legacy root and carries "MateEngineX" nowhere in its name, yet killing it achieves nothing, and killing the kernel out from under an attached crash handler can surface the Unity crash reporter instead of a clean exit. |
| D3 | Legacy Electron pet (`build\pet\app`) | any process whose command line contains `\build\pet\app\main.mjs`, **or** whose image is `electron.exe` with `--app-path`/argv resolving under `build\pet\app`; corroborate by reading `build\pet\app\package.json` and requiring `name == "airi-mate-pet"` | **BLOCK** | It is the alternate desktop pet — `package.json` says 透明/无边框/置顶/点击穿透 + VRM 角色 + 右击轮盘. Two pets means two layered click-through windows fighting for the same pixels and the same right-click wheel. Not currently running, so this is a latent, not active, conflict. |
| D4 | Legacy launcher scripts | cmdline contains the **absolute path** of `start-airi-brain.ps1`, `autostart-airi-brain.ps1`, `install-shortcuts.ps1`, `airi-brain.mjs`, `mate-engine-airi-bridge.mjs`, or `llm-capture-proxy.mjs` | **BLOCK** | `start-airi-brain.ps1` orchestrates the whole stack and its `-Stop` path runs `Get-Process -Name MateEngineX \| Kill`. Two supervisors ⇒ the new app's kernel gets killed by the legacy stop button. Not currently running (ports 18181/13333 are free — evidence in §1.1), so this predicate currently yields nothing. |
| D5 | Legacy host supervisor `tools\host\airi-host.mjs` | cmdline contains `\tools\host\airi-host.mjs` | **BLOCK** — and treat as the **primary** runtime signal | It has **no window and no visible UI**, yet it is the root of the live legacy instance: parent of both `MateEngineX.exe 22984` and `airi.exe 12820`, owner of `127.0.0.1:61966/18190/18191/6199`, and the process named in the live lock file. "No window" is not evidence of harmlessness. This is the single check that would have caught the current state most cheaply. |
| D6 | `tools\host\win32-probe.ps1` probes | cmdline contains `\tools\host\win32-probe.ps1` | **IGNORE** (do not kill) | Four instances were live at capture (`-Action cursor/workarea/findwindow/processes`), all `visible=false`, all children of D5, spawning only `conhost.exe` and a transient `csc.exe`. They are short-lived read-only probes; they exit on their own, so killing them just makes the supervisor respawn them. |
| D7 | Installed AIRI app | image path starts `F:\AIRI\` **AND** `SHA256 == BF42992109222621748E71A232902CE2B6FE7E6351428CEE1F8FB998065C33CB` (or `ProductName == AIRI` + `FileVersion == 0.12.0-beta.5`) | **BLOCK, soft variant** — see below | `airi.exe 12820` owns 9 top-level windows, two of them real character surfaces (`Chrome_WidgetWin_1` titled `AIRI` 320×480 at `1113,485`, and `BeatSync - AIRI` 900×600) that are merely hidden right now. So it *would* show a character window. **Soft variant:** if a matching `airi.exe` is running **without** D1 and **without** D5, it is the standalone installed AIRI app, not the legacy chain — warn and let the user continue; if it runs **with** D1 or D5, it is the legacy instance and must block. |
| D8 | AIRI renderer/utility children | same image path+hash as D7 **AND** cmdline contains `--type=` | **IGNORE** | Child processes of D7 (`--type=gpu-process`, `--type=renderer`, `--type=utility --utility-sub-type=…`). A name-based matcher would report "7 airi.exe running" and multi-count one instance; the `--type=` clause collapses them into their parent. |
| D9 | Legacy shortcuts (7 files in §2.6) | file path **AND** SHA256 **AND** resolved `TargetPath`/`Arguments` | n/a — files, not processes | Ownership evidence for shortcut cleanup (§4.5). Include `WorkingDirectory` in the match: four of them point at `powershell.exe`, so the target alone is meaningless. |
| D10 | Legacy user data `%LOCALAPPDATA%\AiriMate` | directory exists; read `host.lock.json` and test whether its `pid` is alive | **IGNORE**, but report | Never delete (user data). But `host.lock.json` is a **first-class pre-check input**: `{pid:18840, controlPort:6199}` + `Get-Process -Id 18840` is a one-syscall liveness test that catches D5 even if the process image path is unreadable. |
| D11 | Game own prefs | `HKCU\Software\Shinymoon\MateEngineX` exists, or `…\LocalLow\Shinymoon\MateEngineX\settings.json` exists with `"startWithWindows": false` | **IGNORE** | Rewritten by the game at every launch (window geometry). No autostart semantics. Only relevant because `startWithWindows` decides whether the game re-creates its own Run entry (§4.2). |

### 3.3 Recommended pre-check order (cheapest, highest-signal first)

1. Read `%LOCALAPPDATA%\AiriMate\host.lock.json`; if `pid` is alive **and** that process's image/cmdline
   matches D5 → **legacy instance running → BLOCK**. (No enumeration needed.)
2. Probe the six legacy endpoints (`61966, 18190, 18191, 6199, 9222, 6121`). Any of `61966/18190/18191/6199`
   listening is, on this machine, unambiguous evidence of the legacy host.
3. Enumerate processes once; apply D1/D3/D4/D5/D7. Resolve every candidate to a **full image path**, hash it
   (`Get-FileHash`) or read its PE version, and only then decide. Never act on `Name`.
4. Collapse children (`--type=`, `--attach`) into their parents before reporting counts.
5. Report D2/D6/D8/D10/D11 as informational lines ("leftovers, no action taken") — the new app must be seen
   to have *considered* them, or the next auditor will re-litigate it.

### 3.4 The two classes, stated plainly

* **Must block a silent continue** — anything that *would show a character / wheel window* or that
  *drives one*: D1 (`MateEngineX.exe` — proven visible 316×320 window), D3 (`build\pet\app` pet — the
  layered click-through VRM window), D7 when accompanied by D1/D5 (`airi.exe` — its `AIRI` and
  `BeatSync - AIRI` windows exist and would show), D5 (`airi-host.mjs` — no window, but it is the parent
  and controller of D1+D7, so continuing silently means the new app's kernel gets stopped by the old
  supervisor), D4 (the old orchestrator, for the same reason).
* **Harmless leftovers that must still be *reported*, never "cleaned" by name** — D2
  (`UnityCrashHandler64.exe`, dies with its parent), D6 (`win32-probe.ps1`, short-lived read-only
  probes), D8 (`airi.exe --type=…` children), D10 (user data + a possibly-stale lock), D11 (game prefs).

---

## 4. Autostart migration specification

### 4.1 What actually points at the legacy stack today

**In every autostart mechanism: nothing.** `Run`, `RunOnce` (both hives, both views),
`Wow6432Node`, `RunOnceEx`, `Policies\Explorer\Run`, both Startup folders, all 186 scheduled tasks, and
all 302 services contain **zero** references to `F:\deepseek harness\AI女友`, `MateEngineX`, `airi`,
`start-airi-brain`, `build\pet`, or a `node.exe` invocation of a legacy script. Proof counters:
`legacyRun=0`, `legacyStartupFiles=0`, `legacyTasks=0`, `matchingServices=0`,
`totalLegacyAutostartReferences=7` — and all 7 are the **shortcuts** of §2.6, which are manual desktop /
Start-Menu launch points, not autostart entries.

The only legacy-adjacent autostart object that exists is an **orphan** `StartupApproved` blob
(`MicrosoftEdgeAutoLaunch_…`) with no matching `Run` value; it belongs to Edge, not to any legacy component.

### 4.2 The historical `MateEngine` Run entry — gone, and it will not come back

The legacy tree's own documents state that `HKCU\…\Run` used to contain a value named **`MateEngine`**
pointing at `…\build\workcopy\MateEngineX.exe`, and that it was written by the **game itself**
(`repos\...\Tools\SystemStartHandler.cs:103-152`, driven by `startWithWindows`), not by the project:

> `文档\反转安全评审.md` §A-5 / line 616: "`HKCU\...\Run` 有 `MateEngine = "…\build\workcopy\MateEngineX.exe"` … **这不是我们装的**"
> `文档\改动总清单.md` line 97: "`startWithWindows` | false | **True** ← 这导致自启项被写回"

Current verified facts (this capture): **no `MateEngine` value exists in any Run key** (HKCU Run holds
exactly 5 values, none matching `(?i)(matengine|mate engine|airi|ai女友|airimate|brain|pet)`), and
`%USERPROFILE%\AppData\LocalLow\Shinymoon\MateEngineX\settings.json` contains **`"startWithWindows": false`**.
⇒ The entry was removed at some point and the game's own switch is now off, so the game will not silently
re-create it. *This is a state, not a guarantee:* flipping that one boolean in the game's settings UI turns
it back on and re-writes a `MateEngine` Run value pointing at the **patched** kernel path — which is exactly
the "residual semantics" recorded as finding A-5. The new app should therefore re-assert the
"exactly one self-owned autostart entry" invariant on **every** launch, not just at install time.

### 4.3 Where the legacy installer would have written (and what it cleans)

`tools\dist\entry-scripts.mjs:246` (the legacy distribution's own uninstaller) reads
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` and deletes values matching
`^(AI女友|AiriMate|airi-brain)`, and says "本方案默认**不建**开机启动项；这里只是清掉上一轮遗留".
`src\host\dist.mjs:344-367` repeats it in its uninstall checklist (④ 删开机启动项 … 以 AiriMate/AI女友 开头的项).
So the legacy convention is: name-prefix `AI女友` / `AiriMate` / `airi-brain` in `HKCU\…\Run`, and
deliberately **no** autostart entry by default. The new app must pick a name that cannot collide with that
prefix set and must not rely on prefix-deletion to clean up after itself.

### 4.4 Backup-then-merge plan (ends with exactly ONE new entry)

*Constraints honoured: never write `F:\AIRI` or `E:\EdGe下载\…`; never modify a value the legacy stack or a
third party owns; no second autostart mechanism.*

**A. Backup (read-only capture, written to the new app's own data dir — never into the legacy tree)**
1. Read `HKCU\…\CurrentVersion\Run`, `…\RunOnce`, `HKLM\…\Run`, `HKLM\…\RunOnce`, both `Wow6432Node`
   variants, and `HKCU/HKLM\…\Explorer\StartupApproved\{Run,Run32,StartupFolder}`.
2. Persist an immutable snapshot before touching anything:
   `backup\<ISO8601>\hkcu-run.json` (name → type + raw value, read with
   `RegistryValueOptions::DoNotExpandEnvironmentNames` so the original text round-trips) plus a `.reg`
   export of the same keys, plus a SHA256 of both. Keep it forever; the uninstaller needs it.
3. Record the pre-existing name set so the installer can detect a collision later.

**B. Pre-flight (abort loudly, do not "fix")**
4. Abort if a value already exists that resolves to the new app's executable but with a *different*
   command line (someone edited it) — surface the diff; never overwrite silently.
5. Abort if the new app's own exe path contains characters that `CreateProcess` would mis-split without
   quoting. This machine proves the need: the legacy tree's path is `F:\deepseek harness\AI女友\…`, and
   `start-airi-brain.ps1` carries a 5-line comment explaining that `Start-Process -ArgumentList` does not
   quote space-containing arguments, causing `Cannot find module 'F:\deepseek'`. Always emit
   `"<full path>" --autostart` with real quotes.

**C. Merge — create exactly one entry**
6. Create **one** value, and only one, in `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`:

   | Field | Value |
   |---|---|
   | name | **`AiriOne`** |
   | type | `REG_SZ` |
   | data | `"<InstallDir>\<AppExe>" --autostart` — quoted, per step 5 above |

   The name is not a free choice; two constraints decide it, and both point the same way.

   * **Do not let the legacy uninstaller eat it.** `tools\dist\entry-scripts.mjs:250` deletes every `Run`
     value matching `^(AI女友|AiriMate|airi-brain)`, and PowerShell `-match` is case-insensitive. Any name
     built on the product name — `AiriMateOne`, `AiriMate One`, `AiriMateOne.Startup`, `AIRIMATEONE` —
     begins with the 8 characters `AiriMate` and therefore **would be silently deleted** by anyone who
     later runs the legacy uninstaller. `AiriOne` and `AiriPetOne` are outside that prefix set.
     Mechanical gate, run before shipping; the chosen name must yield `False`:
     ```powershell
     'AiriOne'     -match '^(AI女友|AiriMate|airi-brain)'   # -> False   (accepted)
     'AiriMateOne' -match '^(AI女友|AiriMate|airi-brain)'   # -> True    (rejected)
     ```
   * **No elevation.** `HKCU` needs none; `HKLM` would, and would also affect other users.

   The same reasoning forbids the new app from using prefix matching for its *own* cleanup: identify the
   entry by **exact name AND** resolved data pointing at the app's own executable (see §4.5). Prefix rules
   are exactly how the legacy uninstaller causes collateral damage.
7. Do **not** create a second entry anywhere: no Startup-folder `.lnk`, no scheduled task, no service, no
   `HKLM` value, no `RunOnce`. Assert after install: across all 10 Run-family keys + both Startup folders
   + all scheduled tasks + all services, the count of entries resolving to the new app's exe path equals
   **exactly 1**.

**D. Verify (post-write, read-back)**
8. Re-read the key and assert name/type/data exactly as written, byte-for-byte after env expansion.
9. Assert `HKCU\…\Explorer\StartupApproved\Run` has **no** disabled blob for the new name. If one exists
   (e.g. inherited from an uninstall/reinstall cycle), *that* blob may be removed — it is ours by name
   **and** by association with a value whose data points at our exe. Never delete a blob for a name that
   is not backed by our own Run value.
10. Re-assert the invariant of step 7 and log both snapshots (before/after) with hashes, so "exactly one"
    is auditable rather than asserted.

**E. Invariant maintenance on every launch**
11. Re-run step 7 at every start; if more than one self-referencing entry exists, report it and remove only
    the extras **whose data resolves to our exe path**. Leave anything else alone and surface it.

### 4.5 Uninstaller: what it must restore or remove

**Remove (only with positive identification):**
* The single `HKCU\…\Run` value, and only after re-resolving its data and confirming it still points at
  the app's own exe. If the value's data has been edited to point elsewhere, **do not delete** — report.
* The `StartupApproved\Run` blob for that name, if and only if the Run value was ours.
* Any Start-Menu/Desktop `.lnk` the app created — matched by **path + resolved target + arguments**, not
  by name alone (the 7 legacy shortcuts show why: four of them target generic `powershell.exe`).
* The app's own install directory and its own `backup\` snapshots **only** if the user asked for a full
  purge; otherwise keep the snapshots and say where they are.

**Restore:** nothing, in the default path — because the plan never overwrites or deletes a pre-existing
third-party value, the backup exists purely as evidence. The restore branch becomes live only if a future
installer version *does* modify an existing value: then it must write back the exact raw string captured
in step 2 (with `DoNotExpandEnvironmentNames` fidelity) instead of a re-serialized approximation.

**Report, never act on:** the legacy artifacts themselves — the 7 shortcuts, the 4 `build\…`
`MateEngineX.exe` copies, the official install under `E:\EdGe下载\…`, `F:\AIRI\*`, the running legacy
processes, `%LOCALAPPDATA%\AiriMate`, `HKCU\Software\Shinymoon\MateEngineX`. The uninstaller should print
"legacy stack still installed (not ours): …" and offer nothing destructive.

### 4.6 What I would NOT touch (and why)

* **All 9 existing Run/RunOnce values** — `Steam`, `BaiduYunDetect`, `QuarkUpdaterTaskUser1.0.0.21`,
  `QuarkCloudDriveUpdaterTaskUser1.0.0.11`, `kaixinbizhi`, `SecurityHealth`, `RtkAudUService`, `ACE-Tray`,
  `delta_force_launcher`. None is legacy; three are security/audio drivers and one is anti-cheat. Deleting
  any of them is unrecoverable user-visible damage.
* **All 7 `StartupApproved` blobs, including the orphan `MicrosoftEdgeAutoLaunch_…`** and the `Steam`
  disabled blob. They are the user's explicit Task-Manager choices; the orphan is Edge's, not ours.
* **All 186 scheduled tasks** — verified 0 legacy by two independent checks. In particular
  `\Microsoft\Windows\Hotpatch\Monitoring` runs `hpatchmonTask.cmd`; an "unknown"-classification sweep that
  acted on its 117 unverified rows would break Windows servicing.
* **All 302 services** — verified 0 matching; none should be touched even to "clean up".
* **`HKCU\Software\Shinymoon\MateEngineX`** and
  `…\LocalLow\Shinymoon\MateEngineX\settings.json` — the game's own prefs. Editing `startWithWindows`
  there would be a silent registry hijack of a third-party app, and the game rewrites it anyway.
* **`F:\AIRI\*` and `E:\EdGe下载\Public.Release.X3.3.0-HOTFIX-1\*`** — explicitly out of bounds, and the
  official install is the user's rollback anchor (`tools\paths.ps1` resolves `$OfficialDir` from it; 13
  legacy scripts historically depended on that path). The new app must treat both as read-only reference.
* **`%LOCALAPPDATA%\AiriMate`** (user data), **`%APPDATA%\ai.moeru.airi`** (AIRI user data),
  **`%USERPROFILE%\AppData\LocalLow\Shinymoon`** (game save/prefs) — never delete without an explicit purge.
* **The legacy project tree itself, `文档\`, `新工程\`, `repos\`, `_legacy\`, `node_modules\`** — the new
  app has no business deleting its predecessor's source.
* **The running legacy processes** — this audit was read-only by mandate. Even for the new app, the
  correct behaviour is to *block with an actionable message*, not to silently kill: the legacy host owns a
  live lock (`host.lock.json`), the kernel holds an established link to it, and `-Stop` is the legacy
  stack's own supported shutdown path.

---

## 5. NOT VERIFIED

| # | Item | Reason |
|---|---|---|
| N1 | Whether the legacy Electron pet (`build\pet\app`) exited cleanly the last time it ran, and when that was | Logs exist (`build\pet\logs\pet.out.log` 75 515 B, `pet.err.log` 5 007 B, `build\pet\app\pet-debug.json` 6 645 B) but were not analysed in this pass. Only its **current** state is proven: not running. |
| N2 | Whether `airi.exe`'s hidden windows (`AIRI`, `BeatSync - AIRI`) are hidden by the legacy host deliberately or are mid-transition | `IsWindowVisible` was false for all 9 at capture; the mechanism that hides them (documented stage suppression / 显隐 control) was not traced. |
| N3 | Full content inventory of the Unity data trees (`build\workcopy\MateEngineX_Data`, `build\workcopy-airi\MateEngineX_Data`) | Only the 5 `MateEngineX.exe` copies and `UnityCrashHandler64.exe` were hashed. A whole-install hash manifest (needed to verify *which* DLLs are patched) was not produced. |
| N4 | Autostart state of **other user profiles** on this machine | `HKLM` + all-users Startup (which cover all users) *were* enumerated; other users' `HKCU` hives are not loaded and were not mounted. |
| N5 | Whether any per-user UWP/`StartupTask` or `HKCU\…\AppModel\SystemAppData\…\StartupTasks` entry references a legacy component | Out of the specified scope; not enumerated. |
| N6 | Whether `HKU\S-1-5-*\…\Run` (other loaded hives) contain legacy entries | Only `HKCU` and `HKLM` were read. |
| N7 | The 117 scheduled tasks classified `unknown` (empty `Execute`, COM-handler, or embedded-quote `Execute`) — individually | Their resolved target existence is unproven. They are still **proven** non-legacy by two independent checks (pattern-first classification, plus a regex sweep over Execute/Arguments/WorkingDirectory). |
| N8 | Whether the legacy distribution installer (`tools\dist\…`, `AIRI女友-安装.cmd`) was ever executed on this machine, and whether it left a `Run` value that has since been deleted | No install log was sought; the current absence of any `AiriMate`/`AI女友`/`airi-brain` Run value is verified, its history is not. |
| N9 | Whether an upstream-signed `MateEngineX.exe` exists elsewhere (the 5 copies here are all `NotSigned`) | Only a filename search across `C:,D:,E:,F:` was performed (it found no sixth copy). Whether the vendor ships a signed build under a different name is unknown. |
| N10 | Which process accounted for the `293` (Win32_Process) vs `292` (Get-Process) count delta | The two queries are inherently a moment apart; ordinary process churn. Recorded in `#integrity` rather than silently reconciled. |
| N11 | Whether `E:\EdGe下载\Public.Release.X3.3.0-HOTFIX-1` contains its own uninstaller, autostart entry, or additional executables | Only a recursive filename search for `MateEngineX.exe` / `airi.exe` and a read-only metadata+hash of `MateEngineX.exe` were done, honouring the do-not-touch constraint. |
| N12 | Whether the `.agent-teams\`, `_legacy\`, `_tools\`, `repos\`, `src\`, `ui\` subtrees contain further executables that spawn the pet/kernel | Only `tools\` (the stated target) and the root-level scripts were inspected in depth; the other subtrees were listed but not exhaustively grepped for `Start-Process`/`spawn(`. |

---

### Appendix — the three deliverables and how to re-verify them

| File | Contents |
|---|---|
| `新工程\docs\evidence\E0-legacy-window-chain.json` | `generatedAt`, `host`, `methodology`, `commands`, `integrity`, `totals`, `itemsStatus` (running / not running with PIDs), `legacyProcesses` (windows, ex-styles, rects, parent chains, children), `relatedProcessTree`, `auditHarnessSelfMatchesExcluded`, `allProcesses` (293), `allTopLevelWindows` (193) |
| `新工程\docs\evidence\E0-autostart-inventory.json` | `host`, `scope`, `classificationTaxonomy`, `commands`, `section1_registry_run_keys` (10 keys), `section2_startup_folders`, `section3_scheduled_tasks` (186, each with actions/triggers/principal/settings), `section4_services` (302 with full `PathName`), `section5_startupApproved`, `section6_shortcut_inventory` (81), `legacyFindings`, `emptyCategoriesProof` |
| `新工程\docs\evidence\E0-legacy-audit.md` | this document |

Reproduce the two JSON files by re-running the scripts whose exact text is stored in each file's
`commands` array (P/Invoke `EnumWindows` block included). Everything read here is stable except the
process/window and port data, which are point-in-time: the legacy instance is live, so a re-capture will
show it as PID changes but the same image paths, hashes, and endpoints.
