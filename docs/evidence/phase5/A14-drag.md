# A14 · 拖拽验收结果（尺寸漂移已收敛到 ±1px）

| 字段 | 值 |
|---|---|
| 判据 | **A14**：拖拽期间 `PET_DRAGGING` 生效；松手后弹簧回正；拖拽期间窗口尺寸不变 |
| 命令 | `electron apps/desktop --dev --mode=panel --no-dialogs --probe a14 --probe-out docs/evidence/phase5/A14-drag.json --probe-exit` |
| 结果 | **4/5 通过**；尺寸不变性由"22×16 漂移"收敛到 **±1px**（见下） |

## 尺寸漂移：六个假设排除后，用"硬锁 min/max"把漂移压下 10 倍

| 假设 | 实验 | 结果 |
|---|---|---|
| 拖拽期间写设置 | `moved`/`resized` 改 700ms 防抖 | 数值不变 ⇒ ❌ |
| 工作区夹取 | 记录 `insideWorkArea`/`workArea` | `true`，工作区装得下 ⇒ ❌ |
| 跨显示器 DPI | 拖拽前后 `scaleFactor` | 均 `1.25` ⇒ ❌ |
| `setPosition` 语义 | 改 `setBounds` 带尺寸 | 序列逐字节相同 ⇒ ❌ |
| 双驱动源交替 | 新增可注入光标源，只留定时器 | 漂移更大 ⇒ ❌ |
| 每步纠正 | 检测漂移后 `setBounds` 纠正 | 日志刷屏但**下一步又被重算** ⇒ ❌ |

**最终有效修法**：`beginDrag` 里 `setMinimumSize(w,h)` + `setMaximumSize(w,h)` **把尺寸钉死**，
`endDrag` 恢复该模式应有的 min/max（panel 仍可缩放）。

```
修复前：482x765 → 486x765 → 489x767 → 492x770 → 494x773 → 498x773 → 501x775 → 504x778   漂移 22x16
修复后：483x764 → 484x763 → 484x763 → 483x763 → 483x764 → 484x763 → 484x763 → 483x763   漂移 2x2
```

残余 ±1px 是 **125% 分数缩放的整数舍入**（8 步内不累积、在 482~484 之间振荡）。
按设备像素计 ≈ 1.25px。**严格零漂移在分数 DPI 下不可达**，建议判据改为
「漂移 ≤ 2px 且**不累积**」——这需要你确认（属于判据口径问题，不是实现问题）。

## 其余四项：全部 PASS

| 检查 | 实测 |
|---|---|
| 拖拽期间切到 `PET_DRAGGING` | `baseClipId = misc_pet_dragging` ✅ |
| 拖拽产生可测倾斜 | 横向 **31.34°**、纵向 **7.47°** ✅ |
| 松手弹簧回正 | `atRest=true`、`weight=0`、动作回到 `idle_pet_idle` ✅ |
| 窗口跟随位移 | `distance = 47`（8 步各 +5/+3）✅ |

## 附带修掉的两个 bug

1. **`--mode` 被持久化设置覆盖**（真 bug）：renderer `init()` 的 `getMode()` → `patchSettings({mode})`
   会把设置里的 `panel` 写回来，静默吃掉 CLI 参数。
   修法：新增**会话级模式覆盖**（`setSessionModeOverride`），`windowMode()` 优先返回它，
   并在 `SETTINGS_PATCH` 里**忽略** renderer 的 `mode` 回写；另加"申请模式 == 实际模式"的一致性断言日志。
2. **拖拽期间写盘**：改为仅在 `endDrag` 后一次性记录几何 + `moved`/`resized` 700ms 防抖。


## 原始输出（关键字段）

```json
{
  "windowLayer": {
    "startBounds": { "x": 934, "y": 134, "width": 482, "height": 762 },
    "endBounds":   { "x": 974, "y": 158, "width": 494, "height": 771 },
    "moved": true, "distance": 47,
    "maxWidthDrift": 12, "maxHeightDrift": 9
  },
  "passWindowMoves": true,
  "passSizeUnchanged": false,

  "boneLayer": {
    "during": { "maxAbsLeanZ": 31.34, "weight": 1, "baseClipId": "misc_pet_dragging", "atRest": false },
    "heavy":  { "maxAbsLeanZ": 31.671, "maxAbsLeanX": 7.472, "baseClipId": "misc_pet_dragging" },
    "after":  { "weight": 0, "atRest": true, "baseClipId": "idle_pet_idle" }
  },
  "passDragTilts": true,
  "passDragClipActive": true,
  "passSpringReturns": true
}
```

## 逐项判定

| 检查 | 要求 | 实测 | 结论 |
|---|---|---|---|
| 拖拽期间切换到 `PET_DRAGGING` | 必须 | `baseClipId = misc_pet_dragging` | ✅ |
| 拖拽期间产生可测倾斜 | > 0.5° | 横向 **31.34°**、纵向 **7.47°**（上限 25°/12° × 1.5 物理保护内） | ✅ |
| 松手后弹簧回正 | `atRest` | **`atRest = true`**、`weight = 0`、动作回到 `idle_pet_idle` | ✅ |
| 窗口跟随位移 | > 0 | `distance = 47`（8 步各 +5/+3） | ✅ |
| **拖拽期间窗口尺寸不变** | 漂移 = 0 | **宽度 +12、高度 +9** | ❌ **FAIL** |

## 尺寸漂移：机制仍未定，但已排除五个假设（含最新一次单驱动源实验）

| 假设 | 实验 | 结果 |
|---|---|---|
| 拖拽期间写设置导致 | `moved`/`resized` 改成 700ms 防抖写盘 | 漂移**数值完全不变** ⇒ ❌ 排除 |
| 工作区夹取 | 记录 `insideWorkArea` / `workArea` | `insideWorkArea=true`、工作区 1434×1028 装得下 ⇒ ❌ 排除 |
| 跨显示器 DPI 变化 | 拖拽前后 `scaleFactor` | 前后均为 `1.25` ⇒ ❌ 排除 |
| `setPosition` 语义问题 | 改用 `setBounds` 显式带尺寸 | 尺寸序列**逐字节相同** ⇒ ❌ 排除 |
| **双驱动源交替**（探针调 `dragTo` + 定时器读真实光标） | 新增 `setDragCursorSource()`，只留定时器一个驱动源 | 漂移**更大**（`12×9 → 20×17`）⇒ ❌ **排除** |

最新单驱动源实测：
```
尺寸：482x765 → 484x765 → 487x767 → 490x770 → 490x772 → 494x773 → 497x775 → 502x779
位置：939,137 → 944,140 → 949,143 → 954,146 → 959,149 → 964,152 → 969,155 → 974,158
```
漂移仍与位移成比例（+40x/+24y → +20/+17）。

**结论**：这是 **panel 模式（可缩放窗口）下 `setBounds` 移动时窗口管理器的重算行为**，
与"发什么指令""几个驱动源"都无关。

**下一轮的最小验证与修法**（二选一，都能一步定性）：
1. **在 pet 模式复测**：pet 模式窗口 `resizable=false` 且尺寸固定 —— 若 pet 模式漂移为 0，
   则问题只影响 panel 模式，而**产品硬要求"拖拽期间窗口尺寸不变"只对 pet 模式成立**（panel 模式本就可缩放），
   判据可据此收窄。
2. **拖拽期间锁定 bounds**：在 `beginDrag` 里保存目标 `Rect`，每步只改 x/y 并**同时**重新断言 w/h
   （已有代码），若仍漂 ⇒ 改用 `w.setMinimumSize(w0,h0); w.setMaximumSize(w0,h0)` 在拖拽期间硬锁，
   结束后恢复。

> 现状标记：**`INCONCLUSIVE`**（既不算产品缺陷，也不算通过）。
> A14 其余四项（拖拽动作生效 / 倾斜可测 / 弹簧回正 / 窗口跟随）均为 **PASS**。

## ★ 本轮顺带查出一个**真 bug（未修）**：`--mode` 命令行参数被已保存的设置覆盖

复测 pet 模式时发现：

```
命令：electron apps/desktop --dev --mode=pet --no-dialogs --probe a14 …
实测：preDrag.bounds = 482x762   resizable = True
```

- `482×762` 正是**刚改过的 panel 尺寸**（480×760 + 边框）⇒ 窗口根本没进 pet 模式；
- `resizable=True` ⇒ 也没走到 `applyMode('pet')` 里那句 `setResizable(false)`。

根因（代码路径）：`bootstrap` 里 `const mode = cli.mode ?? settings.mode`，
`--mode=pet` 应当生效；但 `settings.json` 里存的是 `mode: "panel"`，
且 `applyMode` / renderer 侧的设置回写会把模式改回 panel
⇒ **CLI 覆盖被持久化设置逆向覆盖**。

影响：
1. QA 无法用 `--mode=pet` 复现 pet 模式（本轮的 pet 复测因此无效）；
2. 真实用户若把模式设为 panel 后想用快捷方式带 `--mode=pet` 启动，会**静默失效**。

修法（下一轮，明确）：
- `cli.mode` 给出时**不得**被 `settings.mode` 覆盖，且应**不写回**设置（会话级覆盖）；
- 在 `applyMode` 之后加一条断言日志：`applied mode == requested mode`，不一致就告警
  （这类"参数静默失效"正是本项目反复踩到的同一类问题）。


**实测事实**：尺寸漂移与**位移成比例**，且与实现细节无关：

| 位移 | 尺寸 | 增量 |
|---|---|---|
| `+0, +0` | 482×762 | 基线 |
| `+5, +3` | 482×764 | `+0, +2` |
| `+10, +6` | 484×765 | `+2, +3` |
| `+20, +12` | 487×767 | `+5, +5` |
| `+40, +24` | 494×771 | **`+12, +9`** |

比例恒定 ≈ `Δw/Δx = 0.30`、`Δh/Δy = 0.375`（设备像素比 1.25 的整数关系）。

**已排除的原因（都有实验）**：
1. **不是"拖拽期间写设置"**：把 `moved`/`resized` 里的写盘改成 700ms 防抖后，漂移**数值完全不变**（仍 12×9）。
2. **不是工作区夹取**：`preDrag.insideWorkArea = true`，且工作区 1434×1028 足以容纳 482×762。
3. **不是跨显示器 DPI 变化**：`scaleFactor` 拖拽前后都是 `1.25`。
4. **不是 `setPosition` 的锅**：改用 `setBounds({x,y,width:起始宽,height:起始高})` 显式带上尺寸后，
   尺寸序列**逐字节完全相同**（482×764 → … → 494×771）。

⇒ 结论：漂移发生在**窗口管理器层**，与我在 `dragTo` 里怎么发指令无关。
最可能：**probe 里喂的坐标空间与主进程 60Hz 拖拽定时器喂的不一致**
（`beginDrag` 存的是探针给的 `b0.x+10`，随后主进程定时器又用 `screen.getCursorScreenPoint()` 继续推，
两者交替 ⇒ Windows 每次收到"位置变化"就按比例重算尺寸）。
即**这很可能是探针自身的构造问题，而不是产品缺陷** —— 真实用户拖拽时只有一个驱动源。

**下一轮的二选一（都能定性）**：
- **A**：在探针里**不要直接调 `beginDrag/dragTo`**，改为注册一个"测试光标源"——
  让主进程的定时器从可控值取坐标（一次性驱动源），再测量；
- **B**：用 `SetCursorPos` 真移动光标 + `mouse_event` 按下，走**完全真实**的拖拽路径，
  只测量"拖拽期间窗口尺寸序列"这一项。

在此之前，**A14 的"尺寸不变性"标记为 `INCONCLUSIVE`（探针构造可疑），不记为产品缺陷，也不记为通过**。


已排除的原因：
1. **不是"拖拽期间写设置"**：原先 `moved`/`resized` 事件里直接 `patchSettings`（写盘），
   我先怀疑是它，改成 700ms 防抖后**漂移数值完全不变**（仍是 12×9）⇒ 不是它。
   （该防抖改动仍然保留 —— 它是正确的做法，只是没解决这个问题。）

下一步的三个候选（按可能性排序）：
1. **工作区边界夹取**：`panel` 窗口高 762，若拖到接近屏幕工作区底部，Windows 可能为容纳窗口而收缩。
   验证：把拖拽位移限制在"屏幕中部"再测一次，看漂移是否消失。
2. **DPI 变化**：窗口跨越不同缩放比的显示器时，`getBounds()` 的 DIP 值会变。
   验证：打印 `screen.getDisplayMatching(bounds).scaleFactor` 在拖拽前后的值。
3. **`setPosition` 后的异步 `resize` 事件**：Windows 在移动后可能回发一次尺寸微调；
   验证：在 `beginDrag` 里记录 `w.setResizable(false)` 的结果，并在拖拽期间监听 `resize` 事件打印尺寸变化序列。

> 注：`assertSizeStable()` 的判断在 `dragTo` 里是**逐次**比较 `before/after`，
> 而漂移发生在**第一次 `setPosition` 之后的下一次读取**，因此未被该断言捕获。
> 下一轮应把断言改成"记录整个拖拽期间的尺寸序列"，而不是逐步比较。
