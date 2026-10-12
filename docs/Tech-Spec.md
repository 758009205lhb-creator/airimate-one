# Tech-Spec · AiriMate One

> 与 `PRD.md` 配套。本文冻结**接口、状态机、数据契约与关键机制**；编码不得偏离本文。
> 凡本文未冻结的实现细节，必须先在 `API-Contract.md` 补契约再写代码。
> 本文所有"实测"字样均指本机活体命令结果，证据见 `docs/evidence/`。

---

## 1. 总体架构

```
AiriMate One
├─ 进程层
│  ├─ main（Electron 主进程，单实例）
│  │   ├─ single-instance ……… 三层锁（Electron lock / 命名互斥量 / 运行锁文件）
│  │   ├─ legacy-guard ……… 启动前旧实例只读检测与阻断
│  │   ├─ window-manager …… 唯一 BrowserWindow；panel/pet 双形态
│  │   ├─ tray …………… 托盘：显示/隐藏/恢复/模式/自启/退出
│  │   ├─ hit-region ……… pet 模式命中区域轮询（决定 setIgnoreMouseEvents）
│  │   ├─ secrets …………… safeStorage 加解密的唯一入口（renderer 永不持有明文）
│  │   ├─ asset-protocol … app:// 协议：本地资源受控供给（canonicalize + 白名单根）
│  │   └─ ipc-router ……… 白名单通道 + 运行时校验 + 脱敏日志
│  ├─ preload（sandbox:true，contextBridge 暴露冻结白名单 API）
│  └─ Chromium 辅助进程（GPU/renderer/utility）—— 允许存在，但只有一个应用实例
└─ 渲染层（单一 renderer 文档）
   ├─ Vue 3 + Pinia + TypeScript（apps/renderer）
   ├─ packages/avatar-stage ……… 唯一 Scene / WebGLRenderer / AnimationMixer / VRM
   ├─ packages/motion-director …… 唯一动作状态机（纯逻辑内核 + three 适配器）
   ├─ packages/radial-menu ……… 唯一轮盘（DOM 覆盖层 + rAF 缩放动画）
   └─ apps/desktop/src/main … 会话/人设/记忆/TTS/供应商（主进程侧执行，renderer 只拿事件流）
```

**进程与窗口硬约束（可探针验证）**

| 计数器 | 期望值 | 计数来源 |
|---|---|---|
| 应用实例 | 1 | 三层锁 + 锁文件 pid |
| `BrowserWindow` | 1 | 主进程暴露 `app:diagnostics` 只读计数 |
| 可见顶层窗口（本进程组） | 1 | Win32 `EnumWindows` + 归属判定（路径/签名） |
| `MateEngineX` 可见窗口 | 0 | 同上 |
| 旧 `build\pet` 可见窗口 | 0 | 同上 |
| `THREE.Scene` / `WebGLRenderer` / `AnimationMixer` / `VRM` | 1 / 1 / 1 / 1 | renderer 暴露 `window.__AIRIMATE_STAGE__`（只读句柄，仅开发与验收模式挂载） |
| Live2D 实例 | 0 | 依赖树中不存在任何 live2d 包；探针遍历全局符号 |

---

## 2. 目录与工程结构（新工作区）

```
F:\deepseek harness\AI女友\新工程\
├─ package.json                 （pnpm workspace 根，private）
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ .npmrc                       （registry=https://registry.npmmirror.com）
├─ apps\
│  ├─ desktop\                  Electron 主进程（TS → tsc 输出到 dist）
│  │  ├─ src\main\  src\preload\  src\shared\
│  │  └─ native\MutexKeeper\    （.NET 8 命名互斥量持有者，dotnet build 产出）
│  └─ renderer\                 Vue 3 + Pinia + Vite
├─ packages\
│  ├─ shared\       契约与运行时校验（zod）
│  ├─ security\     路径规范化 / 脱敏 / 密钥指纹 / CSP 常量
│  ├─ motion-director\  动作状态机（纯逻辑）+ three 适配器
│  ├─ avatar-stage\     VRM 舞台
│  ├─ radial-menu\      轮盘
│  └─ （会话内核落在 apps\desktop\src\main\，不单独成包）
├─ tools\motion-lab\   .anim→.vrma 管线与验证
├─ tools\qa\           验收探针与截图（每个判据一条命令）
├─ assets\motion\      本地动作资产（不分发）
├─ assets\models\      模型引用清单（不分发）
└─ docs\               本文档集 + evidence\
```

**纪律**：新工程不得 import 旧 `build\` 或 `src\` 的任何文件；旧代码只有在**逐文件评审**后才可复制进新工程，并需在 `docs/evidence/E0-code-reuse-log.md` 登记（来源、许可证、改动点）。

---

## 3. 单实例（三层保护）

### 3.1 L1 · Electron 应用锁

```ts
const gotLock = app.requestSingleInstanceLock({ pid: process.pid })
if (!gotLock) { app.exit(0) }        // 不创建任何窗口
app.on('second-instance', (_e, argv, cwd, extra) => { wakeUp('second-instance') })
```
唤醒动作 = `win.show()` + `win.restore()`（若最小化）+ `win.focus()` + `win.flashFrame(true)`（可配）。**绝不创建窗口。**

### 3.2 L2 · Windows 命名互斥量 `Local\AiriMateOne.Singleton`

- 实现：`apps\desktop\native\MutexKeeper`（.NET 8 控制台，`dotnet build -c Release` 本机可编译，实测 `dotnet 8.0.404` 可用）。
- 行为：`new Mutex(true, @"Local\AiriMateOne.Singleton", out createdNew)`；`createdNew=false` ⇒ 立刻打印 `ALREADY_HELD` 退出码 3；
  否则打印 `HELD <pid>` 后阻塞读 stdin；stdin 关闭即释放并退出（保证主进程崩溃后锁不悬挂）。
- 主进程：`spawn` 后等待首行；收到 `ALREADY_HELD` ⇒ 走唤醒路径并退出；收到 `HELD` ⇒ 记录 `mutexHolderPid`。
- 该 helper **不含任何窗口**，是纯守卫进程，不计入"可见窗口"。

### 3.3 L3 · 运行锁文件

路径：`%LOCALAPPDATA%\AiriMateOne\run\instance.lock`

```json
{ "appId": "com.airimate.one", "pid": 1234, "startedAt": "…", "heartbeatAt": "…",
  "version": "1.0.0", "windowMode": "panel", "bootId": "uuid" }
```

裁决规则（写入即原子替换 + `fsync`）：
1. 读锁文件；若无 ⇒ 接管。
2. 若 `pid` 进程不存在 ⇒ 判定陈旧，接管并记录 `stale-lock`。
3. 若 `pid` 存在但**归属不是本应用**（按镜像路径 + 可执行文件哈希判定）⇒ 判定陈旧，接管并记 `pid-reuse`。
4. 若 `pid` 存在且归属本应用，且 `now - heartbeatAt < 15s` ⇒ 判定"已有实例"，走唤醒路径。
5. 心跳 5s 更新 `heartbeatAt`（含 `windowMode`）。

> **冲突裁决顺序**：L1 > L2 > L3。三层结论不一致时以 L1 为准，并把三层结果写进诊断日志（脱敏）。

---

## 4. 窗口与双模式

### 4.1 窗口模型：**恰好两个独立 BrowserWindow**（2026-10-08 返工轮改写）

> ★★ **本节口径已被改写**（原题「唯一窗口」）。改写的理由与全部落点见
> `Acceptance-Matrix.md` §0.5（含"根因"一节）。一句话：
> 旧硬约束「应用只创建一个 `BrowserWindow` / 可见窗口数 = 1」把实现方**逼**成了
> "把聊天塞进桌宠窗口"（贴底 dock + 把窗口放大到 380×560），
> 而用户明确否决该形态 ⇒ **约束本身被废止**。

现在**恰好两个**窗口，各有唯一的创建点：

| 窗口 | 创建点 | 作用 | 关键参数 |
|---|---|---|---|
| **pet / panel**（角色） | `window-manager.ts` 的 `createMainWindow()` | 角色 + 轮盘 + 气泡 + 管理面板 | `transparent:true` / `frame:false` / `pet` 恒 `340×420` / `skipTaskbar:true`（pet）/ `alwaysOnTop` / `autoShowOnReady`（**默认 false**，见 §4.1c） |
| **chat**（对话） | `chat-window.ts` 的 `ensureChatWindow()` | **唯一**有输入框与对话文字流水的界面 | ★ `frame:true`（**系统原生边框**，2026-10-09 改写）/ `transparent:false` / `resizable:true` / 外框 `720×560`（最小 `560×420`）/ `skipTaskbar:false` / `alwaysOnTop` 可配（默认 false）/ `setMenuBarVisibility(false)` |

**第三个窗口是禁止项**。两个窗口共用**同一份** renderer 构建，靠 URL 的
`?surface=chat` 区分要渲染哪个界面（`main.ts` 用**动态 import** 分派 ——
这从**结构上**保证 chat 窗口的模块图里没有 `three` / `VRM` / `AvatarStage`，
而不是靠"记得别挂载"）。

三条新判据（取代旧的"可见窗口数 = 1"）：

1. **角色可见窗口数 = 1**（只有 pet 窗口渲染角色）；
2. **chat 窗口内 WebGL canvas 数 = 0**，`Scene/Renderer/Mixer/VRM` 计数全为 0；
3. **全应用 `WebGLRenderer` 总数恒为 1**，只存在于 pet 窗口。

⚠ **Chromium 渲染进程数变成 2 是允许的**（Electron 每个窗口一个 renderer），
不算违反"单角色"。

**安全装配只有一份**：`window-security.ts` 的 `applyWindowSecurity()` 被两个窗口共同调用。
为什么不各写一份：新增第二个窗口时最容易发生的事就是"照着抄一份、顺手简化两行"，
而少掉的每一条（权限拒绝 / 导航拦截 / CSP 注入 / 诊断转发）**都没有任何界面表现**。

`window-manager.ts` 的其余约束不变（`transparent` 与 `frame` 只能在创建时设定、
模式切换不重建 renderer/Scene/VRM、pet 尺寸拖拽期间不得变化）。

#### 4.1.1 ★★ 对话窗口改用**系统原生边框**（2026-10-09 完善轮改写）

**改的是什么**：`chat-window.ts` 的 `frame:false` → **`frame:true`**。
上一版的理由写在旧注释里（"这样就不必在无边框与可用性之间做取舍"）——
**那个取舍本身就是错的**：自绘标题栏**复刻不出**系统菜单（左上角图标右键）、
双击标题栏最大化、`Win+方向键`贴边、以及任务栏分组与跳转列表。

**用户这一轮明确要求对齐参考实现** `DataAxeagle/DockPetWin-Aemeath`：它的
`AgentChatWindow.xaml` **没有设置 `WindowStyle`** ⇒ 用的是 WPF 默认的
`SingleBorderWindow` = 系统原生边框。⇒ 本轮照做。

`frame:true` 一次性带来（全部由系统实现，见 `Acceptance-Matrix.md` §2.6）：

| 能力 | 实现方 |
|---|---|
| 拖动（无 `-webkit-app-region`） | 系统 |
| 缩放（四边 + 四角） | 系统 |
| 最小化 / 最大化 / 还原 | 系统（右上角三个按钮） |
| 左上角系统菜单（移动/大小/最小化/关闭） | 系统 |
| 双击标题栏最大化、`Win+方向键`贴边 | 系统 |
| 任务栏项 | 系统 |

**随之删除的**（`ChatWindow.vue` 里的旧路径，一件不留）：
自绘标题栏 `.chatw__titlebar`、「–」最小化按钮、「×」关闭按钮、
以及它们对应的 `-webkit-app-region` 布局假设。
→ 取而代之的是**窗口内的一行信息头**（头像 + 标题 + 状态）+ 一条**功能菜单栏**
（文件/桌宠/对话/记忆/设置/帮助）。键盘入口不变：`Esc` 仍然只隐藏窗口。

**三个必须一起处理的连带项**（不同时处理就会出现"看起来无关"的缺陷）：

1. **尺寸语义变了**：Electron 的 `width/height` 在 `frame:true` 时**包含系统装饰**
   （标题栏 + 边框）。参考实现的 `Width=720 Height=560` 在 WPF 里是**外框**，
   所以请求值必须**减掉装饰量**（`chat-window.ts` 的 `FRAME_DECORATION = {20,19}`，
   本机 125% 缩放实测）。
   ⚠ 判定也要跟着改：探针比较的是**外框**（容差 ±16 DIP），
   并把"请求值"与"装饰量"一并记进证据。
   ⚠ **不用"临时建个窗口量一下装饰量"**：那会让应用短暂出现**第三个 `BrowserWindow`**，
   直接与本轮的硬约束冲突（试过，已撤销）。
2. **几何记忆存的是外框**：`rememberBounds()` 必须存 `getBounds()` 的读回值。
   存"补装饰之前的目标"会造成**每开一次窗口就长大一圈**的环（实测约 13 DIP/次），
   而现象是"位置和大小记不住"。这个环在 `frame:false` 时代**不存在**。
3. **窗口内的菜单栏不要与 Electron 的菜单栏混淆**：`frame:true` 给的是**系统标题栏**，
   而 `autoHideMenuBar` 管的是 Electron 在客户区插的那条 `File/Edit/View`。
   `setMenuBarVisibility(false)` 才能让 `Alt` 也不再唤出它
   ⇒ 客户区只有我们自己的那一行深色菜单。

#### 4.1.2 ★★ 对话窗口的**菜单栏**（2026-10-09 完善轮新增）

结构对齐参考实现（头部 → 中部滚动区 → 底部操作行），并在客户区顶部加一条菜单栏：

| 菜单 | 项 |
|---|---|
| 文件 | 隐藏窗口 / 重启应用 / 退出应用 |
| 桌宠 | 显示桌宠 / 收回桌宠 / ☑ 桌宠常驻 / 打开管理面板 |
| 对话 | 新建对话 / 清除对话 / 打开数据目录 |
| 记忆 | 打开记忆页 / 打开日程与提醒 |
| 设置 | 偏好设置 / 语音与麦克风 / 快捷键 / ☑ 开机自启 / ☑ 对话窗口置顶 |
| 帮助 | 快捷键一览 / 关于 |

**纪律：每一个菜单项都必须有真实动作**（点了没反应、或显示"暂未实现"的一律算失败）；
**不支持的功能直接不显示**，不显示灰色死项。

**实现上的两个要点**：

1. 菜单项在 `ChatWindow.vue` 里是**数据**（`menus` computed → `MenuEntry[]`），
   不是模板里的一堆 `<li @click>`。⇒ 探针可以**逐个执行**它们并记录每项的可观测返回值
   （`__AIRIMATE_CHAT_PROBE__('clickAll')`），"点了没反应"因此是一个**机械可测**的事实。
   `runAction()` 的 `switch` 是**穷尽**的：新增 `MenuAction` 却没写实现会**编译失败**，
   而不是静默什么都不做。
2. 「新建对话」与「清除对话」**是两件不同的事**：
   · `chat:clear`  —— 真的删掉历史（不可逆）；
   · `chat:context-reset` —— 只把"上下文起点"（`session.json` 的 `contextResetAt`）推到此刻：
     她**不再记得**之前聊过什么（提示词用 `visibleHistory()`），界面也不再显示上一段，
     但历史**一条不删**（隐私导出里还在）。
   若两项做同一件事，那就是一个**骗人的菜单**。

---

### 4.1b pet 窗口基础参数

基础参数（不可被模式覆盖）：

```ts
webPreferences: {
  preload: <abs>,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  spellcheck: false,
}
```

---

### 4.1c ★★ 桌宠常驻与启动行为（**2026-10-09 完善轮新增**）

> PRD FR-1b 是这一节的规格来源；这里只写**实现落在哪、为什么这么落**。

**唯一状态机**：`apps/desktop/src/main/pet-visibility.ts`。

| 概念 | 载体 | 回答的问题 |
|---|---|---|
| **常驻** | `settings.petResident`（默认 `false`） | "**下次启动**要不要自己出现？"（持久） |
| **可见** | `BrowserWindow.isVisible()` | "**现在**看不看得见她？"（瞬时） |

两个概念**必须分开**（PRD FR-1b.4 的三条规则就在这里实现）。
`petMenuState()` 是**唯一**的快照组装点（`buildPetMenuState()`），
托盘 tooltip、三处菜单、`conversation:state` 全都调它 ——
这是"三处读数不可能互相矛盾"的**结构性**保证，而不是"记得三处都改"。

**启动行为的落点**（`bootstrap.ts`）：

```
wantResident = CLI 覆盖(--probe-pet-mode) ?? settings.petResident
createMainWindow({ autoShowOnReady: wantResident })     ← 桌宠那一半（创建时就定）
if (startupOpenChat) openConversation('startup')        ← 对话那一半（IPC 注册之后）
```

- `autoShowOnReady` 是 `CreateWindowOptions` 的**新入参**（默认 `true` 保持旧行为）。
  ⚠ 窗口仍然**照常创建**（只是不 `show()`）：renderer 要挂载、舞台/VRM 要初始化、
  快捷键与轮盘都挂在它身上 ⇒「呼出」是**即时**的。这不是"延迟创建"。
- **`window-manager.ts` 刻意不读设置**：它只接受一个布尔。
  "要不要自动显示"的判定留在 `bootstrap`，否则窗口层就依赖了设置层。
- 两个开关都关 ⇒ 什么都不做，应用只剩托盘图标（**合法状态**，不是缺陷）。

**`--probe-pet-mode start-hidden|start-resident`**（CLI，**会话级覆盖、不写设置**）：
判据 C2/C3 要求"**重启后**仍按新值执行"，而自动化里"重启"只能是第二次进程启动。
这个开关让第二次启动显式要求"这次必须按常驻启动"，而**设置文件里的值**才是被验证的对象
（命令行在真实重启时并不存在）。

**命中区域与气泡的干净态**（PRD FR-1b.7）：`hidePet()` 会调
`hitRegions().reset('pet-hidden')` 并广播 `evt:ui-action { action: 'pet-hidden' }`；
`hit-region.ts` 的 `tick()` **额外**加了一条不变量"窗口不可见就不参与命中判定"。
两道一起才完整：**判据（矩形清空）+ 不变量（不可见不判定）**。
不做这件事的后果是"看不见的窗口还在吃桌面点击"，而它不会报任何错，
也不会被截图发现（窗口是不可见的）。

**新增 IPC 白名单**（全部走 `guarded()` + zod）：

| 通道 | 作用 |
|---|---|
| `pet:show` / `pet:hide` / `pet:toggle` / `pet:open-panel` | 呼出 / 收回 / 切换 / 呼出并切管理面板 |
| `pet:set-resident` | 写「桌宠常驻」并**立即生效 + 落盘**（`flushSettings()`） |
| `pet:flush-settings` | 只把设置立即落盘（不等 800ms 防抖） |
| `pet:menu` | 让主进程在鼠标位置弹出**原生**桌宠右键菜单（无入参） |
| `ui:action` | 界面动作路由（打开记忆页 / 日程 / 偏好 / 语音 / 快捷键 / 关于） |
| `chat:context-reset` | 「新建对话」：只重置上下文，**不删历史** |
| `chat:open-data-dir` | 打开对话数据目录（`shell.openPath`，路径由主进程给定） |
| `app:restart` | 重启应用（先 `app.relaunch()` 再 `quit()`，**顺序不可反**） |

**桌宠右键菜单为什么在主进程**（`ipc.ts` 的 `PET_MENU`）：
菜单项里有「重启应用 / 退出应用」，把这类能力交给渲染进程的界面层是
**没必要扩大的攻击面**。⇒ renderer 只能说"用户在我的窗口上右键了"（无入参），
菜单项与动作**全部由主进程持有**。

### 4.2 两种模式

| 项 | panel | pet |
|---|---|---|
| 尺寸 | 420×760（可记忆） | 340×420（固定；拖拽期间不得变化） |
| frame | `true`（自绘标题栏可选） | `false` |
| transparent | `false` | `true` |
| alwaysOnTop | 用户可切 | 默认 `true`（层级 `'floating'`） |
| skipTaskbar | `false` | `true` |
| resizable | `true` | `false` |
| 背景 | 不透明应用底色 | 透明；`backgroundColor: '#00000000'` |

模式切换实现（**同一窗口**）：

```ts
win.setBounds(targetBounds)            // 先设尺寸
win.setResizable(mode === 'panel')
win.setAlwaysOnTop(...)
win.setSkipTaskbar(...)
if (mode === 'pet') { win.setBackgroundColor('#00000000'); /* transparent 不可运行时切换 */ }
webContents.send('window-mode-changed', { mode, bounds })
```

> **实测约束**：Electron 的 `transparent` **只能在创建时设定**。因此窗口**始终以 `transparent: true` 创建**，
> panel 模式用不透明 CSS 背景填满，pet 模式让背景透明。这样切换模式无需重建窗口，
> 满足"切换不新建窗口/不重载角色"。`frame` 同样不可运行时切换 ⇒ 窗口以 `frame: false` 创建，
> panel 模式在 renderer 内自绘标题栏与窗口按钮（最小化/关闭/拖动），从而两种模式共享同一个窗口。

模式切换必须保持：`WebGLRenderer` 不重建、`AnimationMixer` 不重建、VRM 不重载、mixer 时间不回退。
验证方式：切换前后读取 `__AIRIMATE_STAGE__` 的 `stageId/rendererId/mixerId/vrmInstanceId` 与 `mixer.time`，断言 id 不变且时间连续。

#### 4.2.1 ⛔ 已作废：第三种布局 `conversation`（2026-10-08 返工轮删除）

> ★★ **整节作废，保留仅为审计留痕。**
>
> 本节描述的是「对话态 = pet 模式内的一种布局，`WINDOW_GEOMETRY.conversation = 380×560`，
> 由 `enterConversationLayout` / `exitConversationLayout` 管理」。**该形态已被用户明确否决**
> （聊天对话框与桌宠必须是两个完全独立的窗口），实现已**全部删除**：
>
> | 本节提到的东西 | 现状 |
> |---|---|
> | `WINDOW_GEOMETRY.conversation` | **已删除**；改为 `WINDOW_GEOMETRY.chat = {720×560}` / `chatMin = {560×420}` |
> | `enterConversationLayout` / `exitConversationLayout` / `isConversationLayout` / `syncConversationLayoutForMode` / `conversationSizeDiagnostics` / `petLayoutSize` | **已删除** |
> | `ConversationDock.vue`（窗内贴底 dock，kind=`panel` 命中区域上报） | **已删除**；内容并入 `components/ChatWindow.vue`（独立窗口，**不做**命中区域上报） |
> | 「panel 模式对话框是舞台浮层」 | **已删除**；chat 窗口与 panel/pet 模式**完全解耦** |
> | `conversation.ts` 的打开副作用 = 切窗口尺寸 | **改为** `showChatWindow()` / `hideChatWindow()`（显示/隐藏第二个 BrowserWindow） |
>
> **现行口径见 §4.1**；判据与取证见 `Acceptance-Matrix.md` §0.5 / §2.4，
> 实现见 `apps/desktop/src/main/chat-window.ts`。
>
> 为什么把作废内容留着而不是删干净：本节是**被否决形态的完整规格**，
> 删掉之后"当初为什么要把窗口放大到 380×560"就再也查不到了 ——
> 而那个根因（旧规格的"只创建一个 BrowserWindow"硬约束）正是本轮返工要修的东西。

<!-- 以下为作废原文，仅供审计对照，不得作为实现依据 -->

`WindowMode` 枚举**不变**（仍是 `panel | pet`）。对话态是 **pet 模式内的一种布局**，
由 `WINDOW_GEOMETRY.conversation` 与 `apps/desktop/src/main/conversation.ts` 的状态机管理：

| 项 | 取值 | 唯一真源 |
|---|---|---|
| 尺寸 | `380 × 560`（两个数都是 4 的整数倍，125% 缩放下不被 DIP 栅格取整） | `packages/shared/settings.ts` → `WINDOW_GEOMETRY.conversation` |
| 对齐 | 进入与退出都按 **bottom-center**（角色基线在底部，窗口向上长） | `window-manager.ts` → `enterConversationLayout` / `exitConversationLayout` |
| 还原 | 进入前记录 `{x, y, pet 常量尺寸}` ⇒ 退出按**常量**还原（**严格互逆**；不用 `getBounds()` 读回值反算，避免尺寸逐次漂移） | 同上（模块级 `conversationReturn`） |
| 进入条件 | 只在 `pet` 模式；**拖拽期间结构化拒绝**（`reason: 'dragging'`）并发出**可见**告警，绝不静默 | `conversation.ts` → `openConversation` |
| panel 模式 | **不切窗口尺寸**：对话框是舞台浮层（宽度 = 窗口宽 − 24px，贴舞台底部） | `ConversationDock.vue` + `openConversation` 的 panel 分支 |
| 尺寸自验证 | 进入后最多 3 次迭代收敛到目标，`settled / tries / actual` **如实落盘**（`conversationSizeDiagnostics()`） | `enterConversationLayout` |
| 拖拽期不变 | 对话布局期间 `autoResize()` 直接拒绝（`reason: 'conversation-layout'`）；拖拽本身仍以不可变目标尺寸驱动 | `autoResize` / `dragTo` |

**IPC 契约**（三条通道，全部进白名单 + 两侧 zod 校验）：
`conversation:open` / `conversation:close` / `conversation:state`；
出站 `evt:conversation-state`、`evt:conversation-listen`。
五个入口（轮盘「对话」/ 托盘「开始·结束对话」/ 全局快捷键 `Ctrl+Alt+Space` / 语音唤醒词 / 双击角色）
**全部**走这三条通道，不各写一套 —— 这样"某个入口没生效"能被一条探针覆盖。
全局快捷键注册失败**必须在三处可见**：`hotkey.error`（进诊断与 `conversation:state`）、
`evt:alert`（界面告警条）、结构化日志。

**命中区域**：对话框与气泡由组件每帧写入 `renderer/src/stage-bus.ts`，由 `AvatarStage` 的命中区域循环
**统一**随角色/轮盘一起上报（`kind` 分别为 `panel` 与 `bubble`）。
**不允许**各自调用 `reportHitRegions` —— 那是"整体替换"语义，两个来源会互相清空对方的区域。

**取证**：`--probe conversation`（45 项）+ `tools/qa/conversation-shots.ps1` + `tools/qa/hotkey-toggle.ps1`；
原始产物见 `docs/evidence/phase15/`，总说明见 `docs/evidence/phase15/CONVERSATION-ROUND.md`。

### 4.3 pet 模式命中区域（关键机制）

问题：`pet` 模式要"透明区域不吃桌面点击"，但角色与轮盘必须可点。

机制（主进程 `hit-region.ts`）：

1. renderer 每帧（节流 100ms，仅在变化时）上报**交互区域矩形集合**（屏幕坐标，窗口相对）：角色包围盒、轮盘当前圆形包围盒、可见的聊天气泡。
2. 主进程以 60ms 间隔用 `screen.getCursorScreenPoint()` 取光标屏幕坐标，换算为窗口坐标，判定是否落在任一面内（含 `HALO` 外扩：角色 +18px，轮盘 +24px）。
3. `win.setIgnoreMouseEvents(!inside, { forward: true })`。
   - `forward: true` 让窗口在被忽略时仍收到 `mousemove`，供区域自更新与悬停高亮。
4. **互锁规则**：`ignore = false` 的持续时间下限 120ms（防抖动）；轮盘开启期间强制 `ignore = false`（保证键盘与点击）。
5. panel 模式恒为 `ignore = false`。
6. 禁用 CSS `pointer-events: none` 之外的"假装不可点"做法；命中区域与实际可点元素必须同源计算（同一个几何函数），以满足"可点击区域必须与视觉一致"。

### 4.4 拖动

- pet 模式：renderer 收到 `pointerdown`（button 0，落在角色区域）后进入拖动，主进程用
  `win.setPosition(x, y)`（两参重载，**不使用** `setBounds`，避免尺寸漂移）跟随；
  位移以 `screen.getCursorScreenPoint()` 差分为准（不依赖 DOM 事件频率），60Hz。
- 拖动开始时上报 `motion: drag-start`，结束时 `motion: drag-end`，并随后持续上报窗口位置（用于摇晃驱动）。
- 拖动期间 `setResizable(false)` 保持不变；每次 `setPosition` 后断言 `getBounds()` 的 `width/height` 未变（偏差 0 容忍）。

---

## 5. 资源供给与自定义协议

### 5.1 协议

- 注册特权：`protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: false, bypassCSP: false } }])`（必须在 `app.ready` 之前）。
- 生产：`app://bundle/…` → `apps/renderer/dist`；`app://asset/…` → 白名单根（见下）。
- 开发：renderer 由 Vite dev server 提供（仅 `127.0.0.1`，随机端口，一次性 token；见 §7.5）。

### 5.2 路径安全（`packages/security/paths.ts`）

每一次资源请求：
1. URL 解码 → 拒绝含 `\0`；
2. 拒绝含 `..` 段（在**解码后**判定，防 `%2e%2e`）；
3. `path.resolve` 后必须 `startsWith(root + path.sep)`（Windows 大小写不敏感比较）；
4. `fs.realpathSync.native` 解析后**再次**做前缀判定（防 symlink/junction 逃逸）；
5. 拒绝 ADS（`:` 出现在文件名部分）、拒绝设备名（`CON/PRN/AUX/NUL/COM1..9/LPT1..9`）；
6. 扩展名白名单：`.html .js .css .json .png .jpg .webp .ktx2 .bin .glb .vrm .vrma .wasm .woff2 .svg`；
7. 单文件大小上限（模型 256 MB、其它 32 MB）；
8. 失败一律返回 404（不回显绝对路径），日志记脱敏原因。

### 5.3 模型与动作资产的定位

`assets/models/catalog.json`（**只含路径引用，不含资产本体**）：

```json
{ "avatars": [ { "id": "lazuli", "label": "Lazuli", "path": "F:\\deepseek harness\\AI女友\\repos\\Mate-Engine\\Assets\\MATE ENGINE - Avatar\\DLCs\\Lazuli_VRM.vrm",
                 "sha256": "<启动时校验，首次记录>", "license": "upstream-dlc-asset", "redistributable": false } ],
  "motions": { "dir": "assets/motion", "manifestGlob": "manifests/*.json" } }
```

- 启动时若路径不存在 ⇒ renderer 显示**可见告警位**（附路径与获取方式），**不静默空白、不退回 T-pose**。
- 校验 `sha256` 不匹配 ⇒ 告警（不阻断，允许用户替换模型）。
- 分发物**不含**任何 `.vrm`、`.vrma`、`.anim`。

---

## 6. 动作管线（`.anim` → `.vrma`）与 MotionDirector

### 6.1 转换正确性要求（编码前逐条对照）

1. **muscle 曲线的读取**：Unity Humanoid `.anim` 的肌肉曲线是「相对 T-pose 参考的归一化增量」。
2. **骨骼名映射**：Unity PascalCase（`LeftUpperArm`、`LeftFoot`、`Jaw`、`LeftEye`）→ VRMA camelCase（`leftUpperArm`、`leftFoot`、`jaw`、`leftEye`），映射表在 `tools/motion-lab/humanoid-map.mjs` 内以数据形式冻结并被单元测试覆盖。
3. **叠加而非替换 rest**：运行时 `local = rest * delta`（先 `rest` 后 `delta` 的顺序必须与坐标约定一致，并由"世界方向自检"证明），不能写 `local = delta`。
4. **必须绑定成功的骨骼**：`hips, spine, chest, neck, head, leftUpperLeg, rightUpperLeg, leftLowerLeg, rightLowerLeg, leftFoot, rightFoot, leftUpperArm, rightUpperArm, leftLowerArm, rightLowerArm, leftHand, rightHand`（17 根）——转换产物必须全部覆盖，validator 逐条断言。
5. **加载验证**：每个 `.vrma` 必须用真实 `@pixiv/three-vrm-animation` 的 `VRMAnimationLoaderPlugin` 解析成功，且每条 humanoid 轨道都能对应到目标模型的实际 normalized bone（未对应项必须为 0 条）。
6. **manifest**：`assets/motion/manifests/<id>.json`，字段见 `API-Contract.md` §4。
7. **首帧保护**：动作加载完成前不得渲染 T-pose；`avatar-stage` 在拿到第一个 `base` 动作前保持"加载态遮罩"。
8. **失败可见**：任何动作加载失败 ⇒ renderer 顶部告警条 + 主进程脱敏日志，禁止静默。

### 6.2 分层

| 层 | 内容 | 实现 | 是否写入骨骼 |
|---|---|---|---|
| L0 基础动作 | 待机轮换 / 一次性 / 状态 / 拖拽（互斥，同一时刻只有一个 `base` 权重为 1） | `AnimationMixer` 的 action 权重与交叉淡化 | 是（mixer 直接写 `normalizedBone`） |
| L1 摇晃叠加 | 拖拽弹簧倾斜（hips）+ 四肢滞后 | 在 mixer 之后、`vrm.update` 之前，用四元数**右乘**到已计算出的骨骼四元数 | 是（乘法叠加） |
| L2 表演叠加 | 表情（ExpressionManager）、眨眼、口型（viseme 权重）、视线（lookAt） | 走 `VRM.expressionManager` / `lookAt`，不触碰骨骼 | 否（仅 morph/lookAt） |
| L3 物理 | `springBone`（发丝/衣物） | `vrm.update(dt)` 内部 | 是（物理链，不与 L0/L1 冲突） |

**更新顺序（固定）**：`mixer.update(dt)` → L1 摇晃叠加 → L2 表演叠加 → `vrm.update(dt)` → `renderer.render(scene, camera)`。
> 旧原型实测踩过顺序坑（`mixer.update → pose.update → vrm.update`），该顺序保留并与 Mate 的语义一致。

### 6.3 状态机

状态：`loading | idle | oneshot | state(walk|sit|sleep) | drag | error`

转移（其余转移一律拒绝并记警告）：

| 从 | 事件 | 到 | 说明 |
|---|---|---|---|
| loading | clips-ready | idle | 立刻进入 `idle[0]`，无 T-pose 帧 |
| idle | idle-timer ≥ 12s | idle(next) | 3s 交叉淡化 |
| idle/state | oneshot(cmd) | oneshot | 打断当前，播放完回到进入前状态 |
| any | drag-start | drag | `PET_DRAGGING` 淡入 0.18s，当前 base 淡出 0.18s；暂停待机轮换 |
| drag | drag-end | 进入 drag 前的状态 | 淡出 0.25s 回原动作；弹簧目标归零 |
| state | state-exit | idle | — |
| any | clip-error | error | 显示告警；保持上一有效动作（不静止） |

参数（照搬 Mate 并冻结）：`IDLE_SWITCH_TIME=12s`、`IDLE_TRANSITION_TIME=3s`、
`springFrequency=2.6`、`dampingRatio=0.35`、`maxLeanZ=25°`、`maxLeanX=12°`、`limbLag=6`、
指数滤波 `k = 1 - exp(-12·dt)`、`horizontalVelocityToLean=0.25`、`verticalVelocityToPitch=0.15`、`mouseSensitivity=0.6`。

弹簧积分（与 Mate `AvatarSwayController` 同式）：

```
w = 2π·freq ;  a = w²·(target - x) - 2·ζ·w·v ;  v += a·dt ;  x += v·dt
```

> 该积分在 `dt` 抖动下可能发散，因此：`dt` 上限夹取 1/30s，并对 `x` 夹取物理上限（倾斜角上限的 1.5 倍）。

### 6.4 待机集合（≥10）

优先使用：`PET_IDLE\PET_IDLE.anim`、`PET_IDLE_2..10.anim`；缺失时回退 `PET_IDLE\ME_02\PET_IDLE_16..22.anim`。
每个产物必须有 manifest 且 5 秒内腿部（`left/rightUpperLeg`、`left/rightLowerLeg`）累计角位移 > 3°。

---

## 7. 安全设计

### 7.1 渲染进程边界

- `sandbox: true` + `contextIsolation: true` + `nodeIntegration: false`。
- preload 用 `contextBridge.exposeInMainWorld('airimate', Object.freeze({...}))` 暴露**白名单函数**；不暴露 `ipcRenderer` 本体、不暴露任何 `require`/`process`。
- 所有入站消息（main→renderer 与 renderer→main）在**两侧**都用 zod schema 校验；校验失败即丢弃 + 脱敏记日志（含通道名、失败字段路径，不含原值）。
- 禁止：`remote` 模块、`eval`、`new Function`、`innerHTML` 注入不可信内容（Markdown 渲染必须经 `marked` + `dompurify`，且链接只允许 `http/https`，其余协议强制 `noopener` 且不可点击）、远程脚本、`will-navigate` 放行（一律 `preventDefault`，仅允许 `app://` 与 dev-server 源）。

### 7.2 CSP

对 `app://` 响应头与 HTML `<meta>` 双重下发：

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self'; connect-src 'self' http://127.0.0.1:*;
media-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
```

> `style-src 'unsafe-inline'` 仅为 Vue/组件库内联样式所需；不允许内联 `<script>`，因此 `script-src` 保持严格。
> `connect-src` 仅放行环回，LLM/TTS 出网请求**全部在主进程**发出（renderer 不直连外网，避免密钥进入 renderer）。

### 7.3 密钥

- 存储：`safeStorage.encryptString`（DPAPI/Keychain 后端）密文写入 `%APPDATA%\AiriMateOne\secrets\<providerId>.bin`；
  `safeStorage.isEncryptionAvailable() === false` ⇒ 拒绝保存并提示（不降级为明文）。
- 备选：Windows Credential Manager（`cmdkey`/`CredWrite`），仅当 safeStorage 不可用时启用，且需显式用户确认。
- **密钥永不进入 renderer**：renderer 只能看到 `{ providerId, hasKey: true, keyFingerprint: "…", keyLength: 51 }`；
  fingerprint = `sha256(key).slice(0,8)`。
- 出网请求由主进程（`apps/desktop/src/main`）发起；进程命令行不含密钥；日志中任何疑似密钥（`sk-`/`Bearer`/JWT/32+ hex/base64 长串）一律替换为 `«redacted:len=51,sha=ab12cd34»`。
- 崩溃转储：设置 `app.setPath('crashDumps', <受限目录>)` 并在启动时清理超过 7 天的转储；分发前扫描转储目录。

### 7.4 日志

- 统一 `packages/security/logger.ts`：`level, ts, scope, msg, fields`，写 JSONL 到 `%APPDATA%\AiriMateOne\logs\`。
- 写入前经 `redact()`：正则命中列表见 API-Contract §6；命中后只保留长度与前 8 位哈希。
- 日志**不含**对话正文（只记长度与哈希）；诊断包导出前再过一次 `scan()`，命中即阻断导出。

### 7.5 本机端口

- 仅当必要（开发期 Vite、可选本地 TTS 桥）：**随机端口**（`listen(0)`）+ `127.0.0.1` 绑定 + 一次性 token（`crypto.randomBytes(32).toString('base64url')`，通过 query 首请求校验一次后即失效）+ 端口冲突记录（`EADDRINUSE` ⇒ 重试 3 次并记 `port-conflict`）。
- 验收：`Get-NetTCPConnection -State Listen` 中本应用进程的监听项必须全部满足 `LocalAddress ∈ {127.0.0.1, ::1}`。

---

## 8. 旧实例检测与启动项迁移（规格）

### 8.1 检测（只读，启动前置）

新应用启动顺序固定为：
1. 解析命令行（无 GUI）；
2. L1/L2/L3 单实例；
3. **旧实例检测**（`legacy-guard.ts`）：命中"会显示角色/轮盘"的旧实例 ⇒ 弹阻断对话框，给出 PID/路径/哈希与处置建议，用户确认后退出（**不自动杀进程**）；
4. 创建托盘与唯一窗口。

检测谓词（每条都必须可解释，禁止仅凭进程名）：

| 目标 | 谓词 |
|---|---|
| `MateEngineX.exe` | 进程名匹配 **且** 映像路径位于已登记的旧工程前缀（`F:\deepseek harness\AI女友\build\`）**或** PE 哈希命中已知清单 **或** 命令行/工作目录含 `MateEngineX_Data`。三者都不满足 ⇒ 视为无关进程，仅记录 |
| 旧 `build\pet` | 映像路径以 `node_modules\electron\dist\electron.exe` 结尾 **且** 进程命令行包含 `build\pet\app\main.mjs`（用 `Win32_Process.CommandLine` 判定） |
| 旧 brain/bridge 入口 | 命令行包含 `start-airi-brain.ps1` / `autostart-airi-brain.ps1` / `airi-brain.mjs` / `mate-engine-airi-bridge.mjs` |
| 旧 AIRI + 独立桥组合 | `airi.exe` 进程存在 **且** 旧桥进程存在（两者同时命中才告警，避免误伤用户正常使用 AIRI） |

处置矩阵：命中"显示角色/轮盘"类（MateEngineX 可见窗口、旧 build\pet）⇒ **阻断**；
命中"仅后台"类（旧 brain/bridge 无窗口）⇒ 警告 + 提供"忽略并继续"（记录用户选择）。

### 8.2 启动项迁移（阶段 7）

1. 备份：导出 `HKCU\...\Run`、两个 Startup 文件夹清单、`Get-ScheduledTask` 中相关任务 XML 到 `%APPDATA%\AiriMateOne\migration\backup-<ts>\`。
2. 识别指向旧入口的项（谓词同 §8.1）。
3. 合并：注册**唯一一个** `HKCU\...\Run\AiriMateOne`，值 = `"<install>\AiriMateOne.exe" --autostart`；删除/禁用旧项前逐个记录。
4. 卸载器：删除自有项；若备份中存在被本应用改动的旧项，按备份**恢复原样**；提供 `--restore-legacy` 开关。
5. 验收：安装→卸载→重启各一次，`Get-ItemProperty HKCU:\...\Run` 与启动文件夹中旧桌宠命中数 = 0。

---

## 9. 可观测性与验收探针

- 主进程：`app:diagnostics`（只读）返回 `{ pid, instances, windows: [...], mutexHolderPid, lockPid, windowMode, uptimeSec, ports: [...] }`（由 `tools/qa/*.mjs` 通过 CLI 参数 `--diagnostics <file>` 导出，避免额外端口）。
- renderer：`window.__AIRIMATE_STAGE__`（仅在 `--diagnostics` 模式挂载，返回只读快照，**不是可变句柄**）：

```ts
{ stageId, rendererId, mixerId, vrmInstanceId, sceneCount, rendererCount, mixerCount, vrmCount,
  live2dCount, activeClip, activeWeight, baseClipId, crossfade: {from,to,t},
  bones: { leftUpperLeg: {x,y,z,w}, … }, // 17 根必需骨骼
  boneTravelAccum: { … },               // 每个动作的累计角位移（度）
  fps: { avg1s, avg5s }, heapMB, wheel: { open, cx, cy, scale } }
```

- 每个验收判据在 `tools/qa/` 下有一条可复跑命令，输出 JSON 证据到 `docs/evidence/<阶段>/<判据>.json`，并把原始 stdout 存为同名 `.txt`。

**视觉验收**：所有 UI/动作相关判据必须附**真实桌面截图**（全屏 `CopyFromScreen` 或窗口截图），
文件落在 `docs/evidence/<阶段>/screens/`，并在验收矩阵中给出路径。

---

## 10. 构建与运行

| 目标 | 命令（PowerShell 5.1） |
|---|---|
| 安装依赖 | `pnpm install --registry=https://registry.npmmirror.com` |
| 构建契约与包 | `pnpm -r --filter "./packages/**" build` |
| 构建 renderer | `pnpm --filter @airimate/renderer build` |
| 构建 main | `pnpm --filter @airimate/desktop build` |
| 互斥量守卫 | `dotnet build apps/desktop/native/MutexKeeper -c Release` |
| 启动（开发） | `pnpm --filter @airimate/desktop dev` |
| 动作管线 | `node tools/motion-lab/convert-anim.mjs --batch assets/motion/batch.json` |
| 动作验证 | `node tools/motion-lab/validate-vrma.mjs --dir assets/motion` |
| 加载验证 | `node tools/motion-lab/load-test.mjs --dir assets/motion` |
| 验收探针 | `node tools/qa/<check>.mjs` |

**交付纪律**：任何"完成"声明必须附命令 + 原始输出 + 证据路径；未验证项标 `NOT VERIFIED`。

---

## 11. 明确不做（与 PRD §2.2 一致，此处列技术红线）

- 不调用 `SetParent`/`SetWindowLong` 等 Win32 嵌入手法。
- 不使用 CDP 注入实现任何生产功能（CDP 仅允许在 `tools/qa/` 的验收探针中使用，且必须可关闭）。
- 不同时创建第二个 `BrowserWindow` / 第二个 `WebGLRenderer` / 第二个 `AnimationMixer` / 第二个 VRM。
- 不在 pet 模式用"两个窗口透明叠加"伪装单窗。
- 不把 `.anim`/`.vrm`/`.vrma` 打进分发包。
- 不改动 `F:\AIRI` 与 Mate 官方安装目录的任何字节。
- 不自动结束归属不明的用户进程。
