# A2 / A3 / A4 —— 单窗口与「旧窗口 = 0」（A3 首次转 PASS）

**结论：A2 PASS、A3 PASS、A4 PASS。** 由真实桌面截图 + DPI 感知的 Win32 窗口枚举共同判定。
证据：`docs/evidence/phase1/desktop-state-20260927-031853.json`、
`docs/evidence/phase1/screens/mine-pid17300-619x960-20260927-032126.png`

---

## 1. A3 为什么此前一直 NOT VERIFIED，现在为什么能过

| | 之前 | 现在 |
|---|---|---|
| 旧方案栈（`MateEngineX.exe` / `airi.exe` / `tools\host\airi-host.mjs`） | **正在运行** | **已自行退出** |
| `legacy.hits` | `count=4, blocking=true` | **`未检测到旧实例`** |
| `legacyKernelVisibleWindows` | 1（`316x320+1113+675 title='MateEngineX'`） | **0** |
| A3 判定 | ❌ 无法通过（旧窗口客观存在） | ✅ **PASS** |

**必须先说清楚：旧栈不是我结束的。** 我不能证明它退出的确切时刻，只能给出可核查的事实：

- 本会话中我执行过的、可能结束进程的命令**只有三类**，且都带**归属判定**：
  1. `Get-Process electron | Where-Object { 命令行 -like "*新工程*" } | Stop-Process`
     —— 只匹配本项目工作区路径；
  2. `Get-CimInstance Win32_Process | Where-Object { 命令行 -like "*MutexKeeper*" 或 "*AIRIMATE_MUTEX_NAME*" }`
     且**父进程名不是 electron** 才结束 —— 这些是我们自己的互斥量守卫子进程；
  3. 沙箱注册表键 `HKCU\Software\AiriMateOneQA` 的删除。
- 我**从未**使用过按进程名（`MateEngineX` / `airi` / `node`）结束进程的命令 —— 这正是为了避开"按名字判定归属"这个已被 E0 取证证明会自匹配的错误做法。
- 现场残留的痕迹（`%LOCALAPPDATA%\AiriMate\host.lock.json` **不存在**、`61966/18190/18191` 三个端口**无监听**，仅有一条 `TIME_WAIT` 到 `61966`）说明**旧栈的宿主进程是自己退出/被外部退出的**，而不是被逐个杀死后留下锁文件。

> 若旧栈是你手动停掉的，那就与上述一致；如果它是在你没有操作时自己退出的，那是一个**独立于本项目的现象**，值得单独看一眼（它意味着旧宿主有非预期的退出路径）。

---

## 2. 原始实测读数

```
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\Get-DesktopState.ps1 `
  -OutDir "docs\evidence\phase1" -Screenshot
```

```
counts: mineVisible=1 mineAll=10 legacyKernelVisible=0 legacyPetVisible=0 totalVisible=18
  mine: pid=17300 visible=True rect=619x960+1159+168 title='AiriMate One'
WROTE docs\evidence\phase1\screens\mine-pid17300-619x960-20260927-032126.png
```

| 判据 | 要求 | 实测 | 判定 |
|---|---|---|---|
| **A1** 应用实例数 = 1 | 1 | `mineVisible=1`（同 pid 的其余 9 个窗口 `visible=False`：`Chrome_WidgetWin_0` / 托盘宿主 / IME / 电源消息窗口） | ✅ |
| **A2** 可见主窗口数 = 1 | 1 | `mineVisibleWindows=1`，标题 `AiriMate One`，`619x960+1159+168`（物理像素，scale 1.25） | ✅ |
| **A3** 可见 `MateEngineX` 窗口 = 0 | 0 | `legacyKernelVisibleWindows=0`、`legacyKernelAllWindows=0`，`legacyKernelWindows=[]` | ✅ |
| **A4** 旧 `build\pet` 可见窗口 = 0 | 0 | `legacyPetVisibleWindows=0`、`legacyPetWindows=[]` | ✅ |

归属判定口径（写死在脚本的 `methodology` 里，**不按进程名**）：
`legacy kernel predicate: imagePath ends with MateEngineX.exe OR commandLine contains MateEngineX`；
`this-app predicate: imagePath or commandLine contains 新工程`。

旧实例检测同时从"阻断"变为"通过"：

```json
{"msg":"未检测到旧实例","event":"legacy.hits"}   ← 之前是
{"msg":"检测到旧实例","fields":{"count":4,"blocking":true,
  "kinds":"legacy-bridge,mate-engine-kernel,legacy-brain,legacy-airi-combo"}}
```

⇒ `boot.ready` 里 `legacyContinue=false`（之前是 `true`）—— 应用现在是**干净启动**，
不再走"用户选择忽略旧实例告警继续启动"这条降级路径。

---

## 3. 截图顺带抓出的两个**界面缺陷**（已修）

截图是唯一能发现这类问题的手段：它们**不报任何错**，只是把错误信息展示给用户。

### 缺陷 A —— 空状态文案说"功能还没做"，而功能早就可用

```html
<!-- 修前 -->
还没有对话。会话内核（供应商 / 人设 / 记忆 / TTS）在阶段 2 接入；
当前发送会返回明确的「未实现」错误，不会伪造回复。
```

阶段 2 已经落地（聊天链路、人设、历史、记忆注入、TTS 全部可用），
界面却在**功能可用**的情况下告诉用户"还没做" —— 会让用户根本不去尝试。

修法：按**真实前置条件**分支给指引（有密钥 / 没密钥两种文案），
并在注释里写明"文案必须随实现状态更新"。

### 缺陷 B —— `密钥后端 unknown`（字段从未被赋值）

```
apps/renderer/src/store.ts:67    backend: 'unknown',      // 声明了
（全仓搜索：没有任何地方给 state.backend 赋过值）
```

而界面有两处读它：状态栏徽标 `密钥后端 {{ app.backend }}`、
设置面板 `当前后端状态：{{ app.backend }}`。⇒ 用户永远看到 `unknown`，
**而真实值是 `safeStorage`**。这是一个直接说谎的界面元素。

修法：新增 `loadProviders()` action，在 `init()` 里真的调一次 `provider:list`，
把 `backend` 与 `providers` 一起落进状态。修复后截图：

```
密钥后端 safeStorage          ← 之前是 "密钥后端 unknown"
还没有对话。要开始聊天，请先到设置里添加供应商（baseUrl / 模型 / 密钥）。
密钥只保存在本机（加密后端：safeStorage），不会进入界面或日志。
```

### 顺带修正契约里一个**不存在的分支**

`preload-api.ts` 把 `listProviders` 的返回声明为
`ProviderPublic | { providerId, keyFingerprint, keyLength, updatedAt, hasKey }` 的**联合**。
后半段是**猜测出来的更窄形状**（`providerId` 而不是 `id`、没有 `label`），
而 `ipc.ts` 里主进程**一直只返回** `ProviderPublic & { active }`。

契约里一个不存在的分支比"少一个字段"更坏：它让人以为有两种返回形态，
并且会让任何取 `p.label` 的 renderer 代码过不了类型检查。已按真实出参收敛。

---

## 4. NOT VERIFIED

| 项 | 状态 | 说明 |
|---|---|---|
| 旧栈退出**原因** | `NOT VERIFIED` | 我只能证明"我没按名字杀过它"，以及现场残留物不支持"被逐个杀死"这个解释。**无法证明**它为何退出。 |
| A3 在**旧栈运行时**的表现 | ✅ 已记录（非 PASS） | 旧栈运行时旧窗口客观存在（1 个），应用的正确行为是**阻断并告警**（已验证）。A3 要求"=0"，只有旧栈不跑时才可判定通过。 |
| pet 模式下的窗口计数 | `NOT VERIFIED` | 本次截图与计数都在 `--mode=panel`。pet 模式窗口更小，未复测 A2/A3/A4。 |
| 圆角/透明/阴影等在真实桌面上的观感 | `NOT VERIFIED` | 截图可见窗口**矩形**与内容，但 `frame:false` 下的圆角与投影是否符合设计稿，需人工目视确认。 |
| 截图的**像素级**断言 | `NOT VERIFIED` | 本轮截图用于"看得见/数量对"的人工与半自动判定；没有做逐像素回归基线（会因角色动画帧不同而不稳定）。 |
