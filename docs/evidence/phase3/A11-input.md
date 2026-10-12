# A11 · 输入语义验收 —— **判据已于本轮（交互/取景修复轮）重写**

| 字段 | 值 |
|---|---|
| 判据 | **A11（新）**：短按什么都不做；左键"按住移动 > 4 CSS px 且落在角色上"才拖窗口；阈值内与空白处都不拖；右键/F1/Esc 行为不变 |
| 命令 | `pwsh -File tools/qa/run-probe.ps1 -Name a11` |
| 结果 | **通过（`allPass = true`）** |
| 原始 JSON | `docs/evidence/phase3/round-interaction/a11.json`（本目录的 `A11-input.json` 是它的副本） |

---

## ⚠ 为什么必须重写：**旧判据本身是错的**

旧 A11 的核心断言是「左键 `pointerdown` ⇒ **必须**开始拖拽」。
而"按下即拖拽"正是用户报的**缺陷一**（点一下就乱跑，且点画布空白也拖窗口）。
⇒ **旧的 A11 越"通过"，用户越点不动**。判据与被测需求相反时，测试通过只是把缺陷固化。

同时，旧文件把 `passLeftStartsDrag = false` 解释成"测试手段限制（合成事件没有 `pointerId`）"。
该解释**已不成立**：本轮修掉了 `setPointerCapture` 抛错中断处理器的问题（包进 try/catch），
并且实测证明合成事件可以驱动完整链路 —— 从 A11 到 `dragRepeated50`，全部由合成指针事件驱动并通过。

## 新判据与实测

| 输入 | 必须 | 必须不 | 实测 |
|---|---|---|---|
| 短按（按下+抬起，不移动） | 什么都不做 | 不移动窗口 / 不开轮盘 / 不改缩放 | ✅ 窗口 `482×761 @1288,352` 未变；`dragging=false`；`wheelOpen=false`；`scaleBefore=scaleAfter` |
| 按住移动 > 4 CSS px（落在角色上） | 进入拖拽、窗口真的移动 | —— | ✅ `dragging=true`；窗口位移 `+64,+32` |
| 按住移动 2 px（< 阈值） | 什么都不做 | 不进入拖拽 | ✅ `dragging=false` |
| 画布空白处按住移动 20 px | 什么都不做 | 不进入拖拽 | ✅ `dragging=false` |
| 右键 | 开轮盘（再点关闭） | —— | ✅ `false→true→false` |
| F1 / Esc | 开 / 关 | —— | ✅ `false→true` / `true→false` |
| 拖动结束 | 尺寸回到拖动前、位置留在新处 | —— | ✅ `482×761`（逐位相等）；位置 `= 拖动中位置` |

拖拽尺寸的完整读数（含标定与结束收敛）：

```
windowStart    = 482×761 @1186,228
windowDuring   = 482×761 @1248,260          ← 逐位相同
windowAfterEnd = 482×761 @1248,260          ← 逐位相同
duringDragSizeDelta = {dw: 0, dh: 0, max: 0}
strictDuringDragIdentical = true            ← 曾经是 false，现已达标
sizeCalibration = { target: 482×761, requestSnapped: 480×760, snappedActual: 482×761, ok: true }
endSizeConvergence = { tries: 0, converged: true }   ← 全程没有偏差，无需纠正
```

**「拖动过程中每帧一字不差」已是达标项**：本机 `scaleFactor = 1.25`，`482×761 DIP = 602.5×951.25 物理像素`，
而 `482`/`761` 都不是 4 的整数倍 ⇒ 对应半个物理像素 ⇒ 读数会在 761/762 之间跳。
用户 2026-09-27 选择方案 B（尺寸对齐 4 DIP 栅格）后，请求 `480×760`（= 600×950 物理像素，整数）读回稳定的 `482×761`。
根因链与三处改动见 `INTERACTION-FIX-EVIDENCE.md` §2.4；**连跑 3 次结果一致**。

## 判据覆盖关系（谁负责哪一条）

| 约束 | 由谁验收 |
|---|---|
| 左键不打开轮盘 / 右键与 F1 开关轮盘 | **A11**（本文件） |
| 单击不拖窗口、阈值内不拖、空白处不拖 | **A11**（本轮新增） |
| 拖拽真的移动窗口 + 摇晃叠加 + 松手回正 | `A14`（`docs/evidence/phase5/A14-drag.json` = `phase3/a14.json`） |
| 50 次拖动尺寸零漂移 | `dragRepeated50`（`round-interaction/dragRepeated50.json`） |
| 单击/连点 20 次无副作用 | `clickOnly` / `clickRepeated20` |

## 仍未验证

**真实鼠标/触控板的物理手感**（触控板惯性、系统双击间隔、拖出窗口后的指针捕获行为）`NOT VERIFIED` ——
探针用页面内合成 `PointerEvent`（可复现坐标优先）。若要做，路径是 `SetCursorPos` + `mouse_event`
或 `webContents.sendInputEvent`，代价是坐标不可复现。
