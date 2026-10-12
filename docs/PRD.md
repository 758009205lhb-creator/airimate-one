# PRD · AiriMate One

| 字段 | 值 |
|---|---|
| 项目代号 | **AiriMate One** |
| 产品定位 | 一个 Windows 桌面 AI 女友/桌宠软件：AIRI 的对话智能体内核 + Mate 的 VRM 角色与动捕动作 |
| 文档版本 | v1.0（阶段 0 冻结） |
| 权威等级 | 本文件与 `Tech-Spec.md`、`API-Contract.md`、`Acceptance-Matrix.md` 是**唯一实现依据**；与 `F:\deepseek harness\AI女友\文档\*` 旧文档冲突时以本套为准 |
| 作废声明 | 旧文档中一切「AIRI 窗口与 MateEngineX 窗口对齐/并存/半透明叠底」的要求**一律作废** |

---

## 1. 一句话硬口径

> **一个软件实例、一个可见角色、一个轮盘、一个动画状态机；恰好两个 `BrowserWindow`（角色 + 独立对话窗口），默认只显示对话窗口。**
>
> ⚠ 「恰好两个窗口」是**创建上限**，不是"同时可见"的要求：2026-10-09 完善轮起，
> 默认启动**只显示对话窗口**（`petResident=false` + `startupOpenChat=true`，见 FR-1b）。
> 两个窗口**都已创建**，只是桌宠默认不显示。

展开为六条不可协商的约束：

1. 只有一个应用实例（进程组内只允许一个 Electron 应用根进程 + 其必需的 Chromium 辅助进程）。
2. ★ **恰好两个 `BrowserWindow`**：pet/panel（角色）与 chat（对话）。**只有 pet 窗口渲染角色**（角色可见窗口数 = 1）；chat 窗口内 `WebGL canvas = 0`、`Scene/Renderer/Mixer/VRM` 计数全为 0。**不许开第三个窗口**。
   > ⚠ 2026-10-08 返工轮改写。原第 2 条是「只有一个可见主窗口（一个 `BrowserWindow`）」——
   > 那条约束把聊天逼进了桌宠窗口（贴底 dock + 把窗口从 340×420 放大到 380×560），
   > 而用户明确否决该形态。**Chromium 渲染进程数变成 2 是允许的**（Electron 每窗一个 renderer）。
   > 口径全文与取证见 `Acceptance-Matrix.md` §0.5 / §2.4。
   > ⚠ 2026-10-09 完善轮**再补一句**：可见窗口数**不再恒为 1 或 2** ——
   > 默认启动时可见窗口 = 1（只有对话窗口），勾选「桌宠常驻」或呼出桌宠后才是 2。
   > 判据改为"**按身份**计数"（`characterVisibleWindowCount = 1`、
   > `chatVisibleWindowCount ≤ 1`，且**两者都存在**），见 `Acceptance-Matrix.md` §2.5。
3. 屏幕上只有一个可见角色实例（一个 VRM、一个 Three.js Scene、一个 `WebGLRenderer`、一个 `AnimationMixer`）。
4. 只有一个径向轮盘（同一份 DOM/绘制实例，随角色锚点移动）。
5. 只有一个动画状态机（`MotionDirector` 是唯一的动作决策者）。
6. AIRI 自带 Live2D **实例数 = 0**；`MateEngineX.exe` **可见窗口数 = 0**；旧 `build\pet` **可见窗口数 = 0**。

---

## 2. 目标与非目标

### 2.1 目标

| ID | 目标 | 可验证的完成定义 |
|---|---|---|
| G1 | 保留 AIRI 的聊天、人设、记忆、TTS、供应商设置与智能体能力 | 能在新应用内完成：录入供应商密钥 → 选择模型 → 设定人设 → 多轮对话 → 记忆写入与召回 → TTS 朗读；全部在新 renderer 内完成，无 AIRI 安装目录参与运行 |
| G2 | 角色视觉使用 Mate 的 VRM，不使用 AIRI 自带 Live2D | 运行时 `Live2D 实例数 = 0`；加载的 VRM 为 `Lazuli_VRM.vrm` |
| G3 | 动作来自 Mate 真实动捕 `.anim` 转换的 VRMA | ≥10 个待机动作来自 `PET_IDLE*` 转换产物；拖拽使用 `PET_DRAGGING` 转换产物；每个动作有 manifest 与骨骼活动量证据 |
| G4 | Mate 风格的轮盘交互 | 右键开合、F1 开合、左键**仅**在「按住 + 移动 > 4 CSS px 且命中角色」时拖窗口（短按/空白处不动）、从头部锚点 `scale 0→1` 径向弹出、rAF 驱动 |
| G5 | panel / pet 双布局同窗切换 | 切换不新建窗口、不新建 renderer、不重载角色 |
| G6 | 单实例与旧实例治理 | 第二次启动只唤起聚焦；启动前检测旧实例并阻断；开机启动项迁移为唯一一项 |
| G7 | 安全合规 | 密钥零落盘明文、IPC 白名单、CSP `self`、自定义协议路径校验、日志脱敏 |

### 2.2 非目标（本轮明确不做）

- 不做多角色/多模型同屏。不做 Live2D 回退路径。
- 不做 Android / Web / 移动端。桌面仅 Windows 10/11 x64。
- 不做云端账号体系、不做联网分发商店、不做自动更新（离线交付）。
- 不把 Mate 的 C# 源码或 UI 资产复制进本工程。
- 不追求"对齐 Mate 官方安装目录"，官方目录只读且不参与运行。

---

## 3. 用户场景（验收即场景）

| 场景 | 步骤 | 通过判据 |
|---|---|---|
| S1 首次配置 | 启动 → 设置 → 填供应商 baseURL/密钥/模型 → 保存 | 密钥不出现在任何文件/日志/命令行；`safeStorage` 密文落盘 |
| S2 日常对话 | 双击角色区域 → 输入 → 发送 | 流式回复出现在 panel；回复驱动表情/口型/动作事件 |
| S3 桌宠形态 | 切到 pet 模式 | 同窗口变透明无边框紧凑形态；角色未重载（mixer/clip 计数不变） |
| S4 轮盘 | 右键角色 → 轮盘开 → 右键或 Esc → 关 → 再右键 | 三次锚点位置误差 ≤ 2px；左键点角色**不**开轮盘，只拖拽 |
| S5 拖拽 | 左键按住角色拖动 → 松手 | 窗口跟随位移；`PET_DRAGGING` 生效；松手后按弹簧参数回正；窗口尺寸不变 |
| S6 待机 | 静置观察 | ≥10 个待机动作轮换，切换间隔 12s、交叉淡化 3s；全程无 T-pose |
| S7 第二次启动 | 应用运行中再次双击快捷方式 | 实例数仍为 1、可见窗口仍为 1、角色仍为 1，且已有窗口被聚焦 |
| S8 旧实例阻断 | 手工启动 `MateEngineX.exe` 后再启动本应用 | 出现可操作提示，**不静默继续**；不自动杀进程 |
| S9 开机 | 重启电脑 | 只出现本应用（若启用自启）；旧桌宠不自启 |
| **S10 桌宠对话**（2026-10-08 另立，见 §3.1） | 双击角色区域（或轮盘「对话」项 / 托盘「开始对话」/ `Ctrl+Alt+Space` / 语音唤醒词）→ 打开对话框 → 打字或说话 → 发送 | 对话框贴在角色下方且**不切窗口模式**；回复**以语音朗读为主**并在头顶显示短暂气泡（朗读结束 + `bubbleAutoHideSec` 秒自动消失）；主界面**不回放**对话文字流水；历史仍写入 session-store / 记忆，「记忆」页默认折叠可查；全程窗口/Scene/Renderer/Mixer/VRM 计数不变 |

### 3.1 S10 的口径（2026-10-08 用户裁定「另立」，S2 原文保留不变）

用户 2026-10-08 裁定：**不动 S2 的措辞，另立 S10**。两条场景的关系与边界：

| 项 | 口径 |
|---|---|
| S2 仍然有效 | 「双击角色区域 → 输入 → 发送」这条**入口**与「回复驱动表情/口型/动作事件」这条**判据**继续有效（本轮实测 `lastSource="dblclick"`、动作事件链未改） |
| S2 中被取代的一句 | 「流式回复出现在 **panel**」——本轮起，回复**不再以面板文字流水的形式呈现**，改为「语音朗读 + 头顶气泡」。以 S10 为准 |
| 与 FR-7.4 的差异 | 轮盘第 1 项的名称由「聊天」改为「**对话**」（`WHEEL_SPEC.items` 的 `id` 仍是 `chat`，**契约不变**），行为由 `setMode('panel')` 改为**显示并聚焦独立的对话窗口**。以 S10 为准 |
| 数据层不变 | 会话历史、记忆写入、召回注入**一条都没删**；变的只是**主界面不再回放**这些文字，查看入口收进「记忆」页且**默认折叠** |
| 布局（**2026-10-08 再次改写**） | 仍是 `panel` / `pet` **两种模式**（`WindowMode` 枚举未变）；但对话**不再是窗口内的布局**：<br>⛔ 旧表述「对话态是 pet 模式内的一种布局（`WINDOW_GEOMETRY.conversation = 380×560`），panel 模式下对话框只是舞台浮层」**已作废** —— `WINDOW_GEOMETRY.conversation` 已删除，「打开对话就放大 pet 窗口」的逻辑也删除了。<br>✅ 现行：对话是**第二个独立 `BrowserWindow`**（`720×560`，最小 `560×420`，见 `WINDOW_GEOMETRY.chat`/`chatMin`），pet 窗口恒为 `340×420` 且**不被对话开合改动任何属性** |
| 入口语义（**2026-10-08 定稿，取代"开/关切换"**） | 五条入口（轮盘「对话」/ 托盘「开始对话」/ `Ctrl+Alt+Space` / 双击角色 / 语音唤醒）**语义完全一致 = 显示并聚焦，再次触发只聚焦、绝不隐藏**；隐藏只走 chat 的「×」/ `Esc` / 托盘「结束对话」。判据见 `Acceptance-Matrix.md` §0.5.4 |

**取证**：三条命令 + 原始产物见 `docs/evidence/phase15/CONVERSATION-ROUND.md`；
逐条读数见 `docs/evidence/phase15/conversation.json`（45/45）、`conversation-hotkey.json`、`conversation-shots.json`。

---

## 4. 功能需求

### FR-1 窗口与生命周期

- FR-1.1 ★ **应用恰好创建两个 `BrowserWindow`**（**2026-10-08 改写**，原文是"只创建一个"）：
  · **pet/panel（角色）** —— `apps/desktop/src/main/window-manager.ts` 的 `createMainWindow()`；
  · **chat（对话）** —— `apps/desktop/src/main/chat-window.ts` 的 `ensureChatWindow()`。
  两个创建点是**仅有的两处** `new BrowserWindow()` 调用；**第三个窗口是禁止项**。
  两个窗口共用同一份 renderer 构建，靠 `?surface=chat` 区分界面（`main.ts` 用动态 import 分派，
  从结构上保证 chat 窗口的模块图里没有 `three` / `VRM` / `AvatarStage`）。
  安全装配只有一份（`window-security.ts` 的 `applyWindowSecurity()`），两个窗口共同调用。
- FR-1.2 支持两种布局模式：`panel`（默认，含聊天/设置/记忆 + 角色舞台）、`pet`（透明、无边框、`alwaysOnTop`、紧凑）。
- FR-1.3 模式切换只改窗口属性与 renderer 侧布局状态，**不重建窗口、不重建 Scene、不重载 VRM**。
- FR-1.4 关闭按钮默认 `hide()`，不退出；托盘菜单提供：桌宠呼出/收回/常驻、开始/结束对话、打开管理面板、记忆、日程与提醒、面板/桌宠模式、恢复默认位置、窗口置顶、偏好设置、语音与麦克风、快捷键一览、关于、开机自启开关、退出。
- FR-1.5 真实退出只能由托盘"退出"、桌宠右键菜单"退出应用"或对话窗口菜单「文件 → 退出应用」触发（`app.isQuitting` 门闩），退出时释放互斥量、锁文件、托盘。
- FR-1.6 pet 模式下窗口尺寸固定（拖拽期间不得变化），位置由拖拽驱动。

### FR-1b ★★ 桌宠常驻与启动行为（**2026-10-09 完善轮新增**）

> **这一节取代了旧行为「打开软件就自动出现桌宠」** —— 那条行为**不再存在**
> （没有任何开关能把"启动只出现桌宠"之外的形态单独恢复成旧观感；
> 要恢复旧观感请设 `petResident=true` + `startupOpenChat=false`）。

- FR-1b.1 **`petResident`（桌宠是否常驻），默认 `false`**。
  · `false`（默认）：应用启动（含开机自启）**不显示桌宠窗口**；桌宠只在被"呼出"时出现。
  · `true`：应用启动即显示桌宠并保持（= 2026-10-08 之前那一版的行为）。
  ⚠ 它**只决定"启动时显示不显示"**，与"现在可见不可见"是两件事（见 FR-1b.4）。
- FR-1b.2 **`startupOpenChat`（启动时是否打开对话窗口），默认 `true`**。
- FR-1b.3 组合效果（**这就是用户要的那条**）：

  | `petResident` | `startupOpenChat` | 启动后看到什么 |
  |---|---|---|
  | `false`（默认） | `true`（默认） | **只有对话窗口**，没有桌宠 ← 新默认行为 |
  | `true` | `true` | 对话窗口 + 桌宠 |
  | `false` | `false` | 什么都没有，**只留托盘图标** |
  | `true` | `false` | 只有桌宠（= 旧行为） |

  「什么都没有、只留托盘」是**合法状态而不是缺陷**：托盘菜单里随时能「显示桌宠」或「开始对话」。
- FR-1b.4 **「常驻」与「可见」是两个概念，必须分开**：
  · 「收回桌宠」**只改可见性**，**不写** `petResident` ——
    用户点"收回"的意思是"我现在先不想看见她"，不是"以后都别出现了"；
  · 「取消常驻」**两件事都做**（写 `petResident=false` **并**收回窗口）；
  · 「呼出桌宠」**不改** `petResident`（呼出不该有持久副作用）。
- FR-1b.5 **三处菜单入口都要有，且状态实时同步**：对话窗口菜单栏 → 桌宠、
  托盘右键、桌宠自身右键。唯一真源在主进程（`pet-visibility.ts` 的 `petMenuState()`），
  三处读**同一份快照**（`ConversationState.pet` / `evt:pet-menu-state`）。
- FR-1b.6 切换「桌宠常驻」要**立即生效并落盘**（`flushSettings()`，不等 800ms 防抖）：
  勾上 ⇒ 显示桌宠 + 写设置；取消 ⇒ 隐藏桌宠 + 写设置；**重启后按新值执行**。
- FR-1b.7 桌宠被收回时，**命中区域上报与轮盘/气泡状态必须回到"未显示"的干净态**
  （否则会出现"看不见的窗口还在吃桌面点击"，而它不会报任何错）。

### FR-2 单实例

- FR-2.1 `app.requestSingleInstanceLock()`；第二实例把 `{type:'show-and-focus'}` 发给第一实例后 `app.exit(0)`。
- FR-2.2 Windows 命名互斥量 `Local\AiriMateOne.Singleton`（`CreateMutexW` + `ERROR_ALREADY_EXISTS` 判定）。
- FR-2.3 用户级运行锁文件 `%LOCALAPPDATA%\AiriMateOne\run\instance.lock`，JSON 含 `appId/pid/startedAt/heartbeatAt/version/windowMode`，心跳 5s；判定规则见 Tech-Spec §5。
- FR-2.4 三层任一判定"已有实例"即走唤醒路径；三层结论冲突时按 `app.requestSingleInstanceLock` > 互斥量 > 锁文件 的顺序裁决，并记录诊断。

### FR-3 旧实例与开机项治理

- FR-3.1 启动前检测（只读）：`MateEngineX.exe`、旧 `build\pet` Electron 实例、`start-airi-brain.ps1` 相关入口、旧 AIRI+桥组合。
- FR-3.2 归属判定只允许依据**完整路径前缀、SHA256、项目标记文件、数字签名**；禁止只凭进程名判定。
- FR-3.3 检测到"会显示角色或轮盘"的旧实例时，显示阻断对话框并提供：查看详情 / 打开任务管理器 / 我已知晓并退出。**不自动杀进程**。
- FR-3.4 开机项：备份 `HKCU\...\Run`、启动文件夹、计划任务中指向旧入口的项；合并为本应用**唯一一个**启动项；卸载器恢复或删除自有启动项，且不得留下旧桌宠自启。

### FR-4 AI 会话内核

- FR-4.1 供应商：OpenAI 兼容端点（可配 baseURL / apiKey / model），内置 DeepSeek、OpenAI、Anthropic（经兼容层）、Ollama、自建兼容端点的预设。
- FR-4.2 流式回复；支持中断（stop）。
- FR-4.3 人设：系统提示词 + 角色卡（名字、性格、说话风格、初始好感度等结构化字段）。
- FR-4.4 记忆：会话历史持久化 + 长期记忆条目（可增删改查），召回注入到上下文；存储为本机 SQLite（`better-sqlite3`）或 JSON 文档库，二选一在 Tech-Spec 冻结。
- FR-4.5 TTS：本地引擎（Windows SAPI / Edge TTS 之一）为默认，云端供应商可选；TTS 音频驱动口型叠加层。
- FR-4.6 智能体能力：工具调用框架（时间、天气可留桩、打开轮盘命令等本地工具），工具调用必须经类型校验与超时。
- FR-4.7 单一数据流（见 §6）：所有动作/表情/口型/可见性/窗口模式变化只由会话层产出的统一命令驱动。

### FR-5 角色舞台

- FR-5.1 加载 `Lazuli_VRM.vrm`（路径来自配置，指向本机 Mate-Engine 仓库，**不进分发包**）。
- FR-5.2 一个 `THREE.Scene`、一个 `WebGLRenderer`、一个 `AnimationMixer`、一个 `VRM` 实例（`packages/avatar-stage` 内集中创建并暴露只读计数用于验收探针）。
- FR-5.3 表情（BlendShape/Expression）、视线（lookAt 头部/眼骨）、眨眼（自动+手动）、口型（viseme/口型权重）作为**叠加层**，不得覆盖身体主动作。
- FR-5.4 材质使用 MToon；`springBone` 物理开启；渲染循环由 `requestAnimationFrame` 驱动，固定顺序 `mixer.update(dt)` → 叠加层 → `vrm.update(dt)` → `renderer.render`。
- FR-5.5 模型缺失/加载失败时显示可见告警位（不静默空白，不退回 T-pose）。

### FR-6 动作系统（MotionDirector）

- FR-6.1 唯一动作决策者；优先级：拖拽 > 一次性动作 > 状态动作（行走/坐下/睡眠） > 待机轮换。
- FR-6.2 待机：≥10 个动作，12s 切换、3s 交叉淡化，动作来源为 `PET_IDLE*` 转换产物。
- FR-6.3 加载完成后立即进入第一个待机动作；任何采样时刻都必须存在活动的基础动作（禁止 T-pose 窗口）。
- FR-6.4 拖拽：使用 `PET_DRAGGING` 转换动作 + 窗口位移驱动的指数滤波与弹簧（`springFrequency=2.6`、`dampingRatio=0.35`、`maxLeanZ=25°`、`maxLeanX=12°`）；松手自然回正（非瞬时吸附）。
- FR-6.5 一次性动作：播放完毕回到此前状态；可被打断。
- FR-6.6 动作加载失败必须显示可见告警，**不得静默退回静止**。
- FR-6.7 每个动作必须有 manifest：名称、时长、是否循环、根位移、腿部活动量、允许的叠加层。

### FR-7 径向轮盘

- FR-7.1 触发：右键单击角色开/关切换；`F1` 开/关切换；左键**仅**用于拖拽，且必须满足
  「按住 + 移动 > 4 CSS px **且按下点命中角色**」——短按、阈值内位移、空白处按下都**不得**移动窗口
  （判据 A11，2026-09-27 按用户规格重写；旧表述"按下即拖拽"是缺陷而非规格）。
- FR-7.2 锚点：由**固定舞台锚点**（画布 50% / 92%）推出的稳定包围盒；**不得**用会随动作漂移的
  动态蒙皮包围盒（否则"开→关→开误差 ≤2px"必然不过）。
- FR-7.3 动效：`scale` 从 0 弹出到 1，每帧 `lerp(current, target, 0.2)`，关闭反向缩小；**禁止** CSS transition / 淡入淡出替代。
- FR-7.4 选项：聊天、听力、扬声器、角色、设置、居中、置顶、~~休眠~~。
  ⚠ 「休眠」于 2026-09-27 **临时摘除**（用户方案 C）：该动作的根位移在 three-vrm 逐 clip 放大后
  是荒谬值（y 4.53 m / z 10.30 m），钉死后会呈现"站姿抱臂"这一明显错误的姿态。
  恢复前提是资产侧重新导出该 `.anim`（归一化 `RootT`）；步骤见 `DISABLED_MOTION_SEMANTICS` 注释。
- FR-7.5 视觉：独立设计（不复用 Mate 图标与美术资产），风格与产品自洽。
- FR-7.6 交互：悬停高亮；点击后关闭轮盘并执行；键盘方向键切换、Enter 执行、Esc 关闭。
- FR-7.7 命中测试与视觉一致；透明区域不得吞掉桌面点击（pet 模式下 `setIgnoreMouseEvents` 动态开关策略见 Tech-Spec）。

### FR-8 安全

见 `Tech-Spec.md` §8；要点：`contextIsolation:true`、`nodeIntegration:false`、`sandbox:true`、`webSecurity:true`、CSP `default-src 'self'`、preload 白名单 IPC、禁 `remote`/`eval`/`new Function`、密钥进 `safeStorage`/Credential Manager、自定义协议路径 canonicalize 且拒绝 `..` 与 symlink 逃逸、仅环回随机端口 + 一次性 token、日志脱敏、分发前密钥扫描。

---

## 5. 量化验收判据（摘要，逐条方法见 Acceptance-Matrix）

| # | 判据 | 目标 |
|---|---|---|
| A1 | 新软件应用实例数 | = 1 |
| A2 | 可见主窗口数 | = 1 |
| A3 | 可见 `MateEngineX` 窗口数 | = 0 |
| A4 | 旧 `build\pet` 可见窗口数 | = 0 |
| A5 | 可见 VRM 实例数 | = 1 |
| A6 | 可见 Live2D 实例数 | = 0 |
| A7 | `WebGLRenderer` 数 | = 1 |
| A8 | `AnimationMixer` 数 | = 1 |
| A9 | 第二次启动后窗口数/角色数 | 不变 |
| A10 | 轮盘开→关→开锚点误差 | ≤ 2px |
| A11 | 左键行为 | 只拖拽，不开轮盘 |
| A12 | 任意 5s 采样腿部骨骼运动 | 有运动（非仅上半身） |
| A13 | 待机动作数量 / 轮换 / 交叉淡化 | ≥10 / 12s / 3s |
| A14 | 拖拽期 `PET_DRAGGING` + 松手弹簧回正 | 生效且回正 |
| A15 | 连续运行 2h | 无 T-pose、无第二角色、无进程失控 |
| A16 | 空闲平均帧率 / 内存 | ≥50fps、无持续增长 |
| A17 | 日志/分发物/命令行云密钥命中 | = 0 |
| A18 | 非环回监听端口 | = 0 |
| A19 | 安装/卸载/重启后旧桌宠自启 | = 0 次 |
| A20 | 视觉验收 | 必须含真实桌面截图 |

---

## 6. 唯一数据流（冻结）

```
用户输入 ──► AIRI 会话层（`apps/desktop/src/main`：session-store / memory-store / tts / provider-store）
                 │  产出：回复文本 + 动作事件（统一命令）
                 ▼
        EmotionCommand / MotionCommand / SpeechCommand /
        VisibilityCommand / WindowModeCommand   （类型 + 运行时校验）
                 ▼
             MotionDirector（唯一动作决策者）
                 ▼
              AvatarStage（唯一 Scene/Renderer/Mixer/VRM）
```

- 禁止在 DOM 层再解析一次动作标记；禁止双驱动。
- 所有跨进程消息（main ↔ renderer）必须经 `packages/shared` 的类型 + 运行时校验（zod/valibot），校验失败即拒绝并记日志（脱敏）。

---

## 7. 技术约束与前提

| ID | 约束 | 影响 |
|---|---|---|
| C1 | GitHub 及其全部镜像不可达；仅 `registry.npmmirror.com` 与 gitee 可达 | 依赖一律走 npmmirror；无法从上游拉 AIRI 源码（见 §8） |
| C2 | 无 PowerShell 7，交付脚本一律 5.1 语法 | 所有 `.ps1` 禁止 `??`、三目、`-Parallel` 等 |
| C3 | `F:\AIRI` 与 Mate 官方安装目录逐字节只读 | 不允许 asar 重打包、不允许安装目录注入 |
| C4 | MateEngine Pro License v2.1 的 copyleft 与"禁止商业/二进制平台分发"条款 | 本轮为**私有使用**（§1 授权）；一旦公开分发必须重新评审 |
| C5 | DLC VRM 与 `.anim` 属上游美术/动捕资产，目录内**无**独立许可文件 | **不得进入分发包**；只做本机路径引用 + 缺失告警 |
| C6 | Electron 44.4.5 已在本机 `node_modules` | 可直接离线复用，无需下载 |

---

## 8. 阻塞项与决定点

### BLOCKER-1 · AIRI 源码无法固定到明确 tag/commit —— **已由用户裁定为路线 A（2026-09-27）**

- **事实**：许可证已确认 MIT（`app.asar` 内 `package.json` 实测 `"license": "MIT"`，仓库 `github.com/moeru-ai/airi`，版本 `0.12.0-beta.5`）；
  但 GitHub 与全部镜像不可达、本机无源码 checkout、asar 内无 git 元数据、AIRI 核心包以 `workspace:` 声明且未发布到 npm。
- **裁定**：用户选择 **A —— 接受能力等价实现**（用 AIRI 同源且已发布的 MIT 依赖：
  `@xsai/stream-text`、`@xsai-ext/providers`、`unspeech`、`@proj-airi/ui`、`@proj-airi/server-sdk`）。
  裁定记录（含用户原话）：`docs/evidence/phase2/P2-blocker.json`。
- **口径约束（不得放宽）**：交付物在**能力**上与 AIRI 对齐（聊天 / 人设 / 记忆 / TTS / 供应商），
  但**不是 AIRI 源代码本身** ⇒ **不得声称或暗示"源级集成"**。
- **未违反禁止项**：本轮未修改 / 未重打包 `F:\AIRI`。
- **状态**：`RESOLVED-A`（**阻塞关闭**）。
  环境变化时（GitHub 可达 / 拿到离线源码包）可另起一轮升级为真正的源级集成，届时需要新的实现与验收证据。
- **升级路径**：三选一中的 B / C 仍然有效 —— B 用户提供离线源码包；C 用户提供可达 GitHub 的网络出口。
  详见 `docs/evidence/E0-recon-baseline.md` §2.3。

### LICENSE-RISK-1 · Mate 资产与许可证

- 本轮为私有使用（License §1 明文允许 use/study/modify privately），**不公开分发**；
  分发物不含 `.anim`、不含 DLC VRM、不含 MateEngine 源码。公开分发前必须重新评审 §2/§3 条款。

### RISK-1 · 明文密钥历史遗留

- 旧工程根存在 `.airi-upstream.env` 明文密钥（见 `E0-recon-baseline.md` §4.1）。
- 处置：新工程不读取该文件；迁移向导提示用户**吊销并重新录入**；分发前扫描确保命中数 0。

---

## 9. 交付物清单

| 类别 | 内容 |
|---|---|
| 应用 | `apps/desktop`（Electron 主进程/托盘/单实例/安全策略）、`apps/renderer`（Vue 3 + Pinia + TS） |
| 包 | `packages/avatar-stage`、`packages/motion-director`、`packages/radial-menu`、`packages/companion-kit`、`packages/security`、`packages/shared` |
| 资产管线 | `tools/motion-lab/*`（`.anim`→`.vrma` 转换 + 独立校验 + 加载验证 + 骨骼活动量度量 + 截图证据） |
| 动作资产 | `assets/motion/*.vrma` + `assets/motion/manifests/*.json`（本地，不分发） |
| 文档 | `PRD.md`、`Tech-Spec.md`、`API-Contract.md`、`Migration-Plan.md`、`Acceptance-Matrix.md`、`docs/evidence/*` |
| 安装 | 安装包 + 卸载器 + 回滚说明（阶段 7） |

---

## 10. 里程碑门禁

| 阶段 | 门禁（不通过不进下一阶段） |
|---|---|
| 0 | 五份文档齐备 + BLOCKER 已陈述（本文件 + 三份配套 + 验收矩阵） |
| 1 | 第二次启动不产生第二窗口（有命令与原始输出） |
| 2 | 依赖用户对 BLOCKER-1 的裁定 ⇒ **已裁定为 A**（2026-09-27，见 §8）；按选项 A 以接口契约冻结 |
| 3 | 一个 Scene/Renderer/Mixer/VRM 的实时计数证据 + 截图 |
| 4 | `PET_POSE_1` 定格姿势视觉验收通过后才允许批量转 |
| 5 | 骨骼活动量 + 12s/3s 轮换 + 拖拽弹簧的量化证据 |
| 6 | 轮盘静态像素保真截图验收 + 锚点误差 ≤2px |
| 7 | 密钥扫描 0 命中 + 启动项迁移前后对比 |
| 8 | 20 条判据逐条有命令、原始结果与证据路径 |
