# A12 / A13 —— 动作活性与待机轮换验收（本轮新增探针，此前 NOT VERIFIED）

**结论：A12 PASS，A13 PASS。**
证据文件：`A12-leg-motion.json`、`A13-idle-rotation.json`（均由应用自己写出）

---

## 0. 为什么这两条此前一直是 NOT VERIFIED

`boneTravelAccum` 字段早就实现并逐骨累计了，但**从没做过断言** ——
交接文档里也如实写着"A12 未测"。补这一轮的直接原因是：
我在修 `motion-runtime` 的两个缺陷（见 `phase5/A25-motion-runtime.md`）时动了
**生产动作代码**，而 A12/A13 判据正是建立在它之上，不能只凭"理论上不影响"过关。

### 补测时踩到的两个方法论问题

**问题 1：累计量读非零 ≠ 这 5 秒在动。**
`boneTravel` 是**自启动以来的累计**角行程。直接读到 90° 只能证明"历史上动过"，
证明不了"现在在动" —— 而"人物卡死不动"恰恰是桌宠最典型的故障。
所以探针固定为 `reset → 等 5s 真实时间 → read`。实测清零前/后差别巨大：

| | leftUpperLeg | rightUpperLeg | leftLowerLeg | rightLowerLeg |
|---|---|---|---|---|
| 清零前（自启动累计） | 89.98° | 90.68° | 24.58° | 39.85° |
| **清零后 5 秒真实采样** | **8.09°** | **7.72°** | **0°** | **10.05°** |

**问题 2：探针挂错了钩子，报错信息完全指不到原因。**
我先把 op 加进了 `__AIRIMATE_DRAG_PROBE__`，而主进程调的是 `__AIRIMATE_STAGE__`，
结果只拿到 `Script failed to execute`（renderer 侧不会给编译期提示）。
现在改为独立的 `__AIRIMATE_MOTION_PROBE__`，并且**在 `env.d.ts` 里集中声明所有探针钩子**
—— 以后改名会被 `npm run typecheck` 挡住，而不是留到运行时。

---

## 1. A12：腿部确实在动

```
.\node_modules\electron\dist\electron.exe apps\desktop --dev --mode=panel --no-dialogs `
  --probe a12 --probe-out "docs\evidence\phase3\A12-leg-motion.json" --probe-exit
```

```json
{"sampleWindowSec": 5,
 "legTravel": {"leftUpperLeg": 8.09, "rightUpperLeg": 7.72, "leftLowerLeg": 0, "rightLowerLeg": 10.05},
 "maxLegTravelDeg": 10.05,
 "movedLegBones": ["leftUpperLeg", "rightUpperLeg", "rightLowerLeg"],
 "clipsObserved": ["idle_pet_idle", "idle_pet_idle_10"],
 "idleTotal": 10,
 "passA12": true, "passA13Count": true, "passNoTpose": true,
 "passUiIdleCountMatches": true, "pass": true}
```

判定：**5 秒内 3 条腿骨角行程 > 5°**（阈值 5°：待机动作幅度本就很小，
要求太高会假失败；但 0° 附近必须判失败，那才是卡死）。

### 顺带抓出的一个**界面缺陷**（A13 数量在界面上恒为 0）

探针同时读了界面用的那个 getter，发现并修掉一个**静默**的契约漂移：

```ts
// 修前（apps/renderer/src/store.ts）
idleCount: (s) => s.motion.manifests.filter(m => m.semantic.includes('idle') || /idle/i.test(m.id)).length
```

manifest 契约在收敛后用的是 **`name` / `set`**（见 `MotionClipManifestSchema` 的注释：
早期自造字段与管线产物不一致，16 份清单曾全部校验失败）。
于是 `m.semantic` 恒为 `undefined`、`m.id` 也不存在 ⇒ **`idleCount` 恒为 0**，
状态栏永远显示"动作 0 待机"，而后端明明有 10 个。

这个缺陷**不会报任何错**，只有把界面读数也纳入验收才能发现。修复后实测：

```json
"ui": {"idleCount": 10, "manifestCount": 16, "stageIdleTotal": 10, "clipIds": 16, "failed": 0,
       "manifestSets": ["idle","walk","drag","single","sit","sleep"],
       "manifestNames": ["idle_pet_idle","idle_pet_idle_10","idle_pet_idle_2", ... ,"sleeping_pet_sleeping"]}
```

`idleCount(10) === stageIdleTotal(10)` ⇒ 界面读数与后端一致。

---

## 2. A13：待机轮换真的在换、且没有 T-pose 窗口

```
.\node_modules\electron\dist\electron.exe apps\desktop --dev --mode=panel --no-dialogs `
  --probe a13 --probe-out "docs\evidence\phase3\A13-idle-rotation.json" --probe-exit
```

```json
{"windowSec": 27, "samples": 55,
 "switches": [{"atMs": 1500,  "from": "idle_pet_idle",    "to": "idle_pet_idle_10"},
              {"atMs": 13000, "from": "idle_pet_idle_10", "to": "idle_pet_idle_2"},
              {"atMs": 24000, "from": "idle_pet_idle_2",  "to": "idle_pet_idle_3"}],
 "switchCount": 3, "switchGapsMs": [11500, 11000],
 "idleTotal": 10,
 "emptyClipSamples": 0,
 "distinctClipsObserved": 4,
 "passRotationHappened": true, "passRotationPeriod": true, "passNoTposeWindow": true, "pass": true}
```

可复核点：
- **`emptyClipSamples = 0`**：55 个采样点里 `baseClipId` **没有任何一次为空**
  ⇒ 没有 T-pose 窗口（这是"任何时刻都必须有基础动作"这条硬约束的机械判定）；
- `switchGapsMs = [11500, 11000]` ⇒ 轮换间隔 ≈ 12s；
- 3 次轮换覆盖 4 个不同 clip ⇒ 确实是**轮换**而不是"在两个之间来回跳"。

### ⚠ 这条判据的**测量精度限制**（必须说清，不能含糊过去）

本探针的采样分辨率是 **500 ms**，窗口 27 s。因此：

- 轮换间隔只能测到 **±1 个样本（±500 ms）** 的精度，判据取 `[10.5s, 13.5s]` 区间，
  **不能**宣称"实测 = 12.000s"；
- 首次切换出现在 `atMs = 1500`，间隔只有 1.5s —— 这是**启动初始化**（首个待机动作以
  零淡化装载，随后进入正常轮换计时），不是一次异常轮换，故 `gaps` 从第二次切换起算。

**毫秒级精度由单测保证**（时钟可控，能测到 1 ms）：
`packages/avatar-stage/test/motion-runtime.test.mjs` 的
`待机轮换：不到 12s 不切换，到 12s 切换` 断言了 11999ms 不切、12000ms 切，
`待机轮换：交叉淡化时长必须是 3s（照抄 Mate），且轮换是循环的` 断言了 12 次轮换
覆盖全部 12 个待机 clip 且第 13 次回到起点。**两者互补**：单测管精度，探针管真实运行时。

---

## 3. 本轮顺带修好的一个**工具链缺陷**

在验证过程中发现 `npm run typecheck` **从来没有工作过**：

```
$ npm run typecheck        # 修前：脚本是 "tsc -b --pretty false"
error TS5083: Cannot read file '.../新工程/tsconfig.json'.
```

根因：仓库**没有根 `tsconfig.json`**，而 `tsc -b` 需要它来读 project references
（这是上一任留下的问题，不是本轮引入）。三个约束让"直接补一份 composite 引用"
走不通：① 各包 `composite` 都是 false；② `apps/renderer` 是 `noEmit: true`，
而 composite 工程必须能 emit；③ 各包 module/moduleResolution 并不一致。

**修法**：新增 `tsconfig.typecheck.json`（单工程、`noEmit`、覆盖 `packages/*/src` +
`apps/desktop/src` + `apps/renderer/src` 的 `.ts`），并把脚本改为
`tsc -p tsconfig.typecheck.json --pretty false`。另加 `apps/renderer/src/vue-shims.d.ts`
声明 `*.vue`，否则 `main.ts` 的 `Cannot find module './App.vue'` 会永远是一个假错误、
把真正的类型问题淹没（这正是它此前没被用起来的原因之一）。

**它立刻抓到了上面那个 `idleCount` 缺陷。** 现在全仓 0 错误：

```
$ npm run typecheck
> tsc -p tsconfig.typecheck.json --pretty false
（无输出 = 0 错误）
```

---

## 4. NOT VERIFIED

| 项 | 状态 | 说明 |
|---|---|---|
| A12 的**阈值口径** | 需你确认 | 我取"5 秒内 ≥2 条腿骨 > 5°"。待机动作本身幅度小（`leftLowerLeg` 实测 0°，因为该动作不动小腿），这个阈值是我定的，不是原文规定。若你要求更严（例如必须 4 条腿骨全部 > 0°），需要改判据。 |
| A13 的**首帧语义** | `NOT VERIFIED` | 实测首帧就是 `idle_pet_idle`（非空），但"首帧是否可能与模型加载完成存在竞态"未做压力测试（例如反复冷启动 20 次统计）。 |
| 12s 轮换的**长时稳定性** | `NOT VERIFIED` | 只测了 27s（2 个周期）。漂移/累积误差需要小时级观测（与 A15 浸泡测试合并做更合适）。 |
| A12/A13 在 **pet 模式**下的表现 | `NOT VERIFIED` | 两条探针都跑在 `--mode=panel`。pet 模式的窗口尺寸/画布尺寸不同，未复测。 |
