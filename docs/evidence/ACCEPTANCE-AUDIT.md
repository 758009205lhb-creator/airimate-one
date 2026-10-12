# 验收覆盖审计（交付前自查）

**结论（截至 2026-09-27 晚）：24 条判据中 22 条有明确 PASS 证据；**
**A15/A16（2 小时浸泡）正在进行中（run4，当前构建、无并发干扰）—— 完成前不得算通过。**

证据：`docs/evidence/ACCEPTANCE-AUDIT.json`（机器可读，含每条判据读了哪个文件、哪个字段、实际值）

命令：

```powershell
node tools/qa/audit-acceptance.mjs --json docs\evidence\ACCEPTANCE-AUDIT.json
```

```
验收覆盖审计：共 24 条判据
  PASS=23  FAIL=2  有证据无结论=0  无证据=0
```

> 说明：`PASS=23` 与 `FAIL=2` 之和为 25 > 24，因为 A19 的 3 份证据里有一份是
> `install-cycle`（本轮新增）；审计按"任一证据给出 PASS 即记 PASS、任一为 false 即记 FAIL"
> 的口径，A15/A16 各自只有一份证据且未达时长门槛，故计 FAIL。逐条以 §4 表为准。

---

## 1. 为什么要做这个审计

`docs/Acceptance-Matrix.md` 是**阶段 0** 写的，里面点名了一些脚本
（`probe-stage.mjs --assert`、`proc-window-invariant.ps1`、`ports.ps1` …），
但实现过程中实际用的是**另一批**脚本（`--probe a10`、`Get-DesktopState.ps1`、`auditAutostart()` …）。

于是出现两个都很危险的读数偏差：

| 只看什么 | 会得出什么错觉 |
|---|---|
| 只看矩阵 | "每条判据都有对应工具" —— 但那些工具并不存在 |
| 只看证据目录 | "有一堆证据" —— 但不知道**哪条判据没有**证据，也不知道某份证据里的结论是什么 |

两边一对不上，验收就退化成凭印象。本审计把两者**显式映射**起来，
并且**只信磁盘上的内容**：每条判据列出读的文件、读的字段、实际取值。

## 2. 它第一次运行就抓到的两个真问题

### 问题 1 —— **把"校验分析器"误当成"2 小时浸泡已通过"**

`A15-soak-summary.json` 是分析器对**任意一份** JSONL 的产物。
我在校验分析器逻辑时，用 `--MinSoakSec 200` 分析过一份 **4 分钟**的数据 ——
那份报告里 `passA15=True`、`passA16=True`。

审计第一次运行就把它读成了 **A15/A16 PASS**。若不修，交付报告里会写着
"2 小时浸泡通过"，而**实际浸泡当时才跑了 10 分钟**。

修法：给 A15/A16 加**时长闸门** `requireField: { path: 'actualSoakSec', min: 7200 }` ——
值"看起来通过"还不够，必须真的跑够 2 小时。修后正确报 FAIL 并附待办理由。

> 这条正是"证据要能自证新鲜度"的具体体现：一切**可被重新生成**的证据，
> 都必须带上能判断它是否针对本次运行的字段。

### 问题 2 —— 映射里两个字段路径写错，导致假失败

`A2`（可见主窗口数）与 `A5`（VRM 实例数）被报 FAIL，但实际都是对的：

| 判据 | 我写错的字段 | 正确写法 |
|---|---|---|
| A2 | 给了 `counts.mineVisibleWindows` 但没说明"=1 才算通过"，落到默认的 `allTrue` 判定 | `passWhen: 'eq1'` |
| A5 | `stage.vrmCount` 判 `allTrue`，而它是数字 `1` 不是布尔 | `passWhen: 'eq1'`，并同时校验 `stage.sceneCount` |

⇒ 顺带把判定语义显式化：`passWhen: allTrue | eq0 | eq1 | emptyArray`，
不再用一个笼统的"字段全为 true"。

## 3. 补齐的两条"有证据但无结论"

| 判据 | 原状 | 补法 |
|---|---|---|
| **A21**（动作标记只解析一次） | 只有 `.md` 说明 + 口头"11 个单测" | 跑单测并落 **TAP 原始输出** + 生成 `A21-act-parser.json`（`testsPassed=11 testsFailed=0 pass=true`） |
| **A22**（聊天链路真实接通） | 有 JSON 但映射没指定判定字段 | 用 `passChainWired` + `passReachedServer`：用**无效密钥**打通链路，收到 `auth(401)` 证明请求真的发到了服务端（而不是返回 `NOT_IMPLEMENTED`） |

## 4. 当前逐条状态

| 判据 | 结论 | 证据数 | 备注 |
|---|---|---|---|
| A1 应用实例数 = 1 | ✅ PASS | 1/1 | |
| A2 可见主窗口数 = 1 | ✅ PASS | 1/1 | |
| A3 可见 MateEngineX 窗口 = 0 | ✅ PASS | 1/1 | 旧栈退出后首次通过 |
| A4 旧 `build\pet` 可见窗口 = 0 | ✅ PASS | 1/1 | |
| A5 VRM 实例数 = 1 | ✅ PASS | 1/1 | 同时校验 sceneCount |
| A6 Live2D 实例数 = 0 | ✅ PASS | 1/1 | 浸泡**逐样本**归纳 |
| A7 WebGLRenderer 数 = 1 | ✅ PASS | 1/1 | 浸泡逐样本 |
| A8 AnimationMixer 数 = 1 | ✅ PASS | 1/1 | 浸泡逐样本 |
| A9 第二次启动不新增窗口 | ✅ PASS | 1/1 | 另有 `singleton.wake` 日志 |
| A10 轮盘锚点误差 ≤ 2px | ✅ PASS | 1/1 | `maxErrPx=0`；轮盘由 8 项变 7 项（`sleep` 临时摘除）后已**重新实测通过** |
| A11 **短按不动；越 4px 阈值且命中角色才拖窗口；右键/F1 开轮盘**（判据已于 2026-09-27 重写） | ✅ PASS | 1/1 | 15/15 子项；旧判据"左键只拖拽"本身是错的，见 `phase3/A11-input.md` |
| A12 5 秒内腿部有运动（**阈值已定稿**：任一根 >5° 且 4 骨总行程 >20°） | ✅ PASS | 1/1 | `maxLegTravelDeg=174.02`、`legTravelTotalDeg=415.79` |
| A13 待机 ≥10 / 12s 轮换 / 无 T-pose | ✅ PASS | 1/1 | `emptyClipSamples=0` |
| A14 拖拽 PET_DRAGGING + 弹簧回正 + **尺寸读数恒定** | ✅ PASS | 1/1 | 8 步读数**全部** `482×761`、`sizeDriftMaxDip=0`、`strictSizeUnchanged=true`（口径已定稿为"恒定 + ≤1 DIP"，栅格对齐后实测严格 0 DIP） |
| **A15 连续运行 2h** | ⏳ **进行中** | 1/1 | 时长闸门 7200s；run4 正在当前构建、无并发干扰下重跑，**完成前不算通过** |
| **A16 帧率 ≥50 / 内存无增长** | ⏳ **进行中** | 1/1 | 同上；run2 的 `fps5sMin=0.2` / `clockAdvancing=false` 已定位为**我自己并发 typecheck/测试**造成的窗口 |
| A17 密钥命中 = 0 | ✅ PASS | 3/3 | 工作区 + 程序本体载荷 + 含运行时载荷 |
| A18 非环回监听端口 = 0 | ✅ PASS | 1/1 | `listeningPorts=[]` |
| **A19 安装/卸载/重启后旧自启 = 0** | ✅ **PASS** | **3/3** | 本轮补齐 `install-cycle`：安装 253 文件 → 卸载 254 文件 → 重启等价检验通过 |
| A20 视觉验收截图齐备 | ✅ PASS | 5/5 | |
| A21 动作标记只解析一次 | ✅ PASS | 2/2 | 11/11 单测 |
| A22 聊天链路真实接通 | ✅ PASS | 2/2 | 401 证明到达服务端 |
| A23 TTS 可用（含取消） | ✅ PASS | 1/1 | 27/27 检查 |
| A24 记忆端到端 + 跨进程持久化 | ✅ PASS | 2/2 | 两个不同 bootId |

## 4b. A19 安装演练的两种模式（说明为什么先跑了 `-SkipAutostart`）

自启那两步要调用应用自己的 CLI（写自启项 / 旧自启回滚），而三层单实例保护要求
**独占**启动应用。当另一个实例在跑（本轮正是 2 小时浸泡）时，整条演练会被预检挡住 ——
于是**最容易出错的那部分**（文件复制、快捷方式、安装清单、删除、用户数据保留）
反而一直得不到验证。

所以给演练加了 `-SkipAutostart`：跳过需要独占实例的两步，先把**文件系统侧**验证掉
（可与浸泡并行）。本轮结果：

```
[1/6] 载荷：253 个文件           （清单声明 252，清单自身另计）
[2/6] 复制：253 个文件           （robocopy exit=1）
[3/6] 可执行文件：载荷自带运行时  -> AiriMateOne.exe
[3b]  工作区：…\workspace（assets=True）
[4/6] 自启项：已按 -NoAutostart 跳过
[5/6] 快捷方式：1/1 成功
[6/6] 安装清单：install-manifest.json
安装：PASS

[1/6] 安装清单：schema=airimate/install-manifest/1
[3/6] 快捷方式：检查 2 个（安装时确实存在 1 个），处理失败 0 个
[5/6] 删除安装目录：254 个文件，已删除=True
[6/6] 用户数据：保留（含设置/记忆/密钥）
卸载：PASS

重启等价检验：开机不会执行本应用（已彻底移除）
A19 安装→卸载→重启（等价）演练：PASS
```

**自启两步（写自启项 / 旧自启回滚）已在别处独立验证**：`A19-autostart-audit.json`
（只读审计 + `--mutate` 写→审计→移除）与 `A19-rollback-summary.json`
（沙箱注册表键上的完整回滚演练，3/3 旧项原样恢复）。**尚未**在安装演练里串联这两步。

## 5. 本轮修掉的脚本缺陷（都由演练自己暴露）

| 缺陷 | 现象 | 根因 |
|---|---|---|
| 安装的复制步骤整体失败 | `x 复制失败：Item has already been added. Key in dictionary: 'NO_PROXY'` | 本机同时存在 `NO_PROXY` 与 `no_proxy`，PowerShell 5.1 的 `Start-Process` 构造子进程环境块时抛异常（已知 bug）。改用调用运算符 + 临时降级 `ErrorActionPreference` |
| 快捷方式统计打印成"实际存在 3 个"（实际 1 个） | 看起来像卸载器漏删了两个 | `Where-Object` 只匹配**一项**时返回单个对象而非数组，`.Count` 于是读到对象的属性（`$null`）。一律用 `@(...)` 强制成数组 |
| `-SkipAutostart` 模式下演练自己判自己失败 | `x 安装后自启项 AiriOne 不存在` | 断言没跟着模式走 —— 跳过自启时该项**本该不存在** |

## 6. NOT VERIFIED / 待办（2026-09-27 晚更新）

| 项 | 状态 | 说明 |
|---|---|---|
| **A15 / A16（2 小时浸泡）** | ✅ **已通过** | run5 一次跑满：7206 s / 241 样本 / 0 不变量违规 / T-Pose 0 / `clockAdvancing=true` / 骨骼 240 对样本 0 冻结 / `fps5sMin=62.7` / `heapSlope=0.01 MB/min` / `visibleRatio=1.0`。见 `phase8/A15-soak-run5-PASS.md`。 |
| A14 尺寸零漂移口径 | ✅ **已定稿**（用户 2026-09-27 选 B） | 口径 =「读回值**恒定（不累积）**且偏差 ≤1 DIP」；且在把 panel 尺寸对齐 4 DIP 栅格后，实测为**严格 0 DIP**（8 步读数全 `482×761`）。 |
| A12 的 5° 阈值 | ✅ **已定稿**（用户 2026-09-27 选 C） | 改为组合条件「任一根腿骨 >5° **且** 4 骨总行程 >20°」；实测 174.02° / 415.79°。 |
| **BLOCKER-1（AIRI 源码口径）** | ✅ **已裁定**（用户 2026-09-27 选 A） | 接受能力等价实现；口径约束：**不声称"源级集成"**。裁定记录 `phase2/P2-blocker.json`。 |
| **安装演练里的自启两步串联** | 未做 | 需要独占实例；两步已在别处独立验证（见 §4b）。 |
| `locomotion` 根位移策略 | 未验证 | 本资产包没有 clip 走该分支（唯一 walk 被合理性闸门拦下）。 |
| 真实鼠标拖拽 / 点击级 UI / 桌宠鼠标穿透 / 干净机器安装 | 未验证 | 见 `docs/DELIVERY.md` §5.1。 |
| 审计映射本身的完备性 | 部分人工 | `CRITERIA` 映射是手工维护的（"哪份证据算数"是判断）。它**不能**发现"某条判据的判据本身写错了"，只回答"是否有可解析且给出结论的证据"。 |


证据：`docs/evidence/ACCEPTANCE-AUDIT.json`（机器可读，含每条判据读了哪个文件、哪个字段、实际值）

命令：

```powershell
node tools/qa/audit-acceptance.mjs --json docs\evidence\ACCEPTANCE-AUDIT.json
```

```
验收覆盖审计：共 24 条判据
  PASS=22  FAIL=2  有证据无结论=0  无证据=0
```

