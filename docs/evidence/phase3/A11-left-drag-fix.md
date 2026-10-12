# A11 修正 —— 左键拖拽曾被 `setPointerCapture` 抛错**整段中断**

> ⚠ **历史记录（留档，勿直接引用其结论）**
> 本文件记录的是**那一次**排障（`setPointerCapture` 抛错中断处理器）。
> 其中两条结论**已被后续轮次取代**：
> ① 文中"`allPass=true`（5/5）"指的是**旧判据**（「左键 pointerdown ⇒ 必须开始拖拽」）——
>    该判据本身就是缺陷一（按下即拖拽），已于 2026-09-27 **重写**，见 `A11-input.md`；
> ② 文中 `a14.passSizeUnchanged=False` 与"口径待你拍板"已于 2026-09-27 **定稿并达标**：
>    口径改为「读回值恒定 + 偏差 ≤1 DIP」，且在做完 **panel 尺寸对齐 4 DIP 栅格**后
>    实测已是**严格 0 DIP**（8 步读数全部 `482×761`）。
> 当前判据与原始读数：`phase3/A11-input.md`、`round-interaction/a11.json`、
> `INTERACTION-FIX-EVIDENCE.md` §2.4。**下述排障过程与根因分析仍然有效。**

**结论（当次）：A11 恢复 `allPass=true`（旧判据 5/5）。**
证据：`docs/evidence/phase3/round-interaction/a11.json`（新判据）

---

## 1. 症状与最初的误判

回归时 A11 报 `passLeftStartsDrag=false`：派发 `pointerdown(button=0)` 到画布后
`dragging` 仍是 `false`，而**没有任何错误记录**。

我前后踩了三个坑才定位到它，过程本身值得记下来：

| 我的猜测 | 怎么排除的 | 结论 |
|---|---|---|
| "同步读状态太早，异步 `await` 还没跑完" | 改成等 350ms 宏任务后再读 | ❌ 仍为 false |
| "`drag-begin` IPC 被拒" | 探针内**直接**调 `bridge.dragBegin()` | ❌ `{ok:true}`，IPC 正常 |
| "Vue 事件处理器没跑" | 探针加 capture + bubble 两个监听 | ❌ 两个都收到了 |

三环都排除后，日志里出现了一条线索 —— **`renderer console: [object DOMException]`**。

## 2. 根因

```ts
// 修前
;(ev.target as HTMLElement).setPointerCapture?.(ev.pointerId)
```

`PointerEvent` 是**合成**的（`new PointerEvent(...)`），它的 `pointerId` 在浏览器里
不对应任何**活动指针**，于是 `setPointerCapture()` 抛 `DOMException`。

关键在**抛出点**：它在 `setDragging(true)` **之前**，所以函数体**当场中断** ——
`dragging` 永远是 `false`、`bridge.dragEnd()` 也不会被调用，
而且**不产生任何我们自己的错误记录**（异常直接冒给事件系统，
只以 `[object DOMException]` 的形式出现在控制台）。

## 3. 这不只是"探针的合成事件问题"

必须说清楚这一点，否则容易被当成测试瑕疵放过：

- 合成事件确实是我构造的，但**抛错的是浏览器对 `setPointerCapture` 的真实行为**；
- 生产里同样会抛：`pointerId` 无效（多指/笔输入/指针已释放）、元素已被移除等；
- 一旦抛出，用户得到的是**左键点击完全没反应**，而界面上没有任何提示 —— 这是最糟的故障形态；
- 而**指针捕获本身只是优化**（保证拖出元素后仍收到事件），**不是拖拽的前提**。

所以修法是：捕获失败必须被容忍，拖拽照常开始。

```ts
// 修后
try { (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId) } catch { /* 捕获失败不影响拖拽 */ }
```

## 4. 顺带修掉的两件事

### 4.1 A11 的断言在**错的时刻**测量

`leftDown` 是异步路径（`await bridge.dragBegin()` 之后才 `setDragging(true)`），
而探针**同步**读状态 ⇒ 读到的是"微任务还没跑"，不是"左键没启动拖拽"。
已改为等一个宏任务后再读。判据本身没变，变的是测量时刻。

### 4.2 `reportFailure` 的错误此前**不留痕迹**

拖拽启动失败只变成一个 toast，窗口一关就没了 —— 排障时日志里查不到任何原因。
现在同时 `console.error`，而 renderer 控制台是**被主进程转发进日志文件**的：

```ts
console.error(`[ui] ${prefix}: ${msg}`)
```

## 5. 一次**把探针自己挂死**的教训

诊断过程中我写过一版"直接调用 `onPointerDown()`"的探针，结果是：
合成事件触发的异常在**探针内部**冒泡 ⇒ `executeJavaScript` 永不 resolve ⇒
进程不退出、JSON 不写、命令 120s 超时。
现象极具误导性：看起来像"应用卡死"，实际是**探针自己写坏了**。

现在 `leftDownDiag` 带**内部超时**（1.5s 兜底），并且**不**直接调处理器、
也不自己调 `setPointerCapture` —— 它只做"派发一次 + 读状态"。

## 6. 回归结果（**当次**实测，已被后续轮次取代）

```
[a10 ] passA10=True  passHitRegionMatchesVisual=True  passWheelInWindow=True
[a11 ] allPass=True（旧判据）
[a12 ] pass=True
[a13 ] pass=True
[a14 ] passDragTilts=True  passDragClipActive=True  passSpringReturns=True  passSizeUnchanged=False

双模式：--mode=panel → pass=True   panel(482x762) → pet(342x421) → panel   winId=1/1/1
        --mode=pet   → pass=True   pet(341x420)  → panel(481x760) → pet    winId=1/1/1
```

`a14.passSizeUnchanged=false` 当时是**待拍板**的口径问题（2×2 物理像素、125% 分数 DPI 的整数舍入）。
**现已关闭**：用户 2026-09-27 选定口径 B（恒定 + ≤1 DIP），并在做完 panel 尺寸 4 DIP 栅格对齐后
实测为**严格 0 DIP**（`sizeReadings` 8 项全 `482×761`、`sizeDriftMaxDip=0`、`strictSizeUnchanged=true`）。

---

## 7. NOT VERIFIED

| 项 | 状态 | 说明 |
|---|---|---|
| **真实鼠标**按住拖拽 | `NOT VERIFIED` | 探针派发的是合成 `PointerEvent`。真实指针事件 `pointerId` 有效，`setPointerCapture` 不会抛错 —— 但"真实鼠标拖拽"这条仍需 `SetCursorPos + mouse_event` 级别的注入来验证（`tools/qa/` 尚未实现）。 |
| `setPointerCapture` 在**多指/笔输入**下的行为 | `NOT VERIFIED` | 只是推断它会抛错，未构造真实场景。 |
| 拖拽中**移出窗口**后是否仍收到事件 | `NOT VERIFIED` | 这正是指针捕获的作用；修好后捕获在真实场景下仍生效，但没有测"移出窗口再拖回来"。 |
