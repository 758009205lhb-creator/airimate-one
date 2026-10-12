/**
 * apps/desktop/src/main/chat-window.ts —— **独立对话窗口**（2026-10-08 返工轮新增）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 这个文件存在的**唯一原因**，是本轮返工的根因修正，必须留档：
 *
 *   上一轮把「对话框」做成了 pet 窗口**内部贴底的 dock**（`ConversationDock.vue`），
 *   并把 pet 窗口从 `340×420` 放大到 `380×560`（`WINDOW_GEOMETRY.conversation`
 *   + `enterConversationLayout()`）来腾地方。
 *   根因不是"实现方偷懒"：上一版规格写了「应用只创建一个 BrowserWindow /
 *   可见窗口数 = 1」的硬约束，于是实现方**只能**把聊天塞进桌宠窗口。
 *
 *   用户明确否决这个形态：**聊天对话框与桌宠必须是两个完全独立的窗口，
 *   不能被塞在同一个面板里**。该硬约束在本次被显式修改为三条新口径：
 *     ① 角色可见窗口数 = 1（只有 pet 窗口渲染角色）；
 *     ② chat 窗口内 WebGL canvas 数 = 0（Scene/Renderer/Mixer/VRM 计数全 0）；
 *     ③ 全应用 WebGLRenderer 总数恒为 1，只存在于 pet 窗口。
 *   Chromium 渲染进程数变成 2 是**允许**的（Electron 每个窗口一个 renderer）。
 *
 * 参考实现（照抄交互，不照抄美术）：`DataAxeagle/DockPetWin-Aemeath`
 *   · 聊天是独立的 `AgentChatWindow`（XAML `Width=720 Height=560 MinWidth=560 MinHeight=420`，
 *     `WindowStartupLocation="CenterOwner"`，带系统标题栏 ⇒ 天然可拖动可缩放）；
 *   · 入口在托盘菜单与桌宠右键菜单，**绝不是**把聊天塞进桌宠窗口；
 *   · 单例：`if (agentChatWindow is { IsVisible: true }) { Activate(); return; }`；
 *   · 桌宠气泡里带「看完整对话」按钮，点了就 Activate 聊天窗口。
 * ════════════════════════════════════════════════════════════════════════════
 *
 * 本文件的纪律：
 *   ① 这是**第二个也是最后一个** `new BrowserWindow()` 调用点（第三个窗口是禁止项）；
 *   ② pet 窗口的创建逻辑**一行都不动**（`window-manager.ts` 的 `createMainWindow`）；
 *   ③ 首次打开在**鼠标所在显示器的工作区居中**（`screen.getCursorScreenPoint()` →
 *      `getDisplayNearestPoint().workArea`），**不是**"居中于桌宠窗口"，也不是右下角；
 *   ④ 关闭（× / Esc / 托盘「结束对话」）= `hide()`，不销毁、不退出应用；
 *      再次打开复用**同一个**窗口对象（`BrowserWindow.id` 不变）。
 */
import { BrowserWindow, screen } from 'electron'
import type { Rect } from '@airimate/shared'
import { WINDOW_GEOMETRY } from '@airimate/shared'
import { log } from './log.js'
import { applyWindowSecurity } from './window-security.js'
import { loadSettings, mergeSettings, flushSettings } from './settings-store.js'
import { getPersona } from './session-store.js'

/**
 * ★★ 对话窗口标题：「和 {角色名} 聊天」（2026-10-09 完善轮，对齐参考实现
 *    `DockPetWin` 的 `Title="和爱弥斯聊天"`）。
 *
 * ⚠ 为什么标题必须由**主进程**给，而不是等 renderer 用 `document.title` 设置：
 *   `frame:true` 之后标题栏是**系统画的**，它读的是 `BrowserWindow` 的标题；
 *   而窗口从创建到 renderer 挂载完有一段空窗期 —— 那段时间标题栏会显示
 *   一个临时名字（最坏是文件路径）。主进程在这里同步取一次人设名，
 *   标题栏**从第一帧起就是对的**。
 *
 * ⚠ 人设名取不到时回落到 `她`（与界面里的 `ChatWindow.vue` 同一口径）：
 *   宁可显示"和她聊天"，也不要显示"和 null 聊天"或空标题。
 */
export function chatWindowTitle(): string {
  let name = ''
  try { name = (getPersona().name ?? '').trim() } catch { name = '' }
  return `和 ${name || '她'} 聊天`
}

export interface ChatWindowOptions {
  preloadPath: string
  /** 开发模式：renderer 由 Vite dev server 提供 */
  devServerUrl: string | null
  /** 记忆的几何（`null` = 从未打开过 ⇒ 首次打开居中） */
  rememberedBounds: Rect | null
  alwaysOnTop: boolean
  /** 帧率上限透传（与 pet 窗口同一套 `?fpsCap=` 约定） */
  fpsCap?: number | null
}

let chatWin: BrowserWindow | null = null
/** 本会话内**真正创建**过几次（判据：`openCount ≥ 2 ⇒ createdCount === 1`） */
let createdCount = 0
let readyToShow = false
/**
 * ★★ **每个窗口对象的几何来源**（`WeakMap` 而不是模块级变量 —— 2026-10-09 实测修正）。
 *
 * 踩到的形态（首轮 `chatwindow.json`）：窗口在启动时按**记忆几何**创建
 * （`boundsSource = 'remembered'`），探针把它收起来、清掉记忆、再打开 ——
 * 而 `ensureChatWindow()` 因为**窗口对象已存在**直接 return，模块级的
 * `boundsSource` 就**停在上一次的值**上。于是"这次是居中打开"的读数根本没被采，
 * `center.*` 一整组判据变成"读不到"（看起来像居中坏了）。
 *
 * ⚠ 这类"模块级状态与它所描述的对象生命周期不一致"的缺陷，表现永远是
 *   "某条读数在某些路径下为空"，而**归因方向完全相反**（会去查居中算法）。
 *   挂在窗口对象上（WeakMap）之后，"窗口换了 ⇒ 状态跟着换"是**结构性成立**的。
 */
const boundsSourceByWin = new WeakMap<BrowserWindow, 'remembered' | 'centered' | 'default'>()
/** 本次打开时"居中目标"的原始读数（探针据此算居中的误差，是**实测值**不是推算值） */
let lastCenterReading: CenterReading | null = null
/**
 * ★ **实际请求给 `BrowserWindow` 的矩形**（2026-10-09 完善轮新增）。
 *
 * 为什么必须记它：`frame:true` 之后"请求值 ≠ 外框目标"（要减掉系统装饰），
 * 而判据 C5 写的是"尺寸 720×560" —— 那指的是**外框**。
 * 不记请求值的话，读到一个偏小的 `getBounds()` 时无法判断
 * "是我们请求错了"还是"系统没按请求落点"（两种病因，处置完全不同）。
 */
let lastRequestedBounds: Rect | null = null
/** 本次做的尺寸校正（装饰量 + 校正前的目标），进诊断让"校没校正"可机械复核 */
let lastSizeCorrection: { decor: { width: number, height: number }, from: { width: number, height: number } } | null = null

export interface CenterReading {
  /** 我们请求的窗口左上角 */
  requested: Rect
  /** 请求后从窗口读回的实际矩形 */
  actual: Rect
  /** 鼠标所在显示器的 workArea */
  workArea: Rect
  /** 鼠标屏幕坐标 */
  cursor: { x: number, y: number }
  /** workArea 中心 */
  workAreaCenter: { x: number, y: number }
  /** 实际窗口中心（读回值算出来的） */
  actualCenter: { x: number, y: number }
  /** 中心误差（DIP，取两轴各自绝对差的最大值 —— 判定用这一个数） */
  centerErrorDip: number
}

export function chatWindow(): BrowserWindow | null {
  return chatWin && !chatWin.isDestroyed() ? chatWin : null
}

export function chatWindowId(): number | null {
  const w = chatWindow()
  return w ? w.id : null
}

export function chatCreatedCount(): number {
  return createdCount
}

export function chatReadyToShow(): boolean {
  return readyToShow
}

export function chatBoundsSource(): 'remembered' | 'centered' | 'default' | null {
  const w = chatWindow()
  return w ? (boundsSourceByWin.get(w) ?? null) : null
}

export function lastChatCenterReading(): CenterReading | null {
  return lastCenterReading ? { ...lastCenterReading } : null
}

/** 鼠标所在显示器的工作区（**居中基准**；取不到时退回主显示器） */
function cursorWorkArea(): { workArea: Rect, cursor: { x: number, y: number } } {
  try {
    const cursor = screen.getCursorScreenPoint()
    const wa = screen.getDisplayNearestPoint(cursor).workArea
    return { workArea: { x: wa.x, y: wa.y, width: wa.width, height: wa.height }, cursor }
  } catch {
    const wa = screen.getPrimaryDisplay().workArea
    return {
      workArea: { x: wa.x, y: wa.y, width: wa.width, height: wa.height },
      cursor: { x: wa.x + Math.round(wa.width / 2), y: wa.y + Math.round(wa.height / 2) },
    }
  }
}

/**
 * 判定一个记忆矩形**是否还在任何显示器的可见区内**。
 *
 * 为什么不能只判"左上角在不在屏内"（实测类的坑）：窗口被拖到屏幕右侧外面时，
 * 左上角仍在屏内，但整个窗口只有左边 5px 露着 —— 用户看到的是"窗口消失了"。
 * 所以要求**交集面积达到窗口的 40%**，并且标题栏那一条必须有足够横向重叠
 * （否则拖不动：`-webkit-app-region: drag` 那一块在屏幕外就点不到）。
 */
export function boundsUsableOnSomeDisplay(b: Rect): boolean {
  let displays: Electron.Display[] = []
  try { displays = screen.getAllDisplays() } catch { return true }
  if (!displays.length) return true
  const area = Math.max(1, b.width * b.height)
  for (const d of displays) {
    const wa = d.workArea
    const ix = Math.max(0, Math.min(b.x + b.width, wa.x + wa.width) - Math.max(b.x, wa.x))
    const iy = Math.max(0, Math.min(b.y + b.height, wa.y + wa.height) - Math.max(b.y, wa.y))
    const inter = ix * iy
    if (inter / area < 0.4) continue
    /** 标题栏条带（窗口顶部 40px）的横向可见宽度必须 ≥ 120px，否则拖不动 */
    const ty0 = b.y
    const ty1 = b.y + 40
    const oy = Math.max(0, Math.min(ty1, wa.y + wa.height) - Math.max(ty0, wa.y))
    if (oy <= 0) continue
    if (ix >= 120) return true
  }
  return false
}

/** 居中矩形（按给定尺寸在 workArea 内居中；尺寸大于工作区时收夹） */
function centeredRect(size: { width: number, height: number }, wa: Rect): Rect {
  const width = Math.min(size.width, Math.max(WINDOW_GEOMETRY.chatMin.width, wa.width))
  const height = Math.min(size.height, Math.max(WINDOW_GEOMETRY.chatMin.height, wa.height))
  return {
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: Math.round(wa.y + (wa.height - height) / 2),
    width,
    height,
  }
}

/**
 * ★★ **系统窗口装饰的尺寸**（`frame:true` 时 Electron 的 `width/height` 含它）。
 *
 * 为什么需要（实测，不是理论）：Electron 的 `width` / `height` 指的是
 * **包含系统边框与标题栏的整体尺寸**，而 `frame:false` 时那些装饰是 0 ——
 * 所以上一版"请求 720×560 就得到 720×560"的读数在本轮**不再成立**：
 * 首轮探针实测 `getBounds() = 740×579`（系统边框让外框比"内容区"宽 20 / 高 19）。
 *
 * 参考实现的 `AgentChatWindow.xaml` 写的是 `Width=720 Height=560`，
 * 在 WPF 里那是**窗口外框**。⇒ 我们也要让**外框**落在 720×560，
 * 所以请求值必须减掉装饰量。
 *
 * ⚠ **为什么用一个常量而不是"临时建个窗口量一下"**（这条路我试过，**已撤销**）：
 *   为了量装饰量需要建一个不可见的探针窗口 ⇒ 应用会**短暂出现第三个 BrowserWindow**，
 *   而本轮硬约束是"全应用恰好两个"。窗口计数探针只要在那个瞬间采样就会判失败 ——
 *   用一个只在测量期存在的窗口去换一个常量，代价远大于收益。
 *   （实测装饰量正好是 `20 × 19`，与 Windows 11 在 125% 缩放下的
 *    `2×(8×1.25) = 20` 边框 + `~15×1.25 ≈ 19` 标题栏吻合。）
 *
 * ⚠ 判定要用**容差**：不同 Windows 版本/主题的标题栏高度会差几像素。
 *   探针判"读回外框与 720×560 的偏差 ≤ 16 DIP"，并**把请求值原样记进证据**，
 *   所以真出现大偏差时读数会直接指出来（而不是被一个恒真断言盖住）。
 */
const FRAME_DECORATION = { width: 20, height: 19 } as const

/**
 * 由"想要的**外框**尺寸"算出"该请求的尺寸"。
 *
 * ⚠ 下限是 `chatMin`：校正后若比最小尺寸还小，`setMinimumSize` 会把它夹回去，
 *   于是"请求值"与"实际请求值"不一致 —— 那种不一致必须在读数里看得见
 *   （所以诊断里同时记 `requested` 与 `sizeCorrection`）。
 */
function requestSizeFor(target: { width: number, height: number }): {
  width: number, height: number, decor: { width: number, height: number }
} {
  return {
    width: Math.max(WINDOW_GEOMETRY.chatMin.width, target.width - FRAME_DECORATION.width),
    height: Math.max(WINDOW_GEOMETRY.chatMin.height, target.height - FRAME_DECORATION.height),
    decor: { ...FRAME_DECORATION },
  }
}

/** 位置/尺寸记忆（**只在窗口静止后写一次**，避免拖拽期间高频写盘） */
let rememberTimer: NodeJS.Timeout | null = null

function rememberBounds(): void {
  const w = chatWindow()
  if (!w) return
  /** 最大化 / 最小化时的 `getBounds()` 不是用户的"正常几何"，记下来会让下次打开怪怪的 */
  if (w.isMinimized() || w.isMaximized() || w.isFullScreen()) return
  const b = w.getBounds()
  /**
   * ★★ **存的是"外框"读回值**（2026-10-09 完善轮修正，实测踩到一个会放大窗口的环）。
   *
   * 踩到的形态：首轮 `chatwindow.json` 里 `sizeCorrection.from = 733×572`，
   * 而外框读回是 `720×559` —— 那个 733×572 是**补装饰之前的外框目标**。
   * 一旦把它存进记忆，下次启动就按 733×572 当外框目标 ⇒ 外框读回变大
   * ⇒ 再存一次又变大 ⇒ **每开一次窗口就长大一圈**（约 13 DIP/次），
   * 而现象是"窗口位置和大小记不住"。
   *
   * ⚠ 这个环**在 `frame:false` 时代不存在**（那时目标值就是外框值，两者恒等）；
   *   是 `frame:true` 把"目标"与"外框"分开之后才出现的 ——
   *   这正是"改窗口框架必须连带检查所有几何读写"的一个实例。
   *
   * ⇒ 这里必须存 `getBounds()` 的读回值（**外框**，与用户看到的一致），
   *   而"外框 → 请求值"的换算在 `requestSizeFor()` 里做一次就够。
   */
  mergeSettings({ chatWindowBounds: { x: b.x, y: b.y, width: b.width, height: b.height } })
}

function scheduleRemember(): void {
  if (rememberTimer) clearTimeout(rememberTimer)
  rememberTimer = setTimeout(() => { rememberTimer = null; rememberBounds() }, 500)
  rememberTimer.unref?.()
}

/**
 * 创建（或返回已存在的）对话窗口。
 *
 * ⚠ **不在这里 show**：创建后等 `ready-to-show`，由调用方决定何时显示 ——
 *   这与 pet 窗口的做法一致（避免"白屏一闪"）。
 */
function ensureChatWindow(o: ChatWindowOptions): BrowserWindow {
  const existing = chatWindow()
  if (existing) return existing

  /**
   * 几何决策顺序（**必须**是这个顺序，判据依赖它）：
   *   ① 记忆矩形还在可见区内 ⇒ 用记忆（`boundsSource='remembered'`）；
   *   ② 否则（从未打开过 / 记忆矩形跑到屏幕外）⇒ 在鼠标所在显示器 workArea **居中**
   *      （`boundsSource='centered'`）。
   * 注意 ② 同时覆盖了"首次打开"和"记忆失效回落居中"两种情形 ——
   * 它们的行为**必须相同**，所以不写两个分支。
   *
   * ⚠ **记忆值在创建时从设置里现读**，不用 `o.rememberedBounds`（2026-10-08 实测踩到）：
   *   `ChatWindowOptions` 是 bootstrap 在启动时快照的，进程内后续对设置的修改
   *   （设置面板、探针清场、`chatWindowBounds` 变成 null）**它看不到** ⇒
   *   "首次打开应该居中"会被一个过期的记忆值顶掉，而现象是"居中判据失败"，
   *   完全指不到真正的原因（配置快照过期）。`o.rememberedBounds` 保留为**兜底**
   *   （设置读不出来时用它），并在日志里记下实际用了哪个来源。
   */
  const liveRemembered = (() => {
    try { return loadSettings().chatWindowBounds } catch { return o.rememberedBounds }
  })()
  const remembered = liveRemembered
  const alwaysOnTop = (() => {
    try { return loadSettings().chatWindowAlwaysOnTop } catch { return o.alwaysOnTop }
  })()
  /**
   * ★★ **记忆矩形的尺寸口径**（2026-10-09 完善轮）。
   *
   * `settings.chatWindowBounds` 存的是**外框**（用户看到的那个框，见 `rememberBounds()`），
   * 而 `BrowserWindow` 的 `width/height` 也是外框 ⇒ 记忆值可以直接当 `target`，
   * 下面 `requestSizeFor()` 会统一做"外框 → 请求值"的换算。
   * ⚠ 不要再在这里减一次装饰量：那会造成"读到 720 → 存 720 → 下次开成 707"的缩水环。
   */
  let target: Rect
  /** 本次几何决策的来源（**局部变量** ⇒ 一定与本次创建同步，见 `boundsSourceByWin` 的注释） */
  let source: 'remembered' | 'centered' = 'centered'
  if (remembered && boundsUsableOnSomeDisplay(remembered)) {
    target = { ...remembered }
    source = 'remembered'
  } else {
    const { workArea } = cursorWorkArea()
    target = centeredRect(WINDOW_GEOMETRY.chat, workArea)
    source = 'centered'
  }

  createdCount += 1
  readyToShow = false

  /**
   * ★ **请求值换算**（见 `requestSizeFor` 的注释）：外框目标 720×560
   *   ⇒ 请求 `700×541`（减掉系统装饰），外框读回才是 720×560。
   */
  const reqSize = requestSizeFor({ width: target.width, height: target.height })
  /** 居中的落点也要按**请求尺寸**重算，否则校正后会整体偏右下 */
  const reqTarget: Rect = source === 'centered'
    ? (() => {
      const { workArea } = cursorWorkArea()
      return {
        x: Math.round(workArea.x + (workArea.width - reqSize.width) / 2),
        y: Math.round(workArea.y + (workArea.height - reqSize.height) / 2),
        width: reqSize.width,
        height: reqSize.height,
      }
    })()
    : { x: target.x, y: target.y, width: reqSize.width, height: reqSize.height }
  lastRequestedBounds = { ...reqTarget }
  lastSizeCorrection = { decor: reqSize.decor, from: { width: target.width, height: target.height } }

  const w = new BrowserWindow({
    ...reqTarget,
    show: false,
    title: chatWindowTitle(),
    /**
     * ★★ **系统原生窗口框架**（2026-10-09 完善轮；这是本轮对齐参考实现的**第一件事**）。
     *
     * 参考实现 `DockPetWin/AgentChatWindow.xaml` **没有设置 `WindowStyle`**
     * ⇒ 用的是 WPF 默认的 `SingleBorderWindow` = 系统原生边框。
     * 原生边框一次性带来这些能力，而且**每一条都是系统实现的**：
     *   · 拖动（无需 `-webkit-app-region`）；
     *   · 缩放（四边 + 四角）；
     *   · 最小化 / 最大化 / 还原；
     *   · 任务栏项与系统菜单（左上角图标右键：移动/大小/最小化/关闭）；
     *   · 双击标题栏最大化、Win+方向键贴边等系统手势。
     *
     * ⚠ 上一版是 `frame:false` + 自绘标题栏，理由写在旧注释里（"不必在无边框与
     *   可用性之间做取舍"）—— 那个取舍本身就是错的：自绘标题栏**复刻不出**
     *   系统菜单、贴边手势与任务栏分组，而用户这一轮明确要求对齐参考实现。
     *   ⇒ `frame:false` 的整条路径（自绘标题栏 + 最小化按钮 + 关闭按钮）
     *     在 `ChatWindow.vue` 里被删除，改为**窗口内的一行信息头**（原生框架之上）。
     */
    frame: true,
    /** **普通不透明窗口**：不需要透明合成，也就不需要命中区域上报 */
    transparent: false,
    backgroundColor: '#12141c',
    hasShadow: true,
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: false,
    /** 要能在任务栏找到它（与 pet 窗口相反 —— pet 故意 skipTaskbar） */
    skipTaskbar: false,
    alwaysOnTop,
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
      webviewTag: false,
      enableBlinkFeatures: '',
    },
  })

  /**
   * ⚠ 隐藏 Electron 的**应用菜单栏**（File/Edit/View…），但**保留系统边框**。
   *
   * 两者是**两件事**，很容易混：
   *   · `frame: true`        —— 系统标题栏与边框（本轮要的，**要**）；
   *   · `autoHideMenuBar`    —— Electron 在客户区顶部插的那条菜单（本轮**不要**；
   *     我们有自己的深色菜单栏，见 `ChatWindow.vue` 的 `.chatw__menubar`）。
   *
   * `autoHideMenuBar:true` 单独用是不够的：用户按一下 `Alt` 它就会冒出来，
   * 与本应用的深色 UI 叠在一起。`setMenuBarVisibility(false)` 让 `Alt` 也不再唤出它。
   * ⇒ 客户区就只有我们自己的那一行菜单，标题栏是系统的（"文件/桌宠/…"不会出现两次）。
   */
  w.setMenuBarVisibility(false)

  w.setMinimumSize(WINDOW_GEOMETRY.chatMin.width, WINDOW_GEOMETRY.chatMin.height)

  /**
   * 安全策略：**与 pet 窗口同一份实现**（`applyWindowSecurity`）。
   * 这里刻意不"简化"——第二个窗口最容易变成安全后门
   * （少一条导航拦截、少一次权限拒绝都不会有任何界面表现）。
   */
  applyWindowSecurity(w, { devServerUrl: o.devServerUrl })

  /**
   * 关闭语义：**hide，不销毁、不退出应用**。
   * 与 pet 窗口一样用 `preventDefault()`（而不是 `setQuitOnClose(false)`）——
   * 前者让"关掉对话窗口"这件事在日志里留下痕迹，后者是完全静默的。
   */
  w.on('close', (e) => {
    e.preventDefault()
    rememberBounds()
    w.hide()
    log().info('对话窗口关闭按钮 → 隐藏（未销毁，桌宠继续活动）', {}, 'chat.close.hide')
  })
  w.on('moved', scheduleRemember)
  w.on('resized', scheduleRemember)
  w.on('closed', () => { chatWin = null })

  const q = o.fpsCap && o.fpsCap > 0 ? `&fpsCap=${Math.round(o.fpsCap)}` : ''
  const url = o.devServerUrl
    ? `${o.devServerUrl}/index.html?surface=chat${q}`
    : `app://bundle/index.html?surface=chat${q}`
  void w.loadURL(url).catch((e: unknown) => {
    log().error('对话窗口页面加载失败', { url: url.slice(0, 120), err: e instanceof Error ? e.message : String(e) }, 'chat.load.failed')
  })

  w.once('ready-to-show', () => { readyToShow = true })

  chatWin = w
  /** ★ 把本次几何来源挂到**这个窗口对象**上（窗口销毁重建时状态自然跟着换，见 WeakMap 注释） */
  boundsSourceByWin.set(w, source)
  log().info('独立对话窗口已创建', {
    bounds: `${target.x},${target.y} ${target.width}x${target.height}`,
    requested: `${reqTarget.x},${reqTarget.y} ${reqTarget.width}x${reqTarget.height}`,
    boundsSource: source,
    alwaysOnTop,
    createdCount,
  }, 'chat.created')
  return w
}

/**
 * 显示并聚焦对话窗口（**五个入口共用的唯一实现**）。
 *
 * 单例语义（对齐参考实现 `if (agentChatWindow is { IsVisible: true }) { Activate(); return; }`）：
 *   · 窗口已存在 ⇒ **不新建**，直接 show/restore + focus；
 *   · 已经可见时再调一次 ⇒ **仍然只是聚焦，绝不隐藏**（"再次触发只聚焦"是本轮定稿的语义，
 *     见 Acceptance-Matrix 的入口判据；隐藏只走 close）。
 */
export function showChatWindow(o: ChatWindowOptions): { win: BrowserWindow, created: boolean, center: CenterReading | null } {
  const before = chatWindowId()
  const w = ensureChatWindow(o)
  const created = before === null

  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
  /**
   * 居中读数的采集条件（2026-10-09 口径放宽，必须留档）：
   *
   * 旧条件：`boundsSource === 'centered' && created`（"**首次创建**且居中"）。
   * 它现在**不再够用**：本轮默认启动就把对话窗口建好了（`startupOpenChat` 默认 true），
   * 探针/用户把它收起来再打开时 `created === false` ⇒ 居中读数为空 ⇒
   * `center.*` 一整组判据变成"读不到"（看起来像居中坏了，其实读数根本没采）。
   *
   * 新条件：**只要这个窗口是"居中创建"的就采一次**。语义上这才是对的 ——
   * 判据要回答的问题是"窗口**被居中放下去**了吗"，与"是不是本次调用创建的"无关。
   * ⚠ 来源从**窗口对象**上读（`boundsSourceByWin`），不是模块级变量：
   *   窗口对象可能是**上一次**（启动时）创建的，模块级变量在那条路径上会过期。
   * 用记忆矩形打开时仍然不打扰（那本来就不该有居中读数）。
   */
  if (boundsSourceByWin.get(w) === 'centered') {
    const b = w.getBounds()
    const { workArea, cursor } = cursorWorkArea()
    const actualCenter = { x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2) }
    const workAreaCenter = { x: workArea.x + Math.round(workArea.width / 2), y: workArea.y + Math.round(workArea.height / 2) }
    lastCenterReading = {
      /**
       * ⚠ 这里给的是**实际请求给 BrowserWindow 的那个矩形**（已减掉系统装饰），
       *   而不是"外框目标 720×560"。两者都要能读到：
       *   `requested` = 请求值（判定"我们请求对了没有"），
       *   `actual`    = 读回值（判定"系统把它放在哪、多大"）。
       *   外框目标本身在 `WINDOW_GEOMETRY.chat` 里，是常量。
       */
      requested: lastRequestedBounds ?? centeredRect(WINDOW_GEOMETRY.chat, workArea),
      actual: { x: b.x, y: b.y, width: b.width, height: b.height },
      workArea,
      cursor,
      workAreaCenter,
      actualCenter,
      /**
       * ⚠ 误差取"读回值算出的窗口中心"与"workArea 中心"的最大轴向差。
       *   为什么不用请求值：非整数 DPI 下 `setBounds` 的读回值会差 1–2 DIP
       *   （`sizeDiag` 已实测），用请求值会**掩盖**真实的落点偏差。
       *   反过来也不能只看读回值 —— 所以两个都记进 `requested` / `actual`，判定用 `actual`。
       */
      centerErrorDip: Math.max(
        Math.abs(actualCenter.x - workAreaCenter.x),
        Math.abs(actualCenter.y - workAreaCenter.y),
      ),
    }
    log().info('对话窗口首次打开：已在鼠标所在显示器工作区居中', {
      workArea: `${workArea.x},${workArea.y} ${workArea.width}x${workArea.height}`,
      actual: `${b.x},${b.y} ${b.width}x${b.height}`,
      centerErrorDip: lastCenterReading.centerErrorDip,
    }, 'chat.center')
  } else if (boundsSourceByWin.get(w) === 'remembered') {
    log().info('对话窗口打开：使用记忆的几何', {
      bounds: `${w.getBounds().x},${w.getBounds().y} ${w.getBounds().width}x${w.getBounds().height}`,
      created,
    }, 'chat.restore-bounds')
  }

  log().info('对话窗口已显示并聚焦', { created, windowId: w.id }, 'chat.shown')
  /**
   * ★ 打开成功后**立刻把设置落盘**（2026-10-09 完善轮）。
   *
   * 为什么：打开对话窗口会写两个设置（首次的居中几何 / `chatWindowBounds`）。
   * `mergeSettings` 默认 800ms 防抖 —— 如果用户在这 800ms 内直接关掉应用
   * （或者应用被强杀），那次几何记忆就丢了，而现象是"位置没记住"。
   * 这里的 flush 很便宜（一次小 JSON 原子写），且只发生在**打开**时。
   */
  try { flushSettings() } catch { /* 落盘失败不影响本次打开 */ }
  return { win: w, created, center: lastCenterReading }
}

/** 隐藏对话窗口（**不销毁**；pet 窗口完全不受影响） */
export function hideChatWindow(reason: string): { hidden: boolean, windowId: number | null } {
  const w = chatWindow()
  if (!w) return { hidden: false, windowId: null }
  rememberBounds()
  const wasVisible = w.isVisible()
  w.hide()
  log().info('对话窗口已隐藏（桌宠继续活动）', { reason, wasVisible, windowId: w.id }, 'chat.hidden')
  return { hidden: wasVisible, windowId: w.id }
}

/** 设置变更后应用（目前只有置顶） */
export function applyChatWindowSettings(): void {
  const w = chatWindow()
  if (!w) return
  const s = loadSettings()
  w.setAlwaysOnTop(s.chatWindowAlwaysOnTop)
}

/**
 * ★ 人设改名后同步**系统标题栏**的标题（2026-10-09 完善轮）。
 *
 * 为什么需要它：`frame:true` 之后标题是**系统画出来的**，它不会跟着 renderer 的
 * `document.title` 走（除非调用 `setTitle()`）。用户改了角色名却看到旧名字，
 * 是最容易被当成"改名没保存"的那种表现。
 * 无窗口时是空操作（还没打开对话窗口 ⇒ 下次创建时 `chatWindowTitle()` 会取新名字）。
 */
export function applyChatWindowTitle(): string {
  const t = chatWindowTitle()
  const w = chatWindow()
  if (w && !w.isDestroyed()) {
    try { w.setTitle(t) } catch { /* 标题设置失败不影响功能 */ }
  }
  return t
}

/** 只读诊断（探针读数；**不含任何内容**） */
export function chatWindowDiagnostics(): {
  id: number | null
  title: string | null
  visible: boolean
  focused: boolean
  minimized: boolean
  bounds: Rect | null
  alwaysOnTop: boolean
  createdCount: number
  readyToShow: boolean
  boundsSource: 'remembered' | 'centered' | 'default' | null
  workArea: Rect | null
  center: CenterReading | null
  /** ★ 实际请求的矩形（外框目标减掉系统装饰后的值；2026-10-09 新增） */
  requestedBounds: Rect | null
  /** ★ 本次做的尺寸校正（装饰量 + 校正前的目标）（2026-10-09 新增） */
  sizeCorrection: typeof lastSizeCorrection
} {
  const w = chatWindow()
  let workArea: Rect | null = null
  try {
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    workArea = { x: wa.x, y: wa.y, width: wa.width, height: wa.height }
  } catch { workArea = null }
  return {
    id: w ? w.id : null,
    /**
     * ★ **系统标题栏读到的标题**（2026-10-09 完善轮）。
     *   `frame:true` 之后它是"用户在标题栏上看到的那一行字"的唯一可信读数 ——
     *   renderer 的 `document.title` 与它**不是同一件事**
     *   （前者要显式 `setTitle()` 才会同步过去）。
     */
    title: w ? w.getTitle() : null,
    visible: w ? w.isVisible() : false,
    focused: w ? w.isFocused() : false,
    minimized: w ? w.isMinimized() : false,
    bounds: w ? (() => { const b = w.getBounds(); return { x: b.x, y: b.y, width: b.width, height: b.height } })() : null,
    alwaysOnTop: w ? w.isAlwaysOnTop() : false,
    createdCount,
    readyToShow,
    /** ★ 从**窗口对象**读（不是模块级变量）：窗口换了，来源读数必须跟着换 */
    boundsSource: w ? (boundsSourceByWin.get(w) ?? null) : null,
    workArea,
    center: lastCenterReading ? { ...lastCenterReading } : null,
    requestedBounds: lastRequestedBounds ? { ...lastRequestedBounds } : null,
    sizeCorrection: lastSizeCorrection ? { ...lastSizeCorrection } : null,
  }
}

/** 仅供单测：清掉会话计数（**不碰真实窗口**） */
export function __resetChatWindowForTest(): void {
  createdCount = 0
  readyToShow = false
  lastCenterReading = null
  lastRequestedBounds = null
  lastSizeCorrection = null
}

/** 退出时用：**真正销毁**（与"关闭=隐藏"区分开） */
export function destroyChatWindow(): void {
  if (rememberTimer) { clearTimeout(rememberTimer); rememberTimer = null }
  const w = chatWin
  chatWin = null
  if (w && !w.isDestroyed()) {
    rememberBounds()
    w.destroy()
  }
}
