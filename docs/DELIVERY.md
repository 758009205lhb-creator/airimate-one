# AiriMate One —— 交付说明与验收索引

> **这份文档是交付的入口。** 它说明：交付了什么、怎么独立复核、
> 哪些**没有**验证、以及需要你决策的事项。
>
> **本文件不含任何未经实测的结论。** 每条"通过"都能在 `docs/evidence/` 找到对应的
> 原始文件（探针自己写出的 JSON/JSONL，不是整理过的叙述）。

---

## 0. 一句话状态

软件已实现并可运行。**24 条验收判据全部通过**（`PASS=24  FAIL=0  进行中=0  无证据=0`）。

```
node tools/qa/audit-acceptance.mjs
  → PASS=24  FAIL=0  进行中=0  有证据无结论=0  无证据=0
    交付文档引用的证据文件：27 个，缺失 0 个
  → [audit] 每条判据都有明确结论的证据，且交付文档引用全部有效
```

最后关闭的两条是同一件事的两面 ——「连续运行 2 小时」（A15）与「空闲帧率 ≥50 / 内存无增长」（A16），
由 `phase8/A15-soak-run5.jsonl` 一次跑满：**7206 s / 241 样本 / 0 不变量违规 / T-Pose 0 /
`fps5sMin=62.7` / `heapSlope=0.01 MB/min` / 窗口全程可见**（`A15-soak-run5-PASS.md`）。
前三次不算通过的原因**都留了证**（系统睡眠 / 我的并发工作 / 窗口被遮挡），详见该文件与 `A15-soak-run4-findings.md`。

> **2026-09-27 追加一轮**：用户指定的「桌宠交互与取景稳定性修复」已完成 ——
> 三个缺陷全修、另抓出 4 个新缺陷、用户四项决策全部落地。见 §3.4。

> **接手请看 `docs/evidence/README-当前状态.md`** —— 当前状态、一条命令怎么查、还有哪些未验证项。

原始审计输出（含每条判据读了哪个文件、哪个字段、实际取值）：
`docs/evidence/ACCEPTANCE-AUDIT.json`

---

## 1. 交付了什么

| 组成 | 说明 |
|---|---|
| `apps/desktop` | Electron 主进程：三层单实例、唯一窗口、托盘、IPC 白名单、供应商/会话/记忆/TTS/自启 |
| `apps/renderer` | Vue 3 界面：角色舞台、对话面板、设置、径向轮盘宿主 |
| `packages/shared` | 契约真源：52 个 IPC 通道、五个统一命令、设置、错误、`StageSnapshot` |
| `packages/security` | 脱敏、路径授权、CSP、密钥指纹、日志 |
| `packages/avatar-stage` | **唯一**角色舞台（Scene/Renderer/Mixer/VRM 都只在这里创建） |
| `packages/motion-director` | 纯决策状态机（不依赖 three） |
| `packages/radial-menu` | 径向轮盘几何与命中 |
| `tools/motion-lab` | `.anim → VRMA` 转换管线（Unity Humanoid 肌肉曲线 → `VRMC_vrm_animation`） |
| `tools/qa` | 19 个验收/卫生脚本（探针分析、安装演练、载荷扫描、许可生成、覆盖审计、收尾编排） |

阶段 0 要求的五份文档齐备：`PRD.md` / `Tech-Spec.md` / `API-Contract.md` /
`Migration-Plan.md` / `Acceptance-Matrix.md`。

## 2. 不可协商的约束 —— 实测状态

| 约束 | 实测 | 证据 |
|---|---|---|
| 一个软件实例 | ✅ | `desktop-state-*.json`：`mineVisibleWindows=1`；三层单实例（Electron 锁 + 命名互斥量 + 锁文件） |
| **一个可见窗口** | ✅ | 同上；`BrowserWindow.getAllWindows().length=1` |
| 一个 Scene / Renderer / Mixer / VRM | ✅ | 浸泡**逐样本**归纳：`scene=1 renderer=1 mixer=1 vrm=1` |
| **不用 Live2D** | ✅ | 逐样本 `live2dCount=0`；工程内无 live2d 依赖 |
| 一个角色 | ✅ | `vrmCount=1` 全程不变 |
| **同窗**双模式切换 | ✅ | `DUALMODE-from-{panel,pet}.json`：`BrowserWindow.id` 与 `webContents.id` 全程为 `1` |
| 旧 `MateEngineX` 可见窗口 = 0 | ✅ | `legacyKernelVisibleWindows=0`、`legacyKernelAllWindows=0` |
| 旧 `build\pet` 可见窗口 = 0 | ✅ | `legacyPetVisibleWindows=0` |
| 不监听端口 | ✅ | `listeningPorts=[]` |

**没有第二个窗口、没有透明叠加、没有 `SetParent`、没有 CDP 注入、没有远程资源。**

## 3. 怎么独立复核

### 3.1 一键复跑全部判据

```powershell
# 依赖（本机 GitHub 与 npm 主站均不可达，只有镜像可用）
npm install --registry=https://registry.npmmirror.com
npm run build                      # 默认产出可分发的干净产物（0 个 .map）

# 单元测试
node apps\desktop\test\run-all.cjs                                  # 98
node --test packages\avatar-stage\test\motion-runtime.test.mjs       # 35
node --test packages\motion-director\test\*.mjs                      # 44

# 类型 / 卫生
npm run typecheck
node tools\qa\check-no-src-artifacts.mjs     # src 产物 + JSON BOM

# 覆盖审计（逐条判据 × 实际证据）
node tools\qa\audit-acceptance.mjs --json docs\evidence\ACCEPTANCE-AUDIT.json
```

### 3.2 逐条判据的取数命令

全部命令见 `README.md` 的「验收探针」一节（含 `--probe a10/a11/a12/a13/a14/a19/tts/memory/petmode/soak`）。
约定：**判定只认 JSON 里的 `pass` 字段，不看退出码**（探针走 `quit('probe')` 退出码为 1）。

### 3.3 逐条结论与证据位置

| 判据 | 结论 | 证据 |
|---|---|---|
| A1 应用实例数 = 1 | ✅ | `phase1/desktop-state-20260927-031853.json` |
| A2 可见主窗口数 = 1 | ✅ | 同上 |
| A3 可见 `MateEngineX` 窗口 = 0 | ✅ | 同上 + `phase1/A2-A3-A4-single-window.md` |
| A4 旧 `build\pet` 窗口 = 0 | ✅ | 同上 |
| A5 VRM 实例数 = 1 | ✅ | `phase1/A-boot-diagnostics.json` |
| A6 Live2D = 0 | ✅ | `phase8/A15-soak-run2.jsonl`（逐样本） |
| A7 WebGLRenderer = 1 | ✅ | 同上 |
| A8 AnimationMixer = 1 | ✅ | 同上 |
| A9 二次启动不新增窗口 | ✅ | `phase7/A19-no-legacy.json` + 日志 `singleton.wake` |
| A10 轮盘锚点误差 ≤ 2px | ✅ | `phase3/A10-wheel-anchor.json`（`maxErrPx=0`） |
| A11 **短按不动 / 越 4px 阈值且命中角色才拖 / 右键·F1 开轮盘**（判据本轮重写） | ✅ | `phase3/A11-input.json`（= `round-interaction/a11.json` 副本）+ `phase3/A11-input.md` |
| A12 5 秒内腿部有运动 | ✅ | `phase3/A12-leg-motion.json` |
| A13 待机 ≥10 / 12s 轮换 / 无 T-pose | ✅ | `phase3/A13-idle-rotation.json` + `phase3/A12-A13-motion-activity.md` |
| A14 拖拽 `PET_DRAGGING` + 弹簧回正 + 尺寸读数恒定 | ✅ | `phase5/A14-drag.json`（= `phase3/a14.json`）：8 步读数**全部** `482×761`、`sizeDriftMaxDip=0`、`strictSizeUnchanged=true` |
| **A15 连续运行 2h** | ✅ | `phase8/A15-soak-run5-summary.json`（7206s / 241 样本 / 0 违规 / T-Pose 0 / 时钟推进 / 骨骼 0 冻结）+ `A15-soak-run5.jsonl` |
| **A16 帧率 ≥50 / 内存无增长** | ✅ | 同上（`fps5sMin=62.7`、`heapSlope=0.01 MB/min`、`visibleRatio=1.0`） |
| A17 密钥命中 = 0（工作区 + 分发物） | ✅ | `phase7/A17-secret-audit.json`、`A17-dist-payload.json`、`A17-dist-payload-runtime.json` |
| A18 非环回监听端口 = 0 | ✅ | `phase1/A-boot-diagnostics.json`（`listeningPorts=[]`） |
| A19 安装/卸载/重启后旧自启 = 0 | ✅ | `phase7/A19-autostart-audit.json`、`A19-rollback-summary.json`、`A19-install-cycle-summary.json` |
| A20 视觉验收截图 | ✅ | `phase1/screens/`（角色可见、取景修复、桌宠自拍）、`phase3/screens/A20-wheel-open.png` |
| A21 动作标记只解析一次 | ✅ | `phase2/A21-act-parser.json`（11/11）+ `.tap` 原始输出 |
| A22 聊天链路真实接通 | ✅ | `phase2/A22-chat-chain.json`（收到 401 ⇒ 请求确实到达服务端） |
| A23 TTS 可用（含取消） | ✅ | `phase2/A23-tts.json`（27/27 检查） |
| A24 记忆端到端 + 跨进程持久化 | ✅ | `phase2/A24-memory-e2e.json`、`A24-restart-summary.json`（两个不同 `bootId`） |

### 3.4 桌宠交互与取景稳定性（**用户指定的一轮修复**，2026-09-27）

按用户要求"只做一轮：先复现录像里的缺陷，再按规格改，不改后端/安全/聊天/动作资产"。

- 根因（先于代码）：`phase3/INTERACTION-ROOT-CAUSE.md`
- 验收证据：`phase3/INTERACTION-FIX-EVIDENCE.md`，原始读数在 `phase3/round-interaction/*.json` + 截图
- 复现：`pwsh -File tools/qa/run-probe.ps1 -Name <探针名>`（跑完自动清理遗留实例/互斥体/锁）

| 判据 | 结论 | 证据（原始 JSON） |
|---|---|---|
| 单击不移动窗口/不缩放/不重取景 | ✅ | `round-interaction/clickOnly.json`、`clickRepeated20.json`（连点 20 次位移与尺寸漂移均为 0） |
| 仅"按住 + 移动 > 4 CSS px 且命中角色"才拖窗口 | ✅ | `round-interaction/a11.json`（`passBarelyDoesNotDrag` / `passBlankDoesNotDrag` / `passLeftStartsDrag`） |
| 50 次拖动后窗口尺寸与首帧一字不差 | ✅ | `round-interaction/dragRepeated50.json`（`maxWidthDrift=0 / maxHeightDrift=0`，连跑 3 次一致） |
| 连续 60s 待机：根位移零漂移、相机零变化 | ✅ | `round-interaction/idleAnchor60s.json`（`hips` 屏幕漂移 0.000px、相机变体 1、锚点误差 0.000px） |
| 切换 10 个待机动作相机完全不变 | ✅ | `round-interaction/clipSwitchCamera.json`（10 个 clip、1 个相机签名） |
| 轮盘三次开合锚点误差 ≤2px | ✅ | `round-interaction/wheelStable.json`（误差 0） |
| 角色 80% 以上在画布内且真的被画出来 | ✅ | `round-interaction/avatarVisible.json` / `avatarVisible-pet.json` + `panel-mode-visible.png` / `pet-mode-visible.png` |
| 全部待机 clip 根位移行程 = 0 | ✅ | `round-interaction/rootMotionIdle.json`（10/10 `mode=none`、横纵 0） |
| 动作转换后角色仍在画布内 | ✅ | `round-interaction/clipPoses.json`（sit / walk / pose 切过去；`sleep` **按方案 C 被挡下**且角色留在待机、仍在画布内） |
| 拖动**过程中**每帧尺寸 0 DIP | ✅ | `round-interaction/a11.json`（`strictDuringDragIdentical=true`、`duringDragSizeDelta=(0,0)`、`endSizeConvergence.tries=0`）—— 由 panel 尺寸对齐 4 DIP 栅格实现（证据 §2.4） |
| 拖动期间尺寸读数恒定（A14） | ✅ | `phase3/a14.json`：8 步读数**全部** `482×761`、`sizeDriftMaxDip=0`、`strictSizeUnchanged=true` |

**用户四项决策已全部落地**（2026-09-27）：

1. A14「零漂移」措辞 → **B**：改为「读回值**恒定（不累积）**，且偏差 ≤1 DIP」；因第 3 项，实测**已是严格 0 DIP**；
2. A12 判定阈值 → **C**：组合条件「任一根腿骨 >5° **且** 4 骨总行程 >20°」（实测 174.02° / 415.79°）；
3. panel 尺寸对齐 4 DIP 栅格 → **B**：`482×761 → 480×760`，并让 `rememberBounds()` 不再持久化读回值；
4. `sleep` 动作 → **C**：临时摘掉（轮盘项移除 + `DISABLED_MOTION_SEMANTICS` 单点屏蔽 + 人设提示词移除），
   避免呈现"站姿抱臂"这一明显错误的姿态；恢复前提是资产侧重新导出该 `.anim`。

细节与原始读数见 `phase3/INTERACTION-FIX-EVIDENCE.md` §2.4 / §5.4 / §8。

## 4. 安全加固 —— 逐项实测

### 4.1 静态断言（`node tools/qa/check-claims.mjs`；扫 62 个源码文件 + 83 个产物文件）

这些是**静态性质** —— 运行期"看起来没有"不等于"不存在"，必须靠源码/产物检查证明：

| 断言 | 结果 |
|---|---|
| 工程内**不存在 live2d 依赖**（不只是运行期没加载） | ✅ |
| 生产源码不使用 `eval` | ✅ |
| 生产源码不使用 `new Function`（含 `setTimeout` 传字符串） | ✅ |
| 生产源码不使用 CDP / 远程调试端口 | ✅ |
| 生产源码不调用 `SetParent` 之类的窗口劫持 API | ✅ |
| renderer 产物不含外部 http(s) 资源引用（CSP `self` 的前提） | ✅ |
| 构建产物不含 sourcemap | ✅ |
| 窗口创建显式加固（`contextIsolation` / `nodeIntegration:false` / `sandbox` / `webSecurity` / `webviewTag:false` / `allowRunningInsecureContent:false`） | ✅ |

> 检查器**剔除注释**后再匹配 —— 注释里写"不要用 eval"是正常的，
> 不该判成违规（这类假阳性会让检查被整体忽略）。
> 机器可读结果：`docs/evidence/CLAIMS-CHECK.json`

### 4.2 运行期实测

| 项 | 状态与证据 |
|---|---|
| IPC 白名单（**52** 通道），双向 zod 校验 | 入参越界实测被拒（返回 `IPC_SCHEMA`） |
| preload 用 `contextBridge` 暴露唯一 API | `apps/desktop/src/preload/index.ts`；通道名内联为常量 + `assertContract()` 防漂移 |
| **密钥只在主进程** | `safeStorage` 密文落盘；renderer 只拿 `hasKey`/`keyFingerprint`/`keyLength`（`phase2/A17b-secret-isolation.json`） |
| 密钥不进日志 / 命令行 / 诊断包 / 分发包 | `phase7/A17-secret-audit.json`（8 层审计，**0 命中**）+ 分发载荷扫描 |
| 自定义 `app://` 协议 + 路径规范化 | 拒绝 `..`、NUL、盘符、UNC、ADS、设备名、符号链接逃逸 |
| CSP `self` | **生产不放行任何环回地址**（开发期才放行 dev server） |
| 不监听端口 | `phase1/A-boot-diagnostics.json`：`listeningPorts=[]` |

## 5. 已知缺口（**不得当作已完成**）

### 5.1 未验证项

| 项 | 说明 |
|---|---|
| **A15 / A16（2 小时浸泡）** | ✅ **已通过**（`phase8/A15-soak-run5.jsonl`）：7206 s / 241 样本 / `completedCleanly=true` / 0 不变量违规 / T-Pose 0 / `clockAdvancing=true` / 骨骼 240 对样本 0 冻结 / `fps5sMin=62.7` / `heapSlope=0.01 MB/min` / 窗口全程可见。前三次为何不算，逐次留证于 `A15-soak-run5-PASS.md` 与 `A15-soak-run4-findings.md`。 |
| 拖动结束收敛的失败路径（run4 抓出，**已修**） | 尺寸"±4 DIP 穷举"没命中时，原实现把窗口留在**最后一次尝试**的尺寸（通常是 `+4`）⇒ 失败一次就**放大一次**（实测三次拖动把窗口从 `481×761` 推到 `486×773`）。已改为**回退到可达尺寸里最接近目标的那一次**，并把 `bestEffort` 写进证据；失败后果从"被推大 5×12 DIP"变成"差 1~2 DIP 且一定不变大"。 |
| 安装演练里**自启两步的串联** | 需独占实例；两步已在别处独立验证（只读审计 + `--mutate`；沙箱键回滚 3/3）。完整模式演练尚未端到端跑过。 |
| 真实鼠标拖拽 | A11/A14 用的是合成 `PointerEvent`；真实指针事件的 `pointerId` 有效（`setPointerCapture` 不会抛错），但未做 `SetCursorPos + mouse_event` 级注入验证。 |
| `locomotion` 根位移策略 | 代码路径已实现并有闸门读数，但本资产包**没有任何 clip 走该分支**（唯一 walk clip 的横向行程 4.380 m，被合理性闸门拦下）⇒ 无运行时证据。 |
| 托盘菜单 / 设置面板的**点击级** UI | 未做 UI 自动化。 |
| 换一台**没有开发树**的机器安装 | 运行时形态已自带 372 MB 运行时，理论上不依赖开发树，但未在干净机器验证。 |
| 桌面宠物模式的鼠标穿透 | 未测。 |
| 12s 轮换的**毫秒级**验证 | 浸泡受 30s 采样限制只有 ±0.4s 精度（run5 反推 11.886–12.198 s，包住 12 s）；毫秒级由 `--probe a13` 与单测保证。 |
| 13 个依赖缺包内许可正文 | 对外分发前需从上游补齐。 |

### 5.2 BLOCKER-1（AIRI 源码无法锁定）—— **已裁定为路线 A，阻塞关闭**

**事实**（全部实测）：GitHub 与所有镜像均不可达（TLS 握手失败）；本机无 AIRI 源码副本；
`app.asar` 内无 git 元数据（仅 `license: MIT`、`version: 0.12.0-beta.5`、
`github.com/moeru-ai/airi`）；AIRI 核心包在 npm 上声明为 `workspace:` 且**未发布**。
⇒ 无法把 AIRI 固定到任何 tag/commit，因此**做不到"源级集成"**。

**用户裁定（2026-09-27）：路线 A —— 接受能力等价实现。**

交付物用**已发布的 MIT 依赖**实现与 AIRI 等价的能力：
`@xsai/stream-text@0.5.0`、`@xsai-ext/providers`、`unspeech@0.1.16`、
`@proj-airi/ui@0.12.0-beta.5`、`@proj-airi/server-sdk`。

**口径约束（写进结论，不得放宽）**：交付物在**能力**上与 AIRI 对齐
（聊天 / 人设 / 记忆 / TTS / 供应商），**但不是 AIRI 源代码本身** ⇒
**本交付不声称"AIRI 源级集成"**，也不得在对外材料里暗示这一点。

该阻塞项**就此关闭**（不是"解决了"，而是"由用户裁定了可接受的替代路线"）。
若日后 GitHub 可达或拿到离线源码包，可另起一轮改为真正的源级集成。

### 5.3 许可边界（影响分发形态）

Mate Engine 采用 *MateEngine Pro License v2.1*：允许私用与修改、含 copyleft 条款、
**禁止商业与二进制再分发**；其 DLC 资产（VRM）**没有独立许可文件**。

⇒ **本构建只做私有自用**，分发包**不含** `VRM`/`VRMA`/`.anim`
（组装与安装两处都做了机械拦截，实测载荷里这三类计数为 0）。
第三方依赖许可已生成清单：`THIRD-PARTY-NOTICES.md`（111 个包，0 个未声明许可）。

## 6. 决策项状态

### 6.1 已关闭（用户 2026-09-27 决定）

| # | 事项 | 选择 | 结果 |
|---|---|---|---|
| 1 | **A14 尺寸口径** | **B**：「`getBounds()` 读数**恒定（不累积）**，且与拖动前偏差 ≤1 DIP」 | 判据文案与字段已更新（`audit-acceptance.mjs`）。**并且**因为同时做了下面第 3 项的栅格对齐，实测已是**严格 0 DIP**（8 步读数全部 `482×761`） |
| 2 | **A12 的判定阈值** | **C**：组合条件「任一根腿骨 >5° **且** 4 骨总行程 >20°」 | 实测 `174.02° / 415.79°`，两个条件都过 |
| 3 | **panel 尺寸是否对齐 4 DIP 栅格** | **B**：做 | `482×761 → 480×760`；`rememberBounds()` 不再持久化读回值。**结果：`strictDuringDragIdentical=true`、`duringDragSizeDelta=(0,0)`、`endSizeConvergence.tries=0`** |
| 4 | **`sleep` 动作姿态** | **C**：临时摘掉，不呈现错姿态 | 轮盘 8→7 项 + `DISABLED_MOTION_SEMANTICS` 单点屏蔽 + 人设提示词移除；`clipPoses` 实测 `accepted=false` 且角色留在待机、仍在画布内 |
| 5 | **BLOCKER-1 口径** | **A**：接受**能力等价实现** | 见 §5.2。**阻塞关闭**；口径约束写死为"**不声称 AIRI 源级集成**" |
| 6 | **`sleep` 资产是否重导** | **暂不重导**，保持屏蔽 | 维持第 4 项现状；恢复前提与 5 步流程仍写在 `DISABLED_MOTION_SEMANTICS` 注释里，随时可执行 |
| 7 | **`fpsCap` 取值** | **保持 60** | 未改动。`phase8/A15-soak-run5.jsonl` 就是在 `fpsCap=60` 下实测 `fps5sMin=62.7`（≥50 门槛）通过的 ⇒ **现状即达标**；schema 默认 90 只是余量更大，不影响任何判据 |

判据原文与原始读数：`phase3/INTERACTION-FIX-EVIDENCE.md` §2.4 / §5.4 / §8；
浸泡读数：`phase8/A15-soak-run5-PASS.md`。

### 6.2 仍需你定

**无。** 全部决策项已关闭（上表 7 项）。
若日后环境变化（GitHub 可达 / 拿到离线 AIRI 源码包 / 重导 `sleep` 资产），
可另起一轮把对应项从"替代路线"升级为"原路线"，届时需要新的证据。

## 7. 复现性与"证据新鲜度"

本项目对证据的要求是**能自证针对本次运行**：

- 所有探针输出带 `bootId` / 时间戳 / 原始读数；
- 跨进程判据用**两个不同 `bootId`** 对照（A24）；
- 时长类判据带**时长闸门**（A15）；
- 可被重新生成的证据（如分析器报告）必须带能判断"是否针对本次运行"的字段 ——
  这条是**踩坑换来的**：分析器曾被用来校验一份 4 分钟数据，
  那份报告里 `passA15=True`，差点被当成"2 小时通过"。
