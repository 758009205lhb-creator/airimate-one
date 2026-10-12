# 桌宠交互与取景稳定性修复 —— 验收证据（本轮）

**范围**：只做「桌宠交互 + 取景稳定性」一轮修复。**未改**后端、安全、聊天/记忆/TTS、动作资产字节。

**复现材料**：`docs/evidence/phase3/recording-frames/f01…f12.png`（录像 `20260927-0848-31.5316609.mp4` 抽帧）
—— 两条硬读数：f01 状态栏 `当前 misc_pet_d…` + **舞台全空白**；f06 `idle_pet_idle_10 / 64 fps / 131 MB` + **舞台全空白**。

**根因说明**：`docs/evidence/phase3/INTERACTION-ROOT-CAUSE.md`（缺陷一/二/三 + 预期行为表）。

**原始读数**：本文件所有数字都来自 `docs/evidence/phase3/round-interaction/*.json`（由 `tools/qa/run-probe.ps1` 落盘，**未经手工编辑**）。

---

## 0. 一句话结论

| # | 用户报的缺陷 | 现状 | 关键证据 |
|---|---|---|---|
| 一 | 单击即拖拽（点一下就乱跑） | **已修** | A11：单击 1 次 / 连点 20 次，窗口位移 `(0,0)`、尺寸漂移 `(0,0)`、不进入拖拽、不开轮盘、不改缩放 |
| 二 | 拖动中窗口尺寸累积增长（482×762 → 528×810） | **已修** | `dragRepeated50`：50 次拖动，`maxWidthDrift=0 / maxHeightDrift=0`、唯一尺寸 `482×761` |
| 三 | 角色跑出画布（舞台全空白） | **已修** | `avatarVisible`：`inFrustum=true`、非背景像素 19.7%（panel）/ 14.1%（pet）、≥92% 在画布内；截图 `panel-mode-visible.png` / `pet-mode-visible.png` |

**另外发现并修掉 4 个此前未知的缺陷**（第 4 节），其中 2 个是**只有探针才能抓到**的类型。

---

## 1. 交互（缺陷一）

### 1.1 修法

`apps/renderer/src/components/AvatarStage.vue`：把「按下即拖拽」换成显式左键手势状态机。

| 环节 | 旧行为 | 新行为 |
|---|---|---|
| `pointerdown` | 立即 `bridge.dragBegin()` | **只记录**（起点屏幕坐标 + 是否命中角色），**不碰窗口** |
| `pointermove` | 无阈值概念 | 位移 > `DRAG_THRESHOLD_PX = 4` CSS px **且按下点命中角色** 才 `dragBegin` |
| `pointerup` | 无条件 `endDrag()` | 短按 = 什么都不做；拖拽过 = 结束拖拽 + 抑制随后的 `click` |

阈值换算：`4 × max(1, devicePixelRatio)` —— `screenX/screenY` 与 CSS px 同尺度，按 DPR 归一后阈值在任何缩放下都≈4 CSS px。

### 1.2 验收读数（`round-interaction/a11.json`，`allPass = true`）

| 断言 | 实测 |
|---|---|
| `passClickDoesNotDrag` | true（`dragging=false`） |
| `passClickDoesNotMoveWindow` | true（窗口 `482×761 @1288,352` **未变**） |
| `passClickDoesNotOpenWheel` | true |
| `passClickDoesNotRescale` | true（`cameraUnchanged=true`，`scaleBefore=scaleAfter=1`） |
| `passBarelyDoesNotDrag` | true（按下后移动 **2px** < 4px 阈值 ⇒ 不拖拽） |
| `passBlankDoesNotDrag` | true（画布左上角 6px 处按下并移动 20px ⇒ 不拖拽） |
| `passLeftStartsDrag` | true（越阈值 ⇒ `dragging=true`） |
| `passDragMovesWindow` | true（窗口实际位移 `+64,+32`） |
| `passSizeRestoredOnEnd` | true（结束尺寸 = 拖动前尺寸，逐位相等） |
| `passPositionKeptOnEnd` | true（松手后窗口留在新位置，不回弹） |
| 轮盘：右键开/关、F1 开、Esc 关 | 4 项全部 true（**行为未改变**） |

补充：`clickOnly` / `clickRepeated20` 两个独立探针在**另一进程**里重复同一结论（连点 20 次：位移 `(0,0)`、尺寸漂移 `(0,0)`）。

### 1.3 技术说明（如实记录）

指针事件由**页面内合成派发**（`PointerEvent`），不是 OS 级鼠标注入。
选择它的理由：它走完整真实链路 —— Vue 处理器 → `isOnAvatar()` 命中判定 → 阈值判定 → `bridge.dragBegin` IPC → 主进程 `beginDrag/setBounds`；而 OS 级注入给不出可复现坐标（A14 曾因"两个驱动源"产生假漂移）。

- **能**验证：单击不拖窗口、拖动越阈值才拖、窗口尺寸不变、相机不变；
- **不能**验证：真实鼠标的物理手感（触控板惯性、系统双击间隔）→ 见第 6 节 `NOT VERIFIED`。

---

## 2. 拖动期间窗口尺寸（缺陷二）

### 2.1 地面真值测量（`sizeDiag.json`）

先做一次"窗口尺寸到底可不可控"的对照实验（本机 `scaleFactor = 1.25`，`482×761 DIP = 602.5×951.25 物理像素`，**本身就不是整数**）：

| 操作 | 连续 8 次移动的尺寸读数 | 结论 |
|---|---|---|
| `setPosition(x,y)`（只动位置） | `485×762 → 487×763 → 488×765 → 490×765 …` | **逐步累积增长**（旧缺陷的成因） |
| `setBounds({x,y})`（只给位置） | `492×767 → 494×769 → … → 506×777` | 累积更快（+2/步） |
| `setBounds({x,y,w,h})`（**显式带冻结尺寸**） | `484×761`（8 次**完全相同**） | **不累积** ← 唯一可用写法 |
| 请求 470 / 482 / 484 分别读回 | `472 / 484 / 486` | 恒有 **+2** 的固定偏移，且**不可回收**（再请求 470 仍得 472） |

⇒ 结论：**尺寸漂移不是本项目的逻辑错误，而是"用哪种 API + 非整数 DPI"的问题**。
拖动必须用第三种写法（本轮的 `dragTo()` 正是如此），而那个固定偏移由下面的补偿处理。

### 2.2 修法（`apps/desktop/src/main/window-manager.ts`）

1. **不可变目标尺寸**：`beginDrag()` 记录一次 `targetSize`，全程不再读回值当目标（旧代码把上一帧 `getBounds()` 当下一帧目标 ⇒ 正反馈累积）。
2. **尺寸映射标定**（`calibrateDragSize()`）：请求 `target` → 读回 `actual` ⇒ `delta = target − actual`，之后请求 `target + delta`。**自验证**：补偿后仍读不回目标就把 `ok:false` 写进证据并退回直接请求，不假装成功。
3. **DIP 栅格对齐**（`dipGridStep()`）：`scaleFactor = 5/4` ⇒ 位置量化到 4 DIP 的整数倍（= 5 物理像素），消除"移动时宽度 ±1"的半像素项。
4. **拖动结束有限穷举 + 验证**（`endDrag().endSizeConvergence`）：解除 min/max 后在 `±4 DIP` 邻域里**逐个试并读回验证**，命中即止（最多 30 次）。
   —— 为什么不是"迭代逼近"：`dragRepeated50` 第一次跑到第 31 轮时结束在 `482×763`（目标 762）且**没有自我恢复**，因为该位置的映射不可逆（`sizeDiag` 已证：请求 480 与 482 都读回 484）。穷举把"猜"变成"找"，实测 `searchTried` 里第 11 个组合 `-2,0 => 482×761` 命中。
5. **拖动期间冻结设置写入**（`bootstrap.ts`：`rememberBounds()` / `scheduleRemember()` 在 `isDragging()` 时直接返回）。

### 2.3 验收读数

`dragRepeated50.json`（用户判据：「50 次拖动后与首帧一字不差 / 累计偏差 > 0 px 判失败」）：

```
rounds = 50
maxWidthDrift = 0     maxHeightDrift = 0
uniqueWidths = [482]  uniqueHeights = [761]
windowBefore = {x:1280, y:352, width:482, height:761}
windowAfter  = {x:1280, y:352, width:482, height:761}
pass = true
```

**连跑 3 次结果一致**（`maxWidthDrift=0 / maxHeightDrift=0`，`482×761 → 482×761`）。
每轮的 `pre → post` 也逐条落盘（`sizeSeries`）。

> 记一笔踩坑：第一版结束收敛用"迭代逼近"，50 轮里第 31 轮停在 `482×763` 且**不恢复**（映射不可逆）。
> 改成"±4 DIP 邻域穷举 + 逐次读回验证"后消失 —— 见 §2.2 第 4 条。

A11 的拖动用例（`a11.json`）：

```
windowStart  = 482×761 @1288,352
windowDuring = 482×762 @1352,384     ← 高度差 1 DIP（见下）
windowAfterEnd = 482×761 @1352,384   ← 逐位回到拖动前尺寸
sizeCalibration  = { firstActual: 484×761, requestedDelta: {-2, 0}, calibratedActual: 482×761, ok: true }
endSizeConvergence = { tries: 6, converged: true, requestedDelta: {-2,0} }
```

### 2.4 「拖动过程中每帧尺寸一字不差」—— **已达标（严格 0 DIP）**

> 这一项曾经是 `NOT MET`（1 DIP 量化残差）。用户 2026-09-27 定下方案 B 之后，
> 加了一处**代码修正**并重测，现在**严格口径**也成立。过程如实记录如下。

**根因（可复现的因果链）**：

1. `%APPDATA%\AiriMateOne\settings.json` 里 `panelBounds` 曾是 `482×761`，而 `WINDOW_GEOMETRY.panel = 480×760`；
2. 原因：窗口**请求** 480×760，`getBounds()` **读回** 480+2 / 760+1 = 482×761（`sizeDiag.json` 实测恒定 +2/+1），
   而 `rememberBounds()` 把**读回值**写进了设置 —— 与缺陷二是同一个坏模式（把读回值当配置）；
3. 本机 `scaleFactor = 1.25 = 5/4` ⇒ **DIP 尺寸必须是 4 的整数倍**，对应物理像素才是整数（4×1.25 = 5）。
   `482 = 4×120.5`、`761 = 4×190.25` 都不在栅格上 ⇒ 边移动边设尺寸时窗口管理器按整数物理像素取整，
   DIP 读数在 761/762 之间跳。**pet 的 340×420 恰好都在栅格上**（425/525 物理），所以 pet 模式没有这个问题。

**修法（三处，都在同一条链上）**：

| 位置 | 改动 |
|---|---|
| `window-manager.ts` `snapSizeToDipGrid()` | 新增：尺寸**向下**对齐 DIP 栅格（向下而非就近：`482/4 = 120.5` 正好居中，就近会得到**更大**的 484） |
| `window-manager.ts` `beginDrag()` | 拖动请求 `requestSize` 也走栅格对齐（只对齐"位置"不够 —— 高度 `761` 仍是半个物理像素）；并以**对齐后的请求**重测一次，用它的结果重写 `calibration.ok`（否则证据里会出现"标定失败"与"全程逐位不变"并排的矛盾读数） |
| `bootstrap.ts` 启动迁移 + `rememberBounds()` | 记忆的 `panelBounds` 一次性自愈（`482×761 → 480×760` 并落盘）；此后只存**对齐栅格后的尺寸**，不再存读回值 |

**实测（`round-interaction/a11.json`）**：

```
windowStart    = 482×761 @1186,228
windowDuring   = 482×761 @1248,260     ← 逐位相同
windowAfterEnd = 482×761 @1248,260     ← 逐位相同
duringDragSizeDelta = {dw: 0, dh: 0, max: 0}
strictDuringDragIdentical = true       ← 严格口径达标
sizeCalibration = { target: 482×761, requestSnapped: 480×760, snappedActual: 482×761, ok: true }
endSizeConvergence = { tries: 0, converged: true }    ← 全程没有发生偏差，无需纠正
```

**A14 的同一口径顺带达标**（`phase3/a14.json`）：8 步读数**全部** `482×761`，
`sizeReadingsDistinct = ["482x761"]`、`sizeDriftMaxDip = 0`、`strictSizeUnchanged = true`。

**稳定性**：连跑 3 次 `a11` + 3 次 `dragRepeated50` 结果一致（`strictDuring=true`、`maxWidthDrift=0 / maxHeightDrift=0`）。

---

## 3. 取景与锚点（缺陷三）

### 3.1 修法（`packages/avatar-stage/src/stage.ts`）

| 项 | 旧做法（漂移根源） | 新做法 |
|---|---|---|
| 角色位置 | `autoCenterOnSkinnedContent()` 按**当前动画帧**的蒙皮中心平移 `vrm.scene.position` | **已删除**；改为建立锚点时按**固定 rest 姿势**测一次并固化（`anchorAndFrameOnce()`） |
| 相机 | `reframe()` 按**当前动画帧**的蒙皮顶点算 `position/lookAt`，且挂在 `onResize()` 上 | 只在 rest 姿势上算一次；resize **只**在宽高比变化 ≥ `ASPECT_CHANGE_THRESHOLD = 0.01` 时重算投影，投影中心不动 |
| 锚点 | 无 | `setStageAnchor(0.50, 0.92)`：内容**基线**投影到画布 50% / 92% |
| 缩放 | 无（点击/拖动会意外改变大小） | `setAvatarScale(0.70–1.40)`，**只**由设置面板触发；围绕锚点缩放，中心与基线不动 |
| 命中判定 | 用动态蒙皮包围盒 | `avatarHitEllipse()`（由固定锚点 + rest 身高 + 显式缩放推出） |
| 轮盘锚点 | 用动态蒙皮包围盒 | `avatarAnchorBox()`（同上，与在播哪个 clip 无关） |

顺带修正了一个**符号错误**：旧的哨点投影公式会把 `anchorY = 0.92` 算成"内容中心落在画面顶部 8% 处"（方向反了），且"横向平移相机"对水平视线**完全无效**（正对 target 上方的点永远投影在水平中心）。推导与修正写在 `freezeCameraOnRestPose()` 的注释里。

### 3.2 验收读数

`idleAnchor60s.json` —— 连续 **60.3 s**、**214** 个采样点（250 ms 一次）：

| 读数 | 实测 | 判据 |
|---|---|---|
| 相机变体数 | **1**（`position/lookAt/fov` 全程逐位相同） | 必须 = 1 ✓ |
| `hips` 骨骼投影屏幕坐标漂移 | **x 0.000 / y 0.000 px** | 根位移被钉死 ✓ |
| 锚点几何误差（投影回来 vs 目标） | **x 0.000 / y 0.000 px**，变体数 **1** | ≤1px ✓ |
| 锚点比例 | `{x: 0.5, y: 0.92}` | 与规格一致 ✓ |
| 始终在视锥内 | true | ✓ |
| 期间轮换的 clip 数 | 6 | ✓ |
| 最低 fps | 61.7 | ✓ |

`clipSwitchCamera.json`（判据：「切换 10 个待机动作，`position/lookAt/fov` 完全不变」）：

```
distinctClipCount = 10   （idle_pet_idle, _2 … _10）
distinctCameraSignatures = 1
passAllSwitches = true   （每次切换前后相机签名逐位相同）
```

`wheelStable.json`（判据：「三次开合锚点误差 ≤ 2px」）：

```
anchors = [{135, 336.672}, {135, 336.672}, {135, 336.672}]   （开→关→开 ×3）
anchorErrorPx = 0
```

---

## 4. 本轮**新发现**的 4 个缺陷（都是探针抓出来的）

### 4.1 命中判定没有参与拖动门槛（缺陷一的残留）

`onPointerDown` 里算了 `isOnAvatar`，但只用来决定"要不要 `setPointerCapture`"；`onPointerMove` **没有**用它 ⇒ **在画布空白处按下再移动，照样拖窗口**。
抓它的探针：A11 的 `blankDrag` 用例（`passBlankDoesNotDrag=false`，`after.dragging=true`）。
修法：把 `onAvatar` 存进手势状态，`onPointerMove` 里作为硬门槛。

### 4.2 画布被 three.js 的内联尺寸**钉死**，panel→pet 切换后角色缩在角落

`onResize()` 用 `canvas.getBoundingClientRect()` 量尺寸并 `renderer.setSize(cw, ch, true)`。
`updateStyle = true` 会把 CSS 尺寸写成**内联样式**，压过 `.stage-canvas{width:100%}` ⇒ 画布盒子不再跟随布局，而测量又只读回这个被钉死的值 ⇒ `ResizeObserver(canvas)` 永远看不到"布局变了"。

`layoutDiag-pet.json` 原始读数（**修前**）：`.stage-slot = 340×420`，`canvas = 90×289`
（90 = 340 − panel 侧栏 250；289 = 420 − 标题栏/状态栏 131 —— **panel 布局的残留值**）。

修法：量 `canvas.parentElement`、`setSize(..., false)` 不写内联样式、`ResizeObserver` 观察容器。
修后：`layoutDiag.json`（panel）`slot 230×647 = canvas 230×647`；`layoutDiag-pet.json`（pet）`slot 340×420 = canvas 340×420`。

截图对照：`pet-mode-visible.png`（修前角色只占窗口左上角 → 修后铺满窗口、脚落在 92% 基线）。

### 4.3 `screenRect()` / `inFrustum` 测的是**常量**（自欺型证据）

`screenRect()` 用 `Box3.setFromObject`，而它对 `SkinnedMesh` 用的是**几何绑定姿态**的局部坐标 ⇒ 与动画无关、恒定不变。
后果：60 s 漂移测试得到漂亮的 `drift = 0.00`，**但测的是一个常量**（第一次跑就出现了这个假通过，被我按"这个数字好得不合理"复查抓出）。
`viewDiagnostics().inFrustum` 同样基于该常量包围盒 ⇒ 角色在画外时它仍可能为 true —— 这正是录像里"舞台全空白、状态栏一切正常"能骗过检查的原因。

修法：两处都改用实测蒙皮顶点包围盒（`skinnedBounds()`），并在 `screenRect()` 的返回值里带 `source: 'skinned' | 'box3'`，证据里能直接看到用的是哪条路径。

### 4.4 根位移被逐 clip 放大到**米级**（比录像里的症状更严重）

three-vrm 按 `modelRestHipsY / animationRestHipsY` **逐 clip** 放大整条 hips 平移轨道，而本资产包的 `restHipsPosition.y` 差异极大（0.0050 ~ 1.4933）。以实测模型髋高 `0.834 m` 换算：

| clip | animRestY | 放大倍数 | 放大后行程 x / y / z（米） |
|---|---|---|---|
| `idle_pet_idle_2` | 0.00518 | **161×** | 3.97 / **35.02** / 9.18 |
| `idle_pet_idle_5` | 0.00517 | 161× | **13.59** / 25.43 / 9.96 |
| `idle_pet_idle_6` | 0.00517 | 161× | 3.29 / 22.41 / **27.67** |
| `locomotion_pet_walk_left` | 0.00498 | **167×** | 4.38 / 2.61 / 1.70 |
| `sleeping_pet_sleeping` | 0.09546 | 8.7× | 0.62 / 4.53 / **10.30** |
| `sitting_pet_sit_01` | 1.37174 | 0.6× | 0.00 / 0.00 / 0.00 |
| `idle_pet_idle`（首个） | 0.17191 | 4.9× | 0.03 / 0.14 / 0.17 |

⇒ 结论：**这套资产只要把根位移放出来，角色就会被抛到几十米外**（录像里的"空白舞台"只是其中一个 clip 的表现）。因此 `none`（钉死）不是保守选择，而是唯一正确选择。

---

## 5. 根位移策略（`rootMotionMode`）

### 5.1 设计与实现

在**装载时**改写 hips 平移轨道的**数值**（不动资产字节、不改 `.vrma`），且必须发生在 `mixer.clipAction()` **之前**：

| 策略 | 横向 x/z | 纵向 y |
|---|---|---|
| `none` | 钉在模型 rest 位置 | 钉在模型 rest 位置 |
| `inPlace` | 钉在模型 rest 位置 | 保留动画值 |
| `locomotion` | 按"相对本 clip 起始姿势"的位移播放 | 保留动画值 |

- 策略来源：manifest 的 `rootMotionMode` 字段（新增，可选）；缺省由 `manifestRootMotionMode()` 按 `set`/名字推断，**默认 `none`**（保守侧）。
- **合理性闸门**（第 4.4 节直接催生）：横向行程 > 髋高 25% 或纵向 > 髋高 40% ⇒ 钉死该轴并记录原因（阈值以角色髋高为尺度，不用魔法数）。
- **归一化不可能时拒绝装载并给可见错误**（抛错 ⇒ 进 `failed[]` ⇒ 弹告警），不允许静默带着偏移运行。

### 5.2 验收读数（`rootMotionIdle.json`，`pass = true`）

```
records = 16        idle = 10
idleMaxHorizontal = 0        idleMaxVertical = 0
全部 10 个待机 clip：mode = none、normalized = true、h = 0、v = 0
```

`locomotion_pet_walk_left` 被闸门拦下并**降级为原地**，原因原文落盘：

```
横向根位移 4.380 m 超过髋高的 25%（0.209 m）⇒ 钉死横向；
纵向根位移 2.607 m 超过髋高的 40%（0.334 m）⇒ 钉死纵向
```

### 5.3 动作转换验证（`clipPoses.json`，`pass = true`）

`rootMotionMode` 是"在动作转换时定死"的策略，所以必须**真的切过去**看。
其中 `sleep` 现在**期望被拒**（见 5.4 的方案 C）：

| 语义 | 期望 | 实测 `accepted` | 切换后命中 clip | 在视锥内 | 截图 |
|---|---|---|---|---|---|
| sit | 切过去 | true | `sitting_pet_sit_01` | true | `clipPoses-clip-sit.png` |
| **sleep** | **被挡住** | **false** | `idle_pet_idle_10`（保持在待机，**没有换成错姿态**） | true | `clipPoses-clip-sleep.png` |
| walk | 切过去 | true | `locomotion_pet_walk_left` | true | `clipPoses-clip-walk.png` |
| pose | 切过去 | true | `pose_pet_pose_1` | true | `clipPoses-clip-pose.png` |

⇒ **没有任何动作把角色推出画布**；且 `disabledHits = {motion:"sleep", at:…}` 证明 sleep 是
**被策略挡下的**，不是"调用方忘了发请求"。

### 5.4 副作用与处置（有据可查，不是猜测）

钉死根位移会让"由根位移表达的姿态"丢失。逐 clip 核对后：

- **sit 不受影响**：`sitting_pet_sit_01` 的根位移放大后行程 = `0.00 / 0.00 / 0.00 m` ⇒ 钉死它**改变 ≤2 mm**。
  截图里她仍是站姿（抬腿）—— 那是**资产自身的内容**，与本轮修复无关（已记为资产质量问题）。
- **sleep 受影响**：`sleeping_pet_sleeping` 的根位移放大后 y = 4.53 m、z = 10.30 m（荒谬值）⇒ 只能钉死，
  "躺下"这一分量丢失，会呈现**站姿抱臂**这个明显错误的姿态。
  **用户 2026-09-27 决定（方案 C）：先把它摘掉，不呈现错姿态**。落地方式：

  | 位置 | 改动 |
  |---|---|
  | `packages/shared/src/settings.ts` | `WHEEL_SPEC.items` 里移除「休眠」项；新增 `DISABLED_MOTION_SEMANTICS = ['sleep']` |
  | `packages/avatar-stage/src/stage.ts` | `requestMotion()` **单点屏蔽**（轮盘、聊天 Act 标记、验收探针三条入口同时生效），并记入 `disabledMotionHits` |
  | `apps/desktop/src/main/session-store.ts` | 人设提示词里去掉 `[motion:sleep]`（不再让模型请求一个必然被拒的动作） |
  | `apps/renderer/src/components/AvatarStage.vue` | 轮盘处理函数里的 `sleep` 分支随之移除 |

  **`clip` 资产仍在**（未删文件、未改字节）：只要从 `DISABLED_MOTION_SEMANTICS` 里删掉 `'sleep'`
  并把轮盘项、提示词放回，即可恢复 —— 恢复步骤写在 `DISABLED_MOTION_SEMANTICS` 的注释里（5 步）。
  恢复的前提是**资产侧重新导出该 `.anim`（归一化 `RootT`）**。

---

## 6. 回归验证（改动波及面的复测）

| 判据 | 结果 | 证据 |
|---|---|---|
| petmode：panel ⇄ pet **同窗**切换（硬约束：一个实例、一个可见窗口） | **pass** | `phase3/petmode.json`：`windowId = 1,1,1`、`webContentsId = 1,1,1`、`visibleWindows = 1,1,1`、`uiMode` 跟随、`rendererFollowedMode = true` |
| A10：轮盘锚点精度 + 命中区域与视觉一致 | **pass** | `phase3/a10.json`：`passA10=true`、`passHitRegionMatchesVisual=true`（轮盘由 8 项变 7 项后仍通过） |
| A12：5 s 内腿部有运动（新口径） | **pass** | `phase3/a12.json`：`maxLegTravelDeg=174.02`、`legTravelTotalDeg=415.79`、`passA12SingleBone=true`、`passA12TotalTravel=true`（阈值 5° / 20°） |
| A13：待机轮换（12 s 周期、无 T-pose 窗口） | **pass** | `phase3/a13.json`：`passRotationHappened`、`passRotationPeriod`、`emptyClipSamples=0`、`distinctClipsObserved=4` |
| A14：拖拽期 PET_DRAGGING + 弹簧回正 + 尺寸恒定 | **pass（严格口径）** | `phase3/a14.json`：`passWindowMoves/passDragTilts/passDragClipActive/passSpringReturns = true`；8 步读数全部 `482×761`、`sizeDriftMaxDip=0`、`strictSizeUnchanged=true` |
| 单测 | **全绿** | `apps/desktop/test/run-all.cjs` = 98；`packages/avatar-stage/test/motion-runtime.test.mjs` = 35；`packages/motion-director/test/*.test.mjs` = 44 |
| 类型检查 | **0 错误** | `npm run typecheck` |
| 静态断言 8 条 | **全成立** | `node tools/qa/check-claims.mjs`（含 `no-live2d-dependency` / `no-cdp-in-production` / `no-setparent` / `no-sourcemap-in-dist` / `window-hardening-params`） |
| 仓库卫生 | **OK** | `node tools/qa/check-no-src-artifacts.mjs`（`src` 下无编译产物；无带 BOM 的 JSON） |

### 6.1 本轮顺带修掉的三个**工具/卫生**问题（都是自己造成的）

1. **`dist/` 里的历史 sourcemap**：先用 dev 构建（`tsconfig.json` 会出 `.map`）、再跑生产构建时，
   `tsc` **不会清理** `outDir` ⇒ 分发目录里带着未压缩源码的映射，`no-sourcemap-in-dist` 正确地失败。
   修法：新增 `tools/qa/clean-dist-maps.mjs` 并挂到 `build:packages:prod` 开头（生产构建前先清）。
2. **两处带 BOM 的 JSON**（`docs/evidence/phase1/desktop-state-*.json`）：PowerShell 5.1 的
   `Set-Content -Encoding UTF8` 总会写 BOM。已就地去掉前 3 字节，内容不变。
3. **审计把"通配引用"当成文件名**：`DELIVERY.md` 里写 `phase3/round-interaction/*.json`
   （描述"这一轮的原始读数"），检查器报"引用了不存在的证据"——而那个目录里有 20+ 个 JSON。
   修法：`audit-acceptance.mjs` 的引用检查对含 `*` 的路径改为"父目录存在且至少有 1 个匹配"。
   （这类"文档指向不存在的东西"正是该检查要防的，但**误报**同样会让它失去作用。）

---

## 7. `NOT VERIFIED` / `NOT MET` 清单（不掩盖）

| 项 | 状态 | 原因 / 最小解决路径 |
|---|---|---|
| `locomotion` 策略的实际效果 | **NOT VERIFIED**（无可用资产） | 唯一 walk clip 被合理性闸门拦下（横向 4.380 m）⇒ 本资产包**没有任何 clip 走 `locomotion` 分支**。代码路径有闸门读数作证据，但没有"真的走起来"的运行时证据 |
| 真实鼠标/触控板的物理手感 | **NOT VERIFIED** | 探针用页面内合成 `PointerEvent`；未做 OS 级注入（会给不出可复现坐标）。触控板惯性、系统双击间隔、拖拽中的光标捕获行为未测 |
| 轮盘"三次开合"的**人手**操作 | **部分** | 误差 ≤2px 是用轮盘自身几何（与 `show()` 同源）测的确定性读数；没有用真实鼠标点三次来测 |
| `.anim` / `.vrma` 资产本身的姿态正确性 | **NOT VERIFIED** | 本轮只看"角色在不在画布内"。sit 呈站姿（5.4 节）已查明与本次修复无关，但"该资产本应是什么姿态"需要资产侧对照 |
| `sleep` 动作 | **临时屏蔽**（方案 C，已执行） | 不是"没做"，而是**刻意不呈现错姿态**。恢复前提：资产侧重新导出该 `.anim`（归一化 `RootT`）。恢复步骤见 `DISABLED_MOTION_SEMANTICS` 注释 |
| A15/A16 长稳帧率 | **沿用上一轮结论** | 本轮改动后**未**重跑 2 小时浸泡（改动集中在取景/交互，未动渲染循环的调度）。本轮 `idleAnchor60s` 的 `fpsMin` 只能说明"短时健康" |
| 打包/安装链路 | **未复测** | 本轮未产生新的 dist 载荷结论；`tools/qa/stage-dist.mjs` 未重跑 |

> **已关闭（原 NOT MET）**：「拖动过程中每帧尺寸一字不差（0 DIP）」—— 见 2.4 节，现已达标。

---

## 8. 用户决策项（**四项已全部关闭**，2026-09-27）

| # | 决策 | 选择 | 落地 |
|---|---|---|---|
| 1 | A14 的"零漂移"措辞 | **B**：改为「读回值恒定（不累积），且与拖拽前偏差 ≤ 1 DIP」 | `audit-acceptance.mjs` 的 A14 条目改判据文案与字段；A14 探针新增 `sizeReadings*` 三项并把判定收敛到一处。**并且因为第 3 项做了栅格对齐，实测已是严格 0 DIP** |
| 2 | A12 的判定阈值 | **C**：组合条件「任一根腿骨 > 5° **且** 4 骨总行程 > 20°」 | `bootstrap.ts` 的 a12 探针；新增 `legTravelTotalDeg` / `a12Thresholds` / `passA12SingleBone` / `passA12TotalTravel` |
| 3 | panel 尺寸是否对齐 4 DIP 栅格 | **B**：做 | 见 2.4 节（`snapSizeToDipGrid` + 拖动请求对齐 + 启动迁移 + `rememberBounds` 不再存读回值）。**结果：严格口径达标** |
| 4 | `sleep` 动作姿态 | **C**：临时摘掉 | 见 5.4 节（轮盘项移除 + `DISABLED_MOTION_SEMANTICS` 单点屏蔽 + 人设提示词移除） |

**顺带处理的一条观察**：`settings.json` 里 `fpsCap` 曾是 **60**，而代码默认（`AppSettingsSchema`）与
A16 的实测结论都指向 **90**（注释原文：cap 60 实测稳定 49.4，低于 ≥50 门槛）。本轮**未擅自改动**这个值 ——
它属于 A16 的范围（当前 A15/A16 仍在等 2 小时浸泡），留给用户决定。
2. **A12 的 5° 阈值**：由我拟定，需确认。
3. **（本轮新增）panel 窗口尺寸是否对齐 4 DIP 栅格**（`482×761 → 480×760`）：做了就能让"拖动期间尺寸一字不差"成立，代价是记住的窗口尺寸变化 ±4px。
4. **（本轮新增）`sleep` 动作的姿态缺失**：接受"站姿抱臂"，还是安排资产侧重新导出该 `.anim`？

---

## 9. 复现命令（全部可重跑）

```powershell
cd 'F:\deepseek harness\AI女友\新工程'
npm run typecheck                       # 0 错误
node apps/desktop/test/run-all.cjs      # 98
npm run build                           # 生产构建（默认 0 sourcemap）

# 单条探针（自动清理遗留实例/互斥体/锁，落盘 JSON 并截图后退出）
pwsh -File tools/qa/run-probe.ps1 -Name a11                 # 输入语义（新判据）
pwsh -File tools/qa/run-probe.ps1 -Name dragRepeated50      # 50 次拖动：尺寸零漂移
pwsh -File tools/qa/run-probe.ps1 -Name idleAnchor60s       # 60s 锚点/相机稳定
pwsh -File tools/qa/run-probe.ps1 -Name clipSwitchCamera    # 10 个 clip 切换相机不变
pwsh -File tools/qa/run-probe.ps1 -Name clipPoses           # 动作转换：sit/sleep/walk/pose
pwsh -File tools/qa/run-probe.ps1 -Name layoutDiag -Mode pet
pwsh -File tools/qa/run-probe.ps1 -Name avatarVisible -Mode pet
pwsh -File tools/qa/run-probe.ps1 -Name sizeDiag            # 窗口尺寸地面真值（归因用）
```

`--probe` 路径的退出码**按设计为 1**（`quit('probe')`）⇒ 只用 JSON 里的 `pass` 判定，不要看退出码。

---

## 10. 本轮改动的文件

**产品代码**
- `apps/renderer/src/components/AvatarStage.vue` —— 左键手势状态机（阈值 + 命中门槛 + 点击抑制 + blur/visibility 清理）、`setStageAnchor(0.50,0.92)`、设置驱动的显式缩放、轮盘锚点改用固定锚点、移除轮盘的 sleep 分支、新增手势/取景探针操作
- `apps/renderer/src/components/SettingsPanel.vue` —— 「角色 → 大小」滑杆（0.70–1.40，步进 0.05）
- `apps/desktop/src/main/window-manager.ts` —— 不可变 `targetSize`、尺寸映射实测标定、**DIP 栅格对齐（位置 + 请求尺寸）**、结束穷举验证、`snapSizeToDipGrid()`、`requestSize/requestDelta/sizeCalibration/endSizeConvergence` 证据字段
- `apps/desktop/src/main/bootstrap.ts` —— 拖动期间冻结设置写入、**panel 尺寸启动迁移**、`rememberBounds()` 改存栅格对齐值；**重写 A11 判据**、**A12 新阈值（5°/20°）**、**A14 尺寸子判据收敛到一处**；新增 12 个探针
- `apps/desktop/src/main/session-store.ts` —— 人设提示词去掉 `[motion:sleep]`
- `packages/avatar-stage/src/stage.ts` —— 固定锚点 + 一次性取景、删除 `autoCenterOnSkinnedContent()`、根位移策略与合理性闸门、**`requestMotion()` 单点屏蔽 `DISABLED_MOTION_SEMANTICS`**、画布量容器且不写内联样式、`screenRect`/`inFrustum` 改用蒙皮包围盒、`anchorProjection()`/`boneScreenPositions()`/`probeNextIdle()`
- `packages/shared/src/ipc.ts` / `settings.ts` —— `rootMotionMode`、`avatarScale`、`manifestRootMotionMode()`、**`DISABLED_MOTION_SEMANTICS`**、轮盘项由 8 项变 7 项

**QA 工具**
- `tools/qa/run-probe.ps1`（新增）—— 探针运行器：跑完即清理、落盘 JSON、打印 `pass`
- `tools/qa/clean-dist-maps.mjs`（新增）—— 生产构建前清历史 sourcemap（防"未压缩源码进分发"）
- `tools/qa/audit-acceptance.mjs` —— A11/A12/A14 判据文案与字段更新；引用检查支持通配路径

**文档**
- `docs/evidence/phase3/INTERACTION-ROOT-CAUSE.md`（根因，先于代码）
- `docs/evidence/phase3/INTERACTION-FIX-EVIDENCE.md`（本文件）
- `docs/evidence/phase3/A11-input.md`（A11 判据重写说明）
- `docs/evidence/phase3/round-interaction/`（本轮全部原始 JSON + 截图）
