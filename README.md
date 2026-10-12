# AiriMate One

单实例、单窗口的桌面 AI 伴侣。角色是 **Mate 的 VRM**，动作由 **Mate 真实 `.anim` 动捕转出的 VRMA**
驱动；对话能力（聊天 / 人设 / 记忆 / TTS / 供应商）自建。

---

## 这个软件是什么 / 不是什么

| 是 | 不是 |
|---|---|
| 一个 Electron 进程、**一个可见窗口** | 不是"两个窗口对齐并存" |
| **一个** Scene / WebGLRenderer / AnimationMixer / VRM | 不是多角色、多渲染器 |
| 角色用 **VRM**（three-vrm） | **不用 Live2D**（`live2dCount` 恒为 0） |
| 右键 / F1 呼出**径向轮盘** | 不是侧边栏按钮网格 |
| `panel` 与 `pet` 两种模式**同窗切换** | 不重建窗口（`BrowserWindow.id` 全程不变） |

---

## 运行

```powershell
# 依赖（本机只在镜像可达；GitHub 与 npm 主站均不可达）
npm install --registry=https://registry.npmmirror.com

# 构建全部 7 个 workspace
npm run build

# 启动（开发）
node_modules\electron\dist\electron.exe apps\desktop --dev --mode=panel
```

### 启动参数

| 参数 | 说明 |
|---|---|
| `--mode=panel` / `--mode=pet` | 起始模式（**会话级覆盖**，不写回设置；两种写法 `--mode pet` 与 `--mode=pet` 都支持） |
| `--no-dialogs` | 不弹任何对话框（自动化必须传，否则旧实例告警会挂住脚本） |
| `--fps-cap <15..480>` | 帧率上限（默认 90） |
| `--restore-legacy <备份目录>` | 回滚开机自启项（卸载器入口，不建窗口） |
| `--restore-legacy-out <json>` | 回滚结果落盘路径 |
| `--probe <name>` / `--probe-out <file>` / `--probe-exit` | 验收探针（见下） |

> ⚠ 参数拼错会**立即报错并给出建议**（例如 `--mod=pet` → "是否想写 `--mode`？"）。
> 这是刻意的：参数解析器的沉默会把"你写错了"伪装成"功能没生效"（曾经真的发生过）。

---

## 验收探针

所有判据都有可复现命令与原始输出，**没有"目测通过"**。

```powershell
$e = "node_modules\electron\dist\electron.exe"

# 单实例 / 单窗口 / 旧窗口 = 0（A1–A4）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\Get-DesktopState.ps1 `
  -OutDir docs\evidence\phase1 -Screenshot

# 双模式同窗切换（panel ⇄ pet）
& $e apps\desktop --dev --mode=panel --no-dialogs --probe petmode `
  --probe-out docs\evidence\phase1\DUALMODE-from-panel.json --probe-exit

# 轮盘锚点精度 / 命中区域（A10）
& $e apps\desktop --dev --mode=panel --no-dialogs --probe a10 `
  --probe-out docs\evidence\phase3\A10-wheel-anchor.json --probe-exit

# 输入语义：左键只拖拽、右键/F1 开轮盘（A11）
& $e apps\desktop --dev --mode=panel --no-dialogs --probe a11 `
  --probe-out docs\evidence\phase3\A11-input.json --probe-exit

# 动作活性（A12）与待机轮换（A13）
& $e apps\desktop --dev --mode=panel --no-dialogs --probe a12 --probe-out docs\evidence\phase3\A12-leg-motion.json --probe-exit
& $e apps\desktop --dev --mode=panel --no-dialogs --probe a13 --probe-out docs\evidence\phase3\A13-idle-rotation.json --probe-exit

# 拖拽：PET_DRAGGING 生效 + 弹簧回正（A14）
& $e apps\desktop --dev --mode=panel --no-dialogs --probe a14 `
  --probe-out docs\evidence\phase5\A14-drag.json --probe-exit

# 记忆层端到端 + 跨进程持久化（A24）
& $e apps\desktop --dev --mode=panel --no-dialogs --probe memory `
  --probe-out docs\evidence\phase2\A24-memory-e2e.json --probe-exit
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\check-memory-restart.ps1

# TTS（A23）
& $e apps\desktop --dev --mode=panel --no-dialogs --probe tts `
  --probe-out docs\evidence\phase2\A23-tts.json --probe-exit

# 开机自启：只读审计（A19）+ 回滚演练（沙箱注册表键，不碰真实 Run）
& $e apps\desktop --dev --mode=panel --no-dialogs --probe a19 `
  --probe-out docs\evidence\phase7\A19-autostart.json --probe-exit
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\check-autostart-rollback.ps1

# 长稳浸泡（A15/A16）：先跑再分析（可对同一份数据反复出报告）
& $e apps\desktop --dev --mode=panel --no-dialogs --probe soak `
  --soak-minutes 120 --soak-sample-sec 30 `
  --probe-out docs\evidence\phase8\A15-soak.jsonl --probe-exit
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\soak-2h.ps1 `
  -Jsonl docs\evidence\phase8\A15-soak.jsonl
```

> 探针通过 `--probe-exit` 退出时**退出码为 1**（走既有的 `quit('probe')` 路径）。
> **判定只认 JSON 里的 `pass` 字段**，不看退出码。

### 单元测试

```powershell
node apps\desktop\test\run-all.cjs                          # 399 个（主进程：存储迁移 / 工具 / 语音 / 记忆 / 适配器…）
node --test packages\avatar-stage\test\motion-runtime.test.mjs   # 35 个（动作运行时）
node --test packages\motion-director\test\*.mjs                  # 44 个（纯决策状态机）
node --test packages\companion-kit\test\*.mjs                    # 55 个（适配层框架）

npm run typecheck        # 全仓类型检查（0 错误）
node tools\qa\check-no-src-artifacts.mjs   # 防止编译产物掉进 src/、防止 JSON 带 BOM
node tools\qa\report-progress.ps1          # ★ 进度一条命令（见下）
```

> ⚠ 上面四个数字是**当前实测值**，不是历史文档里的抄写值。
> 单测条数会随改动变化；`report-progress.ps1 -Tests` 会跑一遍并**与期望值比对**，
> 不一致就报"与期望条数不一致"——所以加了用例记得同步那里的 `expect`。

### 一条命令看进度：`report-progress.ps1`

```powershell
# 只读汇报（默认；便宜项实跑，贵项读已有证据）—— 浸泡期间也能安全跑
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\report-progress.ps1

# 重建基线（真跑 4 套单测 + 类型检查）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\report-progress.ps1 -Full

# 结构化结果落盘（供后续 diff）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\report-progress.ps1 -Json docs\evidence\phase14\progress-report.json
```

它输出的是**三类互不相同**的结论，混在一起看会得出错误判断：

| 结论 | 含义 | 是不是失败 |
|---|---|---|
| `FAIL` | 门禁不通过 | **是**（退出码 1） |
| `STALE` | 证据的基准日**早于**最新代码 —— 结论对不上当前代码 | **不是**（退出码仍可为 0） |
| `SKIP` | 该项没跑（如默认不跑单测） | **不得当通过** |

> ⚠ **`STALE` 不是失败**，但必须让人看见；这正是"手写进度报告"最容易骗过人的地方。
> 它用**两个新鲜度锚点**：分发包只看 `apps`/`packages`（改 `tools/qa` 的脚本不会让包失效），
> 探针证据看全部源码。

---

## 安全设计（要点）

- `contextIsolation: true` / `nodeIntegration: false` / `sandbox: true` / `webSecurity: true`；
- renderer **只能**通过 preload 的 `contextBridge` 白名单访问主进程，**通道名逐个列出**；
- 每个 IPC 通道在**发送与接收两个方向**都做 zod 运行时校验；
- **密钥只在主进程**：`safeStorage` 加密落盘，renderer 只拿得到
  `hasKey` / `keyFingerprint` / `keyLength`，**无法还原密钥**；密钥不进日志、不进命令行、不进诊断包；
- 自定义 `app://` 协议 + 规范化路径校验（拒绝 `..`、NUL、盘符、UNC、ADS、设备名、符号链接逃逸）；
- **不监听任何端口**（`listeningPorts = 0`）；
- 生产**不用** CDP 注入、不用 `eval` / `new Function`、不加载任何远程资源（CSP `self`）。

---

## 许可与再分发（重要）

- 本项目**私有自用**。
- **Mate Engine** 采用 *MateEngine Pro License v2.1*：允许私用与修改，含 copyleft 条款，
  **禁止商业与二进制再分发**；其 DLC 资产（VRM）**没有独立许可文件**。
- 因此本仓库**不分发** `VRM` / `VRMA` / `.anim`；`assets/models/catalog.json` 只保存
  **本机路径引用**，不复制资产。`tools/qa/stage-dist.mjs` 会把这三类文件**机械拦截**在载荷之外。
- 第三方依赖许可见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)（111 个包，自动生成）。

> ### ★ 形态裁定（2026-10-03，用户决定）
>
> **本产物永久保持"私有自用"形态，不做可再分发资产的替换（M5 的资产替换不做）。**
>
> 理由与后果都记在此处，避免后来者把它当成"待办"：
> - 打包形态下 `avatar` / `motion` 适配器**正确地不可用**（许可闸门给
>   `denied-packaged-non-redistributable`）——这是**预期行为**，不是缺陷；
> - `packaged` + `requireCommercial` 配真实商用资产这条判据**不再追求**（原为
>   `NOT VERIFIED（且不可能验证）`），改为**明确不做**；
> - 若将来要对外分发，需先取得可商用角色资产并重跑许可闸门，那是一个**新任务**，不是本任务的遗留项。

---

## 目录结构

```
apps/desktop       Electron 主进程：单实例三层、唯一窗口、托盘、IPC、供应商/会话/记忆/TTS/自启
apps/renderer      Vue 3 界面：舞台、对话面板、设置、径向轮盘宿主
packages/shared    契约真源：IPC 通道、统一命令、设置、错误、StageSnapshot
packages/security  脱敏、路径授权、CSP、密钥指纹、日志
packages/avatar-stage  唯一角色舞台（Scene/Renderer/Mixer/VRM 都只在这里创建）
packages/motion-director 纯决策状态机（不依赖 three）
packages/radial-menu     径向轮盘几何与命中
tools/motion-lab   .anim → VRMA 转换管线（Unity Humanoid 肌肉曲线 → VRMC_vrm_animation）
tools/qa           验收脚本与探针分析（含一条命令的 `report-progress.ps1`）
docs               PRD / Tech-Spec / API Contract / Migration Plan / Acceptance Matrix / 证据
```
