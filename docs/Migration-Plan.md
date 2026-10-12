# Migration-Plan · AiriMate One

> 配套：`PRD.md`（FR-3 旧实例与开机项治理、§7 约束 C3/C5、§8 BLOCKER-1/RISK-1）、`Tech-Spec.md`（§8 旧实例检测与启动项迁移规格）、`docs/evidence/E0-recon-baseline.md`（路径/版本/许可证/网络实测基线）、`Acceptance-Matrix.md`（A17/A18/A19 与 S8/S9 的判定口径）。
> **本文是计划，不是执行记录**：所有步骤标注 `待执行`；未经执行并留下证据的命令**不得**声称为已完成。
> **两条不可越过的红线**（PRD §7 C3）：`F:\AIRI` 与 `E:\EdGe下载\Public.Release.X3.3.0-HOTFIX-1` **逐字节只读**，本计划中任何步骤都不得写入、改名、删除、重打包这两个目录下的任何内容。
> 所有命令为 **Windows PowerShell 5.1** 语法（`powershell.exe`）；非 ASCII 路径一律单引号包裹。

---

## 1. 范围与保证

### 1.1 会迁移的内容（migrate）

| 类别 | 内容 | 落点 |
|---|---|---|
| 会话能力 | 供应商预设（baseURL/model/参数）、人设与角色卡、多轮对话历史、长期记忆条目、TTS 偏好、工具/智能体开关 | `%APPDATA%\AiriMateOne\` 下的 SQLite/JSON 文档库（Tech-Spec FR-4.4 二选一在 `API-Contract.md` 冻结） |
| 交互偏好 | 窗口模式（panel/pet）、窗口位置与尺寸、置顶开关、轮盘热键、待机动作集合偏好 | `%APPDATA%\AiriMateOne\settings.json` |
| 密钥 | **不迁移**：仅迁移"哪个供应商配过密钥"这一事实（`providerId` + `hasKey=false` 占位），密钥由用户在应用内**重新录入** | `%APPDATA%\AiriMateOne\secrets\<providerId>.bin`（`safeStorage` 密文，仅登录用户可解） |
| 自启 | 旧自启项合并为**唯一一条** `HKCU\...\Run\AiriMateOne` | 注册表 + 备份目录 |
| 资产引用 | `Lazuli_VRM.vrm` 与 `.anim` 转换产物的**本地路径引用**（不含资产本体） | `assets\models\catalog.json`、`assets\motion\` |

### 1.2 明确放弃的内容（abandon）

| 内容 | 原因 |
|---|---|
| "AIRI 窗口与 MateEngineX 窗口对齐/并存/半透明叠底"的整条实现路线（`src\host\*`、`src\gateway\*`、`src\link\*`、`window-geometry.mjs`、`airi-gateway-bind.mjs`、`supervisor.mjs`） | PRD 开篇**作废声明**：一律作废。新架构是单实例单窗口内嵌 VRM 舞台 |
| 旧宿主/桥的运行时（`tools\host\airi-host.mjs`、`tools\gateway\*`、`tools\bridge\*`、`tools\link\*`） | 同上；且依赖已被作废的双窗口几何 |
| `llm-capture-proxy.mjs`（抓包代理） | 违反"密钥零落盘/零外泄"目标；不作为交付物 |
| 旧 `build\workcopy*` 下的 Unity 运行副本与其日志 | 只是旧原型的运行产物，不是资产来源；新工程不引用 |
| AIRI 自带 Live2D 渲染路径 | PRD §2.2 非目标：不做 Live2D 回退路径；A6 要求 Live2D 实例 = 0 |
| 旧文档目录 `F:\deepseek harness\AI女友\文档\*` 中与 PRD 冲突的验收口径 | PRD 权威等级声明 |

### 1.3 永不触碰（read-only，写操作一律禁止）

| 路径 | 性质 | 保护手段（必须实测） |
|---|---|---|
| `F:\AIRI` | 已安装的 AIRI | 只读访问；**不读取**其配置，不重打包 asar，不注入 |
| `E:\EdGe下载\Public.Release.X3.3.0-HOTFIX-1` | Mate Engine 官方安装 | 只读 |
| `F:\deepseek harness\AI女友\repos\Mate-Engine` | Mate-Engine 源码 checkout（资产来源） | **只读**；只读 `.anim`/`.vrm`，不修改、不提交 |
| `F:\deepseek harness\AI女友\build\pet\assets`、`build\vrma`、`build\motions` | 旧原型已产出的动作/资产副本 | 只读参考；新工程**不 import** 其代码（Tech-Spec §2 纪律） |
| `HKCU` / `HKLM` 中**非本应用**的启动项 | 其它软件的自启 | 只读枚举；只允许改/删由本应用创建或由本应用登记的项 |

**基线快照与前后比对（执行任何迁移前先做，迁移后再做一次）**

```powershell
# 待执行 —— 记录红线目录的文件清单与哈希（只读）
$roots = @('F:\AIRI','E:\EdGe下载\Public.Release.X3.3.0-HOTFIX-1','F:\deepseek harness\AI女友\repos\Mate-Engine')
$rows = foreach ($r in $roots) {
  Get-ChildItem -LiteralPath $r -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object {
    [pscustomobject]@{ root=$r; rel=$_.FullName.Substring($r.Length); len=$_.Length; ticks=$_.LastWriteTimeUtc.Ticks }
  }
}
$rows | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath 'docs\evidence\phase7\recon-readonly-snapshot-before.json' -Encoding UTF8
"fileCount=$($rows.Count)"
# 迁移后重跑并比对（只比 rel/len/ticks，任一不同即判定红线被触碰，立即回滚并报告）
```

> 记录 `len` + `LastWriteTimeUtc.Ticks` 而非全量 SHA256 的原因：`F:\AIRI` 单文件 `app.asar` 就 1.37 GB，全量哈希耗时不可接受。**若用户要求强保证**，可对红线目录的**根级文件**（数量少、体积大）额外做 SHA256，命令见 `docs/evidence/E0-recon-baseline.md` §2.1 的 asar 只读读法。

---

## 2. 遗留物清单与处置（Legacy inventory）

处置四态：`block-at-startup`（启动前只读检测，命中即阻断，不自动杀进程）／`migrate-to-new-app`（内容迁入新应用）／`archive-only`（只归档/只作参考，不执行、不依赖）／`delete-on-uninstall`（卸载器删除；**仅限本应用自有物或用户明确授权的项**）。

| # | 绝对路径 | 角色 | 处置 | 处置细节与依据 |
|---|---|---|---|---|
| 1 | `F:\deepseek harness\AI女友\build\workcopy\MateEngineX.exe`（667,648 B，另有 `UnityPlayer.dll` 34,008,496 B、`MateEngineX_Data\`、`UnityCrashHandler64.exe`） | 旧 Unity 内核运行副本。E0 实测**正在运行**且拥有可见顶层窗口（`class=UnityWndClass`，`title=MateEngineX`） | `block-at-startup` + `archive-only` | Tech-Spec §8.1 谓词 L2：映像路径在 `F:\deepseek harness\AI女友\build\` 前缀内 **或** PE 哈希命中清单 **或** 命令行/工作目录含 `MateEngineX_Data`。命中 ⇒ 阻断对话框（查看详情/打开任务管理器/我已知晓并退出），**绝不自动杀**。旧启动器为 `tools\host\airi-host.mjs`（node.exe）拉起，父链需一并报告 |
| 2 | `F:\deepseek harness\AI女友\build\workcopy-airi\MateEngineX.exe`（667,648 B，含 `_baseline_backup\`） | 旧内核的第二份工作副本 | `block-at-startup` + `archive-only` | 同上谓词（同前缀）。E0 未观测其运行；**不得**因未运行就跳过谓词实现 |
| 3 | `F:\deepseek harness\AI女友\build\pet\app\`（`package.json.name='airi-mate-pet'`，`main.mjs`，`js\{boot,chat,gateway,icons,pose,settings,vrm,wheel}.mjs`） | 旧独立桌宠（Electron）：**功能原型**，其行为参数被 Tech-Spec 部分继承（12s/3s、弹簧常数、`PET_DRAGGING`） | `block-at-startup` + `migrate-to-new-app`（**仅行为参数**，不迁移代码） | 阻断谓词 L3：映像路径以 `node_modules\electron\dist\electron.exe` 结尾 **且** 命令行含 `build\pet\app\main.mjs`。行为参数迁入 `packages/motion-director` 常量表并在 `docs/evidence/E0-code-reuse-log.md` 登记"来源=旧原型，改动点=重写为 TS" |
| 4 | `F:\deepseek harness\AI女友\build\pet\logs\`、`build\pet\assets\`、`build\pet\probe-*.mjs`、`build\pet\截图-*.png` | 旧桌宠日志、资产、探针与截图 | `archive-only` | 只作取证资料；新工程不 import、不运行 |
| 5 | `F:\deepseek harness\AI女友\start-airi-brain.ps1`（24,255 B） | 旧启动入口（拉起宿主 + AIRI + 内核） | `block-at-startup`（谓词命中）+ `archive-only` | 谓词：命令行含 `start-airi-brain.ps1` |
| 6 | `F:\deepseek harness\AI女友\autostart-airi-brain.ps1`（923 B） | 旧自启入口 | `block-at-startup` + `delete-on-uninstall`（**仅当它是本应用安装时登记的旧项且已备份**） | 谓词：命令行含 `autostart-airi-brain.ps1`；自启面见 `Acceptance-Matrix` §2.3 |
| 7 | `F:\deepseek harness\AI女友\install-shortcuts.ps1`（1,923 B） | 旧快捷方式安装器（开始菜单/桌面/启动文件夹） | `archive-only` + **卸载时按备份恢复其创建的快捷方式** | 卸载语义见 §7；恢复来源 = 迁移备份 `startup-folders.json` / `shortcuts.json` |
| 8 | `F:\deepseek harness\AI女友\airi-brain.mjs`（12,753 B） | 旧 brain 进程入口 | `block-at-startup`（谓词）+ `archive-only` | 谓词：命令行含 `airi-brain.mjs` |
| 9 | `F:\deepseek harness\AI女友\mate-engine-airi-bridge.mjs`（26,114 B） | 旧 AIRI↔Mate 桥 | `block-at-startup`（谓词）+ `archive-only` | 谓词：命令行含 `mate-engine-airi-bridge.mjs` |
| 10 | `F:\deepseek harness\AI女友\tools\host\airi-host.mjs` + `tools\host\win32-probe.ps1` | E0 实测**正在运行**的旧宿主（`node.exe`，`--config %LOCALAPPDATA%\AiriMate\config.json`），是 #1/#11 的父进程 | `block-at-startup`（仅后台类 ⇒ 警告 + 允许"忽略并继续"，Tech-Spec §8.1 处置矩阵）+ `archive-only` | 谓词：命令行含 `F:\deepseek harness\AI女友\tools\` **且** 含 `airi-host.mjs`。**这是旧栈的实际存活根因**（E0 实测父链），关停顺序见 §5 |
| 11 | `F:\AIRI\airi.exe`（235,537,920 B）+ `F:\AIRI\resources\app.asar`（1,367,911,043 B） | 已安装的 AIRI（`ai.moeru.airi` 0.12.0-beta.5，MIT） | `block-at-startup`（**组合谓词**）+ `migrate-to-new-app`（**只迁用户数据**，见 §3） | 谓词（Tech-Spec §8.1）：`airi.exe` 进程存在 **且** 旧桥进程存在，**两者同时命中才告警**（避免误伤用户正常使用 AIRI）。目录本身**逐字节只读**，永不修改/重打包 |
| 12 | `%APPDATA%\ai.moeru.airi\`（E0 实测存在：`app-config.json`、`app-options.json`、`Preferences`、`IndexedDB\`、`Local Storage\`、`logs\`、`mcp.json`、`windows-widgets-config.json`、`artistry-options.json`、`server-channel-config.json` 等） | AIRI 的用户数据（供应商/人设/记忆/TTS/窗口） | `migrate-to-new-app`（只读复制，见 §3） | **只读源**；迁移后写入 `%APPDATA%\AiriMateOne\migration\report.json` 记录读取了哪些文件及其 SHA256 |
| 13 | `F:\deepseek harness\AI女友\.airi-upstream.env`（198 B，含 `AIRI_UPSTREAM_KEY=sk-...` 明文） | 旧工程根的明文云密钥文件 | `archive-only`（**新工程不读取**）+ `delete-on-uninstall`（**仅当用户明确勾选**） | PRD `RISK-1`：迁移向导提示用户**吊销并重新录入**；A17 要求分发物/日志/命令行命中数 = 0。**禁止**把该文件复制进任何分发物 |
| 14 | `F:\deepseek harness\AI女友\src\host\*`、`src\gateway\*`、`src\link\*` | 双窗口对齐路线的实现（已作废） | `archive-only` | PRD 作废声明；只允许逐文件评审后参考，且必须在 `docs\evidence\E0-code-reuse-log.md` 登记（来源/许可证/改动点） |
| 15 | `C:\Users\shiqian\AppData\Local\AiriMate\config.json` | 旧宿主配置（`tools\host\airi-host.mjs --config`） | `archive-only` | 只读查看以识别旧自启/旧入口；**不迁移**（属旧宿主私有格式，新应用无对应概念） |

**清点命令（只读，S8/迁移前必跑）**

```powershell
# 待执行 —— 旧实例只读清点（不杀进程、不改注册表）
Get-CimInstance Win32_Process |
  Where-Object {
    ($_.Name -eq 'MateEngineX.exe') -or
    ($_.ExecutablePath -like 'F:\deepseek harness\AI女友\build\*') -or
    ($_.CommandLine -like '*F:\deepseek harness\AI女友\*') -or
    ($_.CommandLine -like '*airi-host.mjs*') -or
    ($_.CommandLine -like '*start-airi-brain.ps1*') -or
    ($_.CommandLine -like '*mate-engine-airi-bridge.mjs*') -or
    ($_.Name -eq 'airi.exe')
  } |
  Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine, CreationDate |
  Sort-Object Name, ProcessId | Format-List
```

> 注意：`Win32_Process.CommandLine`/`ExecutablePath` 对受保护或其它用户进程可能为 `null`——必须显式记录为"不可读"，**不得**当作"无关"（E0 methodology 已登记该已知限制）。

---

## 3. 用户数据迁移

**总原则**
1. **源永远只读**：所有源文件以只读方式打开，迁移过程不写入、不移动、不删除源。
2. **密钥一律不复制**：新应用**不读取** `.airi-upstream.env`，也不从任何明文文件里提取密钥；只迁移"配过哪个供应商"的事实，密钥由用户在应用内重新录入（`safeStorage` 密文）。
3. **迁移产物带溯源标记**：每条迁移记录写 `_migratedFrom`（源绝对路径）+ `_migratedAt` + `_sourceSha256`，写入 `%APPDATA%\AiriMateOne\migration\report.json`。
4. **缺失或畸形 ⇒ 不阻断**：写 `migrationWarnings[]`，以默认值继续；**禁止**用默认值静默覆盖用户数据，必须在设置页显示"有 N 项未迁移"。
5. **幂等**：同一源重复迁移以 `_sourceSha256` 去重；已存在目标且内容相同 ⇒ 跳过并计数 `skipped`。
6. **源结构未冻结的部分（明确标注）**：AIRI 的用户数据结构**未在本轮取证中解析**（`app.asar` 内的 store 形状不确定）。因此下表的"源内路径"分为 **已实测存在**（`app-config.json` 等文件级）与 **待用户确认/待解析**（文件内部键路径）两类，第二类**不允许**作为验收证据，只作为实现线索。

| # | 数据 | 源位置 | 目标位置 | 转换 | 校验 | 源缺失/畸形时 |
|---|---|---|---|---|---|---|
| M1 | 供应商设置（baseURL / model / 温度等**非密钥**参数） | `%APPDATA%\ai.moeru.airi\app-config.json`（E0 实测存在）；键路径**待解析** | `%APPDATA%\AiriMateOne\settings.json` 的 `providers[]` | 映射为 `{providerId,label,baseURL,model,params}`；未知键进 `providers[].extras` 原样保留 | `Invoke-WebRequest -Method Head <baseURL>` 或仅做 URL 语法校验（无网络时降级为语法校验并记 `networkUnverified`） | 缺文件 ⇒ 提供内置预设（DeepSeek/OpenAI/Anthropic 兼容层/Ollama/自建），`warnings += 'M1:source-absent'`；JSON 解析失败 ⇒ 备份原文件到 `migration\quarantine\` 并跳过 |
| M2 | **密钥** | 旧 `.airi-upstream.env` 的 `AIRI_UPSTREAM_KEY` | **不迁移**。目标仅写占位 `{providerId, hasKey:false}` | 无转换；**新应用不打开该文件** | 校验方式 = 反证：`scan-secrets.ps1` 在所有面命中 0（`Acceptance-Matrix` §2.1） | 不适用 |
| M3 | 人设 / 角色卡 | AIRI 用户数据内的人设/角色 store（键路径**待解析**） | `%APPDATA%\AiriMateOne\persona.json` | 归一化为 `{name, systemPrompt, personality, speechStyle, affinityInitial}`；缺失字段用中性默认并在 UI 标"待补全" | schema（zod）校验；`systemPrompt` 长度上限 32 KB | 缺 ⇒ 使用内置中性人设并 `warnings += 'M3:default-persona'` |
| M4 | 对话历史 | AIRI 用户数据（含 `IndexedDB\`，E0 实测存在） | `%APPDATA%\AiriMateOne\db\chat.sqlite`（表 `messages`） | 去重（`role+ts+sha256(text)`）、按 `ts` 升序、保留原始 `sessionId` 映射到新 `conversationId` | 迁移后计数比对：`sourceParsedCount` vs `insertedCount`，差值必须能由 `duplicates`+`rejected` 解释 | 无法解析 ⇒ 记录 `unparsed` 项数与**不写入**（不猜测）；`warnings += 'M4:unparsed=<n>'` |
| M5 | 长期记忆 | AIRI 用户数据（记忆条目） | 同上 SQLite 表 `memories`（`{id,text,createdAt,source,tags}`） | 文本原样；`source='migrated'` | 每条必须非空且 `length <= 8 KB`；超限进 `rejected` 并计数 | 缺 ⇒ 空表，`warnings += 'M5:empty'` |
| M6 | TTS 偏好 | `app-config.json` / TTS 相关 store（键路径**待解析**） | `settings.json` 的 `tts` | 映射到本地引擎（Windows SAPI / Edge TTS 之一，Tech-Spec FR-4.5）+ 语音/语速/音量；云端供应商需重新配置端点 | 本地引擎做一次合成冒烟（生成 1s 音频，断言文件 > 1 KB） | 缺 ⇒ 默认本地引擎；未识别的语音名 ⇒ 回落系统默认并 `warnings += 'M6:voice-fallback'` |
| M7 | 窗口位置/尺寸/模式 | `%APPDATA%\ai.moeru.airi\Preferences`（Chromium 布局，键路径**待解析**） | `settings.json` 的 `window` | 仅迁 `x/y/width/height/mode`；**panel 固定 420×760、pet 固定 340×420**（Tech-Spec §4.2），故只迁 `mode` 与位置，尺寸按模式取固定值 | 位置必须在任一显示器的 `WorkingArea` 内（否则回落"居中"）；`mode ∈ {panel, pet}` | 缺 ⇒ `panel` + 居中；越界 ⇒ 居中并 `warnings += 'M7:offscreen'` |
| M8 | 快捷键 / 轮盘热键 | 旧配置（若存在；键路径**待解析**） | `settings.json` 的 `hotkeys` | 只迁语义动作名（如 `wheel-toggle`），键位映射为 **F1 开合轮盘**（Tech-Spec FR-7.1）+ 右键；冲突检测 | 冲突 ⇒ 保留新默认并在 UI 提示；`F1` 与 `Esc` 为保留键不可被覆盖 | 缺 ⇒ 用默认（`F1`）；冲突 ⇒ `warnings += 'M8:conflict'` |
| M9 | 动作/模型路径引用 | 本机固定路径（`assets\models\catalog.json` 的 `path`；来自 Mate-Engine 仓库，**不进分发包**） | `assets\models\catalog.json` + `assets\motion\` | 写入绝对路径 + `sha256`（首次记录）；转换产物只落本地 | 启动时 `Test-Path` + `sha256`；不匹配 ⇒ 可见告警（不阻断、不退回 T-pose） | 缺 ⇒ renderer 显示**可见告警位**（附路径与获取方式），**不静默空白**（Tech-Spec §5.3） |

**迁移执行命令骨架（待执行；PS 5.1）**

```powershell
# 待执行 —— 备份 + 只读解析 + 报告（不写源）
$src  = Join-Path $env:APPDATA 'ai.moeru.airi'
$dst  = Join-Path $env:APPDATA 'AiriMateOne'
$ts   = Get-Date -Format 'yyyyMMdd-HHmmss'
$bk   = Join-Path $dst ('migration\backup-' + $ts)
New-Item -ItemType Directory -Force -Path $bk | Out-Null
# 1) 只复制需要解析的配置类文件（不复制 IndexedDB/Cache 等大目录；密钥文件绝不复制）
foreach ($f in @('app-config.json','app-options.json','Preferences','mcp.json','windows-widgets-config.json','artistry-options.json','server-channel-config.json')) {
  $p = Join-Path $src $f
  if (Test-Path -LiteralPath $p) {
    Copy-Item -LiteralPath $p -Destination (Join-Path $bk ('src-' + $f)) -Force
    (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash
  }
}
# 2) 解析在独立进程里做（tools\qa\migrate-userdata.mjs），只读打开源，产物写目标 + report.json
node tools\qa\migrate-userdata.mjs --src $src --dst $dst --backup $bk --report (Join-Path $bk 'migrate-report.json')
# 3) 报告必须能被逐条核对
Get-Content -LiteralPath (Join-Path $bk 'migrate-report.json') -Raw
```

**密钥处置的用户提示（必须原样出现在迁移向导里，不可改写为建议性措辞）**

> "旧工程根目录 `F:\deepseek harness\AI女友\.airi-upstream.env` 中存在**明文**云密钥。新应用**不会读取**该文件。请到所用供应商控制台**吊销该密钥**，并在新应用设置页重新录入一枚新密钥（新密钥将用 Windows 凭据保护后落盘）。"

---

## 4. 自启迁移（与 Tech-Spec §8.2 一一对应）

**备份目录布局（冻结）**

```
%APPDATA%\AiriMateOne\migration\backup-<yyyyMMdd-HHmmss>\
├─ hkcu-run.reg                       reg export 的原始 .reg（Run + RunOnce 两份：hkcu-run.reg / hkcu-runonce.reg）
├─ startup-folders.json               两个 Startup 文件夹的完整文件清单（含 .lnk 解析结果）
├─ shortcuts.json                     开始菜单 + 桌面 + Startup 中与本产品相关的快捷方式清单（TargetPath/Arguments/WorkingDirectory/IconLocation）
├─ scheduled-tasks\
│   ├─ index.json                     命中候选任务清单（TaskName/TaskPath/State/Actions）
│   ├─ <safeName>.xml                  Export-ScheduledTask 的原始 XML（每个候选一份，文件名做安全化）
├─ migration-manifest.json            本次迁移的元数据（见下）
└─ migrate-report.json                用户数据迁移报告（§3）
```

`migration-manifest.json` 结构（冻结字段）：

```json
{ "schemaVersion": 1, "createdAt": "<ISO8601>", "host": "<COMPUTERNAME>", "user": "<USERNAME>",
  "backupDir": "<abs>", "toolVersion": "<app version>",
  "before": { "runEntries": ["<name>=<value>", "..."], "startupFiles": ["<abs>", "..."], "scheduledTasks": ["<TaskPath\\TaskName>", "..."] },
  "classifications": [ { "kind": "run|startup|task", "key": "<name|abs|taskPath>", "value": "<raw>",
                         "verdict": "legacy|ours|unrelated", "matchedPredicate": "<regex name>", "evidenceFlags": ["path-prefix","cmdline"] } ],
  "actions": [ { "kind": "keep|delete|disable|create", "key": "...", "reason": "...", "reversible": true } ],
  "after": { "ours": ["AiriMateOne"], "legacyRemaining": [] } }
```

**步骤（每步都必须留下命令与原始输出）**

| 步 | 动作 | 命令（PS 5.1，待执行） | 期望原始输出 |
|---|---|---|---|
| 1 | **备份**（先备份再改动，任何写操作前必须完成） | `$ts = Get-Date -Format 'yyyyMMdd-HHmmss'`<br>`$bk = Join-Path $env:APPDATA ('AiriMateOne\migration\backup-' + $ts)`<br>`New-Item -ItemType Directory -Force -Path $bk,(Join-Path $bk 'scheduled-tasks') \| Out-Null`<br>`reg export 'HKCU\Software\Microsoft\Windows\CurrentVersion\Run' (Join-Path $bk 'hkcu-run.reg') /y`<br>`reg export 'HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce' (Join-Path $bk 'hkcu-runonce.reg') /y` | `操作成功完成。`（reg export 成功）；两个 `.reg` 文件存在且 > 100 B |
| 2 | 备份 Startup 文件夹清单（含 `.lnk` 目标解析） | `$sh = New-Object -ComObject WScript.Shell`<br>`$out = foreach ($d in @([Environment]::GetFolderPath('Startup'),[Environment]::GetFolderPath('CommonStartup'))) { foreach ($f in (Get-ChildItem -LiteralPath $d -Force -ErrorAction SilentlyContinue)) { $t=$null;$a=$null; if ($f.Extension -eq '.lnk') { $s=$sh.CreateShortcut($f.FullName); $t=$s.TargetPath; $a=$s.Arguments }; [pscustomobject]@{dir=$d;name=$f.Name;abs=$f.FullName;len=$f.Length;target=$t;args=$a} } }`<br>`$out \| ConvertTo-Json -Depth 4 \| Set-Content -LiteralPath (Join-Path $bk 'startup-folders.json') -Encoding UTF8` | `startup-folders.json` 条目数 = 两个目录实际文件数（E0 当前实测各 1 个，共 2） |
| 3 | 备份计划任务 XML（仅候选，避免导出全机） | `Get-ScheduledTask \| Where-Object { $_.State -ne 'Disabled' } \| ForEach-Object { $x = Export-ScheduledTask -TaskName $_.TaskName -TaskPath $_.TaskPath; ... 写 scheduled-tasks\<safe>.xml }`（`safe` = `($_.TaskName -replace '[^A-Za-z0-9._-]','_')`） | 每个候选一个 `.xml` 且 > 200 B；`index.json` 条目数与导出文件数一致 |
| 3b | 备份快捷方式清单（开始菜单 + 桌面 + 两个 Startup） | `$dirs = @((Join-Path ([Environment]::GetFolderPath('Programs')) 'AiriMate One'), [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Startup'), [Environment]::GetFolderPath('CommonStartup'), [Environment]::GetFolderPath('CommonPrograms'))`<br>`$sh = New-Object -ComObject WScript.Shell`<br>`$sc = foreach ($d in $dirs) { foreach ($f in (Get-ChildItem -LiteralPath $d -Filter '*.lnk' -Force -Recurse -ErrorAction SilentlyContinue)) { $s = $sh.CreateShortcut($f.FullName); [pscustomobject]@{ abs=$f.FullName; target=$s.TargetPath; args=$s.Arguments; wd=$s.WorkingDirectory; icon=$s.IconLocation } } }`<br>`$sc \| ConvertTo-Json -Depth 4 \| Set-Content -LiteralPath (Join-Path $bk 'shortcuts.json') -Encoding UTF8` | `shortcuts.json` 存在且可被 `ConvertFrom-Json` 解析；条数 = 上述 5 个目录中 `.lnk` 总数；**必须包含**由 `install-shortcuts.ps1` 创建的旧快捷方式（若存在），否则回滚时无法恢复 |
| 4 | **识别**指向旧入口的项 | 用 `tools\qa\autostart-audit.ps1 -Stage pre-install`（谓词见 `Acceptance-Matrix` §2.3） | `legacyHitCount`、`legacyHits[]`（每条含 `kind/key/value/verdict/matchedPredicate`）；**E0 基线显示 `HKCU\...\Run` 当前无本产品相关项，故预期 `legacyHitCount=0`（待实测确认）** |
| 5 | **合并**为唯一一条自启 | `$exe = '<install>\AiriMateOne.exe'`（`<install>` 由安装器决定）<br>`New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'AiriMateOne' -Value ('"' + $exe + '" --autostart') -PropertyType String -Force` | `Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'AiriMateOne'` 返回 `"<install>\AiriMateOne.exe" --autostart`；Run 中本产品相关项**恰好 1 条** |
| 6 | 删除/禁用旧项（**逐个记录后才动**） | 删注册表项：`Remove-ItemProperty -Path '<hive>\...\Run' -Name '<旧项名>'`；禁计划任务：`Disable-ScheduledTask -TaskName '<n>' -TaskPath '<p>'`；移出 Startup：`Move-Item -LiteralPath '<abs>' -Destination (Join-Path $bk 'moved-startup') `（**移动而非删除**，保证可回滚） | 每个动作前先 `Get-ItemProperty`/`Get-ScheduledTask` 打印原值；动作后重跑步 4，`legacyHitCount=0` |
| 7 | **验证** | `tools\qa\autostart-audit.ps1 -Stage post-install` + `tools\qa\autostart-audit.ps1 -Stage compare -BackupDir $bk` | `newAppRunEntryCount=1`、`legacyHitCount=0`、`registryValueMatches=0`、`startupShortcutMatches=0`、`scheduledTaskMatches=0` |
| 8 | **卸载/恢复语义** | 卸载器：①删自有项 `Remove-ItemProperty ... -Name 'AiriMateOne'`；②对 `migration-manifest.json` 中 `actions[].kind in {delete,disable}` 的旧项**按备份恢复原样**（`reg import` / `Enable-ScheduledTask` / 把 `moved-startup` 里的文件移回原位）；③`--restore-legacy` 开关显式启用"恢复全部旧项"，默认**不恢复** | 卸载后 `newAppRunEntryCount=0`；默认（不带开关）时 `legacyHitCount=0`；带 `--restore-legacy` 时 `restoredCount == actions` 中可逆项数 |

> **禁止**：①改动 `HKLM` 下的启动项；②改动非本产品、非旧入口的其它软件自启项（`Steam`、`BaiduYunDetect`、`QuarkUpdater*`、`kaixinbizhi` 等 E0 实测存在的项一律不碰）；③在未完成步 1 备份前执行步 5/6。

---

## 5. 旧实例停机流程（人工、可逆、用户自行执行）

> **这一节是给用户的操作手册**，不是给脚本的。每一步都可逆；每步之后都有验证命令；**任何一步都不允许"杀掉归属不明的进程"**。
> 前置：先完成 §4 步 1–4 的**备份与识别**（这样即使出错也能回滚自启状态）。§4 步 5/6 的"改动"放在本流程**之后**做。

### 5.0 先冻结"旧栈会被自动拉起"的可能（只读确认 + 必要时备份后临时禁用）

```powershell
# 步骤 0（只读确认）：旧栈是否存在自启入口
Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' | Format-List
Get-ChildItem -LiteralPath ([Environment]::GetFolderPath('Startup')) -Force -ErrorAction SilentlyContinue
Get-ScheduledTask | Where-Object { $_.State -ne 'Disabled' } | Select-Object TaskName,TaskPath,State
```
**通过判据**：能明确列出"哪些项会拉起旧栈"。若发现旧自启项 ⇒ 先做 §4 步 1–3 备份，再执行 §4 步 6 把它移出/禁用（**移动而非删除**）。

### 5.1 认领旧进程（只读，产出 PID 与归属证据）

```powershell
# 步骤 1（只读）：列出旧栈进程 + 每个进程的归属证据（路径前缀/父链/命令行）
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like '*F:\deepseek harness\AI女友\*' -or $_.ExecutablePath -like 'F:\deepseek harness\AI女友\build\*' -or $_.Name -eq 'MateEngineX.exe' -or $_.Name -eq 'airi.exe' } |
  Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | Sort-Object ParentProcessId | Format-List
```
**通过判据**：每个 PID 都能回答"它是谁拉起来的"（`ParentProcessId` 可追溯）。
**必须停下并报告的情况**：
- `ExecutablePath`/`CommandLine` 为 `null`（不可读）⇒ 该进程**不得**由用户手动结束，改为在任务管理器里**先看"详细信息 → 命令行/用户"**；仍不可判定 ⇒ 保留不动，在最终报告里列为"归属未证明"。
- 进程属于**其它用户**（`Get-Process -Id <pid> -IncludeUserName` 显示的不是当前用户）⇒ **一律不动**，只记录。
- 进程是本次取证/审查工具本身（E0 记录：命令行含 `EnumWindows` 或祖先链含 DSH harness 的进程，例如 `tools\host\win32-probe.ps1` 的 `powershell.exe`）⇒ **不是旧栈**，不要关。

### 5.2 关闭顺序（从"会在屏幕上显示东西的"开始；每步后验证）

| 顺序 | 目标 | 安全关闭方式（用户操作，**推荐 GUI**） | 每步后的验证命令 | 期望原始输出 |
|---|---|---|---|---|
| 1 | 旧 `build\pet` 桌宠窗口（若存在） | 在其窗口上右键（该应用有托盘/轮盘）→ 选择"退出"；若无退出项，用其窗口标题栏关闭按钮 | `Get-CimInstance Win32_Process \| Where-Object { $_.CommandLine -like '*build\pet\app\main.mjs*' } \| Select-Object ProcessId,Name` | **无输出**（该进程已退出） |
| 2 | `MateEngineX.exe`（Unity 内核，可见窗口 `UnityWndClass`） | **在其窗口内**按 `Alt+F4`，或在窗口右上角关闭；Unity 会自行走正常退出（E0 实测它有窗口且可交互） | `Get-CimInstance Win32_Process -Filter "Name='MateEngineX.exe'" \| Select-Object ProcessId,ExecutablePath,CommandLine` | **无输出**；同时 `Get-Process UnityCrashHandler64 -ErrorAction SilentlyContinue` 无输出 |
| 3 | 旧宿主 `node.exe tools\host\airi-host.mjs`（它是 #1/#2 的父进程，**顺序必须在 2 之后**） | 在其控制台窗口按 `Ctrl+C`；若为无控制台的隐藏进程，则由用户**明确知情后**执行：`Get-Process -Id <由步骤 1 得到的 PID>` → `Stop-Process -Id <pid>`（**仅在步骤 1 已能证明该 PID 的映像路径是 `C:\Program Files\nodejs\node.exe` 且命令行含 `airi-host.mjs` 时**） | 重跑 §5.1 的查询 | **无输出** |
| 4 | 旧 AIRI（`F:\AIRI\airi.exe`，用户自己装的） | **由用户决定是否关闭**：这是用户自己的软件，新应用不要求也不应关闭它。若用户希望关闭，用 AIRI 自己的界面退出 | `Get-Process airi -ErrorAction SilentlyContinue` | 若为空 ⇒ AIRI 已退出；若仍有进程 ⇒ **不算失败**（组合谓词要求"airi.exe 且旧桥同时存在"才告警） |
| 5 | 旧 brain/bridge（`airi-brain.mjs`、`mate-engine-airi-bridge.mjs`） | 同 #3 的方式（控制台 `Ctrl+C` 优先） | `Get-CimInstance Win32_Process \| Where-Object { $_.CommandLine -like '*airi-brain.mjs*' -or $_.CommandLine -like '*mate-engine-airi-bridge.mjs*' }` | **无输出** |

**每一步之后都必须回答的两个问题**（写在证据 `docs/evidence/phase7/S8-retire-legacy.json` 里）：
1. 这个被关掉的进程，其归属证据是什么（路径/命令行/父链）？
2. 它是否被别的进程重新拉起（见 §5.3）？

### 5.3 确认"没有任何东西重生"（等待 + 复查）

```powershell
# 步骤 6：关闭完成后等 10 分钟，再复查一次（防止 watchdog 型拉起）
Start-Sleep -Seconds 600
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like '*F:\deepseek harness\AI女友\*' -or $_.Name -eq 'MateEngineX.exe' } |
  Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | Format-List
# 步骤 7：可见窗口复查（应为 0）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\proc-window-inventory.ps1 -Invariant noLegacyMateEngineX,noLegacyPet -Out docs\evidence\phase7\S8-after-retire.json
```
**通过判据**：步骤 6 **无输出**；`S8-after-retire.json` 内 `visibleLegacyMateEngineXWindowCount=0` **且** `visibleLegacyPetWindowCount=0`。
**若重生**：说明存在拉起者（watchdog/计划任务/宿主）。处置顺序：①回看 §5.1 找到新进程的 `ParentProcessId` 并回到 §5.2 对应顺序处理父进程；②只读检查计划任务与 Run 项（§5.0）；③**不要**用 `Stop-Process -Force` 反复对杀——把这情况作为发现写进报告并交给用户裁定。

**本流程明确不做的事**
- 不对任何"归属未证明"的进程执行 `Stop-Process`/`taskkill`（PRD FR-3.3）。
- 不关闭其它用户的进程、不关闭系统进程、不关闭与本产品无关的软件。
- 不使用 `taskkill /F /IM MateEngineX.exe` 这类**按名字**批量结束的方式（会误伤其它来源的同名程序，也违反"禁止只凭进程名判定"）。
- 不修改 `F:\AIRI` 与 Mate 官方安装目录（关闭进程 ≠ 修改目录，但仍不得写入这两个目录）。

---

## 6. 回滚计划（Rollback）

> 回滚的**唯一权威来源**是 §4 的备份目录 `%APPDATA%\AiriMateOne\migration\backup-<ts>\`。没有备份 ⇒ 不允许执行 §4 步 5/6 的任何写操作。

### 6.1 回滚触发条件（满足任一即回滚）

| # | 条件 | 判定 |
|---|---|---|
| R1 | 红线目录快照比对出现差异 | §1.3 的 before/after 清单 `rel/len/ticks` 任一不同 |
| R2 | A19 三时点有任一点 `legacyHitCount > 0` 且非"备份中原本就存在" | `autostart-audit.ps1 -Stage compare` 输出不一致 |
| R3 | 新应用无法启动或启动后 `appInstanceCount != 1` | `proc-window-inventory.ps1` 断言失败 |
| R4 | 用户数据迁移导致对话历史/记忆不可读（`insertedCount` 与 `sourceParsedCount` 差值无法解释） | `migrate-report.json` 内 `unexplainedDelta > 0` |
| R5 | 用户主动放弃迁移 | 用户书面要求 |

### 6.2 回滚步骤（顺序固定，每步留原始输出）

| 步 | 动作 | 命令（PS 5.1，待执行） | 期望原始输出 |
|---|---|---|---|
| 1 | 停止新应用（用其托盘"退出"，**不杀进程**；若卡住则记录后由用户决定） | `Get-CimInstance Win32_Process \| Where-Object { $_.ExecutablePath -eq '<install>\AiriMateOne.exe' } \| Select-Object ProcessId,Name,CommandLine` | 托盘退出后**无输出** |
| 2 | 删除新应用自有自启项 | `Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'AiriMateOne' -ErrorAction SilentlyContinue` | `Get-ItemProperty ... -Name 'AiriMateOne'` 报错/无该项 |
| 3 | 恢复注册表启动项到备份原样 | `$bk='%APPDATA%\AiriMateOne\migration\backup-<ts>'`<br>`reg import (Join-Path $bk 'hkcu-run.reg')`<br>`reg import (Join-Path $bk 'hkcu-runonce.reg')` | `操作成功完成。`；随后 `Get-ItemProperty HKCU:\...\Run` 与备份内条目**逐条相同** |
| 4 | 恢复被移出的 Startup 快捷方式 | `$moved = Join-Path $bk 'moved-startup'`<br>`if (Test-Path -LiteralPath $moved) { Get-ChildItem -LiteralPath $moved -Force \| ForEach-Object { Move-Item -LiteralPath $_.FullName -Destination '<原目录>' -Force } }` | 两个 Startup 目录的文件数回到备份 `startup-folders.json` 记录的值 |
| 5 | 重新启用被禁用的计划任务 | 按 `migration-manifest.json` 的 `actions` 逐条：`Enable-ScheduledTask -TaskName '<n>' -TaskPath '<p>'`（若原为删除：用 `scheduled-tasks\<safe>.xml` 重建 `Register-ScheduledTask -Xml (Get-Content -Raw '<xml>') -TaskName '<n>'`） | 每条恢复后 `Get-ScheduledTask -TaskName '<n>'` 的 `State` 与备份 `index.json` 一致 |
| 6 | 移除新应用（见 §7 卸载规格） | `& '<install>\Uninstall AiriMateOne.exe' /S` 或控制面板卸载 | `Get-ChildItem '<install>'` 无输出（目录已清）；`%APPDATA%\AiriMateOne` 仅剩 `migration\` 与（用户勾选保留的）`secrets\` |
| 7 | 证明机器回到"安装前自启状态" | `powershell -File tools\qa\autostart-audit.ps1 -Stage compare -BackupDir $bk -Out docs\evidence\phase7\rollback-verify.json` | `"equalsBefore": true`、`"legacyHitCount": 0`、`"newAppRunEntryCount": 0`、`"diff[]": []` |

### 6.3 回滚后**仍然残留**的东西（必须显式告知用户）

| 残留 | 位置 | 说明 / 清理方式 |
|---|---|---|
| 回滚备份本身 | `%APPDATA%\AiriMateOne\migration\backup-<ts>\` | 有意保留（这是回滚依据）。确认不再需要后由用户手动删除 |
| 迁移出的用户数据副本 | `%APPDATA%\AiriMateOne\db\`、`persona.json`、`settings.json` | 卸载器默认**不删**（可能是用户唯一的历史副本）；用户可在卸载向导勾选删除 |
| 密钥密文 | `%APPDATA%\AiriMateOne\secrets\*.bin` | 默认**不删**（删了用户要重新录入）；卸载向导提供"同时删除已保存的密钥"勾选项 |
| 本地动作资产与转换产物 | `assets\motion\*.vrma`、`assets\motion\manifests\*.json`、`assets\models\catalog.json` | 属"本地工作区"资产，**不进分发包也不由卸载器删除**（删了要重跑管线） |
| 日志与崩溃转储 | `%APPDATA%\AiriMateOne\logs\`、`crashDumps\` | §7 规定删除；若用户保留则提示其中不含密钥（A17 已证） |
| 旧栈自身 | 旧工程根、`F:\AIRI`、Mate-Engine 仓库 | **有意保留**：迁移计划不删除旧栈任何字节（只停进程、只改自启项）。彻底退休旧栈是用户的独立决定 |
| 旧 `.airi-upstream.env` | `F:\deepseek harness\AI女友\.airi-upstream.env` | **有意保留但已失效**：迁移完成后用户必须**吊销**其中密钥。是否删除该文件由用户决定（本计划不自动删） |

---

## 7. 卸载规格（Uninstall specification）

### 7.1 卸载器**必须删除**的内容

| # | 内容 | 路径 / 位置 | 备注 |
|---|---|---|---|
| 1 | 应用文件 | `<install>\`（`AiriMateOne.exe`、`resources\app.asar`、`locales\`、`*.dll`、`Uninstall AiriMateOne.exe` 自身由安装器处理） | 卸载完成后 `<install>` 为空目录或已删除 |
| 2 | 快捷方式 | 开始菜单 `%APPDATA%\Microsoft\Windows\Start Menu\Programs\AiriMate One\`、桌面 `<Desktop>\AiriMate One.lnk` | 只删本应用创建的；由备份恢复的旧快捷方式不算 |
| 3 | 自启项 | `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\AiriMateOne` | 删除前把原值写进卸载日志 |
| 4 | 日志 | `%APPDATA%\AiriMateOne\logs\` | 删除前跑一次 `scan-secrets.ps1 -Scope logs`（若命中 > 0 则**先记录命中位置再删**，并作为缺陷上报） |
| 5 | 崩溃转储 | `%APPDATA%\AiriMateOne\crashDumps\` | 同上 |
| 6 | 运行期数据 | `%LOCALAPPDATA%\AiriMateOne\run\instance.lock`、缓存目录、GPU 缓存 | 释放锁文件是"不留悬挂锁"的要求（Tech-Spec §3.3） |
| 7 | **由第三方 `.anim` 派生的缓存动作资产** | `%APPDATA%\AiriMateOne\cache\motion\` 与 `<install>\assets\motion\`（**仅当安装器把它们放进了安装目录**） | LICENSE-RISK-1：不得把派生自动捕资产留在分发路径上。**卸载器必须删除安装目录内的任何 `.vrma`/`.vrm`/`.anim`**（若存在），并打印删除清单 |
| 8 | 卸载日志 | `%APPDATA%\AiriMateOne\logs\uninstall-<ts>.log`（删除前先写；该文件本身保留在 `migration\` 下） | 供事后审计 |

### 7.2 卸载器**不得删除**的内容

| 内容 | 原因 |
|---|---|
| 用户密钥（`secrets\*.bin`） | **除非用户在卸载向导显式勾选"同时删除已保存的密钥"**。默认保留，避免用户无准备地丢失配置 |
| 用户数据（`db\`、`persona.json`、`settings.json`、`migration\`） | 可能是用户唯一的历史/记忆副本；默认保留并给出路径提示 |
| `F:\deepseek harness\AI女友\repos\Mate-Engine` | 资产来源仓库，**只读且不属于本应用** |
| `F:\AIRI` 与 `E:\EdGe下载\Public.Release.X3.3.0-HOTFIX-1` | PRD §7 C3：逐字节只读 |
| 旧工程根的任何文件（含 `build\pet\`、`build\workcopy*\`、旧脚本、`.airi-upstream.env`） | 迁移计划不做旧栈清理；删了会破坏用户的取证/回滚依据 |
| 其它软件的自启项与快捷方式 | 不属于本应用 |
| `node_modules\electron\`（旧工程复用来源） | 旧工程资产，非本应用安装内容 |

### 7.3 "不留旧桌宠自启"断言（Tech-Spec §8.2 步 5 的验收）

```powershell
# 待执行 —— 卸载后断言（三个面合计命中 0，且自有项为 0）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\autostart-audit.ps1 -Stage post-uninstall -Out docs\evidence\phase7\A19-post-uninstall.json
```
**必须看到的原始输出**

```
"newAppRunEntryCount": 0
"legacyHitCount": 0
"registryValueMatches": 0
"startupShortcutMatches": 0
"scheduledTaskMatches": 0
"restoredLegacyCount": 0        (未带 --restore-legacy 时)
```
**判定**：以上五项全为 0 ⇒ 断言成立。**任一项非 0 ⇒ 卸载不通过**，卸载器必须回滚到"未卸载"状态（不删文件）并输出 `LEGACY_AUTOSTART_REMAINS` 错误码。
**重启复测**：重启后 60s 内再跑一次 `-Stage post-reboot`，仍须全为 0（`Acceptance-Matrix` A19 第三个时点）。

---

## 8. 切换清单（Cutover checklist）

> 从"旧栈仍在运行"到"新应用是唯一实例"。**严格按序**；每项都有验证命令与期望原始输出。任一期望不符 ⇒ **停止**，按 §6 回滚。

| # | 阶段 | 动作 | 验证命令 | 期望原始输出 | 状态 |
|---|---|---|---|---|---|
| C01 | 准备 | 记录旧栈与自启基线（只读） | `powershell -File tools\qa\legacy-probe.ps1 -Out docs\evidence\phase7\C01-legacy-before.json` | `legacyProcessCount >= 1`（E0 实测 `MateEngineX.exe` pid 与宿主 `node.exe` 在跑）、`legacyHitCount@autostart = 0`（E0 实测 Run 无本产品项） | `待执行` |
| C02 | 准备 | 备份注册表 + Startup + 计划任务（§4 步 1–3） | 见 §4 步 1–3 命令 | `hkcu-run.reg`/`hkcu-runonce.reg`/`startup-folders.json`/`scheduled-tasks\*` 均存在且非空 | `待执行` |
| C03 | 准备 | 红线目录快照（before） | §1.3 命令 | `fileCount` 落盘 `recon-readonly-snapshot-before.json` | `待执行` |
| C04 | 停机 | 关旧桌宠（若在跑） | §5.2 顺序 1 | 无输出 | `待执行` |
| C05 | 停机 | 关 `MateEngineX.exe`（窗口内 `Alt+F4`） | §5.2 顺序 2 | 无输出 | `待执行` |
| C06 | 停机 | 关旧宿主 `airi-host.mjs`（`Ctrl+C` 优先） | §5.2 顺序 3 | §5.1 查询无输出 | `待执行` |
| C07 | 停机 | 关旧 brain/bridge（`Ctrl+C` 优先） | §5.2 顺序 5 | 无输出 | `待执行` |
| C08 | 停机 | 等 10 分钟确认无重生 | §5.3 步骤 6 | 无输出（10 分钟内无新进程） | `待执行` |
| C09 | 停机 | 可见窗口复查 | `proc-window-inventory.ps1 -Invariant noLegacyMateEngineX,noLegacyPet` | `visibleLegacyMateEngineXWindowCount=0`、`visibleLegacyPetWindowCount=0` | `待执行` |
| C10 | 迁移 | 用户数据迁移（§3） | `node tools\qa\migrate-userdata.mjs --src '%APPDATA%\ai.moeru.airi' --dst '%APPDATA%\AiriMateOne' --backup $bk --report ...` | `unexplainedDelta=0`、`migrationWarnings[]` 已逐条列出；**密钥未被复制**（`secrets\` 内无 `.bin`，直到用户录入） | `待执行` |
| C11 | 迁移 | 安装新应用 | 运行安装器（`AiriMateOne-Setup-<ver>.exe`） | 安装完成；`<install>\AiriMateOne.exe` 存在；`Get-ChildItem '<install>' -Recurse -Include *.anim,*.vrm,*.vrma` **无输出** | `待执行` |
| C12 | 迁移 | 启动新应用（首次，不带 `--autostart`） | `Start-Process '<install>\AiriMateOne.exe' -ArgumentList '--diagnostics','docs\evidence\phase7\C12-diag.json'` | `instances=1`、`visibleWindows=1`、`vrmCount=1`、`live2dCount=0` | `待执行` |
| C13 | 迁移 | 用户重新录入密钥（**新密钥**；旧密钥已吊销） | 应用内设置页操作 + `Get-ChildItem '%APPDATA%\AiriMateOne\secrets'` | `secrets\<providerId>.bin` 出现且非明文；renderer 只见 `hasKey/keyFingerprint/keyLength` | `待执行` |
| C14 | 迁移 | 旧密钥**吊销**确认 | 用户在供应商控制台吊销 + 记录时间 | 用户确认记录落 `docs\evidence\phase7\C14-key-revoked.json`（含 `revokedAt`、供应商标识，**不含密钥本身**） | `待执行` |
| C15 | 自启 | 合并自启为唯一一条（§4 步 5） | `New-ItemProperty ... -Name 'AiriMateOne' -Value '"<install>\AiriMateOne.exe" --autostart'` | `Get-ItemProperty -Name 'AiriMateOne'` 返回该值；本产品相关项**恰好 1 条** | `待执行` |
| C16 | 自启 | 移除/禁用旧自启项（§4 步 6，逐个记录） | §4 步 6 命令 | 每个动作前打印原值；动作后 `legacyHitCount=0` | `待执行` |
| C17 | 自启 | 自启审计（post-install） | `autostart-audit.ps1 -Stage post-install` | `newAppRunEntryCount=1`、`legacyHitCount=0`、其余三项 `=0` | `待执行` |
| C18 | 自启 | 迁移前后对比 | `autostart-audit.ps1 -Stage compare -BackupDir $bk` | `diff[]` 只包含"新增 `AiriMateOne` 项"这一条预期差异 | `待执行` |
| C19 | 单实例 | 第二次启动测试 | `tools\qa\single-instance.ps1 -Exe '<install>\AiriMateOne.exe'` | `instances=1`、`visibleWindows=1`、`secondExitCode=0`、`focusGained=true` | `待执行` |
| C20 | 阻断 | 旧实例阻断测试（S8）：**用户手工**启动 `MateEngineX.exe`，再启动新应用 | `tools\qa\legacy-probe.ps1` + 新应用启动 + 截图 | 阻断对话框出现、主窗口 `visibleMainWindowCount=0`、旧 PID 前后不变（`legacyPidsUnchanged=true`） | `待执行` |
| C21 | 阻断 | 关闭被手工启动的 `MateEngineX.exe`（用户操作，窗口内 `Alt+F4`） | §5.2 顺序 2 | 无输出；`visibleLegacyMateEngineXWindowCount=0` | `待执行` |
| C22 | 重启 | 重启电脑，登录后 60s 内审计 | `autostart-audit.ps1 -Stage post-reboot` + `proc-window-inventory.ps1` | `newAppRunEntryCount=1`、`legacyHitCount=0`、`appInstanceCount=1`、`visibleMainWindowCount=1`、`legacyRespawnCount=0` | `待执行` |
| C23 | 收口 | 红线目录快照（after）并与 before 比对 | §1.3 命令 + 比对 | `identical=true`（`F:\AIRI`、官方安装、Mate-Engine 仓库均未变） | `待执行` |
| C24 | 收口 | 密钥扫描 | `scan-secrets.ps1 -Root . -Out docs\evidence\phase7\A17.json` | `totalHits=0`、`filesScanned>=<冻结下限>`、`commandLineHits=0`、`installerPayloadHits=0` | `待执行` |
| C25 | 收口 | 20 条判据收口审计 | `claim-audit.ps1 -Matrix docs\Acceptance-Matrix.md -Evidence docs\evidence` | `rowsNotVerified=0`；`rowsBlocked` 仅剩 BLOCKER-1 实际受阻行 | `待执行` |
| C26 | 收口 | 卸载演练（一次，在测试机上） | 卸载 + `autostart-audit.ps1 -Stage post-uninstall` | 五项全 0（`newAppRunEntryCount`/`legacyHitCount`/三个面 matches） | `待执行` |
| C27 | 收口 | 回滚演练（一次，在测试机上） | §6.2 步 1–7 | `equalsBefore=true`、`legacyHitCount=0`、`newAppRunEntryCount=0` | `待执行` |

**结束状态（本清单全部完成后）**：`appInstanceCount=1`、`visibleMainWindowCount=1`、`vrmCount=1`、`live2dCount=0`、`visibleLegacyMateEngineXWindowCount=0`、`visibleLegacyPetWindowCount=0`、`legacyHitCount@autostart=0`、`nonLoopbackListenCount=0`、`totalHits@secrets=0`。

---

## 9. 本文档的显式决定（源文档未冻结、由本文冻结的部分）

| # | 决定 | 理由 |
|---|---|---|
| E1 | 备份目录布局与 `migration-manifest.json` 字段结构（§4）被冻结 | Tech-Spec §8.2 只说"导出到 `backup-<ts>\`"，未定义文件与字段；无结构就无法写对照脚本 |
| E2 | 卸载默认**不删**用户密钥与用户数据，改为向导勾选 | 源文档只说"不删用户密钥除非要求"，未定义默认值；默认删会造成不可逆损失 |
| E3 | 旧自启项处置采用**"移动到备份目录"而非删除** | 使 §6 回滚无需依赖 `.reg` 导入即可恢复 Startup 快捷方式；`--restore-legacy` 才有真实内容可恢复 |
| E4 | 关闭旧进程的顺序被固定为：旧桌宠 → `MateEngineX` → 旧宿主 → （可选）AIRI → brain/bridge；且**父进程最后关** | E0 实测 `airi-host.mjs`（node.exe）是 `MateEngineX.exe` 的父进程，先关父会触发子进程重拉或残留 |
| E5 | 明确列出"不动的进程"：归属不可读、其它用户、系统进程、以及**本次取证工具自身**（命令行含 `EnumWindows` 或祖先链含 harness 的 powershell） | E0 methodology 已登记该自匹配陷阱：审计命令本身含 `MateEngineX` 字面量，会被自己命中 |
| E6 | 红线目录用 `rel/len/LastWriteTimeUtc.Ticks` 快照比对（可选加根级 SHA256） | 1.37 GB 的 `app.asar` 全量哈希不可接受；文件级三元组足以发现任何触碰 |
| E7 | 用户数据迁移一律 **copy + 解析**，不移动、不删除源；畸形源进 `migration\quarantine\` | 保证源可用于回滚与二次解析 |
| E8 | AIRI 用户数据的**文件级路径已实测**，**文件内键路径标记为"待解析"**，且这类项不得作为验收证据 | E0 只做到文件级枚举；把"待解析"当已知事实会制造虚假精度 |
| E9 | 卸载器必须删除安装目录/缓存中的任何 `.vrma`/`.vrm`/`.anim` 派生资产并打印清单 | LICENSE-RISK-1 + PRD §7 C5：派生自动捕资产不得留在分发路径上 |
| E10 | 卸载断言失败时不继续卸载，回滚到"未卸载"并报 `LEGACY_AUTOSTART_REMAINS` | 半卸载状态会让"旧桌宠自启 = 0"永远无法证明 |
| E11 | 新应用**不要求用户关闭 `F:\AIRI\airi.exe` 自身**；只有"`airi.exe` + 旧桥同时存在"才告警 | Tech-Spec §8.1 组合谓词的明文意图：不误伤用户正常使用 AIRI |
| E12 | §5 的停机流程规定"每步一条验证命令 + 期望原始输出"，并把"是否被重生"作为必答问题 | 源文档只给了"手工关停"的概念，未定义可判定性 |
| E13 | 迁移完成后仍**保留旧栈全部字节**（含 `.airi-upstream.env`），只吊销密钥 | 旧栈是取证与回滚依据；删除是不可逆的，且超出本计划授权范围 |
| E14 | 一次性里程碑（Phase 0 交付）：本文与 `Acceptance-Matrix.md` 均标 `待执行`，未执行命令一律不声称完成 | Tech-Spec §10 交付纪律：完成声明必须附命令 + 原始输出 + 证据路径 |
