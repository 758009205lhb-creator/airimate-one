# 浸泡 run5 —— **A15 / A16 通过**（2026-09-27 晚）

**结论**：`verdict = PASS`。24 条验收判据至此**全部有明确 PASS 证据**（`PASS=24 FAIL=0`）。

**原始数据**：`docs/evidence/phase8/A15-soak-run5.jsonl`（241 样本 + `meta` + `end`）
**分析输出**：`docs/evidence/phase8/A15-soak-run5-summary.json`
**命令**：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\run-soak-and-finish.ps1 `
  -Jsonl docs\evidence\phase8\A15-soak-run5.jsonl -Minutes 120 -SampleSec 30
```

---

## 1. 关键读数（全部来自 summary JSON，未手工编辑）

| 项 | 实测 | 门槛 | 结论 |
|---|---|---|---|
| 浸泡时长 `actualSoakSec` | **7206 s**（2h00m06s） | ≥ 7200 | ✅ |
| `completedCleanly`（有 `end` 标记） | **true** | 必须 | ✅ |
| 样本数 | **241** | —— | —— |
| 最大采样间隔 | **30.1 s** | ≤ 90 s | ✅（零空洞） |
| 不变量违规（window/scene/renderer/mixer/vrm/live2d/boneCount） | **0** | 0 | ✅ |
| T-pose 采样（`baseClipId` 为空） | **0** | 0 | ✅ |
| 动画时钟 `clockAdvancing` | **true**（180 个有效时钟样本，0 次未推进） | 必须 | ✅ |
| **骨骼运动交叉验证** | **240 对样本、0 次冻结**，|Δq| 最大值区间 `[0.348, 2.147]` | 0 次冻结 | ✅ |
| 帧率 `fps5sMin` | **62.7**（avg 66.6，fps1s avg 66.4） | ≥ 50 | ✅ |
| 可见性覆盖 `visibleRatio` | **1.0**（241/241 可见、241/241 有焦点） | ≥ 0.95 | ✅ |
| 堆内存 `heapSlopeMBPerMin` | **0.01**（118.5 → 158.0 MB 区间） | ≤ 0.5 | ✅ |
| 轮换周期（由采样混叠反推） | **≈ 12.04 s**（区间 11.886–12.198） | 12 s | ✅ |

## 2. 与前三次的区别（为什么这次才算）

| 轮次 | 结果 | 原因（都不是应用缺陷） |
|---|---|---|
| run1 | 无效 | 跑满 10338s 但被**系统睡眠**打断：空洞 3655s / 4912s，空洞后 `fps5s=0`，有效连续仅 **1772s** |
| run2 | 失败 | 跑满 7206s、不变量 0 违规，但 `clockAdvancing=false`、`fps5sMin=0.2` —— 那两个时间窗与**我自己的并发 typecheck/单测/构建**完全重合 |
| run4 | 无效 | 出现 6.5 分钟 `fps5s≈1` + 动画时钟冻结：Chromium 对**不可见窗口**的 rAF 节流（应用主动暂停渲染是正确行为），同轮日志还显示**有真人用过机器**。见 `A15-soak-run4-findings.md` |
| **run5** | **PASS** | 当前构建、机器空闲、窗口全程可见未被遮挡；期间**未在本机跑任何构建/测试/探针** |

## 3. 这一轮顺带修掉的两个"测量工具"缺陷（否则会误判）

1. **`activeTimeSec` 在约 1/4 样本上读到 `null`**，且这些样本的 `n` **严格每 4 个一次**
   （run2 同样如此，n = 0,4,8,…）。根因是采样网格 30 s 与轮换周期 12 s 的相位关系：
   总有固定采样点落在**交叉淡化的某个相位**，那一刻没有任何 action 的 `getEffectiveWeight() > 0`。
   ⇒ 加了**骨骼运动交叉验证**（相邻样本 17 根骨 |Δq| 最大值必须 > 0）：
   既证明"这 1/4 样本只是**读数无效**而非动画停了"，也堵住"时钟恒为 null 的卡死会被静默放过"这个漏判空间。
2. **`run-soak-and-finish.ps1` 的分析步骤曾经是坏的**：续行反引号后紧跟**注释行**，
   导致 `-Jsonl` 被当成新语句（`missing mandatory parameters: Jsonl`）——
   浸泡本身跑完（`PROBE_SOAK_DONE`），**但汇总没生成**，2 小时数据白等。已修（汇总名算在独立语句里）。

## 4. 复算方式（证据可复核）

```powershell
# 同一份 JSONL 可反复重算，结论一致
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\soak-2h.ps1 `
  -Jsonl docs\evidence\phase8\A15-soak-run5.jsonl -OutDir docs\evidence\phase8 `
  -SummaryName A15-soak-run5-summary.json
```

⚠ **不要**用 `-MinSoakSec 0` 的结果下结论：只要给任意一段（哪怕 64 分钟）数据，
它也会报 `passA15=True`。判据 A15 的时长闸门在审计里是独立的一道检查
（`requireField: { path: 'actualSoakSec', min: 7200 }`）。
