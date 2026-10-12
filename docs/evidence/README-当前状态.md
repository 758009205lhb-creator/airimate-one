# 当前状态（**24 条判据全部通过**）

> 本文件是给**接手的人**看的：现在处于什么状态、怎么自查、还有哪些**未验证**项。

---

## 1. 现在是什么状态：没有后台任务在跑

浸泡 **run5 已跑满并通过**：

```
run-soak-and-finish.ps1 -Jsonl docs\evidence\phase8\A15-soak-run5.jsonl -Minutes 120 -SampleSec 30
  → PROBE_SOAK_DONE {"samples":241,"soakSec":7206}
  → A15-soak-run5-summary.json：verdict=PASS
```

| 读数 | 值 | 门槛 |
|---|---|---|
| `actualSoakSec` | **7206 s** | ≥ 7200 |
| 样本 / 最大间隔 | 241 / 30.1 s | ≤ 90 s |
| 不变量违规 / T-Pose | **0 / 0** | 0 |
| `clockAdvancing` | **true**（180 有效样本） | 必须 |
| 骨骼运动（240 对样本） | **0 次冻结** | 0 |
| `fps5sMin` | **62.7**（avg 66.6） | ≥ 50 |
| `heapSlopeMBPerMin` | **0.01** | ≤ 0.5 |
| `visibleRatio` | **1.0** | ≥ 0.95 |

⇒ `node tools/qa/audit-acceptance.mjs` 输出 **`PASS=24  FAIL=0`**，交付文档引用的 27 个证据文件**缺失 0**。
详见 `phase8/A15-soak-run5-PASS.md`。

## 2. 怎么自查（两条命令）

```powershell
node tools/qa/audit-acceptance.mjs                                   # 逐条判据 × 证据
powershell -NoProfile -ExecutionPolicy Bypass -File tools\qa\status.ps1   # 状态速览
```

`status.ps1` 会打印浸泡进度与**最大采样间隔**、A19 演练结论、24 条判据覆盖读数、
以及类型检查 / 守卫 / 静态断言的现状。（⚠ 它会跑 typecheck 等，**别在浸泡进行中执行**。）

**如果浸泡已结束但汇总缺失，它会自动补跑分析** —— 所以收尾不需要记命令。

## 3. 怎么判断"跑完了没有"

看 JSONL 的最后一行：

- 有 `{"kind":"end", ...}` ⇒ **已结束**（同时该文件的写入时间会停住）；
- 否则仍在进行中。

## 4. 已经确定的事

| 项 | 结论 |
|---|---|
| **24 条判据全部通过** | `node tools/qa/audit-acceptance.mjs` → `PASS=24 FAIL=0`；`docs/DELIVERY.md` §3.3 / §3.4 有逐条证据位置 |
| 交互与取景修复轮（2026-09-27） | **16 个探针全部 pass**；三个缺陷全修 + 另抓出 4 个新缺陷；用户四项决策已落地 |
| A19 安装→卸载→重启（等价） | **PASS**（`A19-install-cycle-summary.json`）；完整模式（含自启两步）演练**尚未端到端跑过** |
| 静态断言 8/8 | `tools/qa/check-claims.mjs` |
| 类型检查 / 守卫 / 单测 | 0 错误；98+35+44 全绿 |

## 5. **A15/A16 为什么前三次都不算，run5 才算**

**run5（通过）** 一次跑满：7206 s / 241 样本 / `completedCleanly=true` / 0 不变量违规 / T-Pose 0 /
`clockAdvancing=true` / 骨骼 240 对样本 0 冻结 / `fps5sMin=62.7` / `heapSlope=0.01 MB/min` / `visibleRatio=1.0`。
完整读数见 `phase8/A15-soak-run5-PASS.md`。

前三轮各自的**证据质量问题**（都不是应用缺陷，逐次留证）：

**run1**（`A15-soak-sleep-interrupted.jsonl`）**确实跑满了**：`soakSec = 10338`（2h52m）≥ 7200s。
但采样有两个巨大空洞：

```
✗ n=60 采样间隔 3655.0s > 上限 90s
✗ n=61 采样间隔 4911.9s > 上限 90s
fps5s: min = 0    ← 只出现在这两个空洞之后
```

根因是**本机自动睡眠**（我在对话轮次之间等待，机器空闲）。
睡眠期间应用根本没在跑 ⇒ **"连续运行 2 小时"并未真正被验证**，
有效连续数据只有前 **1772s ≈ 30 分钟**。

**为什么这不算通过**（关键）：判据是"**连续**运行 2 小时"，
而"总时长够"≠"连续"。分析器现在要求 `violations = 0`（含间隔违规），
所以那次正确地报了 FAIL。

**run2** 跑满 7206s、不变量 0 违规、T-Pose 0、heap 斜率 0.001 MB/min，
但 `fps5sMin = 0.2`、`clockAdvancing = false` —— 那两个时间窗与**我自己的并发
typecheck / 单测 / 构建**完全重合（自伤，不是应用缺陷）。

**run4** 采集到一段 **6.5 分钟 `fps5s ≈ 1` + 动画时钟冻结**。`≈1 Hz` 是
Chromium 对**被遮挡/被隐藏窗口**的 rAF 节流特征，而应用自身的 `visibilitychange`
处理**故意**在隐藏时暂停渲染（正确行为、省电）。同一份日志还显示这 2 小时里
**有真人使用过机器**（窗口被移动、出现 3 次真实拖动）。
⇒ run4 的读数**无法判定**，不是失败。同一份日志还**顺带抓出一个真缺陷**（拖动结束
收敛失败会把窗口推大），已修 —— 全部记录在 `phase8/A15-soak-run4-findings.md`。

**run5** 起：采样带 `visibilityState`/`hasFocus`，分析器带可见性覆盖闸门，
因此"用户离开了机器"与"应用帧率不达标"从此可以机械区分。

详述：`docs/evidence/phase8/A15-soak-run1-sleep.md`、`A15-soak-run4-findings.md`

## 6. 下次重跑浸泡时，先看这几件事

| 症状 | 先查什么 |
|---|---|
| 又有大间隔（> 90s） | 睡眠阻止是否失效；本机 `powercfg /requests` **需要管理员权限**（实测被拒），所以只能靠采样间隔反推 |
| `verdict = INVALID_VISIBILITY_COVERAGE` | 那 2 小时里窗口被遮挡/隐藏过（隐藏样本 >5%）。看 `hiddenSamples` 与 `visibilityNote`；重跑时让机器空闲、别让别的窗口整屏盖住桌宠、别锁屏 |
| `fps5s < 50`（且可见样本足够） | 是否本机同时跑了构建/测试（run2 就是这样） |
| 不变量违规 | 看具体是哪一项：`windowCount≠1` / `vrmCount≠1` / `scene≠1` / `live2d≠0` 才是真缺陷；**采样间隔**违规属于证据质量问题 |
| `boneMotionFrozenPairs > 0` | 骨骼真的停过 ⇒ 渲染/动画循环有真问题，看日志与 `activeTimeSec` |
| heap 斜率超阈值 | 窗口不足 30 分钟时为"未判定"（短窗口噪声大于阈值）；够长才判定 |

## 7. 决策项：**全部关闭**（用户 2026-09-27 裁定）

| # | 事项 | 选择 |
|---|---|---|
| 1 | **BLOCKER-1：AIRI 源码无法锁定** | **A** —— 接受**能力等价实现**（已发布的 MIT 依赖）。事实：GitHub 与所有镜像不可达、本机无源码副本、`app.asar` 无 git 元数据、核心包在 npm 上未发布。**口径约束**：交付在**能力**上对齐（聊天/人设/记忆/TTS/供应商），但**不是 AIRI 源代码本身** ⇒ **不声称"AIRI 源级集成"**。阻塞关闭。详见 `docs/DELIVERY.md` §5.2 |
| 2 | **`sleep` 动作** | 维持**临时屏蔽**，并确认**暂不重导资产**。轮盘 7 项、`DISABLED_MOTION_SEMANTICS` 单点屏蔽、人设提示词已去掉该标记；恢复步骤（5 步）留在注释里，资产重导后可随时执行 |
| 3 | **`fpsCap` 取值** | **保持 60**（未改动）。run5 就是在 60 下 `fps5sMin=62.7` 通过的 ⇒ 现状即达标 |
| 4 | A14 尺寸口径 / A12 阈值 / panel 4 DIP 栅格 | 分别取 B / C / B，均已落地并复测（见 `phase3/INTERACTION-FIX-EVIDENCE.md` §8） |

**⇒ 没有遗留决策项。** 环境变化时可另起一轮升级：GitHub 可达或拿到离线源码包 ⇒ 改为真正的源级集成；
资产侧重导 `sleeping_pet_sleeping`（归一化 `RootT`）⇒ 恢复「休眠」项。两件事都需要**新的证据**，不能沿用旧结论。

> 已关闭（用户 2026-09-27 决定）：A14 尺寸口径（B：恒定 + ≤1 DIP，且栅格对齐后实测严格 0 DIP）、
> A12 阈值（C：任一根 >5° 且 4 骨总行程 >20°）、panel 尺寸 4 DIP 栅格对齐（B）、`sleep` 处理（C）。

## 8. 许可边界（影响分发形态）

Mate Engine 采用 *MateEngine Pro License v2.1*：私用与修改允许、含 copyleft、
**禁止商业与二进制再分发**；DLC 资产（VRM）**无独立许可文件**。
⇒ 本构建**只做私有自用**，载荷**不含** `VRM`/`VRMA`/`.anim`
（组装与安装两处都机械拦截，实测计数为 0）。第三方许可清单见
`THIRD-PARTY-NOTICES.md`（111 个包，0 个未声明许可）。
