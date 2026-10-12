# 浸泡 run4 —— 记录它教给我们的两件事（并已修掉）

**时间**：2026-09-27 17:16:54Z 起（`A15-soak-run4.jsonl`），01:31 主动终止（已采集 30 行 = 1 元数据 + 29 样本 + 未打 `end`）
**结论**：**本轮读数无效**（不是"应用失败"）。原因有两个，都可归因、且已分别处理。

**原始数据**：`docs/evidence/phase8/A15-soak-run4.jsonl`
**分析输出**：`docs/evidence/phase8/A15-soak-run4-summary.json`（`verdict = FAIL`，因为 run4 是**旧探针**采集的、没有可见性字段，分析器只能按"全部可见"统计）

---

## 1. 现象

逐样本序列（关键片段）：

```
17:19:09  t= 120s  fps1s=  0  fps5s= 38.6  active=  2.187  bounds=481x761@881,192
17:22:40  t= 330s  fps1s= 66  fps5s= 65.7  active=  2.942  bounds=481x761@881,192
17:23:10  t= 360s  fps1s=  0  fps5s= 13.1  active= 12.618  bounds=481x761@881,192   ← 开始崩塌
17:27:10  t= 601s  fps1s=  0  fps5s=  1.2  active= 12.618  bounds=481x761@881,192
17:29:10  t= 721s  fps1s=  0  fps5s=  0.8  active= 12.618  bounds=481x761@881,192   ← 约 6.5 分钟
17:29:40  t= 751s  fps1s= 65  fps5s= 65.1  active=  1.923  bounds=486x773@880,120   ← 恢复，且窗口变了
17:30:40  t= 811s  fps1s= 62  fps5s= 63.6  active=  2.287  bounds=486x773@880,120
```

两条**互相印证**的读数：`fps5s` 掉到 ≈1（不是 0），同时 `activeTimeSec` **冻结**在 `12.618`。
`≈1 Hz` 正是 **Chromium 对"被遮挡/被隐藏窗口"的 rAF 节流**特征；而冻结的动画时钟说明
渲染循环确实没在跑（应用自身的 `visibilitychange` 处理**故意**在隐藏时暂停渲染 —— 这是**正确行为**，省电）。

⇒ **在窗口不可见的时段测"空闲帧率"没有意义**，它是证据质量问题，不是应用缺陷。

## 2. 顺带抓出的**真缺陷**：拖动结束后尺寸收敛失败会把窗口**推大**

同一份日志里（`%APPDATA%\AiriMateOne\logs\airimate-2026-09-28.jsonl`，bootId `b2ac9d06…`）在
17:29:22–17:29:24 的 **2 秒内出现了 3 次拖动会话**（共 180 条 `window.drag.*`），关键三行：

```
window.drag.size-calibration-failed  { target:"481x761", firstActual:"483x761", compensated:"480x761" }
window.drag.size-restored-on-end     { target:"481x761", requested:"473x760", actual:"482x761", tries:4, converged:false }
window.drag.size-search-failed       { target:"481x761", actual:"484x763", tried:"… 1,4=>484x765" }
… 第三轮 target:"485x768" → actual:"486x773"
```

**根因（我的实现缺陷）**：结束时的"±4 DIP 穷举"在**没命中**时，把窗口**留在最后一次尝试的尺寸**上；
而穷举顺序最后试的是 `+4`，于是失败一次就把窗口**放大一次**。
三次拖动把它从 `481×761` 推到 `486×773`（宽 +5、高 +12）。

**修法**（`apps/desktop/src/main/window-manager.ts` `endDrag()`）：
穷举过程中记下**可达尺寸里最接近目标**的那一次，若最终没命中就**回退到它**，
并把 `bestEffort = { requested, actual, distDip }` 写进证据。
失败时的后果因此从"被推大 5×12 DIP"变成"差 1~2 DIP"，且**一定不会变大**。

> 这条是"把读回值当配置/当目标"这一族问题的第三次现身：
> 第一次是缺陷二（累积增长）、第二次是 `rememberBounds` 持久化读回值、这次是失败路径的落点。

## 3. 另一处观测：窗口在无拖动日志的情况下自己变了尺寸

`t=30s → t=60s` 之间 `bounds` 从 `482x762@900,214` 变成 `481x761@881,192`（宽高各 −1，位置 −19/−22），
而**当时没有任何 `window.drag.*` 日志**（拖动尺寸不漂移时本来就不打日志 ⇒ 与"用户手动拖了一下"一致）。

⇒ 说明这 2 小时里**机器被真人使用过**：这既解释了窗口移动，也解释了 6.5 分钟的"窗口不可见"。
**不是代码问题，但这轮数据因此不能作为"空闲 2 小时"的证据。**

## 4. 因此做的两处修改

| # | 改动 | 性质 |
|---|---|---|
| 1 | 浸泡采样新增 `visibilityState` / `hasFocus` / `hidden` 三个字段（`--probe soak`） | **证据质量**：把"窗口不可见"从"帧率不达标"里分出来 |
| 2 | 分析器（`soak-2h.ps1`）改为：帧率与动画时钟**只在可见样本上统计**；可见样本占比 **< 95% 判 `INVALID_VISIBILITY_COVERAGE`**（不足以判定，而不是 FAIL），并同时输出 `fps5sMinRawAllSamples` 供对照；旧 JSONL 无该字段时按"可见"统计并注明 | **判据口径**：把"用户离开了机器"与"应用帧率不达标"分开 |
| 3 | 拖动结束收敛的 **best-effort 回退**（第 2 节） | **产品修复**：失败路径不再把窗口推大 |

**没有做的事**（避免"为了让判据通过而放松"）：没有调低 `MinFps5s = 50`、没有放宽 `MinSoakSec = 7200`、
没有改 `fpsCap`、没有把不可见时段从**时长/不变量**里剔除（时长与不变量仍然按全部样本统计）。

## 5. 下一轮（run5）的前提

- 应用侧：本轮修复已重建（`npm run build`）；
- 环境侧：**2 小时内机器空闲、没有其他窗口遮挡、不要在本机跑构建/测试/其它探针**；
- 判定：`verdict` 为 `PASS` 才算通过；`INVALID_VISIBILITY_COVERAGE` 表示**需要重跑**（并附隐藏样本数作证）。

接续命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\run-soak-and-finish.ps1 `
  -Jsonl docs\evidence\phase8\A15-soak-run5.jsonl -Minutes 120 -SampleSec 30
```
