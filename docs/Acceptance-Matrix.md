# Acceptance-Matrix · AiriMate One

> 配套文件：`PRD.md`（判据 A1..A20 见 §5，场景 S1..S9 见 §3，门禁见 §10）、`Tech-Spec.md`（探针设计 §9、安全 §7、旧实例与自启迁移 §8、构建运行 §10）、`docs/evidence/E0-recon-baseline.md`（环境实测基线）。
> 本文**不引入新需求**：A1..A20 的语义逐条来自 PRD §5，编号不变。本文只补"怎么测、期望什么原始输出、证据放哪、现在能不能测"。
> ~~本文件**当前状态**：全部为计划状态（`NOT VERIFIED` / `BLOCKED-PENDING-USER`），**没有任何一条被执行过**。~~
> **↑ 这句自述已于 2026-10-03 作废**（它从 2026-09-27 起就不再成立）。真实状态见 §0。

---

## 0. 本矩阵的当前状态（2026-10-03 回写）

**权威口径不是本文，而是机械审计**：`node tools/qa/audit-acceptance.mjs`（判据 × 证据逐条核对）。

| 指标 | 值（2026-10-03 实跑） | ★ 2026-10-09 实跑（完善轮） |
|---|---|---|
| 正式判据总数 | **24**（A1–A24；**本文原表只列到 A20**，A21–A24 见 `DELIVERY.md` §3.3/§3.4） | **30**（新增 A2c..A2g 五条桌宠常驻/启动行为判据，见 §0.6） |
| PASS | **24** | **30** |
| FAIL / 进行中 / 无证据 | **0 / 0 / 0** | **0 / 0 / 0** |
| 交付文档引用的证据文件 | 28 个，缺失 **0** | 28 个，缺失 **0** |
| 门禁 | — | `check-claims.mjs` **14/14 条**（原 11 + 新增 3）；单测 **424 + 35 + 44 + 55** 全绿 |

> ⚠ **上表右列的意义**：判据总数从 24 → 30 是**口径变化的直接后果**
> （新默认行为"打开软件只出现对话窗口"需要它自己的判据），
> 不是"临时多报了几条"。全部命令见 §0.6.2。

### 0.1 ⚠ 证据新鲜度（比"通过与否"更要紧的一条）

`PASS=24` 所引证据的基准日是 **2026-09-27 ~ 09-28**，而代码已推进到 **2026-10-02**（其后本会话又有改动）。
**⇒ 不能拿这份 24/24 声明"当前代码通过"。**

**2026-10-03 已重建的活体读数**（当前代码，证据目录 `docs/evidence/phase14/baseline-20261003/`）：

| 判据 | 今日读数 | 证据 |
|---|---|---|
| A1 应用实例数 = 1 | `visibleWindows=1` / `allWindows=1`，切换全程不变 | `petmode.json`（`start.allWindows`） |
| A2 可见主窗口数 = 1 | **⚠ 口径已两度改写**（§0.5.2 → §0.6）：**默认启动时角色窗口 = 0、chat = 1**（新默认行为"打开软件只出现对话窗口"）。2026-10-09 读数：`titles-match-roles=true`、`mineCharacterVisibleWindows=0`、`mineChatVisibleWindows=1`；呼出/常驻后角色 = 1 | `phase17/chatwindow.json`、`phase17/petresident.json`、`phase17/petresident-shots.json` |
| **A2c..A2g 桌宠常驻与启动行为** | ✅ **已实跑**（2026-10-09）：`petresident.json` 49/49、`petresident-start-resident.json` 42/42、`petresident-restart.json` 7/7、`menuopen.json` 5/5、六张桌面截图 6/6 | `phase17/petresident*.json`、`phase17/menuopen.json`、`phase17/petresident-shots.json`、`phase17/CHAT-WINDOW-ROUND2.md` |
| A3 旧 `MateEngineX` 可见窗 = 0 | `desktop-state-*.json` → `counts.legacyKernelVisibleWindows=0`（旧宿主已于 2026-10-08 卸载，`legacyKernelAllWindows=0`） | `phase16/desktop-state-20261008-153446.json` |
| A4 旧 `build\pet` 可见窗 = 0 | 同上 → `counts.legacyPetVisibleWindows=0` | 同上 |
| A5/A7/A8 单 Scene/Renderer/Mixer | `stage` 快照在切换前后各取一次，`clipIds=16`、`failed=0` | `petmode.json`、`kit.json` |
| A6 Live2D = 0 | 静态断言 `no-live2d-dependency` **通过**（工程内不存在 live2d 依赖） | `node tools/qa/check-claims.mjs` |
| A10 轮盘锚点误差 ≤ 2px | `maxErrPx=0`、`passHitRegionMatchesVisual=true`、`passWheelInWindow=true` | `a10.json` |
| A11 输入语义 | 17 项 pass* 全真（尺寸口径 2026-10-08 改为「≤1 DIP 且可复现」） | `phase16/a11.json` |
| A12 腿部动作 | 7 项 pass* 全真 | `a12.json` |
| A13 待机 ≥10 / 12s 轮换 | 4 项 pass* 全真 | `a13.json` |
| A14 拖拽 + 尺寸恒定 | 9 项 pass* 全真 | `a14.json` |
| A17 密钥命中 = 0 | 分发包扫描 0 命中；完整性复算 PASS | `node tools/qa/scan-dist-payload.mjs`、`verify-dist-integrity.mjs` |
| A18 非环回监听 = 0 | 6 个本机关键端口全部未监听；诊断 `listeningPorts` 空 | 见 `docs/evidence/phase14/基线重建-2026-10-03.md` §5 |
| A19 旧自启 = 0 | `A19` 系列（09-27）仍为唯一证据；**未重跑** | `phase7/A19-*` |
| A20 视觉截图 | 今日新截 `screens/desktop-full-20261003-233052.png` | `phase14/baseline-20261003/screens/` |
| **A15 / A16 2 小时浸泡** | ✅ **已实跑** `phase8/A15-soak-run7-summary.json`（**2026-10-06**，7206 s / 241 样本 / 0 不变量违规 / 100% 可见 / fps 均值 66.5 / 堆斜率 0.035 MB/min / `passA15=passA16=true`） | `phase8/A15-soak-run7.jsonl`、`phase8/negative-clock-criterion-2026-10-06.json` |

**⇒ 结论口径**：A1–A14、A17、A18、A20 有**当日**活体读数；
**A15/A16 已推进到 2026-10-06**（其上一条 run5 基准日为 09-28，已被 run7 取代）；
A19 未重跑（其判据依赖安装/卸载/重启三时点，属独立演练）。

> ### ★★ 2026-10-09（完善轮）：A2 系列与**启动行为**的口径再次变更
>
> 本轮把默认启动行为改成「**打开软件只出现对话窗口，桌宠要另外呼出**」
> （`petResident=false` + `startupOpenChat=true`，见 §0.6）。后果：
> * `visibleCharacterWindowCount` 的期望值从 `1` 变成 **`0 或 1`**；
> * `visibleMainWindowCount` 的合法集合从 `{1,2}` 变成 **`{0,1,2}`**；
> * **`characterWindowCount == 1`（窗口对象恒为一个）才是那条硬不变量** ——
>   可见性只是状态，不是不变量；
> * `soak-2h.ps1` 里把 `characterVisibleWindowCount != 1` 从"违规"**降级为记录**
>   （否则一份按默认设置跑的 2 小时浸泡会被判成"角色窗口不见了"）；
> * **A15/A16 的 2 小时证据尚未按新口径重跑** ⇒ 旧证据（run6/run7）仍有效，
>   但"新口径下的 2 小时"标 `NOT VERIFIED`（见 `phase17/CHAT-WINDOW-ROUND2.md` §4）。

> ### ★ 2026-10-06：A15 的「动画时钟」判据被**用户裁定修改**（口径变过，必须留痕）
>
> **原判据**：相邻样本的 `activeTimeSec` **必须全部相异**（`changes >= count-1`）。
> **新判据**：`相异率 ≥ 95%` **且** `最长连续相同 ≤ 3 样本` **且** `相异取值 ≥ 30% × 样本数`。
>
> **为什么改**：run7 跑满 7206 s、0 不变量违规、100% 可见、fps 66.5、堆斜率 0.035、
> 6 个 clip 正常轮换、`passBoneMotion=True`，却被原判据判 FAIL ——
> 失败来自**采样混叠**：`30 s 采样 ÷ 12 s 轮换 = 2.497 index/样本`
> ⇒ 每 4 个样本循环一次，`_8→_10` 交界**必然**反复落在采样点上。
> 实测 236 个相邻对里只有 5 对同值（相异率 97.88%），最长连续相同仅 2 样本且取值不同。
> **对照 run5（同样参数）0 对同值** ⇒ 原判据在**本采样参数下偶发不稳定**：
> 同一产品状态一轮过、一轮不过。
>
> **改动的代价已被补上**（不是单纯放宽）：新增的「相异取值 ≥30%」断言拦住了
> "低基数循环"这类卡死形态。负向验证见 `phase8/negative-clock-criterion-2026-10-06.json`：
> 时钟全冻 ⇒ **抓住**；每 10 样本循环 ⇒ **抓住**；
> ⚠ 但**「单调蠕变且不回绕」仍能骗过本判据** —— 该形态人造，真实 `AnimationMixer` 不会产生。
> ⇒ **本判据不证明"时钟以正确速率推进"**，那件事由 `passBoneMotion`（骨骼四元数每对都在变）
> 与 `uniqueClips`（clip 真的在轮换）独立负责。

### 0.2 A25–A29 不是矩阵条目（防止误引用）

矩阵与 PRD 只定义到 **A24**。`A25`–`A29` 是**临时回归标签**，只用于文件名，**不是新判据**：

| 标签 | 实际内容 |
|---|---|
| A25 | 舞台动作运行时补测 + 2 个缺陷修复（回归 A12/A13/A14） |
| A25+ | 浸泡暴露缺陷：待机轮换从未落到 mixer 上 |
| A26 / A27 / A29 | 2 分钟帧率抽检（各 7 样本、120 s），用于快速回归 |
| A28 | 单实例/单窗口 6/6 检查（`phase13/A28-single-instance.json`） |

### 0.3 以下行内的 `NOT VERIFIED` 自述保留原样

§2 主矩阵行内的状态列**不再逐行回写**（回写 20 行会引入新的漂移面）。
**唯一权威结论请跑 §0 的那条审计命令**；本文行内状态按 2026-09-27 当时的口径保留，作为历史。

### 0.4 ★ 静态断言门禁（`check-claims.mjs`）：2026-10-06 由用户裁定重写（A9 方案 ①）

**背景**：`no-remote-resources-in-bundle` 长期 FAIL，命中的 5 个 URL 全是**默认值字面量**
（`https://api.deepseek.com/v1` ×4：设置项默认值 + 表单 placeholder；两个 Open-Meteo 端点默认值）。
原正则 `["'`(]https?://…` **不区分"资源加载"与"随便一个字符串"**，属断言口径过宽的假阳性。

**裁定**：**① 口径拆分** —— 只认真正的资源加载上下文，默认值作**具名豁免**，
并把"renderer 无出网原语"新增为明确断言。

**重写后的静态断言从 8 条变成 11 条**：

| 断言 | 性质 |
|---|---|
| `no-remote-resources-in-bundle` | **改窄**：只认 `<script src=>` / `<link href=>` / `import()` / `new URL()` / `src=`/`href=` / CSS `url()` 六种加载上下文 |
| `renderer-source-has-no-egress-primitive` | **新增**：renderer **源码**里 fetch / XHR / WebSocket / EventSource / sendBeacon 命中数必须为 0 |
| `bundle-network-primitives-are-known-and-constrained` | **新增**：产物里只允许**已具名配额**的库级 `fetch`（Vite 预加载 helper ×1 + three.js 加载器 ×3），XHR/WebSocket/EventSource 一律不允许 |
| `renderer-csp-blocks-remote-egress` | **新增**：CSP 基线（`default-src`/`script-src`/`connect-src` `'self'`、`object-src none`、`base-uri none`），且**源码与产物两份必须一致** |

#### ⚠ 这一轮我自己的两个错判，都记在这里

1. **"renderer 的 fetch 命中 0" 只对源码成立，对产物不成立。**
   我此前据源码 0 命中推断"渲染进程没有出网原语"——**源码是对的，产物不是**：
   产物里有 Vite 的 dynamic-import 预加载 helper（1 处）与 three.js 的
   `FileLoader` / `ImageBitmapLoader`（3 处）。⇒ 把它写成**产物**的性质就是假断言。
   现在拆成"源码严格为 0" + "产物只有具名库级原语"两条。

2. **CSP 断言最初查错了对象。** 权威 CSP 在源码 `apps/renderer/index.html`，
   而我最初只查它；负向测试往**产物**注入违规时这条断言**照样全绿**，
   看起来像"断言恒真"，实际是**断言与测试各查一份**。
   ⇒ 现在**两份都查**，并且额外要求两份**一致**（产物才是真正生效的那份）。

#### 为什么这些库级 `fetch` 够不成出网（两道锁，缺一不可）

1. **跑不出远程**：CSP `default-src 'self'` / `script-src 'self'` /
   `connect-src 'self' app: blob: data: http://127.0.0.1:* ws://127.0.0.1:*`
   ⇒ 就算代码去 fetch 一个外域，也会被 CSP 拦掉。
2. **没有远程地址可去**：renderer 只从主进程拿到 `app://model` / `app://asset` 这类本地 URL；
   远程 URL 不进任何出站投影（`redactDeep` 与适配层投影的职责）。

#### 负向验证（证明新断言不是恒真）

`node tools\qa\negative-claims-test.mjs` —— 向真实产物注入违规，要求对应断言**必须变红**，
无论成败都在 `finally` 里**逐字节还原**（实测还原后 sha256 与注入前一致）：

| 注入 | 期望变红的断言 | 结果 |
|---|---|---|
| `<script src="https://evil…">` | `no-remote-resources-in-bundle` | ✅ 抓住 |
| `<link href="https://cdn…">` | 同上 | ✅ 抓住 |
| CSS `url(https://fonts…)` | 同上 | ✅ 抓住 |
| `import("https://cdn…")` | 同上 | ✅ 抓住 |
| `connect-src *` | `renderer-csp-blocks-remote-egress` | ✅ 抓住 |
| `script-src 'self' 'unsafe-eval'` | 同上 | ✅ 抓住 |

**6/6 被抓住**。⇒ 门禁由「8 条断言，其中 1 条长期假红」变为
**「11 条断言全绿，且每条都经负向验证证明确实会红」**。

---

### 0.5 ★★ 窗口模型变更裁定（2026-10-08，用户明确否决旧形态）

#### 0.5.1 被否决的形态与**根因**（必须留档，否则会有人再犯一次）

上一轮把「对话框」做成了 **pet 窗口内部贴底的 dock**（`components/ConversationDock.vue`），
并把 pet 窗口从 `340×420` 放大到 `380×560`（`WINDOW_GEOMETRY.conversation`
+ `window-manager.ts` 的 `enterConversationLayout()`）来腾地方。

**根因不在实现方**：上一版规格写了「应用只创建一个 `BrowserWindow` / 可见窗口数 = 1」的硬约束
（本文 §1.5、PRD:15/20/88、Tech-Spec:38/39/119/121 都是它的落点），
于是实现方**只能**把聊天塞进桌宠窗口 —— 那不是偷懒，是被约束逼出来的唯一解。

**用户裁定（原话口径）**：聊天对话框与桌宠必须是**两个完全独立的窗口**，
不能被塞在同一个面板里。该硬约束**在本次被显式修改**（见 0.5.2）。

#### 0.5.2 新的三条口径（**取代** A2/A3/A4 的「可见窗口数 = 1」）

| 新口径 | 判据读数 | 证据 |
|---|---|---|
| ① **角色可见窗口数 = 1**（只有 pet 窗口渲染角色） | `chat.json.windows` 里 `title === 'AiriMate One'` 的可见窗口数 = 1；`desktop-state-*.json` → `counts.mineCharacterVisibleWindows = 1` | `phase16/chatwindow.json`、`phase16/desktop-state-20261008-153446.json` |
| ② **chat 窗口内 WebGL canvas 数 = 0**，且 `Scene/Renderer/Mixer/VRM` 计数全为 0 | `chat.json.uniqueness.chatUi` → `canvasCount=0`、`stageHandlePresent=false`、`stageCanvasInDom=0` | 同上 |
| ③ **全应用 `WebGLRenderer` 总数恒为 1**，且只存在于 pet 窗口 | `chat.json.uniqueness.stage` → `sceneCount=1 / rendererCount=1 / mixerCount=1 / vrmCount=1 / live2dCount=0`（取自 **pet** 窗口），与 chat 窗口的 `canvasCount=0` 相加即总数 1 | 同上 |

**Chromium 渲染进程数变成 2 是允许的**（Electron 每个窗口一个 renderer），
**不算**违反「单角色」；本文 §1.5 的 `helperProcessCount` 一行原本就写着
「≥1，**不设上限**，只记录」，这条既有授权继续有效。

#### 0.5.3 随之作废/删除的东西（改完不许残留）

| 作废项 | 处置 |
|---|---|
| `WINDOW_GEOMETRY.conversation = {380×560}` | **删除**；新增 `WINDOW_GEOMETRY.chat = {720×560}` / `chatMin = {560×420}` |
| `window-manager.ts` 的 `enterConversationLayout` / `exitConversationLayout` / `isConversationLayout` / `syncConversationLayoutForMode` / `conversationSizeDiagnostics` / `petLayoutSize` | **全部删除**；pet 尺寸恒为 `340×420` |
| 「打开对话就放大 pet 窗口」的逻辑 | **删除**；`conversation:open` 改成「显示并聚焦**独立 chat 窗口**」 |
| `ConversationDock.vue`（pet 窗口内贴底 dock） | **删除**（内容并入 `components/ChatWindow.vue`）；pet 窗口内**对话类输入框 = 0** |
| `ConversationState.layout` 的 `'conversation'` 取值 | **删除**；`layout` 现在只描述 **pet 窗口自己**的形态（`panel`/`pet`），与「对话窗口开没开」解耦 |
| 旧判据「对话打开后窗口尺寸 = `WINDOW_GEOMETRY.conversation`」等一整套 | 由新的 `--probe chatwindow` 取代（见 §2.4） |

#### 0.5.4 ★ 入口语义定稿（**五条入口完全一致**）

**轮盘「对话」/ 托盘「开始对话」/ `Ctrl+Alt+Space` / 双击角色 / 语音唤醒**
一律 **显示并聚焦** chat 窗口；**再次触发只聚焦，绝不隐藏**
（对齐参考实现 `DockPetWin` 的 `if (chat is { IsVisible: true }) { Activate(); return; }`）。

隐藏只有三条路：chat 窗口的「×」、chat 窗口里的 `Esc`、托盘「结束对话」。

**为什么这样定**（不是随手选的）：五条入口如果各有一套 toggle 语义，
「按了没反应」就无法归因；而「同一个按钮点两次把窗口点没了」是比
「多点一次没反应」更坏的体验。**判据**：
`chat.json` 的 `singleton.reopen-keeps-open-without-state-churn` ——
连续重开 3 次后 `hwnd` 不变、`createdCount=1`、`openCount=1`（**没有**发生关→开循环）、
窗口仍可见。

#### 0.5.5 ★ 几何读数口径（125% 缩放下的取整，判定必须带容差）

本机 `scaleFactor = 1.25`，`getBounds()` 的**读回值**与请求值差一个位置相关的取整量
（`phase3/round-interaction/sizeDiag.json` 实测：请求 470→472、482→484）。
因此：

| 判据 | 请求值 | 实测读回 | 判定容差 |
|---|---|---|---|
| chat 默认尺寸 | `720×560` | `727×567` | 请求值必须**精确等于** 720×560；读回值允许 **±8 DIP** |
| chat 居中 | workArea 中心 | 实际中心 | 误差 **≤8 DIP**（实测 4） |
| pet 尺寸 | `340×420` | `341×420` | **±1 DIP**，且**逐位不变**（后者才是要紧的那条） |
| chat 记忆几何 | 设 640×480 | 读回 641×481 | **±8 DIP** |

⚠ 「请求值 vs 读回值」必须**分开断言**：只比读回值会把平台取整判成实现错误；
只比请求值则会漏掉"窗口根本没按请求落点"这种真错误。

---

### 0.6 ★★ 桌宠常驻与启动行为（**2026-10-09 完善轮新增**）

> 规格来源：`PRD.md` **FR-1b**；实现落点：`Tech-Spec.md` **§4.1c**。
> 本节写的是**怎么测**，以及**哪些旧口径被取代了**。

#### 0.6.1 旧行为如何被取代（必须留痕，否则会有人以为这是回归）

| 旧行为 / 旧表述 | 现状 |
|---|---|
| 「打开软件就自动出现桌宠」（2026-10-08 及之前**唯一**的启动形态） | **取代**：默认 `petResident=false` ⇒ 启动**不显示**桌宠。要恢复旧观感需显式设 `petResident=true` + `startupOpenChat=false` |
| 「可见窗口数恒为 1 或 2」 | **取代**：默认 = 1（只有对话窗口）；两个开关都关 = **0**（只剩托盘）。判据改为按身份计数（§1.5） |
| chat 窗口 `frame:false` + 自绘标题栏 | **取代**：`frame:true`（系统原生边框）。见 §0.6.3 |
| chat 窗口标题 `AiriMate One · 对话` | **取代**：`和 {角色名} 聊天`（对齐参考实现） |
| 「对话窗口打开后 pet 窗口读数逐位不变」 | **保留但需重新表述**：现在还要保证"**可见性**变化不影响几何与模式"（呼出/收回都不改尺寸/位置/模式） |
| `ConversationDock.vue`（pet 窗口内贴底 dock） | **文件已删除**（2026-10-08 文档说删了，但磁盘上仍在 ⇒ 本轮补删） |

#### 0.6.2 两个设置的默认值与组合（判据 C1/C2/C3 的口径）

| 设置 | 默认 | 含义 |
|---|---|---|
| `petResident` | **`false`** | 启动（含开机自启）**不显示**桌宠；桌宠只在被"呼出"时出现 |
| `startupOpenChat` | **`true`** | 启动时打开**对话窗口** |

| `petResident` | `startupOpenChat` | pet 可见 | chat 可见 | 托盘 |
|---|---|---|---|---|
| `false`（默认） | `true`（默认） | ✗ | ✓ | ✓ |
| `true` | `true` | ✓ | ✓ | ✓ |
| `false` | `false` | ✗ | ✗ | ✓ |
| `true` | `false` | ✓ | ✗ | ✓ |

**判据 C1..C10（本轮）**：

| # | 判据 | 读数口 |
|---|---|---|
| C1 | 默认启动态：pet `visible=false`、chat `visible=true`、托盘存在、两窗口都已创建 | `phase17/petresident.json` → `startup.*`、`C1.*` |
| C2 | 勾上常驻：pet `visible=true` + `settings.petResident=true`（**写进文件**）+ **重启后仍可见** | 同上 `C2.*` + `phase17/petresident-restart.json` |
| C3 | 取消常驻：pet `visible=false` + 写盘 `false` | 同上 `C3.*` |
| C4 | 三处菜单勾选**完全同步**（主进程 / chat 菜单镜像 / pet 窗口镜像逐字段相等） | 同上 `C4.*`、`syncReadings` |
| C5 | chat 窗口：标题 `和 X 聊天`、外框 720×560（±16）、最小 560×420、可最小化/最大化、**能移动** | 同上 `C5.*`、`chatWindow.*` |
| C6 | 菜单栏**逐项点击都有可观测动作**，无死项（19 项 / 6 组） | 同上 `C6.*`、`menuRun.results` |
| C7 | 窗口计数与角色唯一性（BrowserWindow = 2、chat canvas = 0、WebGLRenderer = 1） | 同上 `C7.*`、`uniqueness.*` |
| C8 | 回归：A10 / A11 / A14 / petoverlay / ui | `phase17/a10.json`、`a11.json`、`a14.json`、`petoverlay.json`、`ui.json` |
| C9 | 真实桌面截图 6 张 | `phase17/petresident-shots.json`、`phase17/menuopen.json` |
| C10 | 没跑的项一律 `NOT VERIFIED` | 见 `docs/evidence/phase17/CHAT-WINDOW-ROUND2.md` §4 |

**取证命令**（逐条可原样重跑）：

```powershell
# C1..C7（主探针；--probe petresident）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\run-probe.ps1 `
  -Name petresident -Mode pet -TimeoutSec 300 -OutDir docs\evidence\phase17 -ExtraArgs '--no-proactive'

# C2/C3 的"重启后"那一半（两次独立进程启动）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\petresident-restart.ps1 `
  -OutDir docs\evidence\phase17 -TimeoutSec 300

# C5/C6 的对话窗口那一半（返工轮探针，口径已按本轮更新）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\run-probe.ps1 `
  -Name chatwindow -Mode pet -TimeoutSec 300 -OutDir docs\evidence\phase17 -ExtraArgs '--no-proactive'

# C9 六张真实桌面截图（内含 --probe menuopen 的哨兵握手）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\petresident-shots.ps1 `
  -OutDir docs\evidence\phase17 -TimeoutSec 300

# C8 回归
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\run-probe.ps1 -Name a10 -Mode panel -OutDir docs\evidence\phase17
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\run-probe.ps1 -Name a11 -Mode panel -OutDir docs\evidence\phase17
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\run-probe.ps1 -Name a14 -Mode panel -OutDir docs\evidence\phase17
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\run-probe.ps1 -Name petoverlay -Mode pet -OutDir docs\evidence\phase17
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\run-probe.ps1 -Name ui -Mode panel -OutDir docs\evidence\phase17
```

#### 0.6.3 ★★ 对话窗口改用系统原生边框（`frame:true`）

**这一条是本轮对齐参考实现的第一件事**，也是**尺寸口径变化的根源**。

| 项 | 旧（`frame:false`） | 新（`frame:true`） |
|---|---|---|
| 拖动 / 缩放 / 最小化 / 最大化 | 自绘标题栏 + 按钮（复刻不出系统菜单与贴边手势） | **系统提供** |
| 标题栏 | `ChatWindow.vue` 里的 `.chatw__titlebar` | **系统**（读 `BrowserWindow.getTitle()`） |
| 客户区顶部 | 自绘标题栏 | **我们自己的深色功能菜单栏**（避免与 Electron 菜单栏混淆：`setMenuBarVisibility(false)`） |
| `width/height` 语义 | 就是外框（无装饰） | **含系统装饰**（本机实测 +20 / +19 DIP） |
| 请求值 | 720×560 | **700×541**（= 720×560 − 装饰量） |
| 外框读回 | 727×567（平台取整） | **720×559**（实测） |
| 判定 | 请求值精确 720×560 / 读回值 ±8 | 外框 **±16 DIP** + 请求值按装饰量精确核对 |

⚠ `frame` **没有 getter**（Electron 不提供 `isFrameless()`）⇒ 探针**不写恒真断言**，
改为断言只有 `frame:true` 才成立的三条性质（`resizable/minimizable/maximizable` 全真、
`isMenuBarVisible() === false`、客户区高度 ≈ 外框高度），
并由**真实桌面截图**（能直接看到系统标题栏与右上角三个按钮）覆盖。

---

## 1. 怎么读这份矩阵

### 1.1 合法状态定义

| 状态标记 | 含义 | 允许的动作 |
|---|---|---|
| `PASS` | 已执行，命令退出码 0，产物 JSON 内 `"pass": true` / `"matches": true`，原始 stdout 已归档 | 才可写"完成" |
| `FAIL` | 已执行且断言不成立 | 必须附失败产物；修完重跑 |
| `NOT VERIFIED` | 命令已冻结但**尚未执行**（`待执行`） | 允许存在于未开工阶段；门禁前必须消掉 |
| `BLOCKED` | 因外部条件无法执行，且已有明确解阻路径 | 必须写明阻塞 ID |
| `BLOCKED-PENDING-USER` | 阻塞点是**用户裁定**（BLOCKER-1） | 必须写明受影响判据与三个选项 |
| `N/A-BY-DESIGN` | 该判据按 PRD 非目标明确不做 | 必须在同一行给出替代判据 |

### 1.2 铁的规则（违反即视为虚假验收）

1. **`NOT VERIFIED` 与 `BLOCKED` 是合法交付状态**；"完成"不是。
2. 任何一条判据写"完成"，必须同时具备**三件套**：①一条可直接复制的命令；②该命令的**原始 stdout/stderr**（原样保存，不许改写成叙述）；③证据路径（存在且可打开）。
3. 缺任一件 ⇒ 该行状态回退为 `NOT VERIFIED`。探针脚本自身输出 `"pass": true` **不构成**通过，必须有人核对期望值。
4. 禁止用"看起来正常""应该没问题""和上次一样"替代原始输出。
5. 证据文件必须是**该次运行产生的新文件**；禁止复用旧时间戳的证据（`tools/qa/` 的每个脚本必须在 JSON 里写 `generatedAt`，复核时比对）。
6. 视觉类判据（A10 锚点、A20 视觉验收、S4 静态像素）**必须**附真实桌面截图；无截图视为未执行。
7. 未执行的文件不许写成已存在：本文所有"证据路径"均为**规划路径**。

### 1.3 证据路径与命名约定（全局唯一约定）

```
docs/evidence/<phase>/<id>.json          ← 探针结构化产物（UTF-8 无 BOM，ConvertTo-Json -Depth 12）
docs/evidence/<phase>/<id>.txt           ← 同一次运行的原始 stdout+stderr（Tee-Object 原样落盘）
docs/evidence/<phase>/screens/<id>-<step>-<ts>.png  ← 真实桌面截图（CopyFromScreen 或窗口截图）
```

- `<phase>` 取 `phase0` … `phase7`，与本文 §4 的 P0..P7 一一对应（P0..P7 与 PRD §10 第 1..8 行同序）。
- `<id>` 取判据号 `A01`…`A20`（两位数，便于排序）或场景号 `S1`…`S9`。
- `<ts>` 取 `yyyyMMdd-HHmmss`。
- 一次运行只产生**一个** `.json` + 一个同名 `.txt`；重跑覆盖同名文件并在 JSON 的 `runs[]` 里累加历史摘要（禁止只留最后一次而无历史）。
- 环境事实（进程/窗口/端口/注册表）与**截图**若要复现，`.txt` 里必须能看到产生它的那条命令的完整命令行。

### 1.4 探针与工具约定（贯穿全表）

| 约定 | 内容 |
|---|---|
| 渲染侧计数与状态 | 只读探针 `window.__AIRIMATE_STAGE__`（Tech-Spec §9）。**仅在 `--diagnostics` 模式挂载**，返回只读快照；实现要求：每层 `Object.freeze`，字段为纯数据，无函数、无 three 句柄、无可变引用；取快照必须是对当前帧的深拷贝 |
| 主进程计数与状态 | `app:diagnostics`（只读），经 `--diagnostics <file>` 导出 JSON，**不新开端口** |
| 进程/窗口清点 | P/Invoke `EnumWindows` + `GetWindowTextW` + `GetWindowThreadProcessId` + `IsWindowVisible` + `GetWindowRect` + `GetWindowLongPtrW`，与 `Get-CimInstance Win32_Process`（`ExecutablePath` + `CommandLine`）按 PID 关联（见 §1.5） |
| 归属判定 | 只允许：完整路径前缀 / SHA256 / 项目标记文件 / 数字签名。**禁止只凭进程名判定**（PRD FR-3.2） |
| 用户输入仿真 | 鼠标：P/Invoke `SetCursorPos` + `mouse_event`；键盘：`keybd_event`（`SendKeys` 仅在已确认前台窗口句柄时兜底，见 §3） |
| 脚本语言 | 一律 Windows PowerShell **5.1**（`powershell.exe`）。禁用 `??`、三目运算符、`-Parallel`、`ForEach-Object -Parallel`、`&&`/`||` 链 |
| 非 ASCII 路径 | 命令行中一律用单引号包裹，如 `'F:\deepseek harness\AI女友\新工程'` |

### 1.5 窗口清点的精确技术（所有"窗口数"判据共用）

任何"可见窗口数 = N"的判据，判定链固定为四步，缺一不可：

1. `EnumWindows` 枚举**顶层窗口**（天然只含顶层），取 `hwnd`、标题、类名、`pid`、`IsWindowVisible`、`GetWindowRect`。
2. `Get-CimInstance Win32_Process` 取全部进程的 `ProcessId/ParentProcessId/Name/ExecutablePath/CommandLine`。
3. 按 `pid` 关联窗口 ↔ 进程；`ExecutablePath`/`CommandLine` 为 `null` 的进程标记 `executablePathReadable=false` 并**单列**，不得默认为"无关"。
4. 归属谓词（只用路径/哈希/标记文件/签名），逐条可解释：

```powershell
# 归属谓词（写进 tools\qa\lib\Ownership.ps1，被所有脚本复用）
# L1 legacy-project 前缀
'F:\deepseek harness\AI女友\build\'  # 旧工程 build 前缀（含 workcopy / workcopy-airi / pet）
'F:\deepseek harness\AI女友\src\'    # 旧宿主/桥源码
'F:\deepseek harness\AI女友\tools\'  # 旧 host/gateway/link 工具
# L2 MateEngineX 命中条件：进程名 MateEngineX.exe 且（映像路径在前缀内 或 SHA256 命中已知清单 或 命令行/工作目录含 MateEngineX_Data）
# L3 旧 build\pet：映像路径以 node_modules\electron\dist\electron.exe 结尾 且 命令行含 build\pet\app\main.mjs
# L4 本应用：映像路径 = "<install>\AiriMateOne.exe" 或 其 Chromium 子进程（--type= 且 --user-data-dir 指向本应用 userData）
```

**计数器定义（消歧，必须按此实现）**

| 计数器 | 定义 | 期望 |
|---|---|---|
| `appInstanceCount` | 路径属本应用的**非 `--type=`** 根进程数（Electron 主进程） | 1 |
| `helperProcessCount` | 本应用 `--type=` 子进程数（GPU/renderer/utility） | ≥1，不设上限，只记录 |
| `mutexKeeperRunning` | `MutexKeeper.exe` 进程存在且已打印 `HELD <pid>` | true |
| `visibleMainWindowCount` | 本应用根进程拥有的、`IsWindowVisible=true` 的顶层窗口数 | **0 / 1 / 2**（见下方 ⚠⚠） |
| `visibleCharacterWindowCount` | 其中 `title = 'AiriMate One'` 的可见窗口数（渲染角色的那个） | **0 或 1**（§2.5：默认启动时是 **0**） |
| `visibleChatWindowCount` | 其中 `title` 匹配 `和 {角色名} 聊天` 的可见窗口数 | **0 或 1** |
| `visibleLegacyMateEngineXWindowCount` | 归属 L2 的进程拥有的可见顶层窗口数 | 0 |
| `visibleLegacyPetWindowCount` | 归属 L3 的进程拥有的可见顶层窗口数 | 0 |

> ⚠ **`visibleMainWindowCount` 的期望值在 2026-10-08 由 `1` 改成 `1 或 2`**（见 §0.5）：
> 本应用现在**恰好两个**窗口（角色 + 独立对话窗口），chat 打开时正确的可见窗口数就是 **2**。
> 把总数当唯一判据会把"正确的两个窗口"读成"多了一个窗口" —— 所以真正要判的是
> **按身份分出来的那两个数**，总数只作旁证。
> `Get-DesktopState.ps1` 已同步输出 `mineCharacterVisibleWindows` / `mineChatVisibleWindows`。

> ⚠⚠ **2026-10-09 完善轮再改一次，而且这次是把"总数"彻底降级为旁证**：
> 新的默认启动行为是「**打开软件只出现对话窗口，桌宠要另外呼出**」
> ⇒ 默认状态下 `visibleMainWindowCount = 1`、`visibleCharacterWindowCount = **0**`、
> `visibleChatWindowCount = 1`。两个开关都关时甚至是 **0**（只剩托盘图标，合法状态）。
> ⇒ **不许再拿任何一个单独的数当判据**：
> 判据是"**按身份的两个数各自在允许集合内，且两者之和 = 总数**"（§2.5 的四条组合表）。
> `visibleCharacterWindowCount = 0` 在默认启动下是**正确**的，不是"角色不见了"。

> ⚠ **chat 窗口标题的口径在 2026-10-09 变了**（对齐参考实现
> `DockPetWin/AgentChatWindow.xaml` 的 `Title="和爱弥斯聊天"`）：
> 旧值 `AiriMate One · 对话` → 新值 **`和 {角色名} 聊天`**。
> ⇒ 任何按旧标题匹配的枚举脚本/判据都必须跟着改，否则会得到
> **恒假**的结论（"chat 窗口不存在"），而窗口其实好端端地开着。

> 说明：`MutexKeeper`（Tech-Spec §3.2）是纯守卫进程、无窗口，不计入 `appInstanceCount`，但必须计为"本应用进程组"成员。`UnityCrashHandler64.exe` 等旧附属进程按 L1 归属计入"旧实例"报告，但不因它单独判 FAIL。

### 1.6 P/Invoke 底座（所有脚本共用，原样可跑）

```powershell
# tools\qa\lib\Win32.ps1  —— 被所有探针 dot-source
$src = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class QAWin32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtrW(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, int dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public const int GWL_STYLE = -16, GWL_EXSTYLE = -20;
  public const uint MOUSEEVENTF_LEFTDOWN=0x0002, MOUSEEVENTF_LEFTUP=0x0004, MOUSEEVENTF_RIGHTDOWN=0x0008, MOUSEEVENTF_RIGHTUP=0x0010, MOUSEEVENTF_WHEEL=0x0800;
  public const uint KEYEVENTF_KEYUP = 0x0002;
}
"@
if (-not ('QAWin32' -as [type])) { Add-Type -TypeDefinition $src -Language CSharp }
```

### 1.7 用户输入仿真（S4/S5/S6 等场景共用）

```powershell
function Invoke-QaMouseMove([int]$x, [int]$y) { [void][QAWin32]::SetCursorPos($x, $y); Start-Sleep -Milliseconds 60 }
function Invoke-QaLeftDown()  { [QAWin32]::mouse_event([QAWin32]::MOUSEEVENTF_LEFTDOWN, 0,0,0,[UIntPtr]::Zero) }
function Invoke-QaLeftUp()    { [QAWin32]::mouse_event([QAWin32]::MOUSEEVENTF_LEFTUP,   0,0,0,[UIntPtr]::Zero) }
function Invoke-QaRightClick(){ [QAWin32]::mouse_event([QAWin32]::MOUSEEVENTF_RIGHTDOWN,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 40; [QAWin32]::mouse_event([QAWin32]::MOUSEEVENTF_RIGHTUP,0,0,0,[UIntPtr]::Zero) }
function Invoke-QaKey([int]$vk) { [QAWin32]::keybd_event([byte]$vk,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 30; [QAWin32]::keybd_event([byte]$vk,0,[QAWin32]::KEYEVENTF_KEYUP,[UIntPtr]::Zero) }
# VK 表：F1=0x70, ESC=0x1B, ENTER=0x0D, LEFT=0x25, UP=0x26, RIGHT=0x27, DOWN=0x28, A=0x41
```

> **注意**：`SetCursorPos` 操作的是**物理桌面坐标**。若 `GetWindowRect` 返回负坐标（副屏在主屏左侧）或窗口在屏幕外，先执行"居中"，否则点击落在窗外、场景假失败。每次点击前必须断言目标点在某个已枚举窗口的 `RECT` 内（写在场景脚本里）。
> **不使用** `SendKeys` 作为首选：它依赖前台焦点且对中文输入法状态敏感。仅当需要输入**文本内容**（S2 聊天输入）时，才在确认目标窗口 `GetForegroundWindow()` 命中后使用 `[System.Windows.Forms.SendKeys]::SendWait()`，并在证据里记录当时的 `hwnd`。

---

## 2. 主矩阵（A1..A20）

> ⚠ **本表是 P0 阶段的"计划版"判据与计划工具**（很多行仍写着"待执行"）。
> **实际验收结论以 `DELIVERY.md §3.3 / §3.4` 与 `node tools/qa/audit-acceptance.mjs` 为准** ——
> 后者直接读 `docs/evidence/**` 的原始 JSON，能区分 `PASS / FAIL / PENDING / 无证据`。
> 本表保留的是"判据语义"（PRD §5 原文），**判据被改写过的地方已在对应行标注**。

> 列含义：`判据`=PRD §5 原文语义（编号不变）；`硬目标值`=可判定的数值/字符串；`验证方法`=具体命令或探针名；`期望原始输出`=可判定的字符串/数值；`证据路径`=按 §1.3；`依赖阶段`=P0..P7；`当前状态`=§1.1 的状态标记。

| 判据 | 硬目标值 | 验证方法（命令 / 探针名） | 期望原始输出 | 证据路径 | 依赖阶段 | 当前状态 |
|---|---|---|---|---|---|---|
| **A1** 新软件应用实例数 | `appInstanceCount = 1` | `powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\proc-window-inventory.ps1 -Invariant appInstance -Out docs\evidence\phase1\A01.json` | `"appInstanceCount": 1`、`"mutexKeeperRunning": true`、`"lockPidMatches": true`、退出码 `0`；同时打印 `instances=1` | `docs/evidence/phase1/A01.json` + `A01.txt` + `screens/A01-launch-<ts>.png` | P1 | `NOT VERIFIED`（待执行） |
| **A2** 可见主窗口数 | **⚠ 口径已改写（2026-10-08，见 §0.5.2）**：不再判"总数 = 1"，改判 **① 角色可见窗口数 = 1**（只有 `title='AiriMate One'` 的那个渲染角色） | `run-probe.ps1 -Name chatwindow`（主）+ `Get-DesktopState.ps1`（旁证） | `chatwindow.json` → `windows.titles-match-roles=true`、`unique.window-count-exactly-two=true`；`desktop-state-*.json` → `counts.mineCharacterVisibleWindows=1` | `docs/evidence/phase16/chatwindow.json`、`docs/evidence/phase16/desktop-state-20261008-153446.json`、`screens/chatwindow-*-pet-running-desktop.png` | P1（P3/P5 复测） | **PASS**（2026-10-08 实测；总数在 chat 打开时为 **2**，见 §0.5.2 的「渲染进程数=2 是允许的」） |
| **A3** 可见 `MateEngineX` 窗口数 | `visibleLegacyMateEngineXWindowCount = 0` | 同上脚本 `-Invariant noLegacyMateEngineX`；归属按 L2 | `"visibleLegacyMateEngineXWindowCount": 0`、`matches=false`、`hits=0`；若命中则同时打印 `pid,imagePath,sha256,title,rect` | `docs/evidence/phase1/A03.json` + `.txt` + `screens/A03-legacy-dialog-<ts>.png`（命中阻断对话框时截） | P1 | `NOT VERIFIED`（待执行；E0 基线实测旧内核窗 `UnityWndClass`/`MateEngineX` 仍在运行，故本条预期先 FAIL，属既知现状） |
| **A4** 旧 `build\pet` 可见窗口数 | `visibleLegacyPetWindowCount = 0` | 同上脚本 `-Invariant noLegacyPet`；归属按 L3（`electron.exe` + 命令行含 `build\pet\app\main.mjs`） | `"visibleLegacyPetWindowCount": 0`、`hits=0`；E0 实测该进程当前未运行，故 `hits=0` 且 `processPresent=false` | `docs/evidence/phase1/A04.json` + `.txt` | P1 | `NOT VERIFIED`（待执行） |
| **A5** 可见 VRM 实例数 | `vrmCount = 1`（且 `vrmInstanceId` 非空、模型 = `Lazuli_VRM.vrm`） | `node tools\qa\probe-stage.mjs --diagnostics docs\evidence\phase3\A05-raw.json --assert vrm=1 --screenshot docs\evidence\phase3\screens\A05-<ts>.png` | `"vrmCount": 1`、`"loadedModel": "Lazuli_VRM.vrm"`、`"vrmInstanceId": "vrm-1"` | `docs/evidence/phase3/A05.json` + `.txt` + `screens/A05-<ts>.png` | P3 | `NOT VERIFIED`（待执行） |
| **A6** 可见 Live2D 实例数 | `live2dCount = 0` | ①`probe-stage.mjs --assert live2d=0`；②静态：`pnpm why live2d`、`Get-ChildItem node_modules -Recurse -Filter '*live2d*'`、`Select-String -Path pnpm-lock.yaml -Pattern 'live2d' -SimpleMatch` | `"live2dCount": 0`、`live2d=0`；②三条**全部** `0 命中`（任一条命中 ⇒ FAIL） | `docs/evidence/phase3/A06.json` + `.txt` | P3 | `NOT VERIFIED`（待执行） |
| **A7** `WebGLRenderer` 数 | `rendererCount = 1` | `probe-stage.mjs --assert renderer=1`；切换 panel↔pet 前后各取一次 `rendererId` | `"rendererCount": 1`、切换前后 `"rendererId"` 相同 | `docs/evidence/phase3/A07.json` + `.txt` + `screens/A07-before-after-<ts>.png` | P3 | `NOT VERIFIED`（待执行） |
| **A8** `AnimationMixer` 数 | `mixerCount = 1` | `probe-stage.mjs --assert mixer=1`；断言 `mixerId` 不变且 `mixer.time` 单调不减 | `"mixerCount": 1`、`"mixerId"` 前后相同、`mixerTime` 后 > 前 | `docs/evidence/phase3/A08.json` + `.txt` | P3 | `NOT VERIFIED`（待执行） |
| **A9** 第二次启动后窗口数 / 角色数 | 不变（`visibleMainWindowCount` 仍 = 1、`appInstanceCount` 仍 = 1、`sceneCount/rendererCount/mixerCount/vrmCount` 四项与首次启动快照相等） | `tools\qa\single-instance.ps1 -Exe '<install>\AiriMateOne.exe' -SecondLaunchArgs '--diagnostics docs\evidence\phase1\A09-second.json'`；脚本流程见 §3 S7 | `"instances": 1`、`"visibleWindows": 1`、`"vrmCount": 1`、`"secondExitCode": 0`、`"focusGained": true`；子进程 `alive=false` | `docs/evidence/phase1/A09.json` + `.txt` + `screens/A09-second-launch-<ts>.png` | P1（角色四项待 P3 复测） | `NOT VERIFIED`（待执行） |
| **A10** 轮盘开→关→开锚点误差 | 三次开合，误差 `≤ 2 px` | `tools\qa\wheel-anchor.ps1 -Cycles 3 -Phase phase6`；每轮：`Invoke-QaMouseMove` 到角色头部 → `Invoke-QaRightClick` → 等 400ms（保证 scale 到位）→ 全屏 `CopyFromScreen` 存档 → `probe-stage.mjs --assert wheel.open=true` 取 `wheel.cx/cy` 与 `scale` → 再右键关闭 → 等 400ms | `"anchorErrPxMean": <2.0`、`"anchorErrPxMax": <2.0`、每轮 `"scale": 1.0`、`"open": true`；误差计算见下 | `docs/evidence/phase6/A10.json` + `.txt` + `screens/A10-cycle1-open-<ts>.png`（1/2/3 各一张 + 关闭态各一张） | P6 | `NOT VERIFIED`（待执行） |
| **A11** 左键行为 | ⚠ **判据已在"桌宠交互与取景修复轮"重写**：**短按什么都不做**；只有"按住 + 移动 > 4 CSS px **且按下点命中角色**"才拖窗口；阈值内与空白处都不得拖；右键/F1/Esc 行为不变（旧表述"左键**只拖拽**"把"按下即拖拽"当成了正确行为 —— 那正是用户报的缺陷一）<br>★ **尺寸子判据再改写（2026-10-08 用户裁定「改判据」）**：从「拖动前后**逐位相同**」改为「**偏差 ≤ 1 DIP 且可复现**」。<br>理由（`--probe sizeMap` 实测，`phase16/sizeMap.json`）：本机 125% 缩放下，只有"请求值本身落在**整物理像素**上"（如 `480×760` = 600×950）时"请求 → 读回"才跨位置一致；半像素尺寸（`482×762` = 602.5×952.5）的读回值随亚像素相位在 ±1 DIP 内摆动 ⇒ "逐位相同"要求了一个**平台不保证**的量。<br>**但放宽必须配"可复现"**：旧缺陷是**累积漂移**（8 步 `482×761 → 528×810`），每步也只涨 1~2 DIP，只判"单步 ≤1 DIP"抓不住它 ⇒ 加判 `passDragSizeReproducible = distinct ≤ 2 且 宽/高都不单调` | `pwsh -File tools\qa\run-probe.ps1 -Name a11`（页面内合成 PointerEvent，走完整 Vue→IPC→主进程 setBounds 链路；**8 步光标位移**采样整条尺寸序列） | `"allPass": true`；`passClickDoesNotMoveWindow` / `passClickDoesNotDrag` / `passBarelyDoesNotDrag` / `passBlankDoesNotDrag` / `passLeftStartsDrag` / `passDragMovesWindow` / `passDragSizeStable`（≤1 DIP）/ `passSizeRestoredOnEnd`（≤1 DIP）/ `passDragSizeReproducible` 全 true；`strictDuringDragIdentical` 与 `strictSizeRestoredExactly` **如实记录但不参与**通过判定 | `docs/evidence/phase16/a11.json`（本轮）+ `docs/evidence/phase3/A11-input.json`（历史口径）+ `phase16/sizeMap.json`（口径依据） | P1（拖拽）/ P6（轮盘耦合） | **PASS**（2026-10-08 实测：8 步读数全 `482x761`、`distinct=1`、`duringMax=1`、`restoreMax=1`；`audit-acceptance.mjs` 判 `A11 PASS`） |
| **A12** 任意 5s 采样腿部骨骼运动 | ⚠ **门槛已由用户 2026-09-27 定稿（方案 C，组合条件）**：任一根腿骨 > **5°** **且** 4 根腿骨总行程 > **20°**（单条件"≥2 根各自 >5°"太松：一根偶然抖动 + 另一根刚过线就能过） | `pwsh -File tools\qa\run-probe.ps1 -Name a12`（5s 内 10 次 500ms 采样，读 `boneTravelAccum` 增量） | `"passA12SingleBone": true`、`"passA12TotalTravel": true`、`"maxLegTravelDeg"` > 5、`"legTravelTotalDeg"` > 20、`"a12Thresholds": {"singleBoneMinDeg":5,"totalMinDeg":20}` | `docs/evidence/phase3/A12-leg-motion.json`（= `a12.json` 副本） | P5 | **PASS**（2026-09-27 实测 `174.02° / 415.79°`；`audit-acceptance.mjs` 判 `A12 PASS`） |
| **A13** 待机动作数量 / 轮换 / 交叉淡化 | 动作数 `≥10`；切换间隔 `12s`；交叉淡化 `3s` | `pwsh -File tools\qa\run-probe.ps1 -Name a13` | `"distinctClipsObserved"` ≥10（本轮实测 4 —— 27s 采样窗的自然结果）、`passRotationPeriod`、`emptyClipSamples = 0`、`passNoTposeWindow` | `docs/evidence/phase3/A13-idle-rotation.json`（= `a13.json` 副本） | P5 | **PASS**（`audit-acceptance.mjs` 判 `A13 PASS`） |
| **A14** 拖拽期 `PET_DRAGGING` + 松手弹簧回正 + **尺寸读数恒定** | ⚠ **尺寸口径已由用户 2026-09-27 定稿（方案 B）**：拖拽期间 `getBounds()` 读数**恒定（不累积）**且偏差 ≤1 DIP；**实施栅格对齐后实测为严格 0 DIP** | `pwsh -File tools\qa\run-probe.ps1 -Name a14`（真实 `beginDrag/dragTo/endDrag` 路径 + 逐帧 `getBounds()`） | `"sizeReadings"` 8 个值全等、`"sizeReadingsDistinct"` 只有 1 个、`"sizeDriftMaxDip": 0`、`"strictSizeUnchanged": true`；另 `passDragTilts/passDragClipActive/passSpringReturns/passWindowMoves` 全 true | `docs/evidence/phase5/A14-drag.json`（= `phase3/a14.json` 副本） | P5 | **PASS**（8 步读数全部 `482×761`；`audit-acceptance.mjs` 判 `A14 PASS`） |
| **A15** 连续运行 2h | 无 T-pose、无第二角色、无进程失控 | `tools\qa\soak-2h.ps1 -Minutes 120 -SampleSec 30`（完整断言见 §7） | `"soakSec": >=7200`、`"invariantViolations": 0`、`"tposeSamples": 0`、`"maxAppInstanceCount": 1`、`"maxVrmCount": 1`、`"maxVisibleWindows": 1`、`"legTravelViolations": 0` | `docs/evidence/phase7/A15.json` + `.txt` + `screens/` 每 15min 一张 `A15-soak-<ts>.png` | P7 | `NOT VERIFIED`（待执行） | <br>★ **2026-10-08 重跑（run6，带 `--soak-with-chat`）**：`actualSoakSec=7206`、`invariantViolationCount=0`、`tposeSamples=0`、`visibleRatio=1`、`characterWindowCount` 全程 =1、**`chatWindowCount` unique = `0,1`（`=1` 有 217 个样本）**、轮换 58 组 0 错位 ⇒ **PASS**。这是**第一次在"单窗口 + 两窗口"两种状态下同轮取证**；`phase8` 的 run5 是单窗口证据（新分析器标 `windowCoverageInstrumented=false`，不得据此声称两窗口并存）
| **A16** 空闲平均帧率 / 内存 | `fps >= 50`；heap **无持续增长** | 同上浸泡脚本（同一次运行同时出 A15/A16 证据），读 `fps.avg1s/avg5s` 与 `heapMB`（renderer）+ 主进程 `app:diagnostics` 的 `workingSetBytes` | `"fpsAvg5sMin": >=50`（跳过前 60s 预热）、`"fpsAvg5sP05": >=50`、`"heapSlopeMBPerMin": <= 0.5`（后 60min 线性拟合）、`"heapPeakMB": < 2560`、`"restartCount": 0` | `docs/evidence/phase7/A16.json` + `.txt`（截图同 A15） | P7 | `NOT VERIFIED`（待执行） | <br>★ **2026-10-08 run6**：`fps5sMin=65.4`、`avg=67.3`（门槛 50）、`heapSlope=0.013 MB/min`（门槛 0.5）⇒ **PASS**。据此**更正**了本轮早先基于 2 分钟短程（42–47 fps）得出的"环境性低速"结论：那是短窗口 + 5s 采样密度的噪声
| **A17** 日志 / 分发物 / 命令行云密钥命中 | 命中数 `= 0`（并按 §2.1 的最小文件数下限防"扫了 0 个文件"） | `powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\scan-secrets.ps1 -Root . -Out docs\evidence\phase7\A17.json`；扫描面与模式见 §2.1 | `"totalHits": 0`、`"patternsHit": []`、`"filesScanned": >=200`（下限随交付物数量在门禁时冻结为 `>=` 该次真实值）、`"commandLineHits": 0`、`"installerPayloadHits": 0` | `docs/evidence/phase7/A17.json` + `.txt` | P7 | `NOT VERIFIED`（待执行） |
| **A18** 非环回监听端口 | `nonLoopbackListenCount = 0`；本应用监听项 `LocalAddress ∈ {127.0.0.1, ::1}` | `tools\qa\ports.ps1 -Invariant noNonLoopbackListen -Out docs\evidence\phase1\A18.json`；精确过滤与归属见 §2.2 | `"nonLoopbackListenCount": 0`、`"appListeners": [{"localAddress":"127.0.0.1",...}]`、`"appListenersNonLoopback": 0`、`"failedToAttribute": 0` | `docs/evidence/phase1/A18.json` + `.txt` | P1（P7 复测含 TTS 桥） | `NOT VERIFIED`（待执行） |
| **A19** 安装 / 卸载 / 重启后旧桌宠自启 | 命中 `= 0` 次（安装后、卸载后、重启后三个时点各自 0） | `tools\qa\autostart-audit.ps1 -Stage post-install|post-uninstall|post-reboot -Out docs\evidence\phase7\A19-<stage>.json`；取值面见 §2.3 | 三个 JSON 均 `"legacyHitCount": 0`、`"legacyHits": []`、`"newAppRunEntryCount": 1`（post-uninstall 时为 `0`）；且 `registryValueMatches=0`、`startupShortcutMatches=0`、`scheduledTaskMatches=0` | `docs/evidence/phase7/A19-post-install.json`、`A19-post-uninstall.json`、`A19-post-reboot.json`（各含 `.txt`） | P7 | `NOT VERIFIED`（待执行） |
| **A20** 视觉验收 | 真实桌面截图齐备 | `tools\qa\screens.ps1 -Scenario all`：全屏 `CopyFromScreen` + 逐窗口 `GetWindowRect` 截图 | 至少 6 张：panel / pet / 轮盘开 / 拖拽中 / 待机 / 阻断对话框；每张有 `Rect` 与 `hwnd` 记录；文件大小 > 20KB | `docs/evidence/phase7/A20.json` + `.txt` + `screens/A20-<scenario>-<ts>.png` | P7（各阶段各自留存） | `NOT VERIFIED`（待执行） |

### 2.0 A10 锚点误差的精确算法（冻结）

```text
记第 i 次"打开后 400ms 的静止帧"上读取到的轮盘视觉中心为 P_i = (wheel.cx, wheel.cy)（逻辑像素，探针值）。
三开三关共产生 3 个打开事件 ⇒ P_1, P_2, P_3。
基准 R = P_1（第一次打开即参考锚点；不引入外部输入，可复现）。
第 i 次误差：err_i = sqrt( (P_i.x - R.x)^2 + (P_i.y - R.y)^2 )   [单位 px]
anchorErrPxMean = (err_1 + err_2 + err_3) / 3
anchorErrPxMax  = max(err_1, err_2, err_3)
通过条件：anchorErrPxMean <= 2.0  且  anchorErrPxMax <= 2.0  且 每次打开 scale >= 0.98
旁证（不替代上面的判定）：每轮截图里在 P_i 处叠加一个 1px 十字标记，与角色头部锚点在像素上的相对位置由人工目视复核。
失败情形必须区分并分别记录：①角色本身在移动（属 A12/A13 场景问题）；②scale 未到达（属动画实现问题）；
③锚点计算与视觉不一致（属 FR-7.7 命中测试与视觉同源问题）。
```

### 2.1 A17 扫描面与模式（精确）

**扫描面（5 个，缺一即 FAIL）**

| # | 面 | 具体范围 |
|---|---|---|
| 1 | 源码与文档 | `<workspace>\docs\`、`apps\`、`packages\`、`tools\` 下全部 `.md/.ts/.js/.mjs/.cs/.json/.yaml/.txt/.ps1`（排除 `node_modules`、`.git`） |
| 2 | 构建产物 | `apps\desktop\dist\`、`apps\renderer\dist\`、`packages\*\dist\` 全部文本文件；`*.log`、`*.map`（`.map` 也要扫，sourcemap 会带字面量） |
| 3 | 运行日志与转储 | `%APPDATA%\AiriMateOne\logs\`、`%APPDATA%\AiriMateOne\crashDumps\`、`%LOCALAPPDATA%\AiriMateOne\` 全量 |
| 4 | 进程命令行 | `Get-CimInstance Win32_Process` 全表 `CommandLine` + `ExecutablePath`（含本应用自身与其子进程） |
| 5 | 安装包载荷 | 安装器（NSIS/electron-builder 产物）解包后的 `$PLUGINSDIR` 之外全部文件 + `resources\app.asar` 内文本条目（用 `npx asar list`/`asar extract-file`，**只读**） |

**模式（正则，命中即列证据；`-Pattern` 集合名 = `cloudkey`）**

```powershell
$patterns = [ordered]@{
  'prefix-sk'      = 'sk-[A-Za-z0-9_\-]{16,}'
  'prefix-other'   = '(?i)\b(?:ak|rk|pk|api[_-]?key|apikey|access[_-]?key|secret[_-]?key)\b\s*[:=]\s*["'']?[A-Za-z0-9_\-]{16,}'
  'bearer'         = '(?i)\bBearer\s+[A-Za-z0-9\-\._~\+/]{16,}=*'
  'jwt'            = '\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\b'
  'hex32plus'      = '\b[0-9a-fA-F]{32,}\b'
  'base64-40plus'  = '\b[A-Za-z0-9\+/]{40,}={0,2}\b'
  'conv-body'      = '(?m)^\s*"(?:content|messages|prompt|completion)"\s*:\s*"[^"]{24,}"'
}
# 扫描命令（每面各跑一次，合并计数）
Select-String -Path <面内文件列表> -Pattern $patterns.Values -AllMatches -Encoding UTF8
```

**判定（防"空扫描假通过"）**
- `totalHits = 0` **且** `filesScanned >= 200`（门禁 P7 前用第一次真实运行值冻结为下限）**且** `patternsHit` 为空数组 ⇒ A17 PASS。
- `filesScanned` 低于下限 ⇒ 判定 `INCONCLUSIVE`（不是 PASS）。
- 允许白名单：仅 `docs\evidence\phase0\E0-recon-baseline.md` 中**已脱敏写法的描述文字**（例如 `AIRI_UPSTREAM_KEY=sk-<已实测存在，本文件不复写明文>`）需显式登记进 `tools\qa\scan-secrets.allowlist.txt`，登记项必须写明行号与理由；**禁止**对任何真实密钥做白名单。
- 命令行面命中即 FAIL，**不允许**白名单（密钥出现在命令行本身就是违规）。

### 2.2 A18 端口过滤与归属（精确）

```powershell
# 1) 取全部监听套接字
$listen = Get-NetTCPConnection -State Listen -ErrorAction Stop
# 2) 非环回判定（IPv4/IPv6 通吃）
$loop = @('127.0.0.1','::1','0:0:0:0:0:0:0:1')
$nonLoop = @($listen | Where-Object { $loop -notcontains $_.LocalAddress })
"nonLoopbackListenCount=$($nonLoop.Count)"
# 3) 归属：按 OwningProcess → 进程路径 + 父子链，判定是否属于本应用进程组
$procs = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine
$appRoots = @($procs | Where-Object { $_.ExecutablePath -eq '<install>\AiriMateOne.exe' })
#   appListeners = 自身 pid ∈ appRoots 或 其祖先链向上可达 appRoots（最多 4 跳）
#   仍无法归属的项计入 failedToAttribute 并单列（禁止默认忽略）
```

**判定**
- A18 的 `= 0` 含义：**全机** `nonLoopbackListenCount = 0`（这是本机验收口径，等价于"本应用没有把任何东西暴露到非环回地址"；若机器上其它软件自身在监听非环回，必须由用户先关闭对应软件，脚本会把它们的 `pid/进程名/路径` 列出来供用户确认，**不得由本脚本自动处理**）。
- 另加约束（Tech-Spec §7.5）：`appListeners` 中每一条 `LocalAddress` 必须 ∈ `{127.0.0.1, ::1}`；出现 `0.0.0.0`/`::`/局域网地址 ⇒ FAIL。
- 开发期 Vite（`127.0.0.1` + 随机端口 + 一次性 token）与本地 TTS 桥必须**同时**满足"环回 + 随机端口"；固定端口需在证据里写明理由并经用户确认。

### 2.3 A19 自启取值面（精确，来自 Tech-Spec §8.2）

```powershell
# 面 1：HKCU Run / RunOnce
Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'        -ErrorAction SilentlyContinue
Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'    -ErrorAction SilentlyContinue
Get-ItemProperty -Path 'HKCU:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue
# 面 2：两个 Startup 文件夹（含快捷方式目标解析）
Get-ChildItem -LiteralPath ([Environment]::GetFolderPath('Startup'))       -Force -ErrorAction SilentlyContinue
Get-ChildItem -LiteralPath ([Environment]::GetFolderPath('CommonStartup')) -Force -ErrorAction SilentlyContinue
#   对每个 .lnk：$sh = New-Object -ComObject WScript.Shell; $sh.CreateShortcut($p).TargetPath / .Arguments
#   注：只读枚举与解析，不写、不删。COM 调用在 workspace-write 沙箱下若被拒，改为读 .lnk 二进制并在证据里标注
# 面 3：计划任务（含隐藏任务）
Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.State -ne 'Disabled' } |
  Select-Object TaskName, TaskPath, State
#   对命中候选导出定义：Export-ScheduledTask -TaskName <n> -TaskPath <p>
# 面 4：备用（Get-ScheduledTask 不可用时）：schtasks.exe /Query /FO LIST /V
```

**"0 命中"的定义**：对上述四个面中每一条记录，用"值字符串 / 快捷方式 `TargetPath`+`Arguments` / 任务 `Actions.Execute`+`Arguments`+`WorkingDirectory`"匹配 Tech-Spec §8.1 的谓词集合：

```
旧入口谓词（正则，大小写不敏感）：
  MateEngineX            -> (?i)mateenginex
  旧 pet                 -> (?i)build\\pet\\app(\\main\.mjs)?
  旧 brain/bridge        -> (?i)(start-airi-brain|autostart-airi-brain|airi-brain\.mjs|mate-engine-airi-bridge)\.?
  旧宿主/工具             -> (?i)F:\\deepseek harness\\AI女友\\(tools|src|build)\\
本应用自有项（唯一允许存在的自启）：
  (?i)^"?<install>\\AiriMateOne\.exe"?\s+--autostart$
```

- `legacyHitCount = 0` 且 `scheduledTaskMatches = 0` 且 `startupShortcutMatches = 0` 且 `registryValueMatches = 0` ⇒ A19 该时点 PASS。
- **post-install**：`newAppRunEntryCount = 1`（恰好一个 `AiriMateOne` 项）。
- **post-uninstall**：`newAppRunEntryCount = 0`（自有项也被删除），且旧项按备份恢复的项数 = 备份中的旧项数（默认 `--restore-legacy` 关闭时为 0）。
- **post-reboot**：重启后 60s 内没有任何旧桌宠进程或旧可见窗口出现 ⇒ `legacyRespawnCount = 0`。
- 三个时点必须**都** PASS 才允许写 A19 = PASS；任一 `NOT VERIFIED` ⇒ A19 整体 `NOT VERIFIED`。

---

### 2.4 窗口分离判据族（`--probe chatwindow`，2026-10-08 返工轮新增）

取代已删除的 `--probe conversation`（它的 45 项里有一整套断言的正是 §0.5.1 里被否决的形态）。

**取证命令**（一条命令跑完，产物落在 `docs\evidence\phase16\`）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\run-probe.ps1 `
  -Name chatwindow -Mode pet -TimeoutSec 300 -OutDir docs\evidence\phase16 -ExtraArgs '--no-proactive'

# 真实桌面截图 + 第三方窗口枚举（五张必需截图 + 归属判定）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\chatwindow-shots.ps1 `
  -OutDir docs\evidence\phase16 -TimeoutSec 420
```

| # | 判据 | 读数键（`phase16/chatwindow.json`） | 期望 | 实测（2026-10-08） |
|---|---|---|---|---|
| C1 | pet 窗口恒为 `340×420` | `beforeOpen.petBounds` / `singleton.petSizes` | 宽度 340±1、高度 420±1，且三次读数**逐位相同** | `341x420` ×3（125% 缩放取整） |
| C2 | chat 默认 `720×560`、最小 `560×420` | `center.requested` / `open.chat-min-size` | 请求值精确 720×560；`getMinimumSize()` = 560×420 | 请求 720×560；读回 727×567（±8 DIP 内） |
| C3 | 重复打开**只复用同一个窗口** | `singleton.hwnds` / `createdCount` | 三次 id 全同、`createdCount=1` | `2 / 2 / 2`、`1` |
| C4 | 不存在第三个窗口 | `windows.length` / `windows.titles-match-roles` | 恰好 2 个，标题分别是角色与对话 | 2 个，标题匹配 |
| C5 | **角色唯一性** | `uniqueness.stage` | `scene/renderer/mixer/vrm = 1/1/1/1`、`live2d=0`，且取自 pet 窗口 | 全 1，`live2d=0` |
| C6 | chat 窗口内 **canvas = 0** | `uniqueness.chatUi` | `canvasCount=0`、`stageHandlePresent=false`、`stageCanvasInDom=0` | 全 0 |
| C7 | **首次打开居中**（鼠标所在显示器 workArea，误差 ≤8 DIP） | `center.centerErrorDip` | ≤8 | **4** |
| C8 | 记忆几何：拖动后关闭再打开被记住 | `remembered.remembered` | 与设置值一致（±8 DIP） | 设 640×480 → 读回 641×481 |
| C9 | 记忆矩形在屏外 ⇒ **回落居中** | `offscreen.falls-back-to-centered` / `offscreen.center-error-le-8dip` | `boundsSource='centered'`、误差 ≤8 | `centered`、误差 **4** |
| C10 | **分离**：pet 窗口内对话类输入 = 0 | `petSeparation.textInputs.conversationCount` | 0 | 0（另有 4 个**配置**输入，来自首次运行向导，见下注） |
| C11 | chat 开关前后 pet 窗口**逐位不变** | `finalDiagnostics.petInvariant.identical` | true | true（`1038,528 341x420` 前后相同） |
| C12 | chat 开关**不改变** pet 的 panel/pet 模式 | `entries.petModeBefore/After` | 相同 | `pet` → `pet` |
| C13 | 五条入口都能打开并聚焦 | `entries.wheel/tray/hotkey/dblclick/wake` | 见 §0.5.4 | 五条全通（`lastSource` 依次为 `wheel`/`tray`/`hotkey`/`dblclick`/`wake`） |
| C14 | 关闭 = 隐藏（不销毁、不退出） | `close.hidden-not-destroyed` | id 仍在、`visible=false` | true |
| C15 | 唤醒路径：打开 + 进"听" + 焦点进输入框 | `entries.wake` | `lastOpenListen=true`、`lastOpenFocusInput=true`、`focusedEl='textarea'` | 全真 |
| C16 | 真实桌面截图（§7.8 五个场景） | `chatwindow-shots.json` | 5/5 非空、`pass=true` | 5/5 |

**注（C10 的口径，必须写清楚）**：pet 窗口里**确实**有 4 个 `<input>`，它们**全部来自
首次运行向导**（`OnboardingWizard.vue` 的 baseUrl / 模型 / 密钥），是**配置**输入。
用户的要求原文针对的是"聊天对话框不许塞进桌宠窗口"（贴底 dock / panel 浮层两种旧形态），
所以硬判据是「**对话类**输入 = 0」；分类规则是"落在 `.wizard` / `.side` 里的算配置输入"，
`chatwindow.json` 里把 `count / conversationCount / configCount / tags` 全部原样记出，
"多出一个没有归属的输入框"会立刻让 `separate.pet-config-inputs-allowed` 判失败。

**已知的假失败源（写进判据，避免下次又踩）**：
- `hitTest()` 在弹出动画开始前（`scale ≤ 0.001`）**返回 null** ⇒ 探针必须先"开轮盘 → 等动画 → 再点"，一遍点不出来不代表入口坏；
- `--probe chat` **已被 A22 占用** ⇒ 新探针名是 `chatwindow`，用 `chat` 会写出 A22 的产物；
- `Start-Process -ArgumentList @('--no-proactive')` 会把它变成 `-no-proactive` ⇒ 参数必须**拼成一个字符串**传；
- `--no-proactive` 曾经**不在** CLI 白名单里 ⇒ 传了会被"无法识别的启动参数"挡掉、应用直接退出、探针零产出（已修）。

---

### 2.5 覆盖层不得盖住角色（`--probe petoverlay`，2026-10-08 新增）

**它守的是什么**：首次运行向导是 `position:absolute; inset:0` 的**全屏覆盖层**，而它的显示条件
依赖主进程的 `onboarding.completed`（要求"供应商已配置 + 测试通过"）——
**没有密钥的用户永远满足不了它** ⇒ 覆盖层**永久驻留** ⇒ 在 `340×420` 的 pet 窗口里
把**角色整个盖住**，用户的直观感受是"桌宠不见了"。
而向导自己的文案却写着"不想现在配？到「设置」里可以随时回来"——**承诺了一条不存在的跳过路径**。

**处置（用户裁定"两个都做"）**：
1. 向导补上真的「稍后再说」按钮（`OnboardingWizard.vue` 的 `skip()`）：只写 `settings.onboarded`
   （管"还弹不弹"），**不**代替用户配置任何东西、**不**绕过 `onboarding:complete` 的判据；
2. `PetShell.vue` 里 `<OnboardingWizard v-if="!isPet" />`：pet 模式不挂向导，保证桌宠形态不被盖住。

| 判据 | 命令 | 期望读数 | 证据 |
|---|---|---|---|
| **pet 模式下不得有全屏覆盖层** | `pwsh -File tools\qa\run-probe.ps1 -Name petoverlay -Mode pet` | `overlays.wizardCount = 0`、`wizardCoversAll = false`、`stageRootCount = 1`、`canvasCount = 1`、`petBounds = 340±1 × 420±1` ⇒ **7/7** | `phase16/petoverlay.json` |
| **panel 模式下向导必须仍在**（否则再没有配置入口） | `pwsh -File tools\qa\run-probe.ps1 -Name ui -Mode panel` | `overlays.wizardCount = 1`（未完成时）、`stageRootCount = 1` ⇒ **52/52** | `phase16/ui.json` |
| **跳过入口存在且可用**（未完成时） | 同上 | `skipPath.skipButtonPresent = true`、`skipButtonDisabled = false`、`skipNoteChars = 54` | 同上 |
| ★ **按下去真的会收起，且可逆** | 同上 | `skipClick = { clicked: true, before: 1, after: 0, settingBefore: false, settingAfter: true, settingRestored: true }` | 同上 |
| **可逆性入口在**（把向导请回来） | 同上 | `resetPath = { clicked: true, resetPresent: true }`（探针**先切到设置页**再读，读完切回 —— 在日程页找它是假失败） | 同上 |

> **「稍后再说」的语义边界**（写在代码注释里，判据只认这个范围）：
> 它**只**写 `settings.onboarded`（管"还弹不弹"）；**不**写供应商/密钥/模型/人设、
> **不**调 `onboarding:complete`（那条该被拒绝就继续被拒绝）、**不**让任何未满足的判据变成满足。
> 探针点击后会**自动还原** `onboarded`（`settingRestored: true`），不留痕。

> ★ **判据为什么读 DOM 而不读屏幕**（这是用一次**错误结论**换来的纪律）：
> 我最初用"屏幕某区域的亮像素数"当证据，得出过"pet 窗口不上屏"的错误结论 ——
> 实际是**用户开着全屏应用**，`CopyFromScreen` 拍到的是**游戏的画面**，
> 本应用的窗口在更低的合成层，截图里根本看不到。
> ⇒ 覆盖层是否可见、是否盖住内容，**只能读自己的 DOM**（`getBoundingClientRect` /
> `querySelectorAll`），**不能**读屏幕像素。这条同时写进了 `PetShell.vue` 的探针注释与
> `--probe petoverlay` 的文件头，`CHAT-WINDOW-ROUND.md` §5.4 有完整复盘。

---

## 3. 场景级端到端清单（S1..S10）

**前置约定**
- **真实桌面会话必需**：S1..S9 **全部**需要交互式桌面会话（`SessionId=1`、已登录、未锁屏）。窗口枚举、`SetCursorPos`、桌面截图在锁屏/无会话/服务会话下会产生假结果。
- **测试前固定状态**：`Get-CimInstance Win32_Process` 快照存档；关闭屏幕保护与休眠：`powercfg /change standby-timeout-ac 0`（**执行前后都要记录，测试后恢复原值**）。
- 每步都产出一个 `docs/evidence/<phase>/<id>.json` + `.txt`；关键步骤截图。
- 全部步骤**只读检测旧实例、绝不自动杀进程**（PRD FR-3.3）。

| # | 场景 | 前置 | 步骤（可执行） | 通过判据 |
|---|---|---|---|---|
| **S1** | 首次配置（**BLOCKED-PENDING-USER**） | BLOCKER-1 已裁定且 P2 会话层落地；`%APPDATA%\AiriMateOne\secrets\` 为空 | 1. 启动应用，`probe-stage.mjs` 确认 `sceneCount=1`；2. 仿真：移动到设置入口并左键，等待设置面板出现（截图）；3. 用 `SendKeys` 填 baseURL/密钥/模型（密钥用一个**专用测试密钥**，测完立即吊销）；4. 点保存；5. `Get-ChildItem '%APPDATA%\AiriMateOne\secrets'`；6. 跑 `scan-secrets.ps1 -Root . -OnlyLogsAndProc`；7. `Get-CimInstance Win32_Process` 全表扫命令行 | ①`secrets\<providerId>.bin` 出现且**非明文**；②`scan-secrets` 在日志/命令行面 `totalHits=0`；③renderer 侧只可见 `{providerId,hasKey:true,keyFingerprint,keyLength}`（无明文）；④`safeStorage.isEncryptionAvailable()=true` |
| **S2** | 日常对话（**BLOCKED-PENDING-USER**） | 同 S1 且密钥已录入；网络可达所选供应商端点 | 1. 双击角色区域（`SetCursorPos` + 两次 `LEFTDOWN/UP`，间隔 <250ms）；2. 断言聊天输入区获得焦点；3. `SendKeys` 输入固定串（如 `ping-<ts>`）；4. 点击发送；5. `probe-stage.mjs` 每 200ms 采样 20s；6. 截图 | ①回复文本流式出现在 panel（首字 < 10s）；②采样中出现表情/口型/动作事件（`activeClip` 或 `expression` 变化 ≥1 次）；③日志中**不含**对话正文（只有长度与哈希） |
| **S3** | 桌宠形态 | P3 舞台可用；panel 模式运行中 | 1. 取 `__AIRIMATE_STAGE__` 快照 → `stageId/rendererId/mixerId/vrmInstanceId/mixer.time`；2. 切到 pet 模式（托盘菜单或轮盘"角色"项）；3. 等 1s 再取快照；4. 断言窗口属性；5. 截图两张 | ①四个 id **完全相同**；②`mixer.time` 后 > 前；③`visibleMainWindowCount` 仍 = 1；④`GetWindowLongPtrW(...GWL_STYLE)` 无 `WS_CAPTION`/`WS_THICKFRAME`、`GWL_EXSTYLE` 含 `WS_EX_LAYERED`；⑤`GetWindowRect` 尺寸 = 340×420（pet） |
| **S4** | 轮盘 | pet 模式；角色已加载 | 循环 3 次：`Invoke-QaMouseMove(anchor)` → `Invoke-QaRightClick` → 等 400ms → 截图 + 取 `wheel{cx,cy,scale}` → `Invoke-QaRightClick`（或 `Invoke-QaKey 0x1B`）→ 等 400ms → 取 `wheel.open`。随后：光标到角色中心 → 纯左键单击 → 取 `wheel.open` → 截图 | ①三次 `anchorErrPx` 均 `≤ 2`（算法见 §2 A10）；②开态 `scale` 单调趋近 1.0（不出现 CSS 过渡痕迹：相邻两帧 `scale` 差值 > 0.05）；③Esc 与右键**都能**关闭；④左键单击后 `wheel.open=false` |
| **S5** | 拖拽 | pet 模式；窗口在屏内 | 1. 光标到角色中心（`SetCursorPos`）；2. `LEFTDOWN`；3. 分 20 步位移 +200px（每步 16ms，同时 60Hz 采样 `getBounds()`）；4. 松手；5. 继续采样 3s；6. 截图拖拽中/释放后 | ①窗口 `x` 跟随位移，误差 ≤ 6px；②**拖拽期** `width/height` 恒为 340×420（0 偏差，任一样本偏差即 FAIL）；③拖拽期 `baseClipId='PET_DRAGGING'`；④松手后倾斜角在 `≥0.6s` 内衰减至峰值的 ≤10% 且无单帧跳零 |
| **S6** | 待机 | P5 动作资产齐备；应用空闲（无输入） | 1. 启动后等首帧 `baseClipId` 非空；2. `idle-rotation.mjs --duration 180 --sample 250` 连续采样；3. 同时 `probe-stage.mjs --bones --window 5` 每 5s 断言腿骨活动；4. 每 30s 截图一张 | ①`distinctIdleClips ≥ 10`；②切换间隔 ∈ [11.5, 12.5]s；③`crossfadeDurSec ≈ 3.0`（±0.1）；④**全程** `baseClipId` 非空且 `activeWeight > 0`（`tposeSamples = 0`）；⑤腿骨 5s 窗口断言 0 次违反 |
| **S7** | 第二次启动 | 应用已在运行（`instances=1`） | 1. 记 `instances_before/visibleWindows_before/vrmCount_before`；2. 用 `Start-Process -PassThru '<install>\AiriMateOne.exe'` 启动第二份；3. 等 3s；4. 记 `instances_after` 等；5. 读第二进程退出码；6. 断言前台窗口是原窗口 | ①`instances_after = 1`（**不出现**第二个根进程）；②`visibleWindows_after = 1`；③`vrmCount_after = 1`；④第二进程退出码 `0` 且进程已消失；⑤`GetForegroundWindow()` 的 `hwnd` 与首次启动的 `hwnd` 相同（或 `IsIconic` 由 true 变 false + `flashFrame` 已触发） |
| **S8** | 旧实例阻断 | 用户**手工**启动 `MateEngineX.exe`（用户自愿，脚本不启动它）；本应用未运行 | 1. 枚举确认旧内核可见窗口 ≥1（记录 `hwnd/pid/rect/sha256`）；2. 启动本应用；3. 断言**不创建主窗口**（`visibleMainWindowCount = 0`）而出现阻断对话框（`#32770` 类对话框窗口 + 标题含产品名，截图）；4. 仿真读取对话框文本；5. 依次点三个按钮做三次（每次重启场景） | ①阻断对话框出现（`"dialogShown": true`，`"dialogClass": "#32770"`）；②主窗口 `visibleMainWindowCount = 0`（**不静默继续**）；③旧进程 PID 在应用运行前后**不变**（`"legacyPidsUnchanged": true`，证明确实没有杀进程）；④"我已知晓并退出"后本应用进程退出码 `0` 且不产生锁文件残留 |
| **S9** | 开机 | 已安装且已合并为唯一自启项；用户授权重启 | 1. 重启前跑 `autostart-audit.ps1 -Stage pre-reboot`；2. 重启；3. 登录后 60s 跑 `-Stage post-reboot`；4. 跑 `proc-window-inventory.ps1`；5. 截图 | ①`newAppRunEntryCount = 1`、`legacyHitCount = 0`；②开机后 `appInstanceCount = 1`、`visibleMainWindowCount = 1`；③旧桌宠可见窗口 `= 0` 且 60s 内 `legacyRespawnCount = 0`；④E0 基线里实测存在的 `tools\host\airi-host.mjs` 等旧宿主**没有**被拉起 |

| **S10** | **桌宠对话**（2026-10-08 另立；PRD §3.1）<br>⛔ **本行描述的形态（窗内底坞 / `WINDOW_GEOMETRY.conversation` 380×560 / `--probe conversation` 45 项）已在 2026-10-08 返工轮被用户否决并删除** —— 聊天改为**第二个独立 BrowserWindow**。<br>★ **取代它的判据**：§0.5（新三条口径）与 §2.4（`--probe chatwindow`，61 项，C1..C16）；证据 `phase16/chatwindow.json`、`phase16/chatwindow-shots.json`。<br>⚠ **下面这段是当时的历史记录，保留仅作审计留痕**；其中"对话框贴在角色下方""`380x560`""`--probe conversation` 45 项""`hitregions.dock-reported`"等读数**一律不再作为现行判据**（现行以 §2.4 为准）。 | 应用以 `--mode=pet` 运行；角色已加载；`ttsEnabled` 由探针显式打开并在结束时还原 | 1. `powershell -File tools\qa\conversation-shots.ps1 -OutDir docs\evidence\phase15`；2. `powershell -File tools\qa\hotkey-toggle.ps1`；3. `node tools\qa\summarize-probes.mjs docs\evidence\phase15` | **（历史，已作废）** ①`conversation.json` → `pass=true`、`passedChecks=45/45`、`failedChecks=[]`；②五个入口各有读数：`wheel.chat-opens-conversation` / `wheel.chat-does-not-switch-panel` / `entry.dblclick-opens-conversation`（`lastSource="dblclick"`）/ `hotkey.reported` + `conversation-hotkey.json` 的 `pass=true`（340×420 → 379×560 → 逐位还原）/ 唤醒词由单测覆盖；③布局：`openSizes=["380x560",…]`、`layout.returns-to-pet`、`panel.size-not-conversation`、`drag.size-constant-in-conversation`；④单实例：`instances=1`、`visibleWindowCount=1`、`single.stage-ids-unchanged`；⑥命中区域：`hitregions.dock-reported`、`hitregions.bubble-reported`（`kinds=["character","panel","bubble"]`）；⑧`ui.no-transcript-flow`、`ui.chat-tab-removed` | `docs/evidence/phase15/`（conversation.json / conversation-hotkey.json / conversation-shots.json / screens/conversation-20261008-111845-*-desktop.png 6 张）、`CONVERSATION-ROUND.md` —— **均为历史证据，记录被否决形态当时的实测** | **历史：PASS（2026-10-08 当时口径）**<br>★ **现行：由 §2.4 的 `--probe chatwindow`（61/61）取代**，见 `phase16/CHAT-WINDOW-ROUND.md` |

**场景 ↔ 判据覆盖**：S1→A17；S2→A17/A20；S3→A5/A7/A8/A9；S4→A10/A11；S5→A14/A12；S6→A12/A13/A15/A16；S7→A1/A2/A9；S8→A3/A4；S9→A19/A1/A2/A20；**S10**→S10 自带判据（`--probe conversation` 45 项 + 两个专用脚本），并**回归** A2/A3/A4/A10/A11/A14（证据同上目录 `a10.json` / `a11.json` / `a14.json` / `desktop-state-20261008-111906.json`）。

> **S10 与 S2 的关系**（2026-10-08 用户裁定「另立」）：S2 的**文字不变**，其"流式回复出现在 panel"一句由 S10 取代；
> 入口（双击角色）与"回复驱动表情/口型/动作事件"仍然有效。详见 `PRD.md` §3.1。

---

## 4. 阶段门禁（P0..P7）

> **编号说明（本文的显式决定）**：本文用 `P0..P7` 作为**本矩阵引用用的稳定标识**，与 PRD §10 表格的第 1..8 行**同序一一对应**（`P0`=PRD §10 第 1 行，……，`P7`=PRD §10 第 8 行）。
> 采用 P 编号而不是直接沿用"阶段 N"的原因：旧文档（以及 Tech-Spec §8.2 的"阶段 7"标注）中存在 0-based 与 1-based 混用，直接引用会产生"阶段 7 到底是启动项迁移还是 20 条判据收口"的歧义。**证据目录名与门禁标识一律用 `phase0..phase7`。**
> 门禁规则：**不通过不进下一阶段**；门禁通过 = 命令退出码 0 **且** 期望原始输出出现 **且** 证据文件已归档。

| 门禁 | PRD §10 原行 | 必须跑通的命令 | 必须看到的原始输出 | 证据 |
|---|---|---|---|---|
| **P0** | 0 | `Get-ChildItem 'F:\deepseek harness\AI女友\新工程\docs' -File \| Select-Object Name,Length` | 5 个文件齐备：`PRD.md`、`Tech-Spec.md`、`API-Contract.md`、`Acceptance-Matrix.md`、`Migration-Plan.md`；且 `docs\evidence\E0-recon-baseline.md` 存在；BLOCKER-1 已在 PRD §8 陈述 | `docs/evidence/phase0/P0-docs.txt` |
| **P1** | 1 | `powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\single-instance.ps1 -Exe '<install>\AiriMateOne.exe' -Out docs\evidence\phase1\P1.json` | `instances=1`、`visibleWindows=1`、`secondExitCode=0`、`lockPidMatches=true`、`mutexKeeperRunning=true`；`nonLoopbackListenCount=0` | `docs/evidence/phase1/P1.json` + `.txt` + `screens/P1-second-launch-<ts>.png` |
| **P2** | 2 | ①`node tools\qa\blocker-status.mjs --blocker BLOCKER-1` ②`Get-Content 'F:\deepseek harness\AI女友\新工程\docs\API-Contract.md' -TotalCount 5` | ①`"BLOCKER-1": "RESOLVED-<A\|B\|C>"`（**A/B/C 任一裁定已由用户书面给出**）②`API-Contract.md` 存在且已冻结会话层接口（zod schema 名可枚举） | `docs/evidence/phase2/P2-blocker.json` + `.txt` |
| **P3** | 3 | `node tools\qa\probe-stage.mjs --diagnostics docs\evidence\phase3\P3.json --assert scene=1,renderer=1,mixer=1,vrm=1,live2d=0 --screenshot docs\evidence\phase3\screens\P3-<ts>.png` | `"sceneCount":1`、`"rendererCount":1`、`"mixerCount":1`、`"vrmCount":1`、`"live2dCount":0`、`"loadedModel":"Lazuli_VRM.vrm"` | `docs/evidence/phase3/P3.json` + `.txt` + 截图 |
| **P4** | 4 | `node tools\motion-lab\load-test.mjs --only PET_POSE_1 --report docs\evidence\phase4\P4.json` + `node tools\qa\screens.ps1 -Scenario pose1` | `"unmappedTracks": 0`、`"boundHumanoidBones": 17`、`"loadOk": true`；定格姿势截图经**用户目视确认**（记录确认人与时间） | `docs/evidence/phase4/P4.json` + `.txt` + `screens/P4-PET_POSE_1-<ts>.png` |
| **P5** | 5 | ①`node tools\motion-lab\validate-vrma.mjs --dir assets\motion --report docs\evidence\phase5\P5-validate.json` ②`node tools\qa\idle-rotation.mjs --duration 180 --report docs\evidence\phase5\P5-idle.json` ③`powershell -File tools\qa\drag-spring.ps1 -Out docs\evidence\phase5\P5-drag.json` | ①`"motionsValidated": >=11`、`"legTravelOk": true`（4 腿骨 5s 累计 > 3°）②`distinctIdleClips>=10`、`switchIntervalSec≈12`、`crossfadeDurSec≈3.0` ③`baseClipId=PET_DRAGGING` 且 `"returnedToRest": true` | `docs/evidence/phase5/P5-*.json` + `.txt` + `screens/P5-*.png` |
| **P6** | 6 | `powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\wheel-anchor.ps1 -Cycles 3 -Out docs\evidence\phase6\P6.json -Screens docs\evidence\phase6\screens` | `anchorErrPxMean<=2.0`、`anchorErrPxMax<=2.0`、`scaleReaches1=true`、`leftClickDoesNotOpen=true`；轮盘静态像素截图经用户目视确认 | `docs/evidence/phase6/P6.json` + `.txt` + `screens/P6-wheel-*.png` |
| **P7** | 7 | ①`powershell -File tools\qa\scan-secrets.ps1 -Root . -Out docs\evidence\phase7\P7-scan.json` ②`powershell -File tools\qa\autostart-audit.ps1 -Stage compare -BackupDir '%APPDATA%\AiriMateOne\migration\backup-<ts>' -Out docs\evidence\phase7\P7-autostart.json` | ①`totalHits=0`、`filesScanned>=<冻结下限>` ②迁移前后对比：`legacyHitCountBefore>0`（E0 基线显示确有待处理项）、`legacyHitCountAfter=0`、`newAppRunEntryCount=1`；随后 A19 三时点全 PASS | `docs/evidence/phase7/P7-*.json` + `.txt` |
| **P7+R** | 8 | `powershell -File tools\qa\claim-audit.ps1 -Matrix docs\Acceptance-Matrix.md -Evidence docs\evidence -Out docs\evidence\phase7\A-claim-audit.json` | `"rowsTotal": 20`、`"rowsWithCommand": 20`、`"rowsWithRawOutput": 20`、`"rowsWithEvidencePath": 20`、`"rowsNotVerified": 0`、`"rowsBlocked": 0`（若 BLOCKER-1 未裁定，则 `rowsBlocked` 必须等于实际受阻行数且逐行列出原因） | `docs/evidence/phase7/A-claim-audit.json` + `.txt` |

---

## 5. 阻塞项登记（Blocker register）

### BLOCKER-1 · AIRI 源码无法固定到明确 tag/commit

| 字段 | 内容 |
|---|---|
| 状态 | **`RESOLVED-A`（用户 2026-09-27 裁定，阻塞关闭）** —— 裁定记录：`docs/evidence/phase2/P2-blocker.json`（含用户原话） |
| 裁定内容 | **选项 A：接受能力等价实现** —— 不做 AIRI 源码级集成，改用 AIRI 同源且已发布的 MIT 依赖（`@xsai/stream-text`、`@xsai-ext/providers`、`unspeech`、`@proj-airi/ui`、`@proj-airi/server-sdk`）自建会话/人设/记忆/TTS/供应商层。**口径约束**：交付在**能力**上对齐，但**不是 AIRI 源代码本身** ⇒ **不得声称或暗示「源级集成」**（写入 `DELIVERY.md` §5.2） |
| 事实（已实测，见 `docs/evidence/E0-recon-baseline.md` §1–§2） | GitHub 不可达（`git ls-remote https://github.com/moeru-ai/airi` → `EXIT=128`，`schannel: failed to receive handshake`）；全部 GitHub 镜像不可达（`ghproxy.net`/`gh-proxy.com`/`ghfast.top`/`hub.fastgit.org`/`raw.gitmirror.com` 全 timeout；`cdn.jsdelivr.net`/`unpkg.com`/`raw.githubusercontent.com` → `000`）；本机无 AIRI 源码 checkout；`F:\AIRI\resources\app.asar` 无 git 元数据；AIRI 核心包以 `workspace:` 声明且**未发布到 npm**（`@proj-airi/stage-ui`、`@proj-airi/ccc`、`@proj-airi/audio`、`@proj-airi/pipelines-audio`、`@proj-airi/model-driver-lipsync`、`@proj-airi/plugin-sdk-tamagotchi` 均 404） |
| 已确认的非阻塞项 | 许可证 = **MIT**（`app.asar` 内 `package.json` 实测 `"license":"MIT"`，`repository=github.com/moeru-ai/airi`，版本 `0.12.0-beta.5`）⇒ 许可层面无障碍，义务是随分发保留 MIT 声明 |
| 影响判据 | **硬受阻（无法产生有效证据）**：`A17`（云密钥路径需要真实会话层持钥）、`S1`、`S2`。**软受阻（可先用桩/契约测试取得部分证据，但不得据此写 PASS）**：`A15`/`A16`（可以起桩对话层跑 2h，但"AIRI 会话层长稳"这一层语义未覆盖）、`A20`（截图可出，但聊天面板像素验收不完整）。**不受阻**：`A1`–`A14`、`A18`、`A19`（均不依赖会话层）+ `S3`–`S9` |
| 受影响门禁 | **P2 阻塞**（PRD §10 第 3 行明文"依赖用户对 BLOCKER-1 的裁定"）；P0/P1/P3/P4/P5/P6/P7 不阻塞，可并行推进 |
| 未违反的禁止项 | 本轮**未**修改、未重打包、未复制 `F:\AIRI` 任何字节（只做只读 asar 头解析） |
| 解阻选项 A（推荐） | **能力等价重实现**：不做 AIRI 源码级集成，改用 AIRI 同源且**已发布在 npmmirror 的 MIT 依赖**（`@xsai/stream-text@0.5.0`、`@xsai/generate-text`、`@xsai/utils-chat`、`@xsai/shared-chat`、`@xsai-ext/providers@0.5.0`、`unspeech@0.1.16`、`@proj-airi/server-sdk@0.12.0-beta.5`、`@proj-airi/ui@0.12.0-beta.5`、`@moeru/eventa@1.0.1`）自建会话/人设/记忆/TTS/供应商层；接口先在 `API-Contract.md` 冻结。代价：交付的是"AIRI 的能力"而非"AIRI 的代码"；不触碰 `F:\AIRI` |
| 解阻选项 B | 用户提供**离线源码包**（`moeru-ai/airi` 的 zip 或 `git bundle`）落到本机；按其 `package.json` + lockfile 固定 commit 后做源码级集成。代价：需用户提供离线包，集成工作量大于 A |
| 解阻选项 C | 用户开通**可达 GitHub 的网络出口**（使 `git ls-remote https://github.com/moeru-ai/airi` 成功）；拉取后固定 commit。代价：需用户改网络环境 |
| 裁定记录要求 | 用户裁定必须落盘：`docs/evidence/phase2/P2-blocker.json` 内写 `{"blocker":"BLOCKER-1","decision":"A\|B\|C","decidedBy":"<用户标识>","decidedAt":"<ISO8601>","verbatim":"<用户原话>"}`。**不允许**由实现方自行选定选项后继续。✅ 已满足：`decision="A"`、`verbatim="A：认可能力等价实现（推荐）"`、`decidedAt="2026-09-27T19:40:00Z"` |

### 伴随风险（非阻塞，但必须在 P7 一并出证据）

| ID | 风险 | 受影响判据 | 处置 |
|---|---|---|---|
| `LICENSE-RISK-1` | Mate 资产与 MateEngine Pro License v2.1 §2/§3（copyleft + 禁止商业/二进制平台分发）；DLC 目录内**无**独立许可文件 | A20（分发物内容） | 本轮**私有使用**；分发物不含 `.anim`/`.vrm`/`.vrma`/MateEngine 源码；公开分发前必须重新评审。证据：`tools\qa\package-audit.ps1` 输出 `"forbiddenAssetHits": 0` |
| `RISK-1` | 旧工程根 `.airi-upstream.env` 存在**明文**云密钥 | A17 | 新工程**不读取**该文件；迁移向导提示用户**吊销并重新录入**；P7 扫描命中数 = 0。证据：`docs/evidence/phase7/A17.json` |

---

## 6. 证据工具计划（`tools\qa\`）

> 一个判据家族一个脚本；每个脚本必须：①支持 `-Out <json>` 与 `-Phase <phaseN>`；②把原始 stdout 用 `Tee-Object` 同步落同名 `.txt`；③JSON 顶层固定字段 `{"id","invariant","generatedAt","host","commandLine","expected","observed","pass","runs":[]}`；④退出码 0=通过、2=断言失败、3=无法判定（`INCONCLUSIVE`，例如扫了 0 个文件）；⑤只读，不修改被检对象（除写自己的证据文件）。

### 6.1 公共库

| 文件 | 作用（一行） | 关键输出 |
|---|---|---|
| `tools\qa\lib\Win32.ps1` | P/Invoke 底座（§1.6）：窗口枚举、光标、鼠标/键盘注入 | 无（被 dot-source） |
| `tools\qa\lib\Ownership.ps1` | 归属谓词库（§1.5 L1–L4）：路径前缀 / SHA256 / 标记文件 / 签名；禁止按名字判定 | `Test-QaLegacyOwner` 返回 `{class, evidenceFlags}` |
| `tools\qa\lib\Evidence.ps1` | 证据落盘：JSON（UTF-8 无 BOM）+ 同名 `.txt` + `runs[]` 历史累加 + `screens/` 目录自建 | `Write-QaEvidence` |
| `tools\qa\lib\Ui.ps1` | 输入仿真（§1.7）+ 窗口内坐标换算 + "目标点必须在某个窗口 RECT 内"前置断言 | `Invoke-QaRightClick` 等 |

### 6.2 判据家族脚本

| 脚本 | 覆盖判据 | 它测什么、打印什么 |
|---|---|---|
| `tools\qa\proc-window-inventory.ps1` | A1, A2, A3, A4, A9(部分), S7, S8, S9 | 枚举顶层窗口 + `Win32_Process` 关联 → 打印 §1.5 六个计数器；`-Invariant appInstance/visibleMainWindow/noLegacyMateEngineX/noLegacyPet` 单选；输出 `hits[]` 含 `pid,imagePath,sha256,title,class,rect` |
| `tools\qa\single-instance.ps1` | A1, A9, S7 | 首次启动 → 快照 → 第二次启动并回收退出码 → 再快照 → 打印 `instances/visibleWindows/vrmCount/secondExitCode/focusGained/legacyPidsUnchanged` |
| `tools\qa\probe-stage.mjs` | A5–A9, A11, A12, A13, A15, A16 | 经 CDP（仅 `tools/qa` 可用、可关闭，Tech-Spec §11）读 `window.__AIRIMATE_STAGE__` 快照并**深比较** `--assert k=v,...`；打印全部探针字段 + `violations[]` |
| `tools\qa\wheel-anchor.ps1` | A10, A11, S4 | 三轮"右键开 → 截图 + 取 `wheel{cx,cy,scale}` → 右键/Esc 关"；打印每轮 `anchorRef`、`anchorMeasured`、`anchorErrPx`、`scaleSeries` 与统计量 |
| `tools\qa\left-button.ps1` | A11, S4 | 左键单击 / 左键拖拽两种输入下采样 `wheel.open` 与窗口位移；打印 `wheelOpenedByLeftClick`、`dragDeltaPx` |
| `tools\qa\idle-rotation.mjs` | A13, S6（轮换部分） | 180s × 250ms 采样 `activeClip/baseClipId/crossfade{from,to,t}`；打印 `distinctIdleClips`、每次切换的 `deltaT`、拟合出的 `crossfadeDurSec` |
| `tools\qa\drag-spring.ps1` | A14, S5 | 拖拽 2s + 释放后 3s，各 60Hz 采样：`baseClipId`、倾斜角、窗口 `bounds`；打印 `dragClipOk`、`leanSeries`、`returnToRestSec`、`sizeDriftPx`（必须 0） |
| `tools\qa\soak-2h.ps1` | A15, A16, A20（周期截图） | 120min × 30s 采样第 §7 节全部字段；打印 `invariantViolations[]`、`tposeSamples`、`fpsAvg5sMin`、`heapSlopeMBPerMin`、`legTravelViolations` |
| `tools\qa\screens.ps1` | A20（+ 各阶段） | 全屏 `CopyFromScreen` 与按 `hwnd` 的窗口截图；打印每张图的 `path/hwnd/rect/bytes`；`bytes < 20KB` ⇒ 警告（疑似黑图） |
| `tools\qa\scan-secrets.ps1` | A17, S1 | 按 §2.1 的 5 个面 + 7 组模式扫描；打印 `filesScanned`、`totalHits`、`patternsHit[]`、每条命中 `file:line:pattern:redactedPreview`（预览只留前 4 位与长度） |
| `tools\qa\ports.ps1` | A18 | §2.2 过滤与归属；打印 `listenCount`、`nonLoopbackListenCount`、`appListeners[]`、`failedToAttribute` |
| `tools\qa\autostart-audit.ps1` | A19, S9, P7 | §2.3 四个面的只读快照 + 谓词匹配（`-Stage pre-install/pre-reboot/post-install/post-uninstall/post-reboot/compare`）；打印 `legacyHitCount`、`legacyHits[]`、`newAppRunEntryCount`、`registryValueMatches`、`startupShortcutMatches`、`scheduledTaskMatches` |
| `tools\qa\legacy-probe.ps1` | S8, A3, A4 | 只读探测旧实例并**原样输出**归属证据（`pid/imagePath/sha256/cmdline/workingDir/visibleWindowCount/windows[]`），供阻断对话框使用；**绝不调用 `Stop-Process`** |
| `tools\qa\claim-audit.ps1` | P7+R 收口 | 解析 `Acceptance-Matrix.md` 主矩阵：每行是否有命令 / 原始输出 / 证据路径 / 状态标记；打印 `rowsWith*` 计数与缺失行号 |
| `tools\qa\blocker-status.mjs` | P2 门禁 | 读 `docs/evidence/phase2/P2-blocker.json` 与 PRD §8；打印 `"BLOCKER-1": "RESOLVED-A|RESOLVED-B|RESOLVED-C|BLOCKED-PENDING-USER"` |

### 6.3 与 `tools/motion-lab/` 的分工（不重复）

| 工具 | 归属 | 产出 |
|---|---|---|
| `tools\motion-lab\convert-anim.mjs` | 管线 | `.anim` → `.vrma` |
| `tools\motion-lab\validate-vrma.mjs` | 管线 | 17 根必需骨骼覆盖、manifest 完整性、腿部活动量 |
| `tools\motion-lab\load-test.mjs` | 管线 | 真实 `VRMAnimationLoaderPlugin` 解析 + 轨道与 normalized bone 对应（未对应项必须 = 0） |
| `tools\qa\*` | 验收 | 只消费上面三者的产物，**不修改**资产 |

---

## 7. 2 小时浸泡回归套件（A15 / A16 / A12 持续断言）

### 7.1 运行前置（必须逐条满足，否则结果无效）

1. 真实桌面会话、已登录、**关闭锁屏与休眠**：`powercfg /change standby-timeout-ac 0`、`powercfg /change monitor-timeout-ac 0`；记录原始值以便测试后恢复（`powercfg /query`）。
2. 应用以 `--diagnostics` 模式启动（挂载 `window.__AIRIMATE_STAGE__`），主进程 `app:diagnostics` 导出到固定文件路径。
3. CDP 仅由 `tools/qa` 使用且可关闭（Tech-Spec §11）；测试结束后关闭。
4. 采样脚本与截图输出目录先建：`docs\evidence\phase7\screens\`。
5. 明确"空闲"定义：**除采样探针外无任何用户输入**（`SetCursorPos` 不移动光标，只读）。

### 7.2 采样与断言表（每 30s 一次，共 240 次）

| # | 采样字段 | 来源 | 断言 | 违规处理 |
|---|---|---|---|---|
| 1 | `appInstanceCount` | `proc-window-inventory.ps1` | `== 1`（**静态不变量**，0 容忍） | 立即中止 + 全套转储 |
| 2 | `characterWindowCount` / `characterVisibleWindowCount` / `chatWindowCount` / `chatVisibleWindowCount` | 应用内 `evt:*` 采样器（`--probe soak` 的 sample 记录） | **`characterWindowCount == 1`**（窗口**对象**恒为一个，0 容忍）；`characterVisibleWindowCount ∈ {0,1}`、`chatWindowCount ≤ 1`、`chatVisibleWindowCount ∈ {0,1}`（都是合法状态） | 立即中止 + 全套转储 |
| 2b | `visibleMainWindowCount`（总数） | 同上 | **只记录，不设断言**（合法值 **0 / 1 / 2**）<br>⚠ 2026-10-08 由 `== 1`（0 容忍）改为"只记录"（理由见 §0.5）；<br>⚠ **2026-10-09 再加一档 `0`**：两个开关都关时只剩托盘图标（理由见 §0.6.2）。<br>**不许**用总数当判据 —— 判据是按身份的两个数（见上一行） | — |
| 3 | `visibleLegacyMateEngineXWindowCount` / `visibleLegacyPetWindowCount` | 同上 | `== 0` 且 `== 0`（静态不变量，0 容忍） | 立即中止 + 全套转储 |
| 4 | `sceneCount` / `rendererCount` / `mixerCount` / `vrmCount` | `__AIRIMATE_STAGE__` | `1/1/1/1`（静态不变量，0 容忍） | 立即中止 + 全套转储 |
| 5 | `live2dCount` | 同上 | `== 0`（静态不变量，0 容忍） | 立即中止 + 全套转储 |
| 6 | `activeClip` / `baseClipId` / `activeWeight` | 同上 | `activeClip` **非 null 且非空**、`baseClipId` 非空、`activeWeight > 0`；**T-pose 判定** = `baseClipId` 为空 **或** `activeWeight == 0` | 计入 `tposeSamples`；连续 2 次（≥60s）即判 FAIL 并中止 |
| 7 | `fps.avg1s` / `fps.avg5s` | 同上 | 跳过前 **60s** 预热；此后 `fps.avg5s >= 50` 的样本占比 = 100%；允许单次瞬时（1 个样本）低于 45 但必须记录 | 单样本 45–50 记 `fpsWarnings`；连续 3 样本 < 50 判 FAIL |
| 8 | `heapMB`（renderer）+ 主进程 `workingSetBytes` | 同上 + `app:diagnostics` | ①后 60min 线性拟合斜率 `<= 0.5 MB/min`；②峰值 `< 2560 MB`；③不出现单调递增 ≥ 40 个连续样本 | 判 FAIL（A16） |
| 9 | 腿骨活动量（**最近 5s**） | `boneTravelAccum` 差值（4 腿骨） | 每个 30s 样本点：对**最近 5s 窗口**求 `boneTravelAccum` 增量，`leftUpperLeg/rightUpperLeg/leftLowerLeg/rightLowerLeg` 四项**各 > 0.5°**，且 `max >= 3.0°`，且同侧上下腿均 > 0.5° | 计入 `legTravelViolations`；连续 4 次（≥2min）判 FAIL 并中止 |
| 10 | `mutexKeeperRunning` / `lockPidMatches` / `lockHeartbeatAgeSec` | `proc-window-inventory.ps1` | `true` / `true` / `< 15` | 连续 2 次异常判 FAIL |
| 11 | `nonLoopbackListenCount` | `ports.ps1`（每 5min 一次即可） | `== 0` | 判 FAIL（A18） |
| 12 | 截图 | `screens.ps1 -Window hwnd` | 每 15min 一张 `A15-soak-<ts>.png`；`bytes < 20KB` 告警 | 人工复核 |
| 13 | 主进程存活与重启计数 | `app:diagnostics.uptimeSec` | `uptimeSec` **单调递增**，不回退（回退 = 发生过重启 ⇒ `restartCount++`） | `restartCount > 0` 判 FAIL |

### 7.3 失败时的处置（固定顺序，缺一步即视为证据不完整）

1. **立即转储**：`probe-stage.mjs --dump docs\evidence\phase7\A15-fail-<ts>-probe.json`（完整 `__AIRIMATE_STAGE__` 快照，含 `bones` 全 17 根四元数、`boneTravelAccum`、`activeClip/crossfade/fps/heapMB/wheel`）。
2. **主进程诊断**：导出 `app:diagnostics` 到 `docs\evidence\phase7\A15-fail-<ts>-diag.json`。
3. **截图**：全屏 + 窗口各一张到 `docs\evidence\phase7\screens\A15-fail-<ts>.png`。
4. **日志尾**：`Get-Content '%APPDATA%\AiriMateOne\logs\*.jsonl' -Tail 300`（**脱敏后再落盘**，落 `A15-fail-<ts>-logtail.txt`）。
5. **进程/窗口全景**：`proc-window-inventory.ps1 -Full` 落 `A15-fail-<ts>-inventory.json`。
6. **然后停止**：浸泡脚本写入 `"aborted": true` + `abortReason` + `abortAtSample` 后退出的**非零**退出码（`2`=断言失败，`3`=无法判定），清理 CDP 与临时文件，**不自动重启应用**、**不自动杀任何进程**。
7. **不掩盖**：允许从 `runs[]` 看到历史；**禁止**删掉失败样本后重跑冒充首次通过（重跑必须在 JSON 里同时保留失败与通过两次记录，并在结论里写明"第 N 次运行通过，前 M 次失败原因 X"）。

### 7.4 通过判据（A15 + A16 合并判定）

```
soakSec >= 7200
invariantViolations == 0                 # 上表 1–5、10、11 全部样本
tposeSamples == 0
legTravelViolations == 0
restartCount == 0
fpsAvg5sMin >= 50                        # 跳过前 60s
heapSlopeMBPerMin <= 0.5                 # 后 60min
heapPeakMB < 2560
maxAppInstanceCount == 1 且 maxVrmCount == 1
maxCharacterWindowCount == 1 且 maxChatWindowCount <= 1   # 2026-10-08 新口径（取代 maxVisibleWindows == 1）
```

> ⚠ **2026-10-08 返工轮**：`maxVisibleWindows == 1` 已作废（chat 打开时正确的可见窗口数就是 2）。
> 正式浸泡**必须**带 `--soak-with-chat`，否则"对话窗口 ≤ 1"这一半**根本没被测到**：
> ```powershell
> node_modules\electron\dist\electron.exe apps\desktop --dev --mode=panel --no-dialogs `
>   --no-proactive --soak-with-chat --probe soak --soak-minutes 120 --soak-sample-sec 30 `
>   --probe-out docs\evidence\phase16\A15-soak-run6.jsonl --probe-exit
> ```
> 采样器的兼容行为：没有按身份计数字段的旧 JSONL 会回落成"总数 ≤ 2"的保守判据，
> 并在报告里输出 `legacyWindowSamplesWithoutIdentityCounts` 如实标注 ——
> **旧证据不能作为新口径的证据**。

**可见性与动画时钟（后加，见 §0.1 的 2026-10-06 说明）**：

```
可见样本占比 >= 95%                       # 低于此值 ⇒ 本轮**无效**（不足以判定），不是失败
动画时钟：相异率 >= 95%
          且 最长连续相同 <= 3 样本
          且 相异取值 >= 30% × 样本数
骨骼运动：相邻样本之间 17 根骨的 |Δq| 最大值 > 0（0 次冻结）
```

> ⚠ 最后两组是**判据被用户裁定修改过**的部分（2026-10-06，原为"相邻必须全部相异"）。
> 修改的理由、代价、以及**负向验证的实测结果（含已知漏判）**见 §0.1；
> 机器可读证据：`docs/evidence/phase8/negative-clock-criterion-2026-10-06.json`。
> **不要**把它读成"标准被放宽" —— 新增的"相异取值下限"拦住了原判据拦不住的
> "低基数循环"形态，但**仍不能**证明时钟推进速率正确（那由骨骼运动与 clip 轮换负责）。

全部成立 ⇒ A15、A16 同一次运行同时 PASS，证据为 `docs/evidence/phase7/A15.json` 与 `A16.json`（同源数据，各自 JSON 内互相引用 `sourceRunId`）。
（当前实际使用的证据路径见 §0.1：`docs/evidence/phase8/A15-soak-run7-*`。）

---

## 8. 本文档的显式决定（源文档未冻结、由本文冻结的部分）

| # | 决定 | 理由 |
|---|---|---|
| D1 | 阶段标识统一为 `P0..P7` + 证据目录 `phase0..phase7`，与 PRD §10 第 1..8 行同序 | 消除 0-based/1-based 混用造成的"阶段 7"歧义 |
| D2 | "窗口数"判据的计数器定义见 §1.5 六项；`MutexKeeper` 不计入 `appInstanceCount` | 源文档只说"一个应用实例"，未定义 Electron 辅助进程与守卫进程如何计数 |
| D3 | A10 的"锚点误差"定义为：**三次开合各自**在打开后 400ms 的静止帧上，`wheel.cx/cy` 与**首次打开**测量值（作为参考锚点）的欧氏像素距离；`mean <= 2` 且 `max <= 2` 才 PASS | 源文档只给"≤2px"，未定义参考基准与采样时刻 |
| D4 | A12 的判定阈值：4 腿骨 5s 增量各 `>0.5°`、`max >= 3.0°`、同侧上下腿均 `>0.5°`；用 `boneTravelAccum` **差值**而非绝对值 | 只判"有运动"，无法防"仅上半身"与"启动瞬间抖动"；`>3°` 取自 Tech-Spec §6.4 的既有数值 |
| D5 | 静默冻结检测：任何 5s 窗口内 4 腿骨增量全部 `<= 0.5°` ⇒ 计入 `legTravelViolations`（即使 `activeClip` 非空也视为"动作在放但角色没动"） | 源文档只要求"activeClip 非空"，无法发现"clip 在放、骨骼冻结"的假存活 |
| D6 | A15 浸泡：30s 采样；静态不变量 0 容忍立即中止；T-pose 连续 2 次判 FAIL；腿骨连续 4 次判 FAIL；失败处置固定 7 步 | 源文档只说"连续运行 2h 无 T-pose/无第二角色/无进程失控" |
| D7 | A16 阈值：预热 60s、`fps.avg5s >= 50`、堆斜率 `<= 0.5 MB/min`（后 60min 线性拟合）、峰值 `< 2560 MB` | "无持续增长"必须量化才可判定 |
| D8 | A17 的 7 组模式 + "`filesScanned >= 200` 下限"防空扫描；只允许对 §1.3 已脱敏的**描述文字**登记白名单，命令行面不允许白名单 | 单纯的 `= 0` 在"扫了 0 个文件"时也会成立 |
| D9 | A18 采用"全机非环回监听 = 0"口径 + `failedToAttribute` 必须为 0；`0.0.0.0`/`::`/局域网地址一律 FAIL | 源文档给了过滤命令但未定义"其它软件在监听"时的处置 |
| D10 | A19 的"0 命中"= 四个面（HKCU Run/RunOnce、两个 Startup 目录、计划任务）合计命中 0，且 `post-install` 时自有项恰好 1、`post-uninstall` 时为 0 | 源文档只给了查询命令，未定义计数口径与"自有项"的期望值 |
| D11 | A17/A15/A16 在 BLOCKER-1 未裁定前的口径：**允许**用桩会话层取得过程证据，但状态一律记 `BLOCKED-PENDING-USER` 或 `NOT VERIFIED`，**不得**记 PASS | ⚠ **该口径已于 2026-09-27 随 BLOCKER-1 裁定为 A 而失效**：A15/A16 已用真实构建跑满 2 小时并通过（`phase8/A15-soak-run5-*`），A17 三个扫描面 0 命中。原文保留作为历史 |
| D12 | 输入仿真首选 `SetCursorPos` + `mouse_event` + `keybd_event`；`SendKeys` 仅在需要输入文本且已确认前台窗口后兜底；每次点击前断言目标点在已枚举窗口 `RECT` 内 | 防副屏负坐标/窗口在屏外导致的假失败 |
| D13 | 所有脚本退出码语义固定：`0` 通过、`2` 断言失败、`3` 无法判定（`INCONCLUSIVE`） | 便于门禁脚本自动判定与防"0 命中=通过"的误判 |
| D14 | 允许的运行期妥协：`--diagnostics` 模式挂载只读探针；CDP 仅 `tools/qa` 使用且可关闭；探针字段必须只读（`Object.freeze` + 值拷贝） | Tech-Spec §9/§11 允许，但"只读"的可验证方式未定义 |
| **D15** | ★ **窗口模型改为"恰好两个独立 BrowserWindow"**：pet/panel（角色，`window-manager.ts`）+ chat（对话，`chat-window.ts`）。旧硬约束「应用只创建一个 `BrowserWindow` / 可见窗口数 = 1」**废止**；判据改为 §0.5.2 的三条（角色窗口 = 1 / chat 内 canvas = 0 / 全应用 WebGLRenderer = 1）。五条入口语义统一为「显示并聚焦，再次触发只聚焦」（§0.5.4）。几何判定一律带 §0.5.5 的容差 | 源文档（PRD:15/20/88、Tech-Spec:38/39）写死"一个可见窗口"，而用户 2026-10-08 明确否决"聊天塞进桌宠窗口"这一形态 —— 旧约束与用户意图直接冲突，必须显式改口径而不是继续打补丁 |
