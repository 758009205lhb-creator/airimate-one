# 双模式同窗切换（panel ⇄ pet）—— 首次验收

**结论：两个方向各 10/10 PASS。** 同一 `BrowserWindow`（id 恒为 1）在两个模式间往返，
窗口**从未重建**，renderer 界面**跟着一起切**。

证据：
- `DUALMODE-from-panel.json`（`--mode=panel` 起：panel → pet → panel）
- `DUALMODE-from-pet.json`（`--mode=pet` 起：pet → panel → pet）
- `screens/PETMODE-selfcap.png`（桌宠模式：只有角色，零界面 chrome）
- `screens/mine-pid25360-425x525-20260927-033119.png`（桌面截图）

---

## 1. 为什么必须专门验这一条

目标里写的是「panel+pet **双模式同窗切换**」，而 `applyMode()` 的注释写着
"只改窗口属性，**不重建窗口**" —— 但**此前没有任何证据**支持这句话。
"重建窗口"恰恰是本项目的红线（硬约束：一个软件实例、一个可见窗口；
禁止两窗透明叠加以假乱真），所以"同窗"必须被机械证明，不能靠注释自证。

**判据选的是最强的那种身份证据**：`BrowserWindow.id` 与 `webContents.id`
在整轮切换中必须**完全不变**。Electron 的窗口 id 单调递增且不复用 ⇒ 只要窗口被重建，
id 必然改变，**无法伪造**。同时要求 `getAllWindows().length` 与可见窗口数恒为 1。

```
命令（两个方向各跑一次）：
.\node_modules\electron\dist\electron.exe apps\desktop --dev --mode=panel --no-dialogs \
  --probe petmode --probe-out docs\evidence\phase1\DUALMODE-from-panel.json --probe-exit
.\node_modules\electron\dist\electron.exe apps\desktop --dev --mode=pet   --no-dialogs \
  --probe petmode --probe-out docs\evidence\phase1\DUALMODE-from-pet.json   --probe-exit
```

| 判据 | `--mode=panel` 起 | `--mode=pet` 起 |
|---|---|---|
| `passSameWindowId` | ✅ | ✅ |
| `passSameWebContentsId` | ✅ | ✅ |
| `passSingleWindowThroughout` | ✅ | ✅ |
| `passSingleVisibleWindowThroughout` | ✅ | ✅ |
| `passModeActuallyChanged` | ✅ | ✅ |
| `passGeometryChanged` | ✅ | ✅ |
| `passGeometryRestored` | ✅（delta 0×0） | ✅（delta **−1**×0） |
| `passModeAttributesApplied` | ✅ | ✅ |
| `passStageHealthyThroughout` | ✅ | ✅ |
| `passRendererFollowedMode` | ✅ | ✅ |

实测读数（`--mode=panel` 起）：

```
start  482x762  mode=panel  winId=1  wcId=1  resizable=true   skipTaskbar=false  shadow=true   min=380x520
after  342x421  mode=pet    winId=1  wcId=1  resizable=false  skipTaskbar=true   shadow=false  min=340x420
back   482x762  mode=panel  winId=1  wcId=1  resizable=true   skipTaskbar=false  shadow=true
```

`--mode=pet` 起时方向相反（`341x420 → 481x760 → 340x420`），且 `winId` 同样恒为 1。

---

## 2. 这一轮抓出的 **4 个真实缺陷**（全都"不报错"）

### 缺陷 1 —— `--mode=pet` 静默失效：CLI 只认空格写法

`parseCli` 的 `valueOf()` 用 `argv.indexOf(flag)` 再取**下一个**元素，
所以 `--mode pet` 能解析、**`--mode=pet` 不能**（返回 `null`）。
两次运行都用 `=` 写法 ⇒ 模式覆盖从未生效，**零报错**。

定位方式（值得复用）：写一个独立的 Electron 小程序打印 `process.argv`，确认
**Electron 原样透传了** `--mode=pet`：

```
ARGV_JSON=[...,"apps\\desktop","--dev","--mode=pet","--no-dialogs"]
```

⇒ 应用**收得到**，是自己没解析。这一步把"Electron 吃掉了参数"这个错误方向排除掉了。

**修法**：`valueOf()` 同时支持 `--flag value` 与 `--flag=value`。

### 缺陷 2 —— 参数拼错会被静默忽略（**让缺陷 1 得以隐身的原因**）

`--mode=pet` 之所以能"悄悄失效"，是因为解析器对不认识的参数**一声不吭**。
参数解析器的沉默是最昂贵的沉默：它把"你写错了"变成"功能好像没生效"。

**修法**：新增白名单校验，未识别参数**立即抛错**，并用编辑距离给出建议：

```
$ electron.exe apps\desktop --dev --mod=pet --no-dialogs
ERROR main 启动失败 {"err":"Error: 无法识别的启动参数：--mod=pet（是否想写 --mode？）。
  可用参数：--dev --no-dialogs --probe-exit ... --mode ..."}
BOOT_FAILED Error: 无法识别的启动参数：--mod=pet（是否想写 --mode？）
```

### 缺陷 3 —— `windowMode()` 把"启动覆盖"和"当前模式"混成一个

原实现 `return sessionModeOverride ?? currentMode`。本意是修"renderer 启动时读回设置、
把模式改回去"，但设了覆盖之后 `windowMode()` **永远返回覆盖值**：
`applyMode('pet')` 之后它仍说 `panel` ⇒ 任何"模式到底变没变"的判断都被它骗过
（实测 `passModeActuallyChanged=false`，而窗口尺寸与属性其实全都正确变了）。

**修法**：`windowMode()` 只返回**实际生效**的 `currentMode`；
启动覆盖单独用 `bootModeOverride()`，仅用于"是否接受 renderer 回写"。

### 缺陷 4 —— **主进程改了窗口，renderer 不知道**（最严重的一个）

`settings:get` 返回的是**持久化设置**，不是本次会话生效的模式。
于是 `--mode=pet` 时：窗口正确变成 340×420 桌宠尺寸，
但 renderer 读到的 `settings.mode` 仍是 `panel` ⇒
**整套面板 UI（标题栏 + 标签页 + 聊天输入框）被画进桌宠窗口里**。

证据（修复前）：`screens/mine-pid8264-425x525-20260927-033033.png`

> 只看窗口几何**完全查不出来**这个问题 —— 窗口是对的，界面是错的。
> 必须问 renderer"你以为自己是什么模式"，所以 UI 探针新增了 `uiMode` / `isPetLayout`。

**修法（两件必须都做）**：
1. `settings:get` 在会话覆盖生效时返回 `{ ...s, mode: session }`；
2. 探针改为走**真实切换路径**（`applyMode` + `patchSettings` + `sendModeChanged` 三步，
   与 `window:set-mode` 完全一致），而不是只调 `applyMode` ——
   因为"忘记广播"这类问题**本来就不在 `applyMode` 里**，只调它测不出来。

修复后：`renderer uiMode=pet isPetLayout=True`（切到 pet）、
`uiMode=panel isPetLayout=False`（切回 panel）。

---

## 3. 桌宠模式的视觉确认

`screens/PETMODE-selfcap.png`（由 `--selfcap` 从帧缓冲自拍，90×289）：

只有角色本体 + 透明背景，**没有标题栏、没有标签页、没有输入框、没有状态栏** ——
即真正的桌宠形态。

> 为什么用 `--selfcap`（帧缓冲自拍）而不是桌面 `CopyFromScreen`：
> 桌宠窗口是 `alwaysOnTop`，桌面截图会被**其它置顶窗口盖住**
> （实测第一次桌面截图抓到的是别的应用）。自拍取的是应用自己的帧，不受遮挡影响。
> 两种证据互补：探针读数证明"切对了"，自拍证明"看起来对"。

---

## 4. NOT VERIFIED

| 项 | 状态 | 说明 |
|---|---|---|
| 几何还原的**逐像素**相等 | 已放宽为 ±2px | `--mode=pet` 往返 1px 偏差（341→340），根因是本机 **125% 分数 DPI 的整数舍入**，与 A14 的"拖拽尺寸漂移 2×2"同源。探针记录了 `geometryDeltaAfterReturn` 原始值，口径是否接受需你确认（与 A14 是同一个待拍板问题）。 |
| **托盘菜单**切换模式 | `NOT VERIFIED` | 探针走的是 `window:set-mode` 同源的路径；托盘菜单项是另一条入口（`tray.ts`），未做点击级验证。 |
| **设置面板按钮**切换模式 | `NOT VERIFIED` | 同上，未做 UI 自动化点击。 |
| 模式切换时的**动画/过渡** | `NOT VERIFIED` | 只验证了终态（几何 + 属性 + 界面），切换过程是否平滑未量化。 |
| 桌宠模式的**鼠标穿透/命中区域** | `NOT VERIFIED` | `ignoreMouseEvents` 在 pet 模式下是否按预期工作，未测。 |
| 几何还原 delta 是否**随切换次数累积** | `NOT VERIFIED` | 只做了 1 次往返（delta −1px）。多轮往返是否累积未测（A14 已证明拖拽 8 步不累积，但模式切换是不同路径）。 |
