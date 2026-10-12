# A25 —— 舞台动作运行时：补测 + 两个真实缺陷修复（回归 A12/A13/A14）

**结论：35/35 单测通过；A14 三个骨骼/弹簧判据在修复后**重新实测**仍然 PASS。**

---

## 0. 为什么做这一轮

发现了一个**比缺陷本身更危险的结构性问题**：

| 模块 | 角色 | 单测数量 |
|---|---|---|
| `packages/motion-director` | **完全没被生产代码引用** | 41 个（很完整） |
| `packages/avatar-stage/src/motion-runtime.ts` | **Stage 每帧真正在调用的那一份** | **0 个** |

也就是"**测的不是跑的那份**"。这类债不会立刻爆，但会让所有测试通过率失去意义 ——
所以我先给**生产运行时**补上不变量测试，再决定是否合并两个实现。

### 为什么不直接合并（把这个决定说清楚）

两者的契约根本不同，不是"改个 import"：

| | `motion-director` | `motion-runtime`（生产） |
|---|---|---|
| 时钟模型 | **帧驱动**：`frame(nowMs) → DirectorFrame{weights[]}` | **事件驱动**：返回 `MotionTarget{clipId, weight, fadeSec}`，由 Stage 决定何时淡化 |
| 输入 | `MotionClipManifest[]`（完整 sidecar 契约） | `ClipRecord[]`（name/semantic/loopable） |
| 输出 | 每帧完整权重表 + 叠加层状态 | 单次迁移目标 |

要用上 `motion-director` 就必须**替换 Stage 的交叉淡化实现**，
而 A12（腿部行程）、A13（10 个待机 + 12s 轮换）、A14（拖拽倾斜/弹簧回正）三条判据
全部建立在当前实现之上 —— 合并等于把三条已验收判据全部推倒重测，
而收益只是"少一份代码"。**当前阶段不值得**，故本轮的决策是：
先给生产实现补测、修缺陷，把合并留给后续（记录在待办里）。

---

## 1. 测出并修掉的两个**真实缺陷**（生产代码）

### 缺陷 1 —— `request()` 丢掉了"拖拽优先级最高"这条闸门

文件头写着纪律 `拖拽 > 一次性 > 状态 > 待机轮换`，但 `request()` 里**没有对应判断**：

```ts
// 修前：拖拽进行中，这条路径照样往下走
request(semantic, opts) {
  const hit = ...                       // ← 找得到 clip
  if (semantic === 'drag') return this.beginDrag()
  if (opts.once) return this.playOneShot(hit.name, ...)   // ← 直接把拖拽顶掉
  return this.enterState(semantic, hit.name, ...)
}
```

后果：拖拽中收到一次语义请求（例如 LLM 回了 `[motion:wave]`），
`baseClipId` 从 `PET_DRAGGING` 被换成 `wave`、相位从 `drag` 改成 `oneShot`
——角色手上还攥着却被要求跳舞，并且"松手回到拖拽前动作"的暂存逻辑随之失效。

**修法**：在 `request()` 入口加闸门，拖拽中一律拒绝并**显式告警**：

```ts
if (this.dragging) {
  this.warn(`拖拽中，忽略语义请求 "${semantic}"（拖拽优先级最高）`)
  return null
}
```

### 缺陷 2 —— `endDrag()` 恢复动作时把相位写死成 `idle`

```ts
// 修前：baseClip 恢复成一次性动作，相位却硬编码 idle
this.phase = 'idle'
if (this.previousClipId && this.clips.has(this.previousClipId)) {
  this.baseClipId = this.previousClipId        // ← 可能是 wave（一次性）
  return { clipId: this.previousClipId, weight: 1, fadeSec: this.t.dragFadeOutSec }
}
```

后果：进入「相位 = `idle`，但 `baseClip` = 一次性动作」的不一致状态。
而 `tick()` 只在 `idle` 相位推进待机轮换 —— 于是**待机轮换会把这次性动作中途抢走**，
再叠 3s 淡化。表现是"拖完松手，动作跳一下就没了"。

**修法**：按"手上那个一次性动作**现在还在不在播**"恢复相位，判据不能是 `previousPhase`
（拖拽已经把 `phase` 改成 `'drag'`，`previousPhase` 只反映拖拽**之前**）：

```ts
if (this.oneShotClipId && this.isOneShotLive()) {
  this.phase = 'oneShot'
  this.baseClipId = this.oneShotClipId
  this.currentFadeSec = this.t.oneShotFadeSec   // 接续一次性动作，用它自己的淡化时长
  return { clipId: this.oneShotClipId, weight: 1, fadeSec: this.t.oneShotFadeSec }
}
```

配一个 `isOneShotLive()`：**时长未知时按"仍在播"处理**（宁可多播一次，
也不能把用户刚触发的动作吞掉）；时长已知（由 Stage 通过新增的 `setClipDuration()` 告知）时按墙钟判断
—— 拖拽可能持续几十秒，久到那个动作早就播完了。

**修法踩到的坑（第一版是错的）**：我第一版把 `durationMs === 0`（未知）当成
"已播完"（`now < start + 0` 恒为 false），结果所有拖拽都无法恢复动作。
被单测 `拖拽结束：回到拖拽前的一次性动作` 当场抓住，改成"未知 ⇒ 仍在播"。

另修一个小的内部不一致：`endDrag()` 的返回分支没有写回 `currentFadeSec`，
于是 `getFadeSec()`（只读查询）会报出拖拽淡入的 0.18 而返回值是 0.25。
新增测试 `淡化时长查询与返回值在所有分支都一致` 把这条钉死。

---

## 2. 我自己写错、被证据纠正的一条测试

我最初断言"拖拽中 `|leanZ| ≤ 25°`"。实测输出 31.34° ⇒ 测试红了。
**但错的是测试，不是代码** —— A14 自己的证据里早就写明了：

> `during": { "maxAbsLeanZ": 31.34, ... }`，备注"（上限 25°/12° × 1.5 物理保护内）"

`maxLeanZDeg` / `maxLeanXDeg` 是**目标上限**；弹簧阻尼比 0.35 < 1，阶跃输入必然过冲，
所以 `springStep()` 里另有一层 ×1.5 的物理保护限幅。正确的判据是
"**目标**被夹在 ±25°/±12° + **输出** ≤ ×1.5"，不是"输出 ≤ 目标"。
测试已按此改写，并在注释里写清原因，避免下一个人再"修正"回去。

---

## 3. 运行的命令与原始结果

### 3.1 单测

```
node --test packages/avatar-stage/test/motion-runtime.test.mjs
```

```
ℹ tests 35
ℹ pass 35
ℹ fail 0
ℹ duration_ms 390.9929
```

覆盖 8 组不变量：① 装载与"无 T-pose"（任何时刻 baseClip 必须是真实存在的 clip）；
② 待机轮换（12s / 3s / 循环 / 只在 idle 相位推进）；③ 优先级（拖拽 > 一次性 > 状态 > 待机）；
④ 缺失资产必须**显式告警**（缺 `PET_DRAGGING` 时不得静默地只有弹簧）；
⑤ 事件流（可观测性：每次切换都带 `atMs`）；⑥ 弹簧/摇晃数学（收敛、有界、无 NaN、dt=0 不变）；
⑦ 眨眼/呼吸（只作叠加层、reduced 时更少但仍会眨）；⑧ `TUNING` 冻结值（判据的量化依据）。

### 3.2 A14 回归（**关键**：改了生产动作路径就必须重测）

```
.\node_modules\electron\dist\electron.exe apps\desktop --dev --mode=panel --no-dialogs `
  --probe a14 --probe-out "docs\evidence\phase5\A14-drag.json" --probe-exit
```

| 指标 | 修前 | 修后 | 判定 |
|---|---|---|---|
| `during.maxAbsLeanZ` | 31.34 | **31.34** | ✅ 拖拽倾斜仍可测 |
| `heavy.maxAbsLeanZ` | 33.65 | **31.671** | ✅ |
| `heavy.maxAbsLeanX` | 7.472 | **7.472** | ✅ |
| `after.maxAbsLeanZ` | 28.82 | **27.459** | ✅ |
| `after.atRest` | true | **true** | ✅ 弹簧回正 |
| `after.weight` | 0 | **0** | ✅ 叠加权重归零 |
| `during.baseClipId` | `misc_pet_dragging` | **`misc_pet_dragging`** | ✅ PET_DRAGGING 生效 |
| `state.warnings` | 0 | **0** | ✅ 无告警 |
| `passDragTilts` | true | **true** | ✅ |
| `passSpringReturns` | true | **true** | ✅ |
| `passSizeUnchanged` | false | **false** | ❌ 见 §4 |
| `widthDrift` / `heightDrift` | 2 / 2 | **2 / 2** | ❌ 见 §4 |

修前基线已留档：`docs/evidence/phase5/A14-drag.before-motionruntime-fix.json`

---

## 4. NOT VERIFIED / 仍未解决

| 项 | 状态 | 说明 |
|---|---|---|
| A14「拖拽期间窗口尺寸不变（漂移 = 0）」 | ❌ **FAIL（已知）** | 实测 `maxWidthDrift = 2`、`maxHeightDrift = 2`（设备像素 ≈ 2.5px）。已排除 5 个假设（设置写盘、工作区夹取、DPI 变化、`setPosition` 语义、双驱动源），根因指向 **125% 分数缩放下的整数舍入**：8 步内在 482~484 间**振荡且不累积**。**严格零漂移在分数 DPI 下不可达**，需要用户确认判据口径（建议改为"漂移 ≤ 2px 且不累积"）。这是一个**需要你拍板的判据问题**，不是我可以自行放宽的。 |
| 跨显示器拖拽（125% → 100% 或 150%） | `NOT VERIFIED` | 只有一个缩放档位的实测；跨 DPI 拖拽未测。 |
| `motion-director` 与 `motion-runtime` 的合并 | `NOT VERIFIED`（未做） | 见 §0 的取舍说明。当前是"两份实现并存"，生产用的是 `motion-runtime`（现已 35 个单测）。 |
| `setClipDuration()` 的实际接线 | `NOT VERIFIED` | 方法已实现并单测覆盖，但 **Stage 目前尚未调用它** —— 因此"拖拽久到一次性动作已播完"这条分支在生产中走的是"时长未知 ⇒ 仍在播"的保守路径。需要在 Stage 装载 clip 后把 `clip.duration` 告知引擎才能生效。 |
| A12 / A13 回归 | `NOT VERIFIED`（本轮未重测） | 本轮改动只触及 `request()` 的拖拽闸门与 `endDrag()` 的相位恢复，理论上不影响腿部行程与待机轮换；但**理论上不影响 ≠ 已验证**。A14 已重测，A12/A13 需补一次。 |
