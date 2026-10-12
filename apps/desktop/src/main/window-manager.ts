/**
 * apps/desktop/src/main/window-manager.ts —— **桌宠（pet/panel）窗口**的管理器
 *
 * ⚠ 2026-10-08 返工轮：本文件**不再是**"唯一允许创建 BrowserWindow 的模块"。
 *   现在**恰好两个**窗口，各有自己的创建点：
 *     · pet/panel（角色）—— 本文件 `createMainWindow()`；
 *     · chat（独立对话窗口）—— `chat-window.ts` 的 `ensureChatWindow()`。
 *   **第三个窗口是禁止项**。旧的"单窗口硬约束"是上一轮把聊天塞进桌宠窗口的根因，
 *   已被显式废止（见 `docs/Acceptance-Matrix.md` §0.5 与 §1.5 的新口径）。
 *
 * 硬约束（PRD FR-1 / Tech-Spec §4）：
 *   ① 角色**只**在 pet 窗口里渲染（全应用 WebGLRenderer 总数恒为 1）；
 *   ② 窗口**始终**以 `transparent:true` + `frame:false` 创建 —— Electron 不支持运行时切换这两项，
 *      所以 panel 模式用不透明 CSS 填满、pet 模式让背景透明，从而"同窗切模式"无需重建窗口；
 *   ③ 模式切换不得重建窗口 / renderer / Scene / VRM；
 *   ④ **pet 模式的窗口尺寸恒为 340×420**，拖拽期间不得变化（判据 A14）；
 *      对话窗口的开合**完全不改**这个窗口的任何东西（判据 A2/A3/A4 的新口径）；
 *   ⑤ 关闭按钮默认 hide() 而非退出（由 bootstrap 处理 'close' 事件）。
 */
import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import type { Rect, WindowMode } from '@airimate/shared'
import { APP_NAME, WINDOW_GEOMETRY } from '@airimate/shared'
import { appPaths } from './paths.js'
import { log } from './log.js'
import { applyWindowSecurity } from './window-security.js'

export interface CreateWindowOptions {
  mode: WindowMode
  preloadPath: string
  /** 开发模式：renderer 由 Vite dev server 提供 */
  devServerUrl: string | null
  /** 记忆的几何（panel 尺寸 / pet 位置） */
  panelBounds: Rect | null
  petPosition: { x: number, y: number } | null
  alwaysOnTop: boolean
  onClose: (e: Electron.Event) => void
  /**
   * ★★ **`ready-to-show` 时是否自动显示窗口**（2026-10-09 完善轮新增）。
   *
   * 为什么需要它：本轮起"打开软件不再自动出现桌宠"（`petResident` 默认 `false`）——
   * 默认启动**只**出现对话窗口。而窗口本身**必须照常创建**（renderer 要挂载、
   * 舞台要初始化、快捷键与轮盘的入口都在它身上），只是**不显示**。
   *
   * ⚠ 这里刻意**不**读设置：`window-manager.ts` 是"窗口属性"的唯一真源，
   *   把"要不要自动显示"的判断放进来就等于让窗口层依赖设置层，
   *   而那个方向一旦建立，"改设置顺手改窗口"的调用会越来越多。
   *   判定在 `bootstrap` 里做，这里只接受一个布尔。
   *
   * 缺省 `true`（保持旧行为）：只有显式传 `false` 才会"创建但不显示"。
   */
  autoShowOnReady?: boolean
  /**
   * 帧率上限（透传给 renderer 的 `?fpsCap=`）。
   * 用途：区分"渲染成本"与"调度开销"——抬到 120 仍只有 ~50 ⇒ 渲染成本问题。
   */
  fpsCap?: number | null
}

let win: BrowserWindow | null = null
let currentMode: WindowMode = 'panel'
/**
 * **会话级模式覆盖**（来自 `--mode` 命令行参数）。
 *
 * 为什么需要（实测 bug）：`bootstrap` 里 `const mode = cli.mode ?? settings.mode` 只用它建窗口，
 * 但 renderer 启动时会 `getMode()` 读回**持久化设置里的 mode**，随后 `patchSettings({mode})`
 * 又把它写回去 ⇒ **CLI 覆盖被持久化设置逆向覆盖**。
 * 实测：`--mode=pet` 启动后窗口仍是 panel 尺寸（482×762）且 `resizable=true`，参数静默失效。
 *
 * 现在：CLI 给出的模式是**会话级覆盖**（`getMode`/`windowMode` 优先返回它），
 * 且不再被写回设置 —— 参数不再会被静默吃掉。
 */
let sessionModeOverride: WindowMode | null = null

export function setSessionModeOverride(m: WindowMode | null): void {
  sessionModeOverride = m
}

export function sessionMode(): WindowMode | null {
  return sessionModeOverride
}
let dragSession: {
  startCursor: { x: number, y: number }
  startWindow: { x: number, y: number }
  lastBounds: Rect
  /**
   * ★ **不可变目标尺寸**：拖动开始时记录一次，整个拖动过程**永不修改**。
   *
   * 为什么必须与 `lastBounds` 分开（实测根因）：
   *   原实现把 `lastBounds`（上一帧 `getBounds()` 的**读回值**）当成下一帧的目标尺寸，
   *   而系统的尺寸重算会让读回值比目标大一点 ⇒ 坏值被当成新目标 ⇒ **误差逐帧累积**
   *   （录像期间实测 482×762 → 528×810，正是用户看到的"单击她也会不断放大"）。
   *   纠正分支又恢复到 `before`（同样是读回值）⇒ **不是恢复到不变量**。
   *   所以这里存一份**只写一次**的目标尺寸，任何纠正都从它恢复。
   */
  targetSize: { width: number, height: number }
  /**
   * ★ **实际请求尺寸** = `targetSize + 实测补偿量`。
   *
   * 为什么要补偿（本轮 `--probe sizeDiag` 的地面真值，133 行原始 JSON 见
   * `docs/evidence/phase3/round-interaction/sizeDiag.json`）：
   *   · 本机 125% 缩放（`scaleFactor = 1.25`），窗口 482×762 DIP = **602.5×952.5 物理像素**；
   *   · `setBounds({482,762})` 之后 `getBounds()` 稳定读回 **483×763**（A11 实测）
   *     ⇒ 物理像素是整数，Electron 的 DIP↔物理换算带一个固定的取整/边框项，
   *     请求 482 永远得不到 482（`sizeDiag` 实测：请求 470→472、482→484、484→486）；
   *   · 这条偏移**不累积**（8 次移动读数完全相同），
   *     但"拖动前后一字不差"的判据因此无法靠"直接请求目标值"满足。
   * ⇒ 拖动开始时**实测一次映射**（请求 target → 读回 actual ⇒ delta = target − actual），
   *   之后按 `target + delta` 请求。**自验证**：补偿后仍读不回 target 就记失败并退回直接请求，
   *   绝不假装成功（`sizeCalibration.ok === false` 会原样出现在探针证据里）。
   */
  requestSize: { width: number, height: number }
  /**
   * **可变**补偿量（`requestSize = targetSize + requestDelta`）。
   *
   * 为什么不能只用拖动开始时标定的固定量（实测）：这个常数项**随窗口位置变化** ——
   * 起点标定 `delta = (−2,−1)`，移动到另一个位置后同一请求读回 482×**762**
   * （A11：拖动中高度差 1px）。位置每帧都在变，所以每帧按实测偏差微调它，
   * 偏差累加并**夹在 ±4 内**（超出就是发散了，宁可记失败也不要和窗口管理器对拉）。
   */
  requestDelta: { width: number, height: number }
  /** 尺寸映射标定结果（探针证据；失败时必须如实呈现） */
  sizeCalibration: DragSizeCalibration
  /** 拖动过程中按实测偏差调整请求量的次数（位置相关的取整项；0 = 一次都不需要） */
  adaptiveAdjustments: number
  /** 整个拖动过程累计做过的尺寸纠正次数（探针据此断言"系统没捣乱"） */
  sizeCorrections: number
} | null = null

/** 把补偿量夹在安全范围内，避免自适应发散的数值爆炸 */
function clampDelta(v: number, limit: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.max(-limit, Math.min(limit, Math.round(v)))
}

export interface DragSizeCalibration {
  /** 我们**想要**的尺寸（= 拖动开始时的窗口尺寸，不可变） */
  target: { width: number, height: number }
  /** 直接请求 target 后系统给的尺寸（null = 未测） */
  firstActual: { width: number, height: number } | null
  /** 求得的请求补偿量（请求 = target + this） */
  requestedDelta: { width: number, height: number }
  /** 用补偿量请求后系统给的尺寸 */
  calibratedActual: { width: number, height: number } | null
  /** 补偿后是否**真的**读回了 target */
  ok: boolean
  attempts: number
  /** 对齐 DIP 栅格后的最终请求尺寸（见 `snapSizeToDipGrid`） */
  requestSnapped?: { width: number, height: number }
  /** **用对齐后的请求**实测读回的尺寸；`ok` 以它为准（见 `beginDrag` 里的说明） */
  snappedActual?: { width: number, height: number }
}

export function getWindow(): BrowserWindow | null {
  return win
}

export function windowMode(): WindowMode {
  /**
   * 返回**实际生效**的模式（`currentMode`），**不**优先返回启动覆盖。
   *
   * ⚠ 这里曾写作 `sessionModeOverride ?? currentMode`。本意是修"`--mode=pet` 被
   * renderer 启动时的 `getMode()` 读回设置、把模式改回 panel"，但它把**两个概念**混成了一个：
   *   · `sessionModeOverride`：**启动时**该用哪个模式（会话级请求，只影响首帧）；
   *   · `currentMode`：**现在**是什么模式（会随用户切换而变）。
   * 于是设了覆盖之后 `windowMode()` 永远返回覆盖值 —— `applyMode('pet')` 之后它仍说 panel，
   * 任何"模式到底变没变"的判断都被它骗过（实测：`--probe petmode` 报
   * `passModeActuallyChanged=false`，而窗口尺寸与模式专属属性其实全都正确变了）。
   * 现在覆盖只用于"首帧取值 + 拒绝 renderer 回写"，对外查询一律返回真实值。
   */
  return currentMode
}

/**
 * 本次会话启动时被 CLI 覆盖的模式（`null` = 未覆盖）。
 * 用途仅限"是否接受 renderer 的模式回写"这一判断。
 */
export function bootModeOverride(): WindowMode | null {
  return sessionModeOverride
}

export function windowBounds(): Rect | null {
  if (!win || win.isDestroyed()) return null
  const b = win.getBounds()
  return { x: b.x, y: b.y, width: b.width, height: b.height }
}

/**
 * 角色窗口**此刻**是否可见（2026-10-09 完善轮新增）。
 *
 * 为什么要有它：`pet-visibility.ts` / 托盘 tooltip / 三处菜单都要回答"她现在在不在屏幕上"，
 * 而"窗口对象存在"与"窗口可见"是两件事 —— 本轮起**默认就是"存在但不可见"**，
 * 所以这个区分从"边角情况"变成了**默认状态**。
 */
export function windowVisible(): boolean {
  if (!win || win.isDestroyed()) return false
  return win.isVisible()
}

/** 角色窗口是否已创建（未创建时"收回"是空操作，"呼出"要如实报错） */
export function windowCreated(): boolean {
  return !!win && !win.isDestroyed()
}

export function isDragging(): boolean {
  return dragSession !== null
}

function defaultPanelBounds(): Rect {
  const wa = screen.getPrimaryDisplay().workArea
  const { width, height } = WINDOW_GEOMETRY.panel
  return {
    x: Math.round(wa.x + wa.width - width - 24),
    y: Math.round(wa.y + Math.max(0, (wa.height - height) / 2)),
    width,
    height,
  }
}

function defaultPetBounds(): Rect {
  const wa = screen.getPrimaryDisplay().workArea
  const { width, height } = WINDOW_GEOMETRY.pet
  return {
    x: Math.round(wa.x + wa.width - width - 60),
    y: Math.round(wa.y + wa.height - height - 80),
    width,
    height,
  }
}

function clampToVisibleArea(b: Rect): Rect {
  const displays = screen.getAllDisplays()
  const onSomeDisplay = displays.some(d => {
    const wa = d.workArea
    return b.x + b.width > wa.x && b.x < wa.x + wa.width && b.y + b.height > wa.y && b.y < wa.y + wa.height
  })
  if (onSomeDisplay) return b
  return defaultPanelBounds()
}

export function createMainWindow(o: CreateWindowOptions): BrowserWindow {
  if (win && !win.isDestroyed()) {
    log().warn('createMainWindow 被重复调用：返回既有窗口（不创建第二个）', {}, 'window.duplicate-create')
    return win
  }

  const initialBounds = o.mode === 'panel'
    ? clampToVisibleArea(o.panelBounds ?? defaultPanelBounds())
    : { ...defaultPetBounds(), ...(o.petPosition ?? {}) }

  /**
   * ⛔ **不要在创建时"顺手对齐"panel 尺寸**（2026-10-08 试过，**已撤销**，留档防重犯）。
   *
   * 试的是什么：在 `new BrowserWindow()` 之前把 `480×760` 对齐成 `472×752`
   *   （`snapSizeToDipGrid` 向下取到 4 的整数倍），理由是"整物理像素的读回跨位置一致"。
   *
   * 结果：**把 A14 从 PASS 打成 FAIL**。
   *   · 改之前：A14 八次读数**全部** `482×761`、`distinct=1`、`driftMax=0`；
   *   · 改之后：读数在 `482×761` / `482×763` 之间跳、`distinct=2`、`driftMax=1`。
   *
   * 教训（比这个改动本身重要）：**"更整齐的数值"不等于"更稳定的行为"**。
   *   本机 125% 缩放下 `482×761`（= 602.5×951.25 物理像素）虽然也是半像素，
   *   但它处在一个**稳定的读回相位**上，八步不动；人为搬到另一个"看起来更整"的值，
   *   反而落到了不稳定的一侧。⇒ 判据必须建立在**实测相位**上，不能建立在对栅格的直觉上。
   *
   * 仍然成立的结论：`482×762`（本轮环境读到的值）落在**不稳定**相位上 ——
   *   这是 A11 那条 1 DIP 漂移的直接原因（详见 `--probe sizeMap` 与 CHAT-WINDOW-ROUND.md §6）。
   *   但它**不能靠"搬尺寸"解决**，需要改判据或在资产/配置层面把基线钉成一个实测稳定的值。
   */
  const snappedInitial = initialBounds

  currentMode = o.mode

  win = new BrowserWindow({
    ...snappedInitial,
    show: false,
    title: APP_NAME,
    // ⑤ 保持最小意外：不显示菜单栏
    autoHideMenuBar: true,
    /**
     * ⚠ `transparent` 的依据（实测取证）：
     *   Electron 只能在**创建时**决定 transparent。窗口被创建为透明后，整窗走透明合成路径；
     *   实测发现：**同一个 WebGL 帧缓冲里角色确实被画出来了**（`canvasNonBgRatio = 1`、
     *   `drawCalls = 24`），但屏幕上（panel 模式的不透明画布也一样）看不到任何画布像素
     *   ⇒ 画布内容没有进入窗口合成。
     *   panel 模式本来就不需要透明，因此**只在 pet 模式创建透明窗口**：
     *     · panel：`transparent: false` + 不透明画布 ⇒ 合成路径最常规、最可靠；
     *     · pet  ：`transparent: true` + 透明画布 ⇒ 桌面可见（该模式是产品的核心形态）。
     *   代价：两种模式之间切换需要**重建窗口**（见 `applyMode`），
     *   但**不重建 renderer/Scene/mixer/VRM**（那些由 renderer 侧持有，窗口重建后 WebGL 上下文会丢失 —
     *   切换时 renderer 侧会重新挂载同一个 Stage 的画布，见 AvatarStage 的 `remountCanvas`）。
     */
    frame: false,
    transparent: o.mode === 'pet',
    backgroundColor: o.mode === 'pet' ? '#00000000' : '#12141c',
    hasShadow: o.mode === 'panel',
    resizable: o.mode === 'panel',
    minimizable: true,
    maximizable: o.mode === 'panel',
    fullscreenable: false,
    skipTaskbar: o.mode === 'pet',
    alwaysOnTop: o.alwaysOnTop,
    acceptFirstMouse: true,
    webPreferences: {
      preload: o.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
      devTools: !!o.devServerUrl || process.argv.includes('--diag'),
      // 禁用 <webview>
      webviewTag: false,
      // 不允许跨域隔离带来的意外
      enableBlinkFeatures: '',
    },
  })

  /**
   * 安全装配：**与 chat 窗口共用同一份实现**（`window-security.ts`）。
   *
   * 为什么抽出去（本轮）：新增第二个窗口时最容易发生的事，就是"照着抄一份、顺手简化两行"——
   * 而少掉的每一条（权限拒绝、导航拦截、CSP 注入）都**没有任何界面表现**。
   * 装配只有一份 ⇒ 两个窗口的安全面不可能漂移。
   */
  applyWindowSecurity(win, { devServerUrl: o.devServerUrl, label: o.mode })

  win.on('close', (e) => o.onClose(e))
  win.on('closed', () => { win = null })

  // 位置/尺寸记忆（panel 模式）由 bootstrap 订阅 'moved'/'resized' 处理
  applyMode(o.mode, { resize: true, persist: false })

  const q = o.fpsCap && o.fpsCap > 0 ? `?fpsCap=${Math.round(o.fpsCap)}` : ''
  const url = o.devServerUrl ? `${o.devServerUrl}/index.html${q}` : `app://bundle/index.html${q}`
  void win.loadURL(url).catch((e: unknown) => {
    log().error('renderer 加载失败', { url, err: e instanceof Error ? e.message : String(e) }, 'window.load.failed')
  })

  win.once('ready-to-show', () => {
    /**
     * ★ `autoShowOnReady === false` ⇒ **创建但不显示**（2026-10-09 完善轮）。
     *
     * 这一条就是"打开软件不再自动出现桌宠"的落点：窗口照常建好、
     * renderer 照常挂载、舞台照常初始化（这样"呼出"是**即时**的，不需要等加载），
     * 只是不上屏。`showWindow()`（托盘/菜单/快捷键）随时能把它显示出来。
     */
    if (o.autoShowOnReady === false) {
      log().info('窗口已就绪但按要求不自动显示（桌宠非常驻）', { mode: o.mode }, 'window.ready.hidden')
      return
    }
    win?.show()
    if (currentMode === 'panel') win?.focus()
  })

  log().info('主窗口已创建', { mode: o.mode, bounds: `${initialBounds.x},${initialBounds.y} ${initialBounds.width}x${initialBounds.height}` }, 'window.created')
  return win
}

export interface ApplyModeOptions {
  resize?: boolean
  persist?: boolean
}

/** 切换模式：只改窗口属性，**不重建窗口** */
export function applyMode(mode: WindowMode, opts: ApplyModeOptions = {}): Rect | null {
  const w = win
  if (!w || w.isDestroyed()) return null
  const prev = currentMode
  currentMode = mode

  if (mode === 'pet') {
    /**
     * ⚠ pet 尺寸**恒定 340×420**（返工轮定稿）。
     *
     * 这里曾经是"打开对话就把窗口放大到 380×560（conversation 尺寸）"的起点，
     * 那条路径连同 `WINDOW_GEOMETRY.conversation` / `enterConversationLayout()` /
     * `syncConversationLayoutForMode()` 一起被删除。现在**没有任何东西**会在
     * 运行期改变 pet 窗口的尺寸：对话窗口是另一个 BrowserWindow，与这里无关。
     * ⇒ "切到 pet 后应不应该更高" 这个问题不再存在，所以也不需要"还原目标"。
     */
    const { width, height } = WINDOW_GEOMETRY.pet
    const b = w.getBounds()
    w.setResizable(false)
    w.setMinimumSize(width, height)
    w.setSkipTaskbar(true)
    skipTaskbarRequested = true
    w.setHasShadow(false)
    if (opts.resize !== false && (b.width !== width || b.height !== height)) {
      // 保持右上角不动地缩到 pet 尺寸
      w.setBounds({ x: b.x + (b.width - width), y: b.y, width, height })
    }
    w.setAlwaysOnTop(true, 'floating')
  } else {
    const { width, height } = WINDOW_GEOMETRY.panel
    const b = w.getBounds()
    w.setMinimumSize(WINDOW_GEOMETRY.panelMin.width, WINDOW_GEOMETRY.panelMin.height)
    w.setResizable(true)
    w.setSkipTaskbar(false)
    skipTaskbarRequested = false
    w.setHasShadow(true)
    if (opts.resize !== false && (b.width !== width || b.height !== height)) {
      w.setBounds({ x: b.x + (b.width - width), y: b.y, width, height })
    }
    w.setAlwaysOnTop(false)
  }

  if (prev !== mode) log().info('窗口模式已切换（同窗，未重建）', { from: prev, to: mode }, 'window.mode')
  return windowBounds()
}

/**
 * 当前是否"跳过任务栏"。
 *
 * 为什么要单独记账：Electron 只提供 `setSkipTaskbar()`，**没有对应 getter**，
 * 所以"pet 模式不进任务栏"这条无法直接查询。记录最后一次请求值即可 ——
 * 它同时也能暴露"我们以为设成 A、实际最后一次设的是 B"这类不一致。
 */
let skipTaskbarRequested = false

export function isSkipTaskbarRequested(): boolean {
  return skipTaskbarRequested
}

export function setAlwaysOnTop(on: boolean): void {
  const w = win
  if (!w || w.isDestroyed()) return
  w.setAlwaysOnTop(on, currentMode === 'pet' ? 'floating' : 'normal')
}

export function showWindow(): void {
  const w = win
  if (!w || w.isDestroyed()) return
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
}

export function hideWindow(): void {
  const w = win
  if (!w || w.isDestroyed()) return
  w.hide()
}

export function centerWindow(): void {
  const w = win
  if (!w || w.isDestroyed()) return
  const wa = screen.getPrimaryDisplay().workArea
  const b = w.getBounds()
  w.setBounds({ x: Math.round(wa.x + (wa.width - b.width) / 2), y: Math.round(wa.y + (wa.height - b.height) / 2), width: b.width, height: b.height })
}

// ───────────────────────────────────────────────────────── 拖动（左键唯一用途）

export interface DragTick { x: number, y: number, dx: number, dy: number, width: number, height: number }

let dragTimer: NodeJS.Timeout | null = null
let dragLastPos: { x: number, y: number } | null = null
/**
 * 拖拽光标源（**可注入**）。
 * 默认读真实光标；QA 可换成"可控光标源"，从而保证**只有一个驱动源**
 * —— 上一轮 A14 实测到的尺寸漂移，正是"探针直接调 dragTo + 定时器同时读真实光标"
 *    两个驱动源交替造成的（见 docs/evidence/phase5/A14-drag.md）。
 */
let dragCursorSource: () => { x: number, y: number } = () => screen.getCursorScreenPoint()
/** 拖拽期间被钉死的尺寸（null = 未在拖拽） */
let dragFixedSize: { width: number, height: number } | null = null

/**
 * 把尺寸**向下**对齐到 DIP 栅格（栅格步长见 `dipGridStep`）。
 *
 * 为什么要"向下"而不是"就近"：本机 `scaleFactor = 1.25`，`482/4 = 120.5` 正好在中间，
 * 就近取整会得到 `484`（比原尺寸**更大**）；向下取整得到 `480`，窗口只会略微变小，
 * 不会在用户没要求的情况下变大。
 */
export function snapSizeToDipGrid(
  size: { width: number, height: number },
  scaleFactor: number,
): { width: number, height: number } {
  const step = dipGridStep(scaleFactor)
  if (step <= 1) return { width: size.width, height: size.height }
  return {
    width: Math.max(step, Math.floor(size.width / step) * step),
    height: Math.max(step, Math.floor(size.height / step) * step),
  }
}

/** 仅 QA 使用：替换光标源（返回还原函数） */
export function setDragCursorSource(src: (() => { x: number, y: number }) | null): void {
  dragCursorSource = src ?? (() => screen.getCursorScreenPoint())
}

/**
 * **实测**窗口尺寸映射，求出"请求多少才能得到目标尺寸"。
 *
 * 见 `dragSession.requestSize` 的注释：非整数 DPI 下 `request + delta` 才是目标值。
 * 三次尝试：① 直接请求 target；② 按 `target + (target − actual)` 请求；
 * ③ 若仍未命中 ⇒ 放弃补偿（回到直接请求 target，至少保证**不累积**）。
 */
function calibrateDragSize(w: BrowserWindow, target: { x: number, y: number, width: number, height: number }): DragSizeCalibration {
  const t = { width: target.width, height: target.height }
  const out: DragSizeCalibration = {
    target: t,
    firstActual: null,
    requestedDelta: { width: 0, height: 0 },
    calibratedActual: null,
    ok: false,
    attempts: 0,
  }
  const put = (width: number, height: number): { width: number, height: number } => {
    w.setBounds({ x: target.x, y: target.y, width, height })
    const b = w.getBounds()
    return { width: b.width, height: b.height }
  }
  try {
    out.attempts = 1
    const a1 = put(t.width, t.height)
    out.firstActual = a1
    if (a1.width === t.width && a1.height === t.height) { out.ok = true; return out }

    out.attempts = 2
    const dw = t.width - a1.width
    const dh = t.height - a1.height
    const a2 = put(t.width + dw, t.height + dh)
    out.requestedDelta = { width: dw, height: dh }
    out.calibratedActual = a2
    if (a2.width === t.width && a2.height === t.height) { out.ok = true; return out }

    // ③ 补偿无效 ⇒ 退回直接请求（读数不累积，只是带一个固定偏移），并如实记录
    out.attempts = 3
    out.requestedDelta = { width: 0, height: 0 }
    out.calibratedActual = put(t.width, t.height)
    log().warn('拖动尺寸映射标定失败（补偿后仍读不回目标）→ 退回直接请求目标尺寸', {
      target: `${t.width}x${t.height}`,
      firstActual: `${a1.width}x${a1.height}`,
      compensated: `${a2.width}x${a2.height}`,
    }, 'window.drag.size-calibration-failed')
    return out
  } catch (e) {
    log().warn('拖动尺寸映射标定异常 → 退回直接请求目标尺寸', {
      error: e instanceof Error ? e.message : String(e),
    }, 'window.drag.size-calibration-error')
    out.requestedDelta = { width: 0, height: 0 }
    return out
  }
}

/**
 * 开始拖动。**只移动，不改尺寸**：
 *   - 用 `setPosition(x, y)` 两参重载（不用 setBounds，避免任何尺寸漂移）；
 *   - 每次移动后断言 width/height 未变，变了立刻纠正并记警告（判据 A14）；
 *   - 用 `screen.getCursorScreenPoint()` 以 ~60Hz 自己推进（不依赖 renderer 的事件频率），
 *     并把**真实窗口位移**回报给 renderer 驱动摇晃叠加层（Mate 的 AvatarSwayController 同源）。
 */
export function beginDrag(startCursor: { x: number, y: number }, onTick?: (t: DragTick) => void): void {
  const w = win
  if (!w || w.isDestroyed()) return
  const b = w.getBounds()
  /**
   * ★ **尺寸在拖动开始时定死一次**。`startBounds` 与 `targetSize` 都从这里取值，
   *   之后整个拖动过程都不再读回来当目标（见 `dragSession.targetSize` 的注释）。
   *
   * ⚠ 这里**不再**做"先把窗口对齐到 DIP 栅格"那一步（2026-10-08 试过，**已撤销**）。
   *   实测（`docs/evidence/phase16/a11.json`）：在拖动开始时把 `482×762` 对齐成 `480×760`
   *   会让窗口的读回相位**翻到另一侧**（拖完停在 `482×763`），比不对齐**更差**。
   *   根因见 `sizeMap.json`：`482×762 DIP = 602.5×952.5 物理像素`（半像素），
   *   而"请求 480×760 → 读回 482×762"这条稳定映射**只在窗口本来就处于该相位时成立**。
   *   ⇒ 正确做法是**在窗口创建时**就让尺寸落在整物理像素上（见 `bootstrap.ts` 的启动栅格自愈），
   *     而不是在拖动开始时临时搬动它。
   */
  const frozen = { x: b.x, y: b.y, width: b.width, height: b.height }
  /**
   * ★ **顺序至关重要：先标定、再钉 min/max**（本轮实测踩到并修正）。
   *
   * 第一版把"钉 min/max"放在标定之前，结果标定**不可能收敛**：
   *   min 被设成 482 ⇒ 任何小于 482 的补偿请求都被夹回 482，
   *   于是"请求 482 → 读回 484"与"请求 480 → 读回 484"给出**同一个结果**，
   *   映射变成不可逆（A11 原始证据：`requestedDelta {0,0}`、`calibratedActual 484x763`、`ok:false`）。
   * 未钉 min/max 时（`sizeDiag` 第①组）映射是 **+2/+1 的仿射关系**（470→472、482→484、484→486），
   * 因此可以反解：请求 `target − (actual − target)` 就能读回 target。
   * 钉 min/max 时也钉在**请求值**上（`requestSize`），而不是目标值。
   */
  const calibration = calibrateDragSize(w, frozen)
  /**
   * 记录本屏的 DIP 栅格步长：拖动位置会量化到它的整数倍，
   * 从而保证物理像素坐标是整数（见 `dipGridStep`）。
   */
  let dragScaleFactor = 1
  try { dragScaleFactor = screen.getDisplayMatching(b).scaleFactor } catch { dragScaleFactor = 1 }
  dragGridStep = dipGridStep(dragScaleFactor)
  /**
   * ★ **请求尺寸也要对齐栅格**（本轮实测修正）。
   *
   * 只对齐"位置"是不够的：`targetSize` 是拖动开始时的**读回值**（本机 `482×761`），
   * 而 `761 = 4×190.25` 不在栅格上 ⇒ 请求 `480×761` 时高度仍是半个物理像素，
   * 窗口管理器取整会让高度在 761/762 之间跳（`dragRepeated50` 第 31 轮实测踩到）。
   * 对齐到 `480×760`（= 600×950 物理像素，整数）后，读回值才是稳定的 `482×761`。
   */
  const snapped = snapSizeToDipGrid(
    {
      width: calibration.target.width + calibration.requestedDelta.width,
      height: calibration.target.height + calibration.requestedDelta.height,
    },
    dragScaleFactor,
  )
  const requestDelta = {
    width: snapped.width - calibration.target.width,
    height: snapped.height - calibration.target.height,
  }
  calibration.requestedDelta = { ...requestDelta }
  calibration.requestSnapped = { ...snapped }
  const requestSize = { ...snapped }
  /**
   * ★ **以"对齐后的请求"为准再验证一次**，并据此重写 `calibration.ok`。
   *
   * 为什么必须重写（实测）：`calibrateDragSize()` 是在**未对齐的请求**（`482×761`，
   * 高度在栅格外）上测的，会给出 `ok:false`；而真正用于拖动的请求是对齐后的 `480×760`
   * —— 它对不对，只有用**它自己**测才算数。否则证据里会出现
   * "标定失败"和"拖动全程尺寸逐位不变"并排的矛盾读数。
   */
  try {
    w.setBounds({ x: frozen.x, y: frozen.y, width: requestSize.width, height: requestSize.height })
    const b2 = w.getBounds()
    calibration.snappedActual = { width: b2.width, height: b2.height }
    calibration.ok = b2.width === frozen.width && b2.height === frozen.height
  } catch { /* ignore */ }
  dragFixedSize = { width: requestSize.width, height: requestSize.height }
  /**
   * ★★ **钉 min/max 是 A14 的承重结构，不许拆**（2026-10-08 返工轮实测，留档防重犯）。
   *
   * 试过、**已撤销**的改动：把这一段删掉（理由是"拖动每帧都显式请求尺寸，不需要钉"）。
   * 结果：**A14 从 PASS 打成 FAIL** ——
   *   · 有钉：八次读数**全部** `482×761`、`distinct=1`、`driftMax=0`；
   *   · 无钉：`482×761` 与 `482×763` 混着出现、`distinct=2`、`driftMax=1`，
   *     且**两次运行的首个读数还不一样**（相位在漂）⇒ 连"可复现"都保不住。
   *
   * ⇒ 结论：窗口管理器的尺寸取整**需要**一对硬边界来约束；
   *   每帧显式请求尺寸（`dragTo` 的做法）**不足以**替代它。
   *
   * 已知代价（如实记录，见 `--probe sizeMap` 与 CHAT-WINDOW-ROUND.md §6）：
   *   钉成**一个点**会让"请求 → 读回"的可达集合平移 1 DIP，
   *   于是 `endDrag` 的迭代收敛可能够不到**拖动前那个读回值**（A11 的 1 DIP 漂移）。
   *   这是一个**取舍**：A14（拖动期间恒定）必须保住，A11 的"逐位还原"在该相位下不可得。
   */
  try {
    w.setMinimumSize(requestSize.width, requestSize.height)
    w.setMaximumSize(requestSize.width, requestSize.height)
  } catch { /* 个别平台/版本可能不支持 maximumSize，忽略 */ }
  dragSession = {
    startCursor,
    startWindow: { x: frozen.x, y: frozen.y },
    lastBounds: { ...frozen },
    targetSize: { width: frozen.width, height: frozen.height },
    requestSize,
    requestDelta,
    sizeCalibration: calibration,
    adaptiveAdjustments: 0,
    sizeCorrections: 0,
  }
  dragLastPos = { x: frozen.x, y: frozen.y }
  if (dragTimer) clearInterval(dragTimer)
  dragTimer = setInterval(() => {
    let pt: { x: number, y: number }
    try { pt = dragCursorSource() } catch { return }
    const r = dragTo(pt)
    if (!r || !onTick) return
    const dx = r.position.x - (dragLastPos?.x ?? r.position.x)
    const dy = r.position.y - (dragLastPos?.y ?? r.position.y)
    dragLastPos = { x: r.position.x, y: r.position.y }
    const b2 = windowBounds()
    onTick({ x: r.position.x, y: r.position.y, dx, dy, width: b2?.width ?? 0, height: b2?.height ?? 0 })
  }, 16)
  dragTimer.unref?.()
}

export interface DragStepResult {
  moved: boolean
  position: { x: number, y: number }
  sizeChanged: boolean
  /**
   * 本帧的**不可变目标尺寸**（拖动开始时定死）。
   * 探针用它断言"拖动全程尺寸不变"，比读窗口当前值更可信 ——
   * 后者是"系统给了什么"，前者是"我们要求什么"。
   */
  targetSize: { width: number, height: number }
  /** 本帧**实际请求**系统的尺寸（= `targetSize` + 标定补偿量） */
  requestSize: { width: number, height: number }
  /** 本帧**实际**读回的尺寸（正常情况下应与 `targetSize` 完全相等） */
  actualSize: { width: number, height: number }
  /** 本帧做了几次纠正（0 = 系统没有捣乱） */
  corrections: number
}

/**
 * **DIP 对齐栅格**：让 DIP 坐标落在"物理像素整数倍"上。
 *
 * 为什么需要（本轮实测）：本机 `scaleFactor = 1.25 = 5/4`，
 * 一个 DIP 不是整数个物理像素。拖动到 x=918 时物理 x = 1147.5（**半个像素**），
 * 窗口管理器于是把宽度按取整方向调整 —— A11 实测：同一标定下，
 * 起点读数 482×762 精确，移动到 x=918 后变成 **481**×762（宽差 1）。
 * 让 DIP 坐标取 4 的整数倍（4 × 1.25 = 5 物理像素，恰为整数）即可消除这个半像素项。
 *
 * 一般化：`s = p/q` 最简分数，取 `q` 作为栅格步长（1.25→4、1.5→2、1→1）。
 * 代价是拖动位置量化到 4 DIP（约 4 px），肉眼不可辨，且换来尺寸**一字不差**。
 */
function dipGridStep(scaleFactor: number): number {
  if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) return 1
  for (let q = 1; q <= 8; q++) {
    const p = scaleFactor * q
    if (Math.abs(p - Math.round(p)) < 1e-6) return q
  }
  return 1
}

let dragGridStep = 1

/** 拖动推进：由 renderer 每帧上报光标屏幕坐标后调用 */
export function dragTo(cursor: { x: number, y: number }): DragStepResult | null {
  const w = win
  if (!w || w.isDestroyed() || !dragSession) return null
  const s = dragSession
  const dx = cursor.x - s.startCursor.x
  const dy = cursor.y - s.startCursor.y
  /**
   * 位置**对齐到 DIP 栅格**（见 `dipGridStep` 的注释）：不对齐时半像素的物理位置
   * 会让窗口宽度被取整成 ±1 的另一个值，破坏"拖动期间尺寸一字不差"。
   */
  const g = dragGridStep > 1 ? dragGridStep : 1
  const nextX = g > 1 ? Math.round((s.startWindow.x + dx) / g) * g : Math.round(s.startWindow.x + dx)
  const nextY = g > 1 ? Math.round((s.startWindow.y + dy) / g) * g : Math.round(s.startWindow.y + dy)
  /**
   * ★ **每一步都以 `s.targetSize` 为目标**（拖动开始时定死的不可变值），
   *   但**请求值**用标定后的 `s.requestSize`（= target + 实测补偿量）。
   *
   * 实测（本轮 `sizeDiag`，两次独立运行，133 行原始 JSON 见证据目录）：
   *   · `setPosition` 每步都让尺寸**累积**漂移（485→487→488→490）；
   *   · `setBounds({x,y})` 只给位置时累积更快（+2/步，8 步到 506×777）；
   *   · `setBounds` **显式带上冻结尺寸**时读数**恒定不累积**（8 步全部 484×763）；
   *   · 但与请求值差一个固定量（请求 470→472、482→484），且**无法回收**
   *     （再请求更小的 470 依旧得到 472）—— 这是 125% 缩放下
   *     DIP↔物理像素换算的固有取整，不是本项目的逻辑错误。
   *   ⇒ 拖动用第三种写法，并用 `requestSize` 把那个固定偏移**实测补偿**掉。
   */
  const target = s.targetSize
  const request = s.requestSize
  w.setBounds({ x: nextX, y: nextY, width: request.width, height: request.height })
  let after = w.getBounds()
  let sizeChanged = false
  let corrections = 0

  /**
   * ⚠ 纠正**必须回到不可变目标**，不能回到 `before`。
   *
   * 原实现 `w.setBounds({ ..., width: before.width, height: before.height })`：
   * `before` 是**上一步的读回值**，它本身可能已经被改坏 ⇒ 纠正等于把坏值固化下来。
   * 现在只从 `request`（= 不可变目标 + 标定补偿）恢复，并且**最多纠正 3 次**
   * （避免与窗口管理器对拉成死循环）。
   */
  while ((after.width !== target.width || after.height !== target.height) && corrections < 3) {
    corrections++
    sizeChanged = true
    log().debug('拖拽中尺寸漂移 → 从不可变目标恢复', {
      target: `${target.width}x${target.height}`,
      requested: `${request.width}x${request.height}`,
      actual: `${after.width}x${after.height}`,
      attempt: corrections,
    }, 'window.drag.size-drift')
    w.setBounds({ x: after.x, y: after.y, width: request.width, height: request.height })
    after = w.getBounds()
  }
  if (after.width !== target.width || after.height !== target.height) {
    /**
     * ★ **自适应**：把这次实测到的偏差累加进后续帧的请求量。
     *
     * 为什么必须自适应（实测）：非整数 DPI 下"请求 → 读回"的常数项会**随窗口位置变化**
     * —— 起点标定出 `delta = (−2,−1)`，移动到另一个位置后同样的请求读回 482×**762**
     * （A11 实测：拖动中高度差 1px）。位置是每帧都在变的，所以固定的 delta 不够，
     * 必须在拖动过程中持续跟着修。上界 ±4 防止与窗口管理器对拉成振荡。
     */
    const dw = target.width - after.width
    const dh = target.height - after.height
    s.requestDelta = {
      width: clampDelta(s.requestDelta.width + dw, 4),
      height: clampDelta(s.requestDelta.height + dh, 4),
    }
    s.requestSize = { width: target.width + s.requestDelta.width, height: target.height + s.requestDelta.height }
    s.adaptiveAdjustments += 1
    // 如实记录：这一帧没能做到一字不差，以及我们下一次会怎么试
    log().warn('拖拽中尺寸与目标不一致 → 已按实测偏差调整后续请求', {
      target: `${target.width}x${target.height}`, actual: `${after.width}x${after.height}`,
      nextDelta: `${s.requestDelta.width},${s.requestDelta.height}`,
      adaptations: s.adaptiveAdjustments,
    }, 'window.drag.size-drift-adaptive')
  }

  s.sizeCorrections += corrections
  s.lastBounds = { x: after.x, y: after.y, width: after.width, height: after.height }
  return {
    moved: dx !== 0 || dy !== 0,
    position: { x: after.x, y: after.y },
    sizeChanged,
    targetSize: { width: target.width, height: target.height },
    requestSize: { width: request.width, height: request.height },
    actualSize: { width: after.width, height: after.height },
    corrections,
  }
}

export function endDrag(): {
  moved: boolean
  distance: number
  bounds: Rect | null
  /** 拖动开始时定死的目标尺寸（结束时用它对账） */
  targetSize: { width: number, height: number } | null
  /** 结束时的实际尺寸；与 `targetSize` 不等则说明**拖动真的改变了窗口尺寸**（应判失败） */
  actualSize: { width: number, height: number } | null
  /** 结束时做过的尺寸纠正次数（0 表示系统全程没捣乱） */
  sizeCorrections: number
  /** 结束前是否强制把尺寸拉回目标（有则说明中途被改过） */
  restoredOnEnd: boolean
  /**
   * 结束时的**尺寸收敛**结果：拖动过程中位置变化会让"请求→读回"的固定偏移
   * 跟着变（实测：起点标定出的偏移在移动后会差 1px），所以结束时必须
   * **在最终位置上重新迭代收敛**，否则每轮拖动都会留下 1~2px 的残留。
   */
  endSizeConvergence: {
    tries: number
    converged: boolean
    requestedDelta: { width: number, height: number }
    /** 解除 min/max 之后穷举过的 (dw,dh)=>读回值 组合（只在需要时才非空） */
    searchTried?: string[]
    /** 穷举次数 */
    searches?: number
    /**
     * 穷举**没命中**时的兜底：回退到"可达尺寸里最接近目标"的那一次。
     * 没有它，失败后窗口会停在最后一次尝试的尺寸（通常是 `+4`，即**被推大**）。见 `endDrag` 注释。
     */
    bestEffort?: { requested: string, actual: string, distDip: number }
  } | null
  /** 拖动开始时的**尺寸映射标定**结果（探针证据；`ok === false` 表示补偿没成功） */
  sizeCalibration: DragSizeCalibration | null
} {
  const w = win
  const s = dragSession
  dragSession = null
  if (dragTimer) { clearInterval(dragTimer); dragTimer = null }
  dragLastPos = null
  let restoredOnEnd = false
  let endSizeConvergence: {
    tries: number
    converged: boolean
    requestedDelta: { width: number, height: number }
    searchTried?: string[]
    searches?: number
    bestEffort?: { requested: string, actual: string, distDip: number }
  } | null = null

  /**
   * ★ 结束前**把尺寸收敛回 `targetSize`**，再解除 min/max 硬锁。
   *
   * 顺序很关键：必须先纠正尺寸、**再**解除 `setMaximumSize` ——
   * 反过来的话，解除瞬间窗口管理器可能按新自由度重排，纠正就白做了。
   *
   * 迭代式（而不是"请求一次"）：非整数 DPI 下"请求 → 读回"是一个**仿射映射**，
   * 且它的常数项会随位置变化。这里用 `request += target − actual` 逐步逼近，
   * 最多 4 次；收敛不了就**如实记录** `converged: false`，不假装成功。
   */
  if (w && !w.isDestroyed() && s) {
    const t = s.targetSize
    let delta = { ...s.requestDelta }
    let tries = 0
    let converged = false
    let cur = w.getBounds()
    while (tries < 4 && (cur.width !== t.width || cur.height !== t.height)) {
      tries++
      try {
        w.setBounds({ x: cur.x, y: cur.y, width: t.width + delta.width, height: t.height + delta.height })
      } catch { break }
      const a = w.getBounds()
      if (a.width === t.width && a.height === t.height) { converged = true; cur = a; break }
      delta = {
        width: clampDelta(delta.width + (t.width - a.width), 8),
        height: clampDelta(delta.height + (t.height - a.height), 8),
      }
      cur = a
    }
    if (tries > 0) {
      restoredOnEnd = true
      log().warn('拖动结束前尺寸与目标不一致 → 迭代收敛', {
        target: `${t.width}x${t.height}`,
        requested: `${t.width + delta.width}x${t.height + delta.height}`,
        actual: `${cur.width}x${cur.height}`,
        tries, converged,
      }, 'window.drag.size-restored-on-end')
    } else {
      converged = true
    }
    endSizeConvergence = {
      tries,
      converged,
      requestedDelta: { ...delta },
    }
  }

  // 解除硬锁并恢复该模式应有的 min/max
  if (dragFixedSize) {
    dragFixedSize = null
    if (w && !w.isDestroyed()) {
      try {
        if (currentMode === 'pet') {
          w.setMinimumSize(WINDOW_GEOMETRY.pet.width, WINDOW_GEOMETRY.pet.height)
        } else {
          w.setMinimumSize(WINDOW_GEOMETRY.panelMin.width, WINDOW_GEOMETRY.panelMin.height)
        }
        w.setMaximumSize(0, 0)   // 0,0 = 不限制
      } catch { /* ignore */ }
    }
    /**
     * 解除硬锁之后再核对一次：`setMaximumSize(0,0)` 本身也可能让窗口重排。
     *
     * ★ 这里改成**有限穷举 + 验证**（而不是"迭代逼近"）。
     *   为什么（`dragRepeated50` 实测）：50 次里有 1 次结束在 `482×763`（目标 762），
     *   而且**没有自我恢复** —— 迭代式收敛在"映射不可逆"的位置上会卡住
     *   （`sizeDiag` 已证：请求 480 与 482 都读回 484）。
     *   穷举一个小邻域（±4 DIP）并**逐个验证读回值**，就把"猜"变成了"找"：
     *   找到就精确命中，找不到就如实记 `converged: false` 与试过的组合。
     */
    if (w && !w.isDestroyed() && s && endSizeConvergence) {
      const t = s.targetSize
      let cur = w.getBounds()
      const tried: string[] = []
      if (cur.width !== t.width || cur.height !== t.height) {
        const seedW = endSizeConvergence.requestedDelta.width
        const seedH = endSizeConvergence.requestedDelta.height
        const deltas = (seed: number): number[] => [0, seed, -1, 1, -2, 2, -3, 3, -4, 4].filter((v, i, a) => a.indexOf(v) === i)
        const dws = deltas(seedW)
        const dhs = deltas(seedH)
        let attempts = 0
        /**
         * ★ **记下"最接近目标"的那次尝试**（本轮由浸泡 run4 抓出的真实缺陷）。
         *
         * 为什么必须有它：穷举失败时，原实现把窗口**留在最后一次尝试的尺寸**上 ——
         * 而最后试的往往是 `+4`，于是窗口在失败后**反而变大**。
         * run4 的实测后果：三次拖动把它从 `481×761` 一路推到 `486×773`
         * （日志 `window.drag.size-search-failed`：`target 485x768 → actual 486x773`）。
         * 现在失败也要收敛到**可达的最近值**，而不是随机落点。
         */
        let best: { dw: number, dh: number, w: number, h: number, dist: number } | null = null
        outer:
        for (const dw of dws) {
          for (const dh of dhs) {
            if (attempts >= 30) break outer
            attempts++
            try { w.setBounds({ x: cur.x, y: cur.y, width: t.width + dw, height: t.height + dh }) } catch { continue }
            const a = w.getBounds()
            tried.push(`${dw},${dh}=>${a.width}x${a.height}`)
            const dist = Math.abs(a.width - t.width) + Math.abs(a.height - t.height)
            if (!best || dist < best.dist) best = { dw, dh, w: a.width, h: a.height, dist }
            if (a.width === t.width && a.height === t.height) {
              cur = a
              endSizeConvergence.requestedDelta = { width: dw, height: dh }
              break outer
            }
          }
        }
        /**
         * 没命中 ⇒ **回到最接近的那次**（再 `setBounds` 一次）。
         * 这样失败时的后果是"差 1~2 DIP"，而不是"被推大 5×12 DIP"。
         */
        const fin0 = w.getBounds()
        if ((fin0.width !== t.width || fin0.height !== t.height) && best) {
          try {
            w.setBounds({ x: fin0.x, y: fin0.y, width: t.width + best.dw, height: t.height + best.dh })
            endSizeConvergence.requestedDelta = { width: best.dw, height: best.dh }
          } catch { /* ignore */ }
          endSizeConvergence.bestEffort = { requested: `${t.width + best.dw}x${t.height + best.dh}`, actual: `${best.w}x${best.h}`, distDip: best.dist }
        }
        endSizeConvergence.searchTried = tried
        endSizeConvergence.searches = attempts
      }
      const fin = w.getBounds()
      endSizeConvergence.tries = Math.max(endSizeConvergence.tries, endSizeConvergence.searches ?? 0)
      endSizeConvergence.converged = fin.width === t.width && fin.height === t.height
      if (!endSizeConvergence.converged) {
        log().warn('拖动结束后尺寸**未能**回到拖动前尺寸（已穷举 ±4 DIP，已回退到最接近值）', {
          target: `${t.width}x${t.height}`,
          actual: `${fin.width}x${fin.height}`,
          bestEffort: endSizeConvergence.bestEffort ? `${endSizeConvergence.bestEffort.actual}（差 ${endSizeConvergence.bestEffort.distDip} DIP）` : '(无)',
          tried: tried.slice(-8).join(' '),
        }, 'window.drag.size-search-failed')
      }
    }
  }
  if (!w || w.isDestroyed() || !s) {
    return {
      moved: false, distance: 0, bounds: windowBounds(),
      targetSize: null, actualSize: null, sizeCorrections: 0, restoredOnEnd,
      endSizeConvergence, sizeCalibration: null,
    }
  }
  const b = w.getBounds()
  const dx = b.x - s.startWindow.x
  const dy = b.y - s.startWindow.y
  return {
    moved: dx !== 0 || dy !== 0,
    distance: Math.round(Math.hypot(dx, dy)),
    bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
    targetSize: { ...s.targetSize },
    actualSize: { width: b.width, height: b.height },
    sizeCorrections: s.sizeCorrections,
    restoredOnEnd,
    endSizeConvergence,
    sizeCalibration: s.sizeCalibration,
  }
}

/** pet 模式按角色需要自动调整尺寸（拖拽中拒绝，避免违反"拖拽期间尺寸不变"） */
export function autoResize(width: number, height: number, anchor: 'top-left' | 'bottom-center'): { applied: boolean, reason?: string } {
  const w = win
  if (!w || w.isDestroyed()) return { applied: false, reason: 'no-window' }
  if (currentMode !== 'pet') return { applied: false, reason: 'not-pet' }
  if (dragSession) return { applied: false, reason: 'dragging' }
  /**
   * ⚠ 这里曾经有一条 `reason:'conversation-layout'` 的拒绝分支，用来保护"对话态尺寸"。
   *   返工轮**删掉了它**：pet 窗口现在恒为 340×420，不存在"另一个东西改过尺寸"的可能；
   *   留一个永远不会命中的分支只会让人以为还存在对话布局。
   */
  const b = w.getBounds()
  if (b.width === width && b.height === height) return { applied: false, reason: 'unchanged' }
  const x = anchor === 'bottom-center' ? Math.round(b.x + (b.width - width) / 2) : b.x
  const y = anchor === 'bottom-center' ? Math.round(b.y + (b.height - height)) : b.y
  w.setBounds({ x, y, width, height })
  return { applied: true }
}

export function currentPreloadPath(): string {
  return join(appPaths().workspaceRoot, 'apps', 'desktop', 'dist', 'preload', 'index.mjs')
}
