# 桌宠交互与取景不稳定性 —— 根因说明与预期行为

**范围**：本轮**只**修桌宠交互与取景稳定性。不重做后端、安全、聊天、动作资产。

**复现材料**：`docs/evidence/phase3/recording-frames/`（从录像
`20260927-0848-31.5316609.mp4` 抽出的 12 帧，596×922，17.2s / 30fps / 517 帧）

---

## 0. 录像里看到的事实

抽帧后得到两条**硬读数**：

| 帧 | 状态栏 | 舞台区 |
|---|---|---|
| f01 | `舞台正常 / 动作 10 待机 / 当前 misc_pet_d…`（**拖拽动作**） | **完全空白** |
| f06 | `舞台正常 / 动作 10 待机 / 当前 idle_pet_idle_10 / 64 fps / 131 MB` | **完全空白** |

⇒ 与代码诊断一致：`inFrustum=false`、`screenRect.x≈-940`、`modelBox.x∈[-5.23,-4.02]`。
**角色已完全跑出视锥**，而状态栏一切"正常"（这是最危险的一类故障）。

---

## 1. 缺陷一：单击即拖拽（无阈值、无命中判定）

**位置**：`apps/renderer/src/components/AvatarStage.vue` `onPointerDown()`（L624-651）

```ts
if (ev.button !== 0) return
ev.preventDefault()
try { (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId) } catch {}
const cursor = { x: Math.round(ev.screenX), y: Math.round(ev.screenY) }
await bridge.dragBegin(cursor)      // ← 按下即开始拖窗口
dragging = true
```

三条问题叠在一起：

1. **没有移动阈值** —— `pointerdown` 立刻 `dragBegin`，短按/单击/误触都进入窗口拖动；
2. **没有命中判定** —— 绑定在画布上（L731 `@pointerdown`），**点空白区域也拖窗口**；
3. **`pointerup` 立即 `endDrag()`**（L732 `@pointerup="endDrag"`）—— 单击就是"开始拖 + 立刻结束"。

**预期行为**：左键必须区分**短按**与**拖动**；只有"按住并移动超过阈值"才算拖动。

---

## 2. 缺陷二：拖动中窗口尺寸**累积增长**（482×762 → 528×810）

**位置**：`apps/desktop/src/main/window-manager.ts` `dragTo()`（L419-453）

```ts
const before = w.getBounds()                       // ← 上一步可能已被改坏
const targetSize = dragSession.lastBounds           // ← 上一帧 getBounds() 的读回值
w.setBounds({ x: nextX, y: nextY, width: targetSize.width, height: targetSize.height })
let after = w.getBounds()
if (after.width !== before.width || after.height !== before.height) {
  w.setBounds({ x: after.x, y: after.y, width: before.width, height: before.height })  // ← 恢复到 before
  after = w.getBounds()
}
dragSession.lastBounds = { ..., width: after.width, height: after.height }  // ← 把读回值当成下一帧目标
```

**两个正反馈环**：

| 环节 | 问题 |
|---|---|
| `targetSize = dragSession.lastBounds` | `lastBounds` 是**上一次 `getBounds()` 的读回值**。一旦系统把尺寸改坏一次，坏值就被**当成新目标**，下一帧照着它设 ⇒ 误差累积 |
| 纠正恢复到 `before` | `before` 也是读回值，同样可能已被改坏 ⇒ **不是恢复到不变量** |

`beginDrag()`（L375-396）虽然把 `min/max` 一起钉死（`dragFixedSize`），
但只锁了"窗口管理器能重算的空间"，**没有把目标尺寸变成不可变值** —— 所以
`lastBounds` 这条反馈环仍然生效。

**预期行为**：拖动全程以**拖动开始时记录的一个不可变尺寸**为目标，
任何偏差都从该目标恢复，不得从 `before` 恢复。

---

## 3. 缺陷三：角色位置与相机都在**追当前动画帧**

### 3.1 居中使用动态蒙皮中心

**位置**：`packages/avatar-stage/src/stage.ts` `autoCenterOnSkinnedContent()`（L1578-1602）

```ts
const b = this.skinnedBounds()          // ← 当前动画帧的蒙皮包围盒
vrm.scene.position.x -= b.center.x      // ← 按**动态量**平移根节点
vrm.scene.position.z -= b.center.z
```

待机动作切换、根位移变化 ⇒ `b.center` 变化 ⇒ **根节点位置变化** ⇒ 角色在画布中移动。

### 3.2 相机也追当前动画帧的包围盒

**位置**：`stage.ts` `reframe()`（L301-433）与调用点 L294 / L672 / L729 / L733

```ts
const probe = this.skinVertexProbe()    // ← 当前动画帧的蒙皮顶点
cx2 = sx / n; cz2 = sz / n              // ← 相机横向位置由动态量决定
this.camera.position.set(cx2, eyeY, cz2 + dist)
this.camera.lookAt(cx2, ..., cz2)
```

`reframe()` 的调用点有四条，其中两条是"每帧条件触发"：

| 调用点 | 触发条件 | 问题 |
|---|---|---|
| L294 | 模型加载完 | 尚可（但此时动画未生效，测的是参考姿势） |
| **L672** | **`onResize()` 里** | **拖动改变窗口尺寸 ⇒ 持续重取景**；`ResizeObserver` 也会触发 |
| L553 | `loadMotions()` 后 | |
| L729-733 | 首个活动动画生效后 | 又居中原点、又重取景 |

**两个动态量互相影响**（居中使用蒙皮中心、取景也使用蒙皮中心），
且在 resize / 动作切换时反复重算 ⇒ 角色位置与取景**都不收敛**。

### 3.3 根位移被 `loaderScale` 放大（症状的放大器）

诊断读数 `animationRestHipsY = 0.0955`，而模型的 rest hips 高得多
⇒ three-vrm 取 `loaderScale = modelRestHipsY / animationRestHipsY ≈ 4.85`，
把 VRMA 的 `RootT` 常量偏移放大：`0.966 × 4.85 ≈ 4.68 m`（与实测 x≈4.6 吻合）。

**预期行为**：
- 角色常驻**舞台锚点**（`STAGE_ANCHOR_X = 画布宽 × 0.50`、`STAGE_BASELINE_Y = 画布高 × 0.92`），
  位置由**固定 rest 骨架**决定，**不得**由当前动画帧的蒙皮中心决定；
- 相机在**模型加载完成后、在固定 rest pose 上**只计算一次；
  clip 切换 / 动作切换 / resize **不得**重取景；
- 待机动作只改关节姿态，不改角色中心点与底部基线；
- 根位移策略在**动作转换时**定死（待机/坐姿/睡眠 `rootMotionMode=none`，x/z 常量偏移归零）。

---

## 4. 预期行为汇总（本轮验收口径）

> **实测结果见 `INTERACTION-FIX-EVIDENCE.md`**（含每条判据的原始 JSON 路径与关键字段）。
> "实测"列的数值全部取自 `docs/evidence/phase3/round-interaction/*.json`。

| 项 | 预期 | 判失败条件 | 实测 |
|---|---|---|---|
| 单击 | 不移动窗口、不缩放、不重取景、不改模型缩放 | 任一发生 | ✅ 连点 20 次：位移 `(0,0)`、尺寸漂移 `(0,0)` |
| 拖动 | 仅"按住 + 移动 > 4 CSS px"触发 | 短按进入拖动 | ✅ 2px 不拖；越阈值且命中角色才拖 |
| 窗口尺寸 | 50 次拖动后与首帧**一字不差** | 累计偏差 > 0 px | ✅ `maxWidthDrift=0 / maxHeightDrift=0`，唯一尺寸 `482×761`（连跑 3 次一致） |
| 角色锚点 | 连续 60s 待机，中心 x 偏差 ≤ 4px、基线偏差 ≤ 3px | 超出 | ✅ **根位移口径**：`hips` 屏幕坐标漂移 **0.000 px**、锚点几何误差 **0.000 px**（内容包围盒会随姿态变 87px —— 那是动作本身，两个口径在证据里分开记） |
| 相机 | 切换 10 个待机动作，`position/lookAt/fov` **完全不变** | 任一变化 | ✅ 10 个 clip、**1** 个相机签名 |
| 可见性 | 包围盒 ≥80% 在画布内、非背景像素比例 > 阈值 | 跑出画布 | ✅ panel 92.3% / pet 100% 在画布内；非背景像素 19.7% / 14.1%；`inFrustum=true` |
| 轮盘 | 三次开合锚点误差 ≤ 2px；右键/F1 行为不变 | 超出 | ✅ 误差 **0 px**（三次锚点逐位相同） |
| 根位移 | 全部待机动作 x/z 漂移 ≈ 0 | 漂移 | ✅ 10 个待机 clip 全部 `mode=none`、横纵行程 **0**；walk 被合理性闸门拦下（证据 §4.4） |

**未达标 / 未验证**（原文见证据 §7）：`locomotion` 无可用资产（`NOT VERIFIED`）、
真实鼠标物理手感（`NOT VERIFIED`）、`sleep` 动作按用户方案 C **临时屏蔽**（不呈现"站姿抱臂"这一错姿态）。

> ✅ 原先未达标的一条「拖动**过程中**每帧尺寸一字不差（0 DIP）」**已达标**：
> 用户 2026-09-27 选择方案 B（panel 尺寸对齐 4 DIP 栅格）后，实测
> `strictDuringDragIdentical = true`、`duringDragSizeDelta = (0,0)`、`endSizeConvergence.tries = 0`。
> 根因与修法见 `INTERACTION-FIX-EVIDENCE.md` §2.4。

---

## 5. 本轮**不改**的东西

后端 IPC 契约、安全模块（`packages/security`）、聊天/记忆/TTS、动作资产本身
（`.anim` / `.vrma` 的二进制内容不动；只在**转换与运行时**层面处理根位移）。

---

## 6. 本轮**新发现**的缺陷（根因之外，由探针抓出）

见 `INTERACTION-FIX-EVIDENCE.md` §4：

1. 命中判定没参与拖动门槛（在空白处按下再移动照样拖窗口）；
2. 画布被 three.js 的内联尺寸钉死 ⇒ panel→pet 切换后角色缩在 90×289 的角落；
3. `screenRect()` / `inFrustum` 测的是**常量**（自欺型证据，第一次跑就给出假的 `drift = 0.00`）；
4. 根位移被**逐 clip** 放大到米级（idle_2 纵向 35 m、idle_5 横向 13.6 m、sleep 纵深 10.3 m）。

