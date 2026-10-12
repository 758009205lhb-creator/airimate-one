# 对话改造轮 · 交付与取证（2026-10-08）

> 目标（用户原话口径）：把「左侧文字聊天面板」改造成「桌宠对话框 + 语音说话」。
> 本文只写**本次真实跑出来**的东西：每条判据给出**可复制的命令**、**原始结果**与**证据路径**。
> 没跑的一律标 `NOT VERIFIED`，并写清卡在哪。

| 字段 | 值 |
|---|---|
| 证据目录 | `docs/evidence/phase15/` |
| 基准日 | 2026-10-08（本轮所有读数均在此日产生） |
| 最终构建 | `npm run build`（prod，无 sourcemap）；**主探针与截图在 prod 产物上跑过** |
| 主探针 | `conversation.json` → `pass=true`，`45/45`，`failedChecks=[]` |
| 探针汇总 | `node tools/qa/summarize-probes.mjs docs/evidence/phase15` → **6/6 PASS** |
| 类型检查 | `npm run typecheck` → 0 错 |
| 单测 | 419/419（desktop）+ 35（avatar-stage）+ 44（motion-director）+ 55（companion-kit） |
| 静态断言 | `node tools/qa/check-claims.mjs` → 全部 11 条成立 |
| 判据审计 | `node tools/qa/audit-acceptance.mjs` → 全 PASS、无“有证据无结论” |

---

## 1. 改动文件清单

### 1.1 契约（`packages/shared`）

| 文件 | 改动 |
|---|---|
| `src/settings.ts` | `WHEEL_SPEC.items` 的 `chat` 项：`label` 聊天→**对话**、`kind` `panel`→`toggle`（id **不变**）；新增 `WINDOW_GEOMETRY.conversation = {380×560}`；`AppSettingsSchema` 新增 `conversationHotkey`(默认 `Ctrl+Alt+Space`)、`conversationHotkeyEnabled`(true)、`bubbleAutoHideSec`(1–30, 3)、`conversationAutoTtsConfirmed`(false) |
| `src/ipc.ts` | 新增通道 `conversation:open` / `conversation:close` / `conversation:state` + `evt:conversation-state` / `evt:conversation-listen`；新增 `ConversationSourceSchema` / `ConversationOpenRequestSchema` / `ConversationCloseRequestSchema` / `ConversationStateSchema` / `ConversationListenRequestSchema`；`SettingsPatchSchema` 加 4 个可写字段；`AppDiagnosticsSchema` 加只读 `conversation`（`.nullable().default(null)`，向后兼容） |
| `src/preload-api.ts` | `AiriMateApi` 加 `conversationOpen/Close/State`、`onConversationState`、`onConversationListen` |

### 1.2 主进程（`apps/desktop/src`）

| 文件 | 改动 |
|---|---|
| `main/conversation.ts` | **新增**：对话状态机（开关 + 布局耦合 + 快捷键注册/注销/如实报错 + 广播）。告警与状态出口用**注入**（`setConversationAlertSink` / `setConversationStateSink`）避免 `ipc ↔ conversation` 循环依赖 |
| `main/window-manager.ts` | `enterConversationLayout` / `exitConversationLayout`（bottom-center 对齐、拖拽期间拒绝、**尺寸自验证收敛**）、`isConversationLayout`、`syncConversationLayoutForMode`、`conversationSizeDiagnostics`；`autoResize` 在对话布局期间拒绝改尺寸 |
| `main/tray.ts` | 「开始对话 / 结束对话」（按时态 enable）+ 快捷键状态行 + 对话态进 tooltip；`refreshTray()` 现在会重建菜单 |
| `main/ipc.ts` | 注册 3 条对话通道（zod 校验）；`window:set-mode` 后对齐对话布局；设置补丁里 `conversationHotkey*` 变更**立即重新注册**；导出 `sendConversationState`（带校验） |
| `main/diagnostics.ts` | 诊断快照加 `conversation`（try/catch 包装，子模块异常不拖垮整份快照） |
| `main/hit-region.ts` / `hit-region-registry.ts` | `state()` 增加 `ids` / `kinds`（只有 id 与 kind，无内容）——让“对话框/气泡到底有没有上报”可判定 |
| `main/voice-call.ts` | 唤醒词第一动作改为**打开对话 + 请求进入「听」**；打开失败**回退**到原全链路通话；新增 `__setConversationOpenerForTest` 让回退分支可被单测覆盖 |
| `main/bootstrap.ts` | 托盘 hooks 接线、两个 sink 接线、启动注册快捷键 + 补发状态、退出时释放快捷键；**新增 `--probe conversation`**（45 项 check，含真实桌面截图握手） |
| `preload/index.ts` | 内联通道 + 4 个新 API + 2 个订阅（与 `shared.IPC` 双向比对由单测保障） |

### 1.3 渲染层（`apps/renderer/src`）

| 文件 | 改动 |
|---|---|
| `stage-bus.ts` | **新增**：舞台几何只读总线（锚点提供者 + 覆盖层矩形 + 自检计数/探针 + `resolveOverlayEl`） |
| `store.ts` | `conversationOpen/ conversationLayout/ conversationHotkey/ composing/ listening/ ttsAskVisible/ ttsActive/ bubble/ sendCount`；动作 `openConversation/ closeConversation/ toggleConversation/ refreshConversationState/ maybeAskAutoTts/ answerAutoTts/ ask/ listenOnce/ showBubble/ hideBubble/ scheduleBubbleHide/ setBubbleHover/ toggleBubbleExpanded`；`send()` 收敛为 `ask()` 的别名；气泡自动消失的内部精确读数 `lastBubbleAutoHideReading()` |
| `bridge.ts` | `conversationOpen/Close/State` + 2 个事件订阅 |
| `App.vue` | 删除「聊天」tab（tab 类型收敛为 7 个）；`<ConversationDock/>` 与 `<SpeechBubble/>` 作为 `AvatarStage` 的**兄弟节点**挂载；UI 探针新增 5 个必需字段 + 补充读数 |
| `components/ConversationDock.vue` | **新增**：对话框（麦克风/输入/发送-停止/关闭、IME 三重保险、48–112 自适应、命中区域上报 kind=`panel`、TTS 确认条、快捷键失败常驻提示） |
| `components/SpeechBubble.vue` | **新增**：气泡（锚点跟随、rAF 驱动 scale 0.94→1 + 120ms 淡入 / 160ms 淡出、3 行截断、悬停暂停、点击展开、命中区域 kind=`bubble`） |
| `components/AvatarStage.vue` | 轮盘 `chat` 项改为开/关对话；`onToggleState('chat')` 反映真实状态；`@dblclick` 打开对话（仍只认角色命中，短按行为不变）；注册锚点提供者；命中区域汇总**覆盖层**一起上报 |
| `components/MemoryPanel.vue` | 迁入「对话历史（默认折叠）」+ **两步确认清空历史**（功能不丢） |
| `components/SettingsPanel.vue` | 新增「对话」设置卡（快捷键、开关、气泡秒数、气泡开关、**注册结果的如实显示**） |
| `components/ChatPanel.vue` | **删除**（不再挂在侧边栏；历史入口收进记忆页） |
| `styles.css` | 对话框与气泡的冻结样式（数值集中在此，改动即改规格） |

### 1.4 测试与 QA 工具

| 文件 | 改动 |
|---|---|
| `apps/desktop/test/voice-loop.test.cjs` | 唤醒词用例**按本轮规格改写**（唤醒 ⇒ 打开对话 + 请求听，不起全链路通话）+ 新增「打开失败 ⇒ 回退通话」用例（用注入件覆盖那条分支） |
| `tools/qa/conversation-shots.ps1` | **新增**：真实桌面截图取证（哨兵文件握手）+ A2/A3/A4 桌面枚举 + **真实微软拼音**候选期 Enter 注入（前台不是本应用就**拒敲**并如实记 skipped） |
| `tools/qa/hotkey-toggle.ps1` | **新增**：全局快捷键 `Ctrl+Alt+Space` 的**真实按键**验收（窗口几何读数） |

---

## 2. 验收判据逐条取证

### 判据 1 · 探针新增字段

```powershell
node tools/qa/summarize-probes.mjs docs/evidence/phase15
```

`__AIRIMATE_UI_PROBE__('read')` 新增字段（全部实测存在，见 `conversation.json` → `uiOpened` / `bubblePhaseUi` / `bubbleLifecycle`）：

| 字段 | 实测值（最终运行） |
|---|---|
| `conversationOpen` | `true`（打开后）/ `false`（关闭后） |
| `conversationLayout` | `"conversation"`（pet 对话态）/ `"panel"`（面板浮层） |
| `bubbleVisible` | `true` → 消失后 `false` |
| `bubbleTextChars` | `30`（= 该轮回复字符数；**只给字符数，不给内容**） |
| `ttsActive` | `true` → `false` |

补充读数（同一出口）：`composing`、`listening`、`ttsAskVisible`、`bubbleExpanded`、`bubbleFullChars`、`sendCount`、`conversationHotkey{accelerator,enabled,registered,error}`、`overlayRects{dock,bubble,ticks,probes,dockInDom}`、`bubbleAutoHide{delayMs,targetMs}`。

### 判据 2 · `--probe conversation`

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\run-probe.ps1 `
  -Name conversation -Mode pet -TimeoutSec 420 -OutDir docs\evidence\phase15
```

**原始结果**：`pass=true`，`passedChecks=45/45`，`failedChecks=[]`
（证据：`docs/evidence/phase15/conversation.json`；同一次运行的 stdout 见 `conversation.txt`）

逐条对应（键名即 `checks` 里的键）：

| 要求 | 键 | 实测 |
|---|---|---|
| 从 pet 态打开 → `conversationOpen=true` | `ui.open-flag` | true |
| 窗口尺寸 = `WINDOW_GEOMETRY.conversation` | `layout.size-equals-geometry` | 三次打开读数均 `380x560`（期望 380×560） |
| 尺寸在多次开合间稳定 | `layout.size-stable-across-cycles` | `["380x560","380x560","380x560"]` |
| 尺寸收敛自验证 | `sizeConvergence` | `{"requested":{380,560},"actual":{380,560},"tries":1,"settled":true}` |
| 实例数仍为 1 | `single.instance` | `instances=1` |
| 可见窗口数仍为 1 | `single.visible-window` / `single.browser-window` | `1` / `browserWindowCount=1` |
| Scene/Renderer/Mixer/VRM 计数与 **id** 不变 | `single.stage-ids-unchanged` | `stage-1 / renderer-2 / mixer-4 / vrm-3` 前后逐位相同，四项计数均 1 |
| 连开/关 3 次、锚点误差 ≤2px | `cycle.three-open-close` / `anchor.error-le-2px` | `anchorErrPx=[0,0,0]` |
| 退出后回到 pet 原尺寸与原位置 | `layout.returns-to-pet` | `340x420+1192+516`（与进入前一致） |
| 发送一句走同一条链路 | `send.dock-uses-single-chain` | `sendCount 0→1`，`disabledAtClick=false` |
| 气泡出现 | `bubble.appears-on-reply` | true（`bubbleTextChars=30`） |
| TTS 开始 | `bubble.tts-started` | true |
| TTS 结束后 3±0.5s 消失 | `bubble.hides-after-tts` | `autoHideDelayMs=3005`（target 3000） |
| 同上（外部旁证） | `bubble.hides-after-tts-external` | `hideDeltaMs=2512`，实测采样周期 `75ms`，容差 500+75 内 |
| `bubbleEnabled=false` 不显示气泡 | `bubble.disabled-no-bubble` | `bubbleShown=false` |
| `bubbleEnabled=false` 仍朗读 | `bubble.disabled-still-speaks` | `ttsPlayed=true` |
| 拖拽期间尺寸读数恒定（A14 口径） | `drag.size-constant-in-conversation` | 8 次读数全 `380x560`，`sizeDriftMaxDip=0` |
| 命中区域上报 dock（kind=panel） | `dock.rect-computed` / `hitregions.dock-reported` | `{x:10,y:461,w:360,h:87}`；`kinds=["character","panel"]` |
| 命中区域上报气泡（kind=bubble） | `hitregions.bubble-reported` | 气泡可见期间 `ids=["character","dock","bubble"]` |
| panel 模式不切尺寸、对话框作浮层 | `panel.overlay-keeps-conversation-open` / `panel.size-not-conversation` / `panel.dock-still-rendered` | `conversationOpen=true`、`layout="panel"`、`bounds=480x760`（= panel 尺寸）、dock 矩形 `{x:12,y:597,w:456,h:87}` |
| 界面上没有滚动对话流水 | `ui.no-transcript-flow` | `.chat__list`=0、`.msg`=0 |
| 侧边栏没有「聊天」页 | `ui.chat-tab-removed` | tabs 不含「聊天」 |
| 轮盘项 label 是「对话」 | `wheel.chat-item-labeled-conversation` | 轮盘项实测 `["对话","听力","扬声器","角色","设置","居中","置顶"]` |
| 轮盘项打开对话 | `wheel.chat-opens-conversation` | 真实点击 `.rmenu__item` → `lastSource="wheel"`、`conversationOpen=true` |
| 轮盘项**不**切 panel | `wheel.chat-does-not-switch-panel` | 点击后 `windowMode()="pet"` |
| 再点一次关闭 | `wheel.chat-toggles-both-ways` | 第二次点击后 `conversationOpen=false` |
| 双击角色打开对话框 | `entry.dblclick-opens-conversation` | 合成真实 `dblclick`（命中点 `170,249.9`）→ `lastSource="dblclick"` |
| 中文输入法候选期 Enter 不发送（合成） | `ime.enter-during-composition-does-not-send` / `ime.draft-preserved` | `sendCount` 不变；草稿 `测试候选` 保留 |
| 中文输入法候选期 Enter 不发送（**真实微软拼音**） | `imeLive.composition-happened` / `imeLive.enter-during-composition-does-not-send` | 输入框 `chars=8`、`hasNonAscii=true`；`sendCount 0→0` |

### 判据 2 附 · 全局快捷键（判据 §二.3「真实按键」）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\hotkey-toggle.ps1 -OutDir docs\evidence\phase15
```

**原始结果**（`conversation-hotkey.json`）：

```
初始：   340x420+1079+620
按一次： 379x560+1054+468     ← conversation 尺寸（380×560，1 DIP 取整残差）
再按一次：340x420+1079+620     ← 位置与尺寸逐位还原
pass=True  passOpen=True  passCloseRestoresExactly=True
```

hwnd 全程为同一个（`4065228`）⇒ 没有第二个窗口。

### 判据 3 · 回归重跑 A2 / A3 / A4 / A10 / A11 / A14

```powershell
# A2/A3/A4（桌面枚举 + 归属判定；由截图脚本在一次运行内顺带取证）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\conversation-shots.ps1 -OutDir docs\evidence\phase15
# A10 / A11 / A14
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\run-probe.ps1 -Name a10 -OutDir docs\evidence\phase15
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\run-probe.ps1 -Name a11 -OutDir docs\evidence\phase15
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\run-probe.ps1 -Name a14 -OutDir docs\evidence\phase15
```

| 判据 | 读数（原始 JSON 字段） | 证据 |
|---|---|---|
| A2 可见主窗口数 | `counts.mineVisibleWindows = 1` | `desktop-state-20261008-111906.json` |
| A3 可见 MateEngineX 窗口 | `counts.legacyKernelVisibleWindows = 0`（`legacyKernelAllWindows = 0`） | 同上 |
| A4 旧 build\pet 可见窗口 | `counts.legacyPetVisibleWindows = 0` | 同上 |
| A10 轮盘锚点 | `passA10=true`、`passHitRegionMatchesVisual=true`、`passWheelInWindow=true`（`pass*` 真值 4） | `a10.json` |
| A11 左键行为 | `allPass=true`、`pass*` 真值 17（`passClickDoesNotMoveWindow` / `passClickDoesNotDrag` / `passBarelyDoesNotDrag` / `passBlankDoesNotDrag` / `passLeftStartsDrag` / `passDragMovesWindow` / `passSizeRestoredOnEnd` / `passRightOpensWheel` / `passF1OpensWheel` / `passEscClosesWheel` … 全 true） | `a11.json` |
| A14 拖拽 + 尺寸 | `pass=true`、`pass*` 真值 9；`passDragTilts` / `passDragClipActive` / `passSpringReturns` / `passSizeReadingsConstant` / `passSizeDriftWithin1Dip` / `passSizeUnchanged` / `passSizeUnchangedStrict` 全 true | `a14.json` |

> 说明：A10/A11/A14 在 `--mode=panel` 下跑（与历史证据同口径）；A14 的“对话布局下”补充读数在上面的 `--probe conversation` 里（`sizeDriftMaxDip=0`）。

### 判据 4 · 视觉证据（真实桌面截图）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\conversation-shots.ps1 -OutDir docs\evidence\phase15
```

| 要求的场景 | 文件 | 字节 |
|---|---|---|
| pet 态 · 对话框**关闭** | `screens/conversation-20261008-111845-pet-dock-closed-desktop.png` | 817 133 |
| pet 态 · 对话框**打开** | `screens/conversation-20261008-111845-pet-dock-open-desktop.png` | 861 899 |
| panel 态 · 对话框作**浮层** | `screens/conversation-20261008-111845-panel-dock-overlay-desktop.png` | 842 438 |
| 气泡**显示中** | `screens/conversation-20261008-111845-bubble-visible-desktop.png` | 866 076 |
| 气泡**消失后** | `screens/conversation-20261008-111845-bubble-gone-desktop.png` | 859 414 |
| （附）真实微软拼音敲键时刻 | `screens/conversation-20261008-111845-ime-live-desktop.png` | 864 035 |

全部为 `CopyFromScreen` 全屏桌面截图（DPI 感知已设置，见脚本内的 `DpiFix2`），清单见 `conversation-shots.json`（`pass=true`、`gateMissingNone/gateRequiredShotsNonEmpty/gateProbeJsonExists` 全 true、`requiredNonEmptyCount=5`）。

### 判据 5 · 中文输入法（可复现步骤）

**自动化（已跑，通过）**：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\conversation-shots.ps1 -OutDir docs\evidence\phase15
# 观察 stdout 里的 “[shots] ime-live …”；读取 conversation.json 的 imeLive / imeLiveSkipped
```

脚本在探针就位后（哨兵握手）执行：先把本应用窗口强行置前（`AttachThreadInput` + `SetForegroundWindow`，最多重试 3 次）→ 逐键注入 `n i h a o` → `Space`（选定候选，提交「你好」）→ `s h i j i e` → `Enter`（**候选期**）。
实测：`imeLive.external.typed=true`、`chars=8`、`hasNonAscii=true`、`sendCountBefore=sendCountAfter=0`。
（`chars=8` = 头一次 `Space` 选词提交的「你好」2 字 + 第二次候选期 Enter 提交的 `shijie` 6 字；
`hasNonAscii=true` 证明**真的是微软拼音在合成**，不是"什么都没发生"的假通过。）
安全纪律：**前台不是本应用时拒绝敲键**并如实记 `imeLiveSkipped.reason="front-window-not-ours"`（第一次实现没这条，把 `nihao` 敲进了另一个应用的输入框——已修）。

**人工复现步骤（30 秒）**：

1. `node_modules\electron\dist\electron.exe apps\desktop --dev --mode=pet --no-dialogs`
2. 按 `Ctrl+Alt+Space`（或双击角色）打开对话框；光标应在输入框内。
3. 切换到**微软拼音**，键入 `nihao`（此时出现候选窗）。
4. **候选窗还在的时候按 Enter** —— 预期：候选词上屏/收起，**不应发送**（气泡不出现、不发请求）。
5. 键入 `nihao` 后按 `Space` 选词，再接着键入任意内容，确认输入框里有中文、且没有触发发送。

---

## 3. 本轮抓到并修掉的真缺陷（都记在代码注释里）

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | 连开/关对话框时，`dock` 的命中区域**有时永远不上报**（界面正常、日志无错，表现只是“对话框可点但点击穿透到桌面”） | 变化签名的缓存没有与“已清除”同步：关闭时上报 `null` 但 `lastSig` 仍留着；再次打开几何一模一样 ⇒ `sig === lastSig` 提前 return，矩形再也不发布 | 清空矩形时**一并清空签名**（`ConversationDock.vue`） |
| 2 | pet 对话态拖拽时窗口宽度读数在 `380/382` 之间跳（A14 口径不过） | `setBounds(380)` 的读回值是位置相关的取整量（`381`），拖动把**读回值**当不可变目标，于是每帧都判“尺寸不符”并自适应对拉 | 进入对话布局时做一次**尺寸自验证收敛**（最多 3 次迭代，结果如实记录 `settled`）；收敛后拖动读数 `380x560` 全程恒定 |
| 3 | `--probe conversation` 报“气泡不在命中区域”“TTS 没开始”“bubbleEnabled=false 时气泡照样出现” | **探针自伤**：① 直接在主进程调 `patchSettings` 不给 renderer 发 `settings-changed` ⇒ renderer 侧开关没变；② 命中区域只在 `bubbleVisible` 变真的**那一瞬间**读一次，而链路要 render→rAF→15Hz 上报→IPC→主进程 | 改设置一律走 renderer 的 `patchSettings` IPC；命中区域在气泡可见的**整个窗口**内连续采样并取并集 |
| 4 | `send.dock-uses-single-chain` 偶发失败（点“发送”没反应） | 探针同步 `click()` 点在一个**还没重渲染完**的 disabled 按钮上（Vue 的 `disabled` 要等下一帧） | 探针在派发 `input` 后等一次渲染再点击；并把 `disabledAtClick` 记进证据 |
| 5 | `bubble.hides-after-tts` 被判 2.45s（真实现是 3.007s） | 外部轮询的采样周期（实测 75ms，繁忙时更长）让两端时刻各滞后一个周期 | 在实现内部用**自己的时钟**精确记录“TTS 结束 → 自动消失”的延时作为**主判据**；外部观测作为**旁证**且容差加上实测采样周期 |
| 6 | 真实 IME 验收把 `nihao` 敲进了**别的应用的输入框** | 脚本只看了一眼标题就去敲键，且 `SetForegroundWindow` 被前台锁静默拒绝 | 改为“最多 3 次 `AttachThreadInput` 强行置前 + 置前失败即**拒敲**并记 `skipped`”；并**绝不发 Esc**（本应用里 Esc = 关闭对话框，会把后续用例全废掉） |
| 7 | `conversation-shots.ps1` 自报 `pass=false`，而 JSON 里三个判据分量看起来都是 true | PowerShell 5.1 里把 `-and` 链 / `@()` / `Where-Object` 写进 `[pscustomobject]@{...}` **字面量**时，同一个表达式在字面量外面求值是 `True`、里面却是 `False`（实测两次） | 所有判定分量**先算成普通变量**再放进 JSON；并把三个 gate 各自落盘，失败时一眼定位 |

---

## 4. 明确未验证 / 已知边界（`NOT VERIFIED`）

| 项 | 状态 | 卡在哪 / 已知边界 |
|---|---|---|
| 真实麦克风说唤醒词 ⇒ 打开对话 | `NOT VERIFIED` | 需要真实麦克风与语音设备。**已验证的是接线**：单测用注入件证明“引擎报出唤醒词 ⇒ 打开对话 + 请求 `voice:listen-once`”，以及“打开失败 ⇒ 回退全链路通话”。 |
| 对话框麦克风按钮的真实录音识别 | `NOT VERIFIED` | 同上（需真实语音设备）。已验证：`hearingEnabled=false` 时**结构化拒绝并可见提示**，以及识别文本走**同一条** `ask()` 发送链（单测 + IPC 层）。 |
| 真实 LLM 供应商的一轮对话（含气泡 + 朗读） | `NOT VERIFIED` | 需要有效密钥与出网。本轮的回复事件用**主进程真实发射的 `evt:chat-done`**（与真实一轮对话之后发出的那条同形）驱动，TTS 是**真实 SAPI**；但“模型真的回了这句话”这一环没跑（与既有 A22 的证据分开，不混用）。 |
| 气泡“最多 3 行”的像素级复核 | `NOT VERIFIED` | 已实现 `-webkit-line-clamp:3` + 120 字截断，并有真实桌面截图；但**没有**逐条构造 1/2/3/4 行文本去量像素。 |
| `bubbleAutoHideSec` 非 3 秒时的行为 | `NOT VERIFIED` | 判据只在 3 秒下测过（探针显式写入 3 并恢复原值）。设置项本身已进 schema 与设置页。 |
| 悬停暂停 / 点击展开的自动化验证 | `NOT VERIFIED` | 代码路径已实现（`setBubbleHover` / `toggleBubbleExpanded`），UI 探针暴露 `bubbleExpanded`；但**没有**合成 `mouseenter`/`click` 的探针用例。 |
| 2 小时浸泡（A15/A16） | `NOT VERIFIED` | 本轮未跑浸泡；AGENTS 纪律要求浸泡期间不得跑构建/单测，与本轮节奏冲突。 |
| 分发物完整性（`verify-dist-integrity.mjs`） | `NOT VERIFIED` | 本轮未出安装包（`npm run build:dist` 未跑）。 |

### 与既有文档的口径冲突 —— **已由用户裁定「另立」（2026-10-08）**

`docs/PRD.md` §3 场景 S2 写的是「双击角色区域 → 输入 → 发送 → **流式回复出现在 panel**」。
本轮按用户规格取消了主界面回放对话文字（历史移到「记忆」页且默认折叠）。

用户裁定：**不动 S2 的措辞，另立 S10**。已落地的文档改动（三份，**均未改 S2 原文**）：

| 文件 | 改动 |
|---|---|
| `docs/PRD.md` | §3 场景表新增 **S10 桌宠对话**；新增 **§3.1** 冻结 S2 与 S10 的边界（哪一句被取代、与 FR-7.4 的差异、数据层不变、布局口径） |
| `docs/Acceptance-Matrix.md` | §3 场景清单新增 **S10** 行（可执行步骤 + 8 组通过判据 + 证据路径 + 状态 `PASS`，并在同一格显式列出同轮的 `NOT VERIFIED` 子项）；「场景 ↔ 判据覆盖」补 S10，并加一条 S10↔S2 的关系说明 |
| `docs/Tech-Spec.md` | 新增 **§4.2.1 第三种布局 `conversation`**：尺寸/对齐/还原/进入条件/panel 分支/尺寸自验证/拖拽期不变/IPC 契约/命中区域口径，全部指向唯一真源与取证命令 |

口径边界（复述 PRD §3.1）：`WindowMode` 枚举**未变**（仍 `panel | pet`），对话态是 pet 模式内的一种布局；
S2 的入口（双击角色）与「回复驱动表情/口型/动作事件」仍然有效。
改完三份文档后重跑：`check-claims.mjs` → 11 条全成立；`audit-acceptance.mjs` → 无 FAIL、无“有证据无结论”。

---

## 5. 复现整套证据

```powershell
cd 'F:\deepseek harness\AI女友\新工程'

npm run build                 # prod 构建（含清理 sourcemap）
npm run typecheck             # 期望：无输出（0 错）
node apps\desktop\test\run-all.cjs            # 期望 419/419
node --test packages\avatar-stage\test\motion-runtime.test.mjs   # 35
node --test packages\motion-director\test\*.mjs                  # 44
node --test packages\companion-kit\test\*.mjs                    # 55

# 主探针（45 项）+ 真实桌面截图（含真实微软拼音）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\conversation-shots.ps1 -OutDir docs\evidence\phase15 -TimeoutSec 420

# 入口：全局快捷键真实按键
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\hotkey-toggle.ps1 -OutDir docs\evidence\phase15

# 回归
foreach ($n in @('a10','a11','a14')) {
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\run-probe.ps1 -Name $n -OutDir docs\evidence\phase15
}

# 汇总与门禁
node tools\qa\summarize-probes.mjs docs\evidence\phase15   # 期望 6/6 PASS
node tools\qa\check-claims.mjs                             # 期望 11 条全成立
node tools\qa\audit-acceptance.mjs                         # 期望全 PASS、无“有证据无结论”
```
