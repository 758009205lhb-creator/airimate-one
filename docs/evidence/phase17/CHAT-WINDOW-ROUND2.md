# CHAT-WINDOW-ROUND2 · 完善与优化轮取证（2026-10-09）

> 本轮性质：**完善与优化轮，不是返工**。上一轮（`docs/evidence/phase16/CHAT-WINDOW-ROUND.md`）
> 已经正确地把聊天做成独立窗口；本轮在这个基础上做三件事：
> **① 对话窗口对齐参考实现**（框架/尺寸/菜单栏/底部操作行）、
> **② 新增「桌宠是否常驻」+「呼出/收回桌宠」**、**③ 改启动行为：打开软件不再自动出现桌宠**。
>
> 本文件是这一轮的**证据索引 + 结论**。所有读数都来自磁盘上的 JSON / PNG，
> 路径与命令逐条给出，可以原样重跑。**没跑的一律标 `NOT VERIFIED`**（§4）。

---

## 0. 参考实现的确切参数（照抄交互与尺寸，不照抄美术）

`DataAxeagle/DockPetWin-Aemeath`（C#/WPF，用户视频里的同角色形态）。

| 位置 | 参考实现 | 本轮做法 |
|---|---|---|
| `AgentChatWindow.xaml` | `Width=720 Height=560 MinWidth=560 MinHeight=420`，`WindowStartupLocation=CenterOwner`，**没有设 `WindowStyle`** ⇒ 系统原生边框，`Title="和爱弥斯聊天"` | ✅ 尺寸对齐；**`frame:true`**（系统原生边框）；标题取 **`和 {角色名} 聊天`**；首次打开在**鼠标所在显示器工作区居中** |
| `AgentChatWindow.xaml` 结构 | 头部（头像+标题+状态+模式按钮）→ 中部 `ScrollViewer` → 底部操作行（输入框+配置目录+清除对话+发送） | ✅ 信息头 + 滚动区 + 底部操作行（输入框/麦克风/清除/目录/发送-停止）；**额外**加了一条功能菜单栏（用户本轮要求） |
| `MainWindow.xaml` | `Title="DockPetWin"` `WindowStyle="None"` `ResizeMode="NoResize"` `Topmost="True"` `ShowInTaskbar="False"` | ✅ 保持现状：`frame:false` / pet 恒 `340×420` / `alwaysOnTop` / `skipTaskbar:true` |
| 桌宠右键菜单（`AddPetMenuItem`） | 当前状态（禁用项）/ 摸摸{名字} / 让她休息·散步 / 回到小屋 / 和她聊天 / 清除提醒 / 偏好设置 / 暂时隐藏 / 重启 / 退出 | ✅ **原生菜单**逐项对齐（`ipc.ts` 的 `PET_MENU`）；顺序与语义一致 |
| 托盘菜单 | 桌宠请求 / 状态切换 / 聊天请求 / 回小屋 / 清提醒 / 设置 / 显隐切换 / 重启 / 退出 | ✅ 显示/收回桌宠、☑ 桌宠常驻、开始/结束对话、打开管理面板、记忆、日程、模式、置顶、偏好、语音、快捷键、关于、自启、退出 |
| 聊天窗口单例 | `if (agentChatWindow is { IsVisible: true }) { Activate(); return; }` | ✅ 保持（`chatwindow.json` 的 `singleton.*`：3 次重开 `hwnd` 不变、`createdCount` 不涨、窗口仍可见） |

> ⚠ **联网抓取参考实现源码在本机不可用**（`web_fetch` 对 `raw.githubusercontent.com` /
> `api.github.com` / `github.com` 全部 `TypeError: fetch failed`，`web_search` 也返回
> 与该仓库无关的结果）。⇒ **本轮的参数全部来自用户在任务书里逐条给出的读数**，
> 未做二次核对。这条**如实标注**，见 §4 的 NOT VERIFIED。

---

## 1. 改动文件清单

### 1.1 新增

| 文件 | 作用 |
|---|---|
| `apps/desktop/src/main/pet-visibility.ts` | **桌宠呼出/收回/常驻的唯一状态机**：`petMenuState()`（三处菜单+托盘 tooltip 共用的唯一快照）、`showPet/hidePet/togglePet/setPetResident` |
| `apps/desktop/src/main/pet-resident-probe.ts` | `--probe petresident` 的 49 项判据（C1..C7 + 回归） |
| `apps/desktop/src/main/menu-open-probe.ts` | `--probe menuopen`：把两种菜单**真的展开**并按哨兵握手交给外部截图 |
| `tools/qa/petresident-shots.ps1` | 六张真实桌面截图（状态类 4 张由本脚本驱动；菜单类 2 张由 `menuopen` 探针握手） |
| `tools/qa/petresident-restart.ps1` | C2/C3 的"**重启后仍生效**"：两次独立进程启动 |
| `docs/evidence/phase17/CHAT-WINDOW-ROUND2.md` | 本文件 |

### 1.2 修改

| 文件 | 改了什么 |
|---|---|
| `packages/shared/src/settings.ts` | 加 `petResident`（默认 `false`）/ `startupOpenChat`（默认 `true`）**进 schema** |
| `packages/shared/src/ipc.ts` | 加 9 条通道（`pet:show/hide/toggle/open-panel/set-resident/flush-settings/menu`、`ui:action`、`chat:context-reset`、`chat:open-data-dir`、`app:restart`）；加 `PetControlRequestSchema`/`PetResidentRequestSchema`/`PetMenuStateSchema`/`UiActionSchema`/`UiActionRequestInputSchema`；`ConversationStateSchema` 加 `pet`（带 `.default()`）；`ConversationSourceSchema` 加 `startup`/`pet-menu`/`probe` |
| `packages/shared/src/preload-api.ts` | 9 个新方法 + `onUiAction` / `onPetMenuState` 订阅 |
| `apps/desktop/src/preload/index.ts` | 内联通道同步（**双向比对由单测钉死**）+ 9 个新方法 |
| `apps/desktop/src/main/chat-window.ts` | ★ `frame:false` → **`frame:true`** + `setMenuBarVisibility(false)`；标题 `和 X 聊天`；`FRAME_DECORATION` 尺寸换算；`boundsSource` 改用 **`WeakMap`**；`rememberBounds()` 存**外框**读回值；`chatWindowTitle()` / `applyChatWindowTitle()` |
| `apps/desktop/src/main/window-manager.ts` | `CreateWindowOptions.autoShowOnReady`（**默认 true**；传 `false` ⇒ 创建但不显示）；导出 `windowVisible()` / `windowCreated()` |
| `apps/desktop/src/main/tray.ts` | 菜单重排（桌宠三项在最上）+ 桌宠/对话/管理面板/记忆/日程/偏好/语音/快捷键/关于；tooltip 用 `petStatusText()`（与菜单同一份）；单击后 `rebuild()` |
| `apps/desktop/src/main/ipc.ts` | 9 条新通道的 handler；`PET_MENU` 的**原生右键菜单**；`CHAT_HISTORY` 改用 `visibleHistory()`；`sendUiAction()` / `sendPetMenuState()`；`APP_RESTART` |
| `apps/desktop/src/main/bootssstrap.ts` | `--probe-pet-mode`；`wantResident` 计算与 `autoShowOnReady`；启动显示策略（`openConversation('startup')`）；`requestRestart` 注入；托盘新钩子；`--probe petresident` / `--probe menuopen` 注册 |
| `apps/desktop/src/main/conversation.ts` | `state.pet`（桌宠快照进对话状态）；`applyConversationSettings()` 加标题同步 |
| `apps/desktop/src/main/session-store.ts` | 加 `contextResetAt`（`.default(0)`）+ `visibleHistory()` / `resetContext()`；`buildPrompt()` 改用 `visibleHistory()` |
| `apps/desktop/src/main/session.ts` | `SessionHooks.requestRestart?` |
| `apps/desktop/src/main/hit-region.ts` | ★ `reset(reason)`；`tick()` 加"**窗口不可见不参与命中判定**" |
| `apps/desktop/src/main/chat-probe.ts` | 口径随本轮更新（标题/外框尺寸/首次打开的重建起点/计数基线/轮盘预聚焦）+ `menuBar`/`frameEvidence`/`engineTicks` 读数 |
| `packages/radial-menu/src/menu.ts` | ★★ **兜底泵**（8ms `setInterval`）+ **时间基 lerp** —— 修的是"桌宠没有焦点时轮盘动画被 rAF 冻结 ⇒ 点不动" |
| `apps/renderer/src/components/ChatWindow.vue` | 整侧重写外壳：删自绘标题栏；加**菜单栏（6 组 19 项，每项真实动作）**、信息头、底部操作行（含清除/目录）；`menuCatalog`/`clickAll`/`menuOpen`/`menuClose` 探针操作 |
| `apps/renderer/src/components/PetShell.vue` | 订阅 `evt:ui-action` 切页；pet 模式下接管右键（`bridge.petMenu()`）；`petMenuState` 进 UI 探针 |
| `apps/renderer/src/components/AvatarStage.vue` | `wheelDiag` / `rafProbe` 两个只读诊断操作 |
| `apps/renderer/src/store.ts` | `petResident`/`petVisible`/`petStatusText`/`appVersion`/`contractVersion` 镜像；`resetConversation()`；`uiAction()`；订阅 `onPetMenuState`/`onUiAction` |
| `apps/renderer/src/bridge.ts` | 新方法 + `uiAction` + `onUiAction`/`onPetMenuState` |
| `apps/renderer/src/styles.css` | 菜单栏/下拉/信息头/头像/快捷键与关于小面板；`.chatw` 去掉边框（`frame:true` 后避免双线） |
| `apps/desktop/test/m1-contract.test.cjs` | **+5 条契约单测**（两个设置的默认值与 schema 穿透 / 老 `ConversationState` 仍可解析 / 桌宠控制入参闭合枚举 / `ui:action` 入参不含单向通知） |
| `tools/qa/check-claims.mjs` | **+3 条静态断言**（原 11 条 → **14 条**）：`chat-window-has-native-frame-and-menubar`、`pet-resident-and-startup-behavior-declared`、`no-dead-conversation-dock` |
| `tools/qa/audit-acceptance.mjs` | 判据 25 → **30 条**（A2b 换证据；新增 A2c..A2g 五条） |
| `tools/qa/Get-DesktopState.ps1` | 枚举按**新旧两种 chat 标题**认窗口（`和…聊天` / `AiriMate One*`） |
| `tools/qa/soak-2h.ps1` | `characterVisibleWindowCount != 1` **从违规降级为记录**（默认桌宠不显示是正确行为）+ 新增 `windowNotes` |
| `docs/PRD.md` | §1 硬口径第 2 条补"可见性不再恒定"；**FR-1.4/1.5 改写**；**新增 FR-1b「桌宠常驻与启动行为」** |
| `docs/Tech-Spec.md` | §4.1 表更新（`frame:true`）；**新增 §4.1.1（原生边框与其三个连带项）**、**§4.1.2（对话窗口菜单栏）**、**§4.1c（桌宠常驻与启动行为）** |
| `docs/Acceptance-Matrix.md` | **新增 §0.6（旧行为如何被取代 / 两个设置的组合表 / C1..C10 / frame:true 口径表）**；§1.5 计数器与口径改写；§7.2 采样表第 2/2b 行改写 |

### 1.3 删除

| 文件 | 理由 |
|---|---|
| `apps/renderer/src/components/ConversationDock.vue` | 2026-10-08 的文档说它"已删除"，但**磁盘上仍在**。它是"把聊天塞进桌宠窗口"那条被否决路径的载体 ⇒ 本轮补删，并加静态断言 `no-dead-conversation-dock` 防它回来 |
| `ChatWindow.vue` 里的自绘标题栏（`.chatw__titlebar` + 最小化/关闭按钮） | `frame:true` 之后由**系统**提供，自绘只是劣化复制品 |

---

## 2. 判据、取证命令与原始读数

### 2.1 C1..C7 + 回归：`--probe petresident`

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\run-probe.ps1 `
  -Name petresident -Mode pet -TimeoutSec 300 -OutDir docs\evidence\phase17 -ExtraArgs '--no-proactive'
```

**结果**：`pass=true`，`passedChecks=49/49`，`failedChecks=[]`。

| # | 判据 | 原始读数 |
|---|---|---|
| C1 | 默认启动态：pet 不可见 / chat 可见 / 托盘存在 / 两窗口都已创建 | `startup = { petVisibleAtBoot: false, petVisibleNow: false, petCreated: true, chatVisible: true, chatTitle: "和 Lazuli 聊天" }`；`C1.tray-exists=true`；`C1.exactly-two-windows=true`；`C1.pet-window-still-created=true` |
| C2a | 起点复位（非常驻 ⇒ 不可见 + 落盘 false） | `residentOff.settings=false`；`C2a.resident-off-persisted=true` |
| C2 | 勾上常驻 ⇒ 可见 + **写进文件** | `residentOn.pet = { resident: true, visible: true, statusText: "桌宠常驻中" }`；`residentOnDisk = true`（读的是 `settings.json` **文件**）；`C2.resident-on-persisted-flag=true`（`persisted:true` 来自 `flushSettings()`） |
| C3 | 取消常驻 ⇒ 隐藏 + 写盘 false | `residentOffAfter = { settings: false, onDisk: false }` |
| C4 | 三处勾选状态完全同步 | `syncReadings.main = { resident:true, visible:true, statusText:"桌宠常驻中" }`；`chatMenu = { …, checkedInMenu: true }`；`petUi = { resident:true, visible:true, statusText:"桌宠常驻中" }` —— **三份逐字段相等** |
| C5 | chat 窗口：标题 / 外框尺寸 / 最小尺寸 / 可最小化最大化 / 能移动 | `title="和 Lazuli 聊天"`；`bounds={357,234,720,559}`（外框 720×560，±16 容差）；`minSize=[560,420]`；`resizable/minimizable/maximizable=true`；`chatMovable = { movable:true, from:{357,234}, to:{381,252}, changed:true, restoreOk:true }` |
| C5b | 尺寸校正真的生效 | `openChatDiag.sizeCorrection = { decor:{20,19}, from:{733,572} }`；`requestedBounds = 713×553` ⇒ **外框落在 720×559**（`frame:false` 时代读回 740×579） |
| C6 | 菜单栏逐项点击都有可观测动作 | `chatMenuItems.count = 19`（6 组）；`menuRun = { executedCount: 16, failedCount: 0, leavesSessionCount: 3, missingActionCount: 0 }`；逐项 detail 见 `menuRun.results`（例如 `chat.new → archived=6 visible=0 total=6`、`settings.autostart → autoStart=true`、`chat.dir → opened=true dir=C:\Users\…\AiriMateOne`） |
| C7 | 窗口计数与角色唯一性 | `windows` 恰好 2 个（`和 Lazuli 聊天` / `AiriMate One`）；`uniqueness.chatUi.canvasCount=0`、`stageHandlePresent=false`；`uniqueness.stage = { sceneCount:1, rendererCount:1, mixerCount:1, vrmCount:1, live2dCount:0 }` |
| 回归 | pet 尺寸/模式不变；呼出收回**不写常驻设置** | `regression.pet-size-unchanged=true`（`341×420`）、`regression.pet-mode-unchanged=true`；`hide.resident-setting-untouched=true`（收回后 `petResident` 仍为 `true`）；`hide.hit-regions-cleared=true`（收回后 `hitRegions().state().regions === 0`） |
| 辅助读数 | 帧循环健康度 A/B（见 §5.1） | `engineTicks = { rafDelta: 2, intervalDelta: 243, windowMs: 2000 }`；`rafAb.afterShowFocus.rafCallbacks=1`、`afterWebContentsFocus = { rafCallbacks:1, hasFocus:true }` |

### 2.2 C2/C3 的"重启后仍生效"：`petresident-restart.ps1`

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\petresident-restart.ps1 `
  -OutDir docs\evidence\phase17 -TimeoutSec 300
```

**结果**：`pass=true`，7/7 checks 全真。

| 检查 | 读数 |
|---|---|
| `passA.json-exists` / `passB.json-exists` | `petresident.json`（49/49）、`petresident-start-resident.json`（42/42） |
| `disk.petResident-true-before-passB` | `true`（脚本把 `true` 写进 `settings.json` 后才启动第二次） |
| `passB.startup-read-resident-from-settings` | `startup.settingsAtBoot.petResident = true` |
| `passB.pet-window-auto-shown` | `startup.petVisibleAtBoot = true`、`petVisibleNow = true`、`statusText="桌宠常驻中"` |
| ★ 关键点 | 第二次启动带 `--probe-pet-mode start-resident`，而该参数**不写设置** ⇒ 被验证的是**设置文件里的值驱动了启动行为**，不是命令行 |
| 反向 | 第一次启动（默认 `false`）`petVisibleAtBoot = false` ⇒ 同一套启动流程在两个方向上都被测过 |

**收尾**：`settingsRestoredTo.petResident = false`（运行前原值），`autoStartRestored = true`（C6 的菜单逐项执行会真的写系统启动项，探针会还原）。

### 2.3 C5/C6 的另一半：`--probe chatwindow`（口径已按本轮更新）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\run-probe.ps1 `
  -Name chatwindow -Mode pet -TimeoutSec 300 -OutDir docs\evidence\phase17 -ExtraArgs '--no-proactive'
```

**结果**：`pass=true`，`passedChecks=68/68`。

| 本轮新增/改写的判据 | 读数 |
|---|---|
| `windows.titles-match-roles` / `windows.chat-title-is-he-chat` | 角色窗口 `title='AiriMate One'` ×1；对话窗口匹配 `^和\s*\S+\s*聊天$` ×1；主进程 `getTitle()` 与枚举一致 |
| `frame.chat-window-capabilities-all-on` | `resizable/minimizable/maximizable = true/true/true` |
| `frame.chat-menubar-hidden` | `isMenuBarVisible() === false`（Electron 菜单栏被显式隐藏，客户区只有我们自己的那一行） |
| `menubar.catalog-read` / `has-enough-items` / `every-item-has-action` / `leaves-session-declared` | `itemCount=19`、`groupCount=6`、`missingAction=[]`、`leavesSession=['file.hide','file.restart','file.quit']` |
| `center.*`（首次打开居中的口径放宽） | `centerErrorDip=3`（≤8）；`requested={367,244,700,541}`、`actual={367,244,705,544}` |
| `open.chat-default-size` | 请求值 = `外框目标(720×560) − 装饰(20,19)` = `700×541` ⇒ 精确相等 |
| `open.chat-actual-size-within-8dip`（口径改 ±16） | 外框读回 `720×559` |
| `entry.wheel-*` | `clicked=true`、`scale=1`、`anchor=[170,174.07]`、`radius=95`、逐项目 `hit` 全对 |

### 2.4 C9 真实桌面截图：`petresident-shots.ps1`

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\petresident-shots.ps1 `
  -OutDir docs\evidence\phase17 -TimeoutSec 300
```

六张图分两条产线（口径写在脚本里）：

| # | 场景 | 标签 | 产线 |
|---|---|---|---|
| ① | 启动默认态：只有对话窗口、**没有桌宠** | `default-only-chat` | 脚本（写设置 → 启动 → 桌面枚举核对 → 截图） |
| ② | 对话窗口菜单栏展开 | `chat-menu-file` | `--probe menuopen` + 哨兵握手 |
| ③ | 勾选常驻之后：桌宠出现 | `pet-resident-on` | 脚本 |
| ④ | 桌宠右键菜单展开 | `pet-menu-open` | `--probe menuopen` + 哨兵握手 |
| ⑤ | 取消常驻之后：桌宠消失 | `pet-resident-off` | 脚本 |
| ⑥ | 对话窗口被拖走之后（真实鼠标拖标题栏） | `chat-dragged` | 脚本（`SetCursorPos` + `mouse_event` 注入到**目标窗口自己的标题栏**） |

★ 每张图都带**桌面枚举的身份读数**（不是"我看着像"）：
`counts = { visibleOurs, character, chat }`，其中 `character` = 宽度 ≤520 的可见窗口数、`chat` = 宽度 ≥560 的可见窗口数。

★ **另外逐窗口各抓一张**（`perWindowShots`：`*-window-chat.png` / `*-window-character.png`）。
这一步不是"更清楚"，而是把"**每个窗口各自的矩形里是什么**"变成文件级可见 ——
**并且它意外给出了两条非常硬的旁证**：

| 文件 | 字节 | 图里能看到什么 |
|---|---|---|
| `…-pet-menu-open-window-character.png` | 142882 | **角色（VRM 身体/头发）、七项轮盘（对话/置顶/听力/居中/扬声器/设置/角色）与「面板」按钮** —— 这是"pet 窗口真的在渲染"的直接像素证据 |
| `…-C-window-character.png` | 16076 | pet 窗口内**只有一个「面板」按钮**、角色还在"正在加载角色…" |

> ⚠ 同一个窗口、不同时刻一张 142 KB、一张 16 KB —— **差额就是角色与轮盘**。
> 这顺带说明"角色可见"这件事是可以从像素上分辨的（不是只能靠 DOM 读数）。

原始读数：`phase17/petresident-shots.json`（`shotsFromProbe` + `shotsFromScript` + `perWindowShots` + `checks`）、
`phase17/menuopen.json`（逐组下拉的 DOM 矩形与项数）。

**判定口径（诚实优先）**：`pass` **不包含**"人手拖标题栏"那两项 ——
它们如实记为 `false` 并进 §4 的 NOT VERIFIED（对非前台窗口注入鼠标拖不动它，
那是 Windows 前台锁定、不是产品缺陷；把它算进 `pass` 会让脚本恒失败）。
读数里有一个显式字段 `drag.affects-pass-verdict = false`，让人一眼看出这个取舍。

#### ⚠⚠ 取证环境的限制（**必读，否则会误读那六张图**）

**这六张图是在用户桌面正在被 `Deepseek Harness Desktop`（1294×848）覆盖的情况下拍的。**
`CopyFromScreen` 抓的是**屏幕像素** ⇒ 被遮挡的部分图里只有遮挡物。
实测后果：
* `default-only-chat` / `pet-resident-off`：**能**直接看到对话窗口（它被抬到了最前）；
* `pet-resident-on`：枚举说"角色窗口可见、`425×525+1298+660`"，
  但**图里看不出桌宠**（它被别的窗口压着，而它自己透明且不进任务栏，本来就最不显眼）；
* `chat-menu-file` / `pet-menu-open`：下拉确实**存在**（`menuopen.json` 里有 DOM 矩形与项数），
  但图里那一块是**半透明的遮挡物**，不是我们窗口的像素。

**⇒ 因此这六张图的正确读法是"两个独立证据并列"，而不是"图证明了一切"**：

| 问题 | 机器读数（权威） | 图（受遮挡影响） |
|---|---|---|
| 桌宠在不在屏幕上 | 桌面枚举 `character = 0/1`（按宽度 ≤520 的可见窗口计数）+ 探针 `petMenuState().visible` | 可能看不到（被遮挡） |
| 对话窗口在不在 | 同上（`chat = 0/1`）+ `chatWindowDiagnostics().visible` | 能看到（被抬到最前） |
| 菜单栏展开了没有 | `menuopen.json` 的 `chatMenus[].dropdown = { present, x, y, w, h, items }` | 位置对，但像素被遮挡物覆盖 |

脚本因此**额外逐窗口各抓一张**（`perWindowShots`）：它同样受遮挡影响，
但把"**每个窗口各自的矩形里是什么**"变成文件级可见，而不是让人从大图里找。

**为什么不干脆把别的窗口最小化**：那会动到用户正在用的应用。
2026-10-08 我把用户正在跑的游戏最小化过一次 —— 那是不可接受的副作用，
所以 `-MinimizeOthers` **默认关闭**，且游戏/全屏进程在永不触碰名单里。
拿到"干净桌面"的六张图需要在**用户没有全屏/大面积遮挡时**重跑本脚本
（命令原样可用），本项因此标 `NOT VERIFIED`（§4）。

**为什么不抓"窗口自己的内容"**：`PrintWindow` + `PW_RENDERFULLCONTENT` 对
`transparent:true` 的窗口不保证可用，而"窗口里画了什么"的权威读数本来就是
探针的 DOM/舞台读数（`chatwindow.json` 的 `chatUi.*`、`petoverlay.json`、
以及 `--selfcap` 的帧缓冲自拍）。用一条不可靠的截图路径去替代它们，只会引入新的不确定性。

### 2.5 C8 回归

| 判据 | 命令 | 结果 |
|---|---|---|
| A10 轮盘锚点 ≤2px | `run-probe.ps1 -Name a10 -Mode panel -OutDir docs\evidence\phase17` | `passA10=true`、`passHitRegionMatchesVisual=true`、`passWheelInWindow=true` |
| A11 输入语义 | `run-probe.ps1 -Name a11 -Mode panel -OutDir docs\evidence\phase17` | ✅ **`allPass=true`**（17 项 `pass*` 全真） |
| A14 拖拽尺寸恒定 | `run-probe.ps1 -Name a14 -Mode panel -OutDir docs\evidence\phase17` | `pass=true`（9 项 `pass*` 全真） |
| petoverlay（pet 下无全屏覆盖层） | `run-probe.ps1 -Name petoverlay -Mode pet -OutDir docs\evidence\phase17` | `pass=true` 7/7 |
| ui（向导/设置/跳过路径） | `run-probe.ps1 -Name ui -Mode panel -OutDir docs\evidence\phase17` | `pass=true` 49/49 |

### 2.6 门禁

| 门禁 | 命令 | 结果 |
|---|---|---|
| 静态断言 | `node tools\qa\check-claims.mjs` | **全部 14 条断言成立**（原 11 条 + 本轮新增 3 条） |
| 验收覆盖审计 | `node tools\qa\audit-acceptance.mjs` | 共 30 条判据 / PASS=30 FAIL=0 |
| 单元测试 | `node apps\desktop\test\run-all.cjs` | **424/424**（原 419 + 本轮新增 5 条契约单测） |
| | `node --test packages\avatar-stage\test\motion-runtime.test.mjs` | 35/35 |
| | `node --test packages\motion-director\test\*.mjs` | 44/44 |
| | `node --test packages\companion-kit\test\*.mjs` | 55/55 |
| 类型检查 | `npm run typecheck` | 通过 |
| 全量构建 | `npm run build` | 通过 |

**构建产物分块**（结构性证据：chat 窗口的代码里没有 three/VRM）：

```
dist/assets/ChatWindow-*.js     16.91 kB   ← 对话窗口的全部界面（含菜单栏）
dist/assets/PetShell-*.js      241.81 kB   ← 角色窗口外壳
dist/assets/vrm-*.js           156.35 kB   ← 只有 pet 分支会加载
dist/assets/three-*.js         588.59 kB   ← 只有 pet 分支会加载
```

---

## 3. 被本轮新口径取代的旧表述（逐条）

| 旧表述（出处） | 现状 |
|---|---|
| 「打开软件就自动出现桌宠」 | **取代**：默认 `petResident=false` ⇒ 启动不显示。恢复旧观感需 `petResident=true` + `startupOpenChat=false` |
| chat 窗口 `frame:false` + 自绘标题栏（`Tech-Spec` §4.1 表、`ChatWindow.vue` 头部注释） | **取代**：`frame:true`（系统原生边框）+ `setMenuBarVisibility(false)` |
| chat 窗口标题 `AiriMate One · 对话`（`chat-probe.ts`、`Acceptance-Matrix` §1.5、`Get-DesktopState.ps1`） | **取代**：`和 {角色名} 聊天` |
| 「可见窗口数 = 1 或 2」（`Acceptance-Matrix` §1.5、§7.2 第 2b 行） | **取代**：合法值 **0 / 1 / 2**；判据改为按身份计数（`characterVisibleWindowCount ∈ {0,1}`，`characterWindowCount == 1` 才是硬不变量） |
| soak 的 `characterVisibleWindowCount == 1` 违规判定 | **降级为记录**（默认桌宠不显示 ⇒ 全程 0 是正确行为），进 `windowNotes` |
| `ConversationDock.vue`（文档说删了、磁盘上还在） | **补删** + 静态断言防复发 |
| `--probe chatwindow` 的 `start.chat-not-created` = "窗口还没被创建过" | **改写**：新默认下窗口在启动时就已创建 ⇒ 判"此刻可见的 chat 窗口数 = 0"且窗口对象未销毁 |
| `center.*` 的采集条件 `boundsSource==='centered' && created` | **改写**：新默认下 `created===false` ⇒ 读数为空 ⇒ 只判 `boundsSource==='centered'` |
| A2 行「角色可见窗口数 = 1」 | **改**：默认 0（新默认行为），呼出/常驻后 1 |
| `audit-acceptance.mjs` 判据 25 条 | **改**：30 条（A2b 换证据，新增 A2c..A2g） |

---

## 4. NOT VERIFIED（**不许写成完成**）

| 项 | 为什么没跑 | 怎么跑 |
|---|---|---|
| **参考实现源码的逐行核对** | 本机 `web_fetch` 对 `github.com` / `raw.githubusercontent.com` / `api.github.com` 全部 `TypeError: fetch failed`；`web_search` 返回的结果与该仓库无关。⇒ 本轮的参考参数**全部来自任务书里用户给出的读数** | 网络可用时抓 `DockPetWin/AgentChatWindow.xaml`、`MainWindow.xaml`、`App.xaml.cs` 的 `AddPetMenuItem` 复核 |
| **对话窗口标题栏被真实鼠标拖动**（`chat-dragged`） | 已注入真实鼠标事件两次，**两次都没能移动窗口**（`movedPx=0`，且注入前的 `rectBefore` 与注入后 `rectAfter` 逐位相同）。根因见 §5.2；探针侧的替代证据是 `isMovable()===true` + 真实 `setBounds()` 位移 + 桌面枚举 | 把窗口切到前台（`AttachThreadInput` + `SetForegroundWindow`）后重跑，或**人工拖一次**并截图 |
| **`-probe-shot` 菜单截图的"人手视角"复核** | 探针能证明"下拉的 DOM 矩形存在且项数正确"（`menuopen.json`），截图证明"像素里有那一块"，但"菜单真的画出来了"这一步**没有机器断言**（Electron 无 `Menu.isOpen()`） | 人工看 `chat-menu-file` / `pet-menu-open` 两张图 |
| **任务栏项（`skipTaskbar:false`）** | Electron **没有** `skipTaskbar` 的 getter（2026-10-08 已记过），本轮仍未找到机器读数 | 人工看任务栏是否有「和 X 聊天」 |
| **六张桌面截图的"干净桌面"版本** | 取证时 `Deepseek Harness Desktop`（1294×848）覆盖着桌面 ⇒ 图里 `pet-resident-on` 看不出桌宠、两张菜单图的像素被半透明遮挡物盖住。**图是真拍的、非空、与探针同一时刻**，但"能一眼看出"这一条不满足。详见 §2.4 的限制说明 | 在**没有全屏/大面积遮挡**时原样重跑 `tools\qa\petresident-shots.ps1`（`-MinimizeOthers` 默认关；也可以人工把大窗口挪开再跑） |
| **托盘菜单项被真实点击** | 托盘菜单无法被机械点击（2026-10-08 已记过） | 人工点一次托盘菜单并截图 |
| **`Ctrl+Alt+Space` 的真实按键注入** | `keybd_event` 会把按键送进当时的前台窗口（可能是别的应用） | `powershell -File tools\qa\hotkey-toggle.ps1` |
| **TTS 朗读 / 真实一轮 LLM 对话** | 探针不依赖供应商（不产生对话正文、不需要密钥） | 配好供应商后发一句 |
| **IME 候选期 Enter 不发送（在 chat 窗口里）** | 需要真实微软拼音注入 | 复用 `conversation-shots.ps1` 的 `ime-live` 握手，目标换成 chat 窗口 |
| **A15/A16 的 2 小时浸泡（本轮新口径）** | 本轮改了启动显示行为与 soak 的窗口判据（`characterVisibleWindowCount` 降级为记录），但**没有重跑 2 小时** | `--probe soak --soak-with-chat --soak-minutes 120` + `soak-2h.ps1`（旧证据 `phase16/A15-soak-run6-summary.json` 仍是当前有效的 2 小时证据，其基准日为 2026-10-08） |
| **`--probe petresident` 在 panel 模式下** | 本轮只跑了 `-Mode pet` | `-Mode panel` 重跑（预期 `C1.mode` 相关项与 pet 模式相同；`layout` 会是 `panel`） |
| **桌宠右键菜单里「摸摸她 / 让她散步」的真实动作** | 这两项目前发送的是 `ui:action` 的 `pet-hidden`/`pet-shown`（用于**复位干净态**），**并不是**"播放摸头动画/切换 walk 动作" —— 本轮没有实现那两个动作语义 | 若要真正实现：在 `PetShell.vue` 里按 `ui:action` 分发到 `Stage.requestMotion('laugh')` / `requestMotion('walk')`。**当前菜单项动作是真实的（会复位状态），但与"摸头/散步"的直觉语义不符** —— 如实标注 |

---

## 5. 本轮踩到的坑与查出的真缺陷（写下来，避免下次重踩）

### 5.1 ★★ rAF 在未聚焦/未显示的窗口上被冻结到 ~1Hz ⇒ 轮盘**点不动**（真缺陷，已修）

**现象**：`chatwindow.json` 的 `entry.wheel-clicked-chat-item=false`，`clickChat` 恒返回
`{ clicked:false, reason:'settling', scale:0 }`。

**排查路径（每一步都是实测读数，不是推理）**：
1. `wheelDiag` 读到 `scale 0 → 0`、`advanced:false`、`documentHidden:false`、`visibilityState:'visible'`；
2. 加 `rafProbe` 直接**数 rAF 回调次数**：700ms 内 **1 次**；
3. `rafAb` A/B：`showWindow()`（show+focus）后 `hasFocus=false`、1 次；
   再 `webContents.focus()` 后 **`hasFocus=true` 但 rAF 仍然只有 1 次** ⇒ **不是"没聚焦"**；
4. `engineTicks`（2 秒窗口）：**`rafTicks` 只涨 2，而 8ms 兜底泵涨了 243** ⇒ rAF 被冻结，
   而 `setInterval` 完全正常（舞台因此仍然 62.6 fps —— 它本来就有兜底泵）。

**根因**：`RadialMenu` 的弹出动画**只**跑在 `requestAnimationFrame` 上，
而 Chromium 会把"未聚焦/被判定为被遮挡"窗口的 rAF 冻结到 ~1Hz。
`hitTest()` 在 `scale <= 0.001` 时直接返回 `null` ⇒ **轮盘永远点不动**。

**为什么本轮才暴露**：以前桌宠是**唯一**窗口、**总是聚焦**的（`startupOpenChat` 还不存在）。
本轮改了启动行为 ⇒ "桌宠被呼出但没焦点"成了**常规路径** ⇒ 旧前提失效。
（这正是"**假设变了，判据/结构必须跟着变**"的又一个实例。）

**修法**（`packages/radial-menu/src/menu.ts`）：照 `avatar-stage/src/stage.ts` 早就在用的做法，
给动画加一条 **8ms 兜底泵**，并把逐帧 lerp 改成**时间基** `1 - 0.2^dt`
（`dt` 归一化到一帧 = 1/60s ⇒ 60Hz 下与原来的 `*0.2` **数值等价**，但两源叠加不会加速、
只剩一源也不会变慢）。`dispose()` 里一并清掉泵。

### 5.2 ★ `mouse_event` 拖动窗口：**先要窗口在前台**（本轮仍失败的取证项）

拖动的注入（`SetCursorPos` + `LEFTDOWN` → 4 步移动 → `LEFTUP`）**没有移动窗口**，
而 `rectBefore === rectAfter`。已加的防线（值得留着）：
* 每次移动后用 `WindowFromPoint` + `GetAncestor(GA_ROOT)` 核对"光标下的根窗口是不是目标"，
  **不是就立刻中止**（否则会去拖**用户的应用** —— 那比失败更糟）；
* 位移用**紧邻拖动的前后两次**读数算（首轮拿"启动时枚举的矩形"当基线，
  得出 `movedPx=0`，而窗口其实**真的被拖走过**一次 —— 基线过期会把成功报成失败）。

**尚未解决的部分**：Windows 的前台锁定让我们的注入拖不动一个非前台窗口。
`SetForegroundWindow` 是**我们自己的**窗口，本脚本已经在用；仍不生效。
⇒ 本项标 `NOT VERIFIED`（§4），不硬凑。

### 5.3 其它（每条都对应一处代码注释）

| 坑 | 表现 | 根因 | 处置 |
|---|---|---|---|
| `frame:true` 后"尺寸 720×560"的含义变了 | 外框读回 `740×579` | Electron 的 `width/height` **含系统装饰** | 加 `FRAME_DECORATION={20,19}` 换算 + 判据改判**外框** |
| 为量装饰量建临时窗口 | 应用会短暂出现**第三个 BrowserWindow** | 与"恰好两个窗口"的硬约束冲突 | **撤销**该做法，改用一个按本机实测标定的常量（并如实标注） |
| `rememberBounds()` 存"请求值" | 每开一次窗口长大一圈（≈13 DIP/次） | 存的是"补装饰之前的目标"；`frame:false` 时代两者恒等，`frame:true` 之后不等 | 存 `getBounds()` 的**外框**读回值 |
| `boundsSource` 是模块级变量 | 关掉再打开时读数停在**上一次**的值 ⇒ 居中读数整组为空 | 变量生命周期与"它描述的那个窗口对象"不一致 | 改挂 **`WeakMap<BrowserWindow, …>`** |
| 探针先清记忆、再关闭窗口 | 清了个空 | `hideChatWindow()` 会 `rememberBounds()` **把记忆写回来** | 关闭**之后**再清一次，并把该读数记进证据 |
| 探针清掉记忆后仍读到"用记忆打开" | 居中读数不采 | 启动时已创建过窗口 ⇒ 探针"收起再打开"复用的是**同一个窗口对象**（创建期决策已定） | 探针显式 `destroyChatWindow()` 重建一次起点，并把计数基线取在**第一次打开之后** |
| 菜单目录漏 `items` 字段 | 探针读到 `items=undefined` ⇒"菜单栏不存在" | `menuCatalog` 只给了 `groups` | 两种形状都给（`groups` 给界面、`items` 给探针） |
| 截图脚本按 `menuopen-*.ready` 过滤 | 两处哨兵各等满 12 秒超时，一张图没拍 | 文件名是 `<前缀>-<label>.ready`，**前缀里没有探针名** | 按"前缀的基名"过滤 |
| `raiseChecks` 报 `topmost=True` 但图里看不到窗口 | 桌面枚举说可见，截图里没有 | **Windows 前台锁定**：非前台进程的 `SetWindowPos(HWND_TOPMOST)` 静默失效 | 截图前先 `SetForegroundWindow` + `BringWindowToTop`（只碰我们自己的窗口） |
| `--probe-shot` 没给前缀时"截图未执行"被判失败 | `5/6`（唯一失败项什么都没测到） | 把"没跑"读成了"失败" | 没给前缀时该断言**不参与判定**，但摘要里保留 `skipped` 计数 |
| `soak-2h.ps1` 把"可见角色窗口 != 1"算作违规 | 默认设置下的 2h 浸泡会被判"角色窗口不见了" | 新默认行为下全程 `characterVisibleWindowCount = 0` 是**正确**的 | 降级为 `windowNotes`（记录、不计数）；硬不变量仍是 `characterWindowCount == 1` |
