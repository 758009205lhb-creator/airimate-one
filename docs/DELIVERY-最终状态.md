# 最终交付状态

**原始快照时间**：2026-09-27 07:22（轮次上限到达时）
**本文件更新**：2026-09-27 晚 —— ① 追加「桌宠交互与取景稳定性修复」一轮的结果与用户四项决策落地情况；
② 2 小时浸泡（A15/A16）**已跑满并通过** ⇒ 24 条判据全部有 PASS 证据。
**纪律**：本文件只写**有原始证据**的结论；未验证的明确标为未验证，不写成通过。

---

## 0. 一句话

软件**已实现并可运行**；**24 条验收判据全部通过**（`PASS=24  FAIL=0  进行中=0  无证据=0`）。

---

## 1. 当前机械读数（2026-09-27 晚实测）

```
验收覆盖审计     PASS=24  FAIL=0  进行中=0  有证据无结论=0  无证据=0
                 交付文档引用的证据文件：27 个，缺失 0 个
                 [audit] 每条判据都有明确结论的证据，且交付文档引用全部有效
2 小时浸泡       run5：7206s / 241 样本 / completedCleanly=true / 0 不变量违规 / T-Pose 0 /
                 clockAdvancing=true / 骨骼 240 对样本 0 冻结 / fps5sMin=62.7 /
                 heapSlope=0.01 MB/min / visibleRatio=1.0          （phase8/A15-soak-run5-*）
类型检查         0 错误
单元测试         98（apps/desktop）+ 35（avatar-stage）+ 44（motion-director）全绿
卫生守卫         src 无编译产物 ✓  仓库无 BOM 的 JSON ✓
静态断言         8/8 成立（含"工程内不存在 live2d 依赖"、"产物无 sourcemap"）
交互/取景探针    16 个全部 pass（a11 / clickOnly / clickRepeated20 / dragStart / dragEnd /
                 dragRepeated50 / idleAnchor60s / clipSwitchCamera / clipPoses / avatarVisible×2 /
                 wheelStable / rootMotionIdle / layoutDiag×2 / sizeDiag）
回归探针         petmode / a10 / a12 / a13 / a14 全部 pass
```

## 2. 已通过的 24 条（逐条证据见 `docs/DELIVERY.md` §3.3 / §3.4）

**不可协商约束全部实测成立**：

| 约束 | 实测 |
|---|---|
| 一个软件实例 | `mineVisibleWindows=1`；三层单实例 |
| **一个可见窗口** | `getAllWindows().length=1`；panel⇄pet 切换中 `windowId`/`webContentsId`/可见窗数全程为 `1` |
| 一个 Scene / Renderer / Mixer / VRM | 浸泡**逐样本**：`scene=1 renderer=1 mixer=1 vrm=1` |
| **不用 Live2D** | 逐样本 `live2dCount=0` **且**工程内无 live2d 依赖（静态断言） |
| 一个角色 | `vrmCount=1` 全程不变 |
| **同窗**双模式切换 | `BrowserWindow.id` 与 `webContents.id` 全程为 `1`（两个方向各 10/10） |
| 旧 `MateEngineX` / 旧 `build\pet` 窗口 = 0 | `legacyKernelVisibleWindows=0`、`legacyPetVisibleWindows=0` |
| 不监听端口 / 生产不放行环回 CSP | `listeningPorts=[]`；环回源只在开发期出现 |
| 无 CDP / `eval` / `new Function` / `SetParent` | 静态断言 |
| 密钥不进 renderer / 日志 / 分发物 | 8 层审计 **0 命中**；载荷扫描 0 命中 |

**其余已通过项**：A10 轮盘锚点（误差 0）、A11 输入语义（**判据已按用户规格重写**，15/15）、
A12 腿部运动（阈值已定稿：任一根 >5° 且 4 骨总行程 >20°；实测 174.02° / 415.79°）、
A13 待机 ≥10 且 12s 轮换无 T-pose 窗口、A14 拖拽弹簧回正 + **尺寸读数恒定（8 步全 `482×761`，严格 0 DIP）**、
A17 密钥、A19 安装→卸载→重启（等价）、A20 视觉截图、A21 动作标记单点解析、
A22 聊天链路接通（401 证明到达服务端）、A23 TTS（27/27）、A24 记忆端到端 + 跨进程持久化。

## 3. 交互与取景修复轮（2026-09-27，用户指定的一轮）

**用户报的三个缺陷全部修复**（根因见 `phase3/INTERACTION-ROOT-CAUSE.md`，证据见 `phase3/INTERACTION-FIX-EVIDENCE.md`）：

| 缺陷 | 判据 | 实测 |
|---|---|---|
| 单击即拖拽 | A11 新判据 | 连点 20 次位移 `(0,0)`、尺寸漂移 `(0,0)`、不拖、不开轮盘、不改缩放 |
| 拖动尺寸累积增长（482×762→528×810） | `dragRepeated50` | 50 轮 `maxWidthDrift=0 / maxHeightDrift=0`，唯一尺寸 `482×761`（连跑 3 次一致） |
| 角色跑出画布（录像里舞台全空白） | `avatarVisible` + 截图 | panel 92.4% / pet 100% 在画布内；非背景像素 19.8% / 14.1%；`inFrustum=true` |
| 60s 待机锚点 / 10 clip 相机 | `idleAnchor60s` / `clipSwitchCamera` | `hips` 屏幕漂移 **0.000px**、锚点误差 **0.000px**、相机变体 **1**；10 clip 仅 **1** 个相机签名 |

**另外抓出并修掉 4 个此前未知的缺陷**：① 命中判定没参与拖动门槛（空白处也能拖窗口）；
② `setSize(...,true)` 的内联样式把画布**钉死**，panel→pet 后画布停在 `90×289`（角色缩在角落）；
③ `screenRect()`/`inFrustum` 用 `Box3.setFromObject` ⇒ 对蒙皮网格**测的是常量**（自欺型证据，
第一次 60s 测试就给出假的 `drift=0.00`）；④ 根位移被**逐 clip** 放大到米级
（`idle_pet_idle_2` 纵向 35 m、`idle_5` 横向 13.6 m、`sleep` 纵深 10.3 m）。

**用户四项决策已全部落地**：A14 口径改「恒定 + ≤1 DIP」（B）／A12 阈值改组合条件 5°+20°（C）／
panel 尺寸对齐 4 DIP 栅格（B，**顺带让严格 0 DIP 达标**）／`sleep` 临时摘掉不呈现错姿态（C）。

## 4. 未通过 / 未验证

| 项 | 状态 | 说明 |
|---|---|---|
| **A15/A16 连续运行 2 小时** | ✅ **已通过** | run5 一次跑满：7206 s / 241 样本 / `completedCleanly=true` / 0 不变量违规 / T-Pose 0 / `clockAdvancing=true` / 骨骼 240 对样本 **0 冻结** / `fps5sMin=62.7` / `heapSlope=0.01 MB/min` / 窗口全程可见。前三次为何不算（**都不是应用缺陷**）逐次留证：run1 **系统睡眠**（有效连续仅 1772s）、run2 **我自己的并发 typecheck/测试**（`fps5sMin=0.2`、`clockAdvancing=false`）、run4 **窗口被遮挡 6.5 分钟 + 有真人使用机器**。见 `phase8/A15-soak-run5-PASS.md`、`A15-soak-run4-findings.md`。 |
| 拖动结束收敛的失败路径 | ✅ **已修**（run4 抓出） | 穷举没命中时原实现把窗口留在**最后一次尝试**的尺寸（通常是 `+4`）⇒ 失败一次就放大一次（实测三次拖动 `481×761 → 486×773`）。现改为**回退到最接近目标的可达尺寸**并记录 `bestEffort`。 |
| 安装演练里**自启两步的串联** | 未做 | 需独占实例；两步已在别处独立验证（只读审计 + `--mutate`；沙箱键回滚 **3/3** 恢复）。完整模式演练尚未端到端跑过。 |
| `locomotion` 根位移策略 | 未验证 | 代码路径与闸门读数都有，但本资产包**没有 clip 走该分支**（唯一 walk clip 横向 4.380 m，被合理性闸门拦下）⇒ 无运行时证据。 |
| 真实鼠标拖拽 | 未验证 | A11/A14 用合成 `PointerEvent`；真实指针事件 `pointerId` 有效（`setPointerCapture` 不抛错），但未做 `SetCursorPos + mouse_event` 级注入。 |
| 托盘菜单 / 设置面板点击级 UI | 未验证 | 未做 UI 自动化。 |
| 无开发树的干净机器安装 | 未验证 | 运行时形态已自带 372 MB 运行时，但未在干净机器实测。 |
| 桌宠模式鼠标穿透 | 未验证 | 未测。 |
| `.anim`/`.vrma` 资产姿态正确性 | 未验证 | 本轮只看"角色在不在画布内"。**sit 不受本轮修复影响**（该 clip 放大后行程 0.00 m）⇒ 它的站姿是资产自身内容。 |
| 12s 轮换的**毫秒级**验证 | 部分 | 浸泡受 30s 采样限制（run5 反推 11.886–12.198 s，包住 12 s）；毫秒级由 `--probe a13` 与 `motion-runtime` 单测保证。 |
| 13 个依赖缺包内许可正文 | 待补 | 对外分发前需从上游取回。 |

## 5. BLOCKER-1（AIRI 源码无法锁定）—— **已裁定为路线 A，阻塞关闭**

**事实**（全部实测）：GitHub 与所有镜像不可达（TLS 握手失败）；本机无 AIRI 源码副本；
`app.asar` 内无 git 元数据（仅 `license: MIT`、`version: 0.12.0-beta.5`、
`github.com/moeru-ai/airi`）；AIRI 核心包在 npm 上声明 `workspace:` 且**未发布**。

**用户裁定（2026-09-27）：路线 A —— 接受能力等价实现。**
交付物用**已发布的 MIT 依赖**实现等价能力：`@xsai/stream-text@0.5.0`、
`@xsai-ext/providers`、`unspeech@0.1.16`、`@proj-airi/ui@0.12.0-beta.5`、`@proj-airi/server-sdk`。

**口径约束（写进结论，不得放宽）**：交付物在**能力**上与 AIRI 对齐（聊天 / 人设 / 记忆 / TTS / 供应商），
**但不是 AIRI 源代码本身** ⇒ **本交付不声称"AIRI 源级集成"**。

该阻塞项就此**关闭**（不是"解决了"，而是"用户裁定了可接受的替代路线"）。

## 6. 决策项：**全部关闭**

| # | 事项 | 选择 |
|---|---|---|
| 1 | **BLOCKER-1 口径** | **A** 接受能力等价实现（口径约束见 §5） |
| 2 | **A14 尺寸口径** | **B**「读回值恒定（不累积）+ 偏差 ≤1 DIP」；栅格对齐后实测**严格 0 DIP** |
| 3 | **A12 判定阈值** | **C** 组合条件「任一根腿骨 >5° **且** 4 骨总行程 >20°」 |
| 4 | **panel 尺寸 4 DIP 栅格对齐** | **B** 做（`482×761 → 480×760`；不再持久化读回值） |
| 5 | **`sleep` 动作姿态** | **C** 临时摘掉；并确认**暂不重导资产**、保持屏蔽 |
| 6 | **`fpsCap` 取值** | **保持 60**（run5 即在 60 下 `fps5sMin=62.7` 通过 ⇒ 现状即达标） |

**⇒ 没有待你决策的遗留项。** 环境变化时可另起一轮升级（见 §7）。

## 7. 怎么接续

```powershell
# 一条命令看状态
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\status.ps1

# 单条探针（跑完自动清理 + 落盘 JSON + 打印 pass）
pwsh -File tools\qa\run-probe.ps1 -Name a11

# 逐条判据 × 证据的机械审计（当前应输出 PASS=24 FAIL=0）
node tools/qa/audit-acceptance.mjs

# 重算浸泡结论（同一份 JSONL 可反复复核）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\soak-2h.ps1 `
  -Jsonl docs\evidence\phase8\A15-soak-run5.jsonl -OutDir docs\evidence\phase8 `
  -SummaryName A15-soak-run5-summary.json
```

**没有后台任务在跑了** —— 浸泡 run5 已结束并通过（`verdict=PASS`，证据 `A15-soak-run5-summary.json`）。

- 下次重跑浸泡：`run-soak-and-finish.ps1 -Jsonl docs\evidence\phase8\A15-soak-run6.jsonl -Minutes 120 -SampleSec 30`
  （阻止睡眠 → 2h 浸泡 → 分析；汇总名自动从 JSONL 名派生，不会覆盖历史轮次）
- 判断跑完：JSONL 最后一行出现 `{"kind":"end"}`
- ⚠ **浸泡期间不要在本机跑 typecheck / 单测 / 构建 / 其它探针**（run2 因此把 `fps5sMin` 打到 0.2），
  **也不要用鼠标拖动桌宠窗口或让别的窗口整屏盖住它**（run4 因此出现 6.5 分钟 `fps≈1`：那是
  Chromium 对不可见窗口的 rAF 节流 + 应用主动暂停渲染，都是正确行为，但会让该轮**无法判定**）。

## 8. 许可边界（影响分发形态）

Mate Engine 为 *MateEngine Pro License v2.1*：私用与修改允许、含 copyleft、
**禁止商业与二进制再分发**；DLC 资产（VRM）**无独立许可文件**。
⇒ 本构建**只做私有自用**，载荷**不含** `VRM`/`VRMA`/`.anim`（组装与安装两处机械拦截，实测为 0）。
第三方许可清单：`THIRD-PARTY-NOTICES.md`（111 个包，0 个未声明许可）。
