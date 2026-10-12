# A25+ —— 浸泡回归暴露的**重大缺陷**：待机轮换从未落到 mixer 上

**结论：缺陷已修，修复前后均有实测证据。**
- 修复前：`docs/evidence/phase8/soak-clock-test.jsonl`
- 修复后：`docs/evidence/phase8/A15-soak-rotation-fix.jsonl`
- 2 小时正式浸泡：`docs/evidence/phase8/A15-soak.jsonl`（进行中，报告由 `tools/qa/soak-2h.ps1` 产出）

---

## 1. 缺陷本身

`MotionDirector` 每 12 秒把 `baseClipId` 轮换到下一个待机动作 —— 这件事**一直是对的**。
但 `Stage.animate()` 里只有：

```ts
this.director.tick()          // 决策：该换到 idle_pet_idle_2 了
if (this.mixer) this.mixer.update(dt)
```

**没有任何地方把轮换结果应用到 mixer**。只有 `requestMotion()` / `setDragging()` 这类
**显式请求**才会调 `applyTarget()`。于是：

| 层面 | 表现 |
|---|---|
| `director.getBaseClipId()` | 每 12 秒**正确变化** |
| 状态栏 / 探针 / 验收读数 | 全部显示"正在轮换"，**看起来完全正常** |
| 实际播放的动画 | **始终是最初那一个**，从头到尾没换过 |

这就是"**读数在动、画面没动**"。它比"明显不动"危险得多 —— 因为它让所有既有断言都通过。

## 2. 是怎么被发现的（过程值得记）

我原本要给 2 小时浸泡做"角色是否还在动"的判据，于是依次试了三种信号：

| 信号 | 实测结果 | 结论 |
|---|---|---|
| 采样点之间比对 `bones`（17 根四元数） | 5 个采样点**逐字节相同** | 不可用（但当时无法判断是"姿态相似"还是"信号坏了"） |
| 多步采样 `getNormalizedBoneNode().quaternion` 与 `getRawBoneNode().quaternion` | 5 秒内每 500ms 只有**恒定 0.026°** 变化；两条源**完全一致** | 不可用 |
| `AnimationAction.time`（活动动作的播放时间） | **恒为 2.45**，而 `duration` 也恒为 2.45 | ★ **这就是线索** |

第三个信号之所以关键：`time == duration` 恰好"看起来像正常播到结尾"，
极易被当成合理值放过去。但它在**跨 120 秒、clip 已轮换 6 次的 9 个采样点里一个字都没变** ——
**运动中的动画不可能如此**。

顺带发现的第二层问题：`this.activeAction` 也是**陈旧引用**（它是"最近一次被显式应用的动作"，
不是"当前在播的动作"）。所以我把时钟改成遍历 mixer 里**所有** `isRunning() && weight > 0`
的 action，取时间最大者；这个值随 `mixer.update()` 单调推进并回绕，**不可伪装**。

## 3. 修法

在 `animate()` 里加一步"把决策落到 mixer"：

```ts
const wantedBase = this.director.getBaseClipId()
if (wantedBase && wantedBase !== this.lastAppliedBase) {
  this.applyTarget({ clipId: wantedBase, weight: 1, fadeSec: this.director.getFadeSec() })
}
```

判据用 `lastAppliedBase`（"这个目标是否已经应用过"），**不是每帧都调** ——
每帧调会每帧重置一次交叉淡化，动作永远淡不完（这正是 `applyTarget` 开头那个
`if (this.activeAction === action)` 早退分支存在的意义）。

## 4. 修复前后实测对照

```
修复前（9 个采样点，跨 120 秒，clip 已轮换 6 次）
n=0 t=0    clip=idle_pet_idle   aTime=2.45/2.45  fps1s=63
n=1 t=15   clip=idle_pet_idle_2 aTime=2.45/2.45  fps1s=66
n=2 t=30   clip=idle_pet_idle_3 aTime=2.45/2.45  fps1s=65
...
n=8 t=120  clip=idle_pet_idle   aTime=2.45/2.45  fps1s=64
                       ↑ baseClipId 在轮换        ↑ 时钟一动不动

修复后（17 个采样点，跨 240 秒）
n=1  t=15   base=idle_pet_idle_2 active=idle_pet_idle_2 aTime=1.323/11
n=2  t=30   base=idle_pet_idle_3 active=idle_pet_idle_3 aTime=3.314/3.733
n=3  t=45   base=idle_pet_idle_4 active=idle_pet_idle_4 aTime=6.353/13.333
n=4  t=60   base=idle_pet_idle_5 active=idle_pet_idle_5 aTime=9.365/9.5
n=12 t=180  base=idle_pet_idle_5 active=idle_pet_idle_5 aTime=0.02/9.5   ← 回绕
                       ↑ base 与 active 一致       ↑ 时钟推进并回绕
```

修复后 `base` 与 `active` **每一个采样点都一致**（此前 active 永远是最初那个），
时钟在 `0 → duration` 之间推进并回绕，时长各不相同（11 / 3.733 / 13.333 / 9.5 秒）⇒
**确实在播不同的动作**。

## 5. 这次为什么既有验收**没有**发现它（必须记下来）

| 既有判据 | 为什么通过 |
|---|---|
| A13（12s 轮换） | 它读的是 `director.getBaseClipId()` —— **决策层**的读数。决策是对的，所以 A13 通过。 |
| A12（腿部有运动） | 它读 `boneTravelAccum`，而该值由 `accountFrame()` 每帧对**当时有效**的动作采样累计。即便只有一个动作在无限循环，累计值也会持续增长 ⇒ 通过。 |
| 静止的 3D 截图 | 单帧截图无法区分"在播动作 A"与"在播动作 B"。 |

⇒ 教训：**"决策层读数正确"不等于"决策被执行"**。凡是"决策 → 执行"之间有一跳的地方，
证据必须取自**执行侧**（这里是 `AnimationAction.time`），否则测的是意图而不是结果。

## 6. 当前状态

- 修复已合入 `packages/avatar-stage/src/stage.ts`；
- 回归：A12 / A13 / A14 探针全部重新实测通过（`passDragTilts/ClipActive/SpringReturns=true`）；
- 单测 35（avatar-stage）+ 44（motion-director）+ 98（desktop）全绿；typecheck 0 错误；全量 build 通过；
- 2 小时浸泡正在后台运行，报告将由 `tools/qa/soak-2h.ps1` 分析产出。

## 7. NOT VERIFIED

| 项 | 状态 | 说明 |
|---|---|---|
| 修复后**长时间**轮换的视觉确认 | `NOT VERIFIED` | 修复后只跑了 4 分钟（8 个 clip 覆盖）。2 小时浸泡会覆盖全部 10 个待机 clip，但那是**读数**证据；"肉眼看到每 12 秒真的换动作"未做连续截图对比。 |
| `mixer._actions` 之外的动作枚举方式 | 已避开 | 我一度用 `mixer._actions`（私有字段）枚举动作，实测拿不到有效值，已改为基于 `director` 目标 + `lastAppliedBase` 的方案，不再依赖私有字段。 |
| `bones` 快照字段的可用性 | **已知不可靠** | `snapshot().bones` 与 `boneTravelAccum` 在 5 秒内只有 0.026° 变化，**不能**用于"是否卡死/T-pose"判定。T-pose 判定现改用"任何采样点都必须有有效 `baseClipId`"。该字段为何近乎静止**未追根因**（可能是 vrm 归一化节点的更新时机），已在 schema 注释中标注其局限。 |
| A15 的 2 小时通过 | 进行中 | 见 `A15-soak-summary.json`。 |
