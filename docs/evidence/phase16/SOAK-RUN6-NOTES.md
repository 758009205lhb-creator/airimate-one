# SOAK-RUN6 交班便签（2026-10-08）—— ✅ **已完成，判定 PASS**

> **状态：这轮浸泡已于 2026-10-08 19:56:55 跑完（`soakSec=7205.9`，241 样本，`end` 标记存在），
> 收尾五步全部执行完毕。结论 `verdict = PASS`（A15 与 A16 双双通过）。下面的"待办"清单
> 保留下来作为**执行记录与复核指引**，不再是待办。**

## 0. 最终结论（一页读完）

| 项 | 读数 |
|---|---|
| 判定 | **PASS**（`passA15=true`、`passA16=true`） |
| 运行窗口 | 2026-10-08 **17:56:49 → 19:56:55**，`actualSoakSec = 7206`（目标 7200） |
| 不变量违规 | **0** |
| 可见样本占比 | **1.0**（`hidden` 样本 0 个） |
| T-pose 采样 | **0** |
| 动画时钟 | `advancing=true`（相异 231/234 对 = 98.72%，门槛 ≥95%） |
| 帧率 | `fps5sMin = 65.4`、`avg = 67.3`（门槛 50） |
| 堆 | `slope = 0.013 MB/min`（门槛 0.5）、`heapSlopeDecidable = true` |
| 待机轮换 | 58 组 / **错位 0 处**、周期 ≈ 11.98s（判据 12s）、`segments = 2` |
| **角色窗口** | `characterWindowCount` **全程 = 1**、`characterVisibleWindowCount` **全程 = 1** |
| **对话窗口** | `chatWindowCount` unique = **`0,1`**（`=1` 有 **217** 个样本，**从未 >1**）⇒「两窗口并存」**真的被测过** |
| 证据 | `A15-soak-run6.jsonl`（594 KB）、`A15-soak-run6-summary.json` |

**这是历史上第一次在"单窗口 + 两窗口"两种状态下同轮取证。**
`phase8/A15-soak-run5`（2026-09-27）是**单窗口**证据：用新分析器重跑时
`windowCoverageInstrumented=false` ⇒ 它**不能**声称"两窗口并存已验"，尽管两轮都 PASS。

## 1. 这轮浸泡在验证什么

| 项 | 内容 |
|---|---|
| 命令 | `node_modules\electron\dist\electron.exe apps\desktop --dev --mode=panel --no-dialogs --no-proactive --soak-with-chat --probe soak --soak-minutes 120 --soak-sample-sec 30 --probe-out docs\evidence\phase16\A15-soak-run6.jsonl --probe-exit` |
| 启动 | 2026-10-08 **17:56:49**（`meta.startedAt = 2026-10-08T09:56:49.039Z`） |
| 预计结束 | **19:56:49** |
| 产物 | `docs/evidence/phase16/A15-soak-run6.jsonl` |
| 日志 | `%APPDATA%\AiriMateOne\logs\airimate-2026-10-08.jsonl`（事件 `probe.soak.chat-open` / `probe.soak.chat-close`） |

**这轮的关键新增**：`--soak-with-chat` —— 浸泡期间在 **10%（t≈720s）打开**独立对话窗口、
**90%（t≈6480s）收起**，从而在同一份 JSONL 里**同时覆盖**"1 个窗口"与"2 个窗口"两种状态。
没有它，"对话窗口 ≤ 1"这半条判据**根本没被测到**（旧浸泡只有单窗口样本）。

## 2. 收尾五步

```powershell
# ① 出结论
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\soak-2h.ps1 `
  -Jsonl docs\evidence\phase16\A15-soak-run6.jsonl -OutDir docs\evidence\phase16 `
  -SummaryName A15-soak-run6-summary.json
```

② 核对下面**每一个**读数（缺任何一个都不许写"通过"）：

| 读数 | 期望 | 为什么 |
|---|---|---|
| `actualSoakSec` | **≥ 7200** | 时长闸门。分析器对任意长度的 JSONL 都能出 `passA15=true` —— 一份 4 分钟切片也能"通过"，不看时长就会得出**完全错误**的结论（本项目已为此专门加过闸门） |
| `invariantViolationCount` | **= 0** | A15 的核心 |
| `visibleRatio` / `passVisibilityCoverage` | **≥ 0.95** / true | <95% ⇒ 本轮 `INVALID_VISIBILITY_COVERAGE`（**不是失败，是无效**）：被遮挡期间 Chromium 把 rAF 节流到 ≈1Hz、应用主动暂停渲染，都是正确行为 |
| `tposeSamples` | **= 0** | 无 T-pose 窗口 |
| `clockAdvancing` | true | 动画时钟在推进（`activeTimeSec` 单调/回绕） |
| `fps5sMin` | **≥ 50** | A16（仅在可见样本上统计） |
| `heapSlopeDecidable` / 斜率 | true / **≤ 0.5 MB/min** | 窗口不足 30 分钟时分析器**拒绝判定**，不要把它读成通过 |
| **`characterWindowCount`** | **全程 = 1** | ★ 新判据的落点：只有 pet 窗口渲染角色 |
| **`chatWindowCount`** | **出现 0 与 1 两种取值**，且**从未 > 1** | ★ 证明"两窗口并存"分支**真的被测过**；若全程只有 0 ⇒ 这半条**没测到**，要如实写出来 |
| `characterVisibleWindowCount` | 全程 = 1 | 可见角色窗口恰好一个 |

```powershell
# ③ 分支覆盖的机械核对（不要靠肉眼翻 240 个样本）
$out='docs\evidence\phase16\A15-soak-run6.jsonl'
Get-Content $out | ForEach-Object { $o=$_|ConvertFrom-Json; if($o.kind -eq 'sample'){ $o.chatWindowCount } } |
  Group-Object | ForEach-Object { "chatWindowCount=$($_.Name): $($_.Count)" }
Get-Content $out | ForEach-Object { $o=$_|ConvertFrom-Json; if($o.kind -eq 'chat-toggle'){ "TOGGLE $($o.action) ok=$($o.ok) t=$($o.tSec)" } }
```

④ 更新 `CHAT-WINDOW-ROUND.md`：把 §5.1 里"正式 2 小时浸泡 **NOT VERIFIED**"改成实测读数；
若这轮无效（可见样本不足）就**如实写"环境不满足、需重跑"**，不许写成通过。

⑤ 复算门禁：`node tools\qa\audit-acceptance.mjs`（A15/A16 走 `requireField: actualSoakSec ≥ 7200` 那道闸门）
与 `node tools\qa\check-claims.mjs`。

## 3. 已知会污染这轮的因素（出现时必须如实标注）

| 因素 | 表现 | 处置 |
|---|---|---|
| 有窗口整屏盖住它 / 锁屏 | `visibilityState=hidden`、`fps5s≈1`、`activeTimeSec` 冻结 | 可见样本 <95% ⇒ 判 **INVALID**，重跑；**不许**把它算成帧率不达标 |
| 本轮期间跑 typecheck / 单测 / 构建 | `fps5s` 掉到 20~30 | 同上（`run2` 就是这么废掉的） |
| 拖动窗口 | 尺寸读数与位置抖动 | 同上 |
| 机器睡眠 | 采样间隔出现分钟级空洞 | `gapViolations` 会记出来 ⇒ 重跑 |

## 3.5 ✅ 收尾时额外核对的那一项：待机轮换的不匹配率 —— **已解释并已修判据**

**在 run6 跑到 t≈4400s 时的一次中间分析里，出现了这个读数**：

```
轮换判定：… 模式复现：每 4 个样本一循环，36 组中错位 62 处（不匹配率 43.056%）
```

对照历史 `phase8/A15-soak-run5`（PASS）的同一项：**59 组中错位 0 处（0%）**。
当时判断"必须解释，不许当噪声放过"。**解释如下（有逐样本证据）**：

分段看 `idleIndex`：

| 时期 | `idleIndex` 序列 | 循环长度 |
|---|---|---|
| chat 关闭期（`chatWindowCount=0`） | `0,3,5,8` 循环 | 每 4 个样本 |
| chat 打开期（`chatWindowCount=1`） | `1,3,6,8` 循环 | 每 4 个样本 |

两段**都仍在精确循环**、周期仍 11.97~11.98s、平均步长仍是 2.5 ⇒ **轮换完全正常**。
真相：**窗口数变化会改变 rAF 调度相位**，采样相位整体平移一次；
而旧判据是"**全程**与**第一组**比"，隐含假设"全程同相位" —— 那是**单窗口基线**下的假设。

**修法（已落地在 `tools/qa/soak-2h.ps1`）**：按 `chatWindowCount` 变化把序列**切段、每段自比**，
段数进证据（`rotationPatternSegments`）。真正的漂移（周期不准）会在**任何一段内部**持续错位。
**修正后 run6 读数：58 组 / 错位 0 处 / `segments=2` / 周期 11.98s。**


## 4. 这轮之前已经确定、不需要重新论证的口径

- **窗口判据**（2026-10-08 改写）：`characterWindowCount == 1` 且 `chatWindowCount <= 1`；
  总数 `visibleWindows` 合法值是 **1 或 2**，**只记录、不设断言**（旧的 `== 1` 已作废）。
- **A11 尺寸子判据**（2026-10-08 用户裁定改写）：「偏差 **≤1 DIP 且可复现**」；
  依据是 `phase16/sizeMap.json`（只有整物理像素尺寸的"请求→读回"映射跨位置一致）。
  已 PASS（8 步读数全 `482x761`、`distinct=1`）。
- **A14 的承重结构**：拖动期间 `setMinimumSize/setMaximumSize` 钉死**不许拆** ——
  实测拆掉会把 A14 从 PASS 打成 FAIL（八次读数变 `482×761`/`482×763` 混现）。
  这条已写进 `window-manager.ts` 的注释。
