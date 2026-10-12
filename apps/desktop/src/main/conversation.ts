/**
 * apps/desktop/src/main/conversation.ts —— 「桌宠对话」的**唯一状态机**
 *
 * ⚠ 2026-10-08 返工轮：本文件的**副作用**换了，状态机与告警出口全部保留。
 *   · 旧副作用：`enterConversationLayout()` / `exitConversationLayout()` ——
 *     **打开对话就把 pet 窗口从 340×420 放大到 380×560**。
 *     用户明确否决了那个形态（聊天框必须与桌宠是两个独立窗口），已**全部删除**。
 *   · 新副作用：`showChatWindow()` / `hideChatWindow()` —— 显示/隐藏**独立的第二个
 *     BrowserWindow**（见 `chat-window.ts`）。**pet 窗口的任何属性都不再被这个文件改动**。
 *
 * 它管四件事，别处不许各写一份：
 *   ① 对话窗口的显示/隐藏状态（真源在这里，不在 renderer）；
 *   ② 全局快捷键的注册 / 注销 / **如实上报失败**；
 *   ③ 把状态广播给 renderer（托盘与快捷键是**主进程发起**的入口，
 *      没有这条广播，界面就不知道对话窗口已经被打开了 —— 那是静默失效的典型形态）；
 *   ④ 供诊断快照读取的只读读数（含 chat 窗口 hwnd、居中误差、pet 窗口前后几何）。
 *
 * 入口语义（**本轮定稿，五个入口共用这一条实现**）：
 *   · 轮盘「对话」/ 托盘「开始对话」/ `Ctrl+Alt+Space` / 双击角色 / 唤醒词
 *     ⇒ 一律 **显示并聚焦** chat 窗口；
 *   · **再次触发只聚焦，绝不隐藏**（与参考实现 DockPetWin 的 `Activate(); return;` 一致）。
 *     隐藏只有三条路：chat 窗口的「×」、chat 窗口里的 Esc、托盘「结束对话」。
 *     为什么这么定：五条入口如果各有一套 toggle 语义，"按了没反应"就无法归因；
 *     而"工具栏里点两次把窗口点没了"是比"多点一次没反应"更坏的体验。
 *
 * 硬约束（对应验收判据）：
 *   · 打开/关闭对话**不改变** pet 窗口的尺寸、位置与 panel/pet 模式（判据 §7.5/§7.6）；
 *   · 快捷键注册失败**必须**同时出现在：诊断快照、`conversation:state`、界面告警里，
 *     绝不允许"按了没反应但什么都不说"。
 */
import { BrowserWindow, globalShortcut } from 'electron'
import type { Alert, ConversationSource, ConversationState, Rect } from '@airimate/shared'
import { IPC } from '@airimate/shared'
import { log } from './log.js'
import { broadcast } from './event-sink.js'
import { loadSettings } from './settings-store.js'
import { windowBounds, windowMode } from './window-manager.js'
import { applyChatWindowSettings, applyChatWindowTitle, chatBoundsSource, chatCreatedCount, chatReadyToShow, chatWindowDiagnostics, chatWindowId, hideChatWindow, lastChatCenterReading, showChatWindow, type ChatWindowOptions, type CenterReading } from './chat-window.js'
import { petMenuState } from './pet-visibility.js'

/**
 * 告警出口（**注入**，不 import `ipc.ts`）。
 *
 * 为什么不用 `import { sendAlert } from './ipc.js'`：`ipc.ts` 要 import 本模块来注册
 * `conversation:*` 三条通道 ⇒ 直接 import 会形成 `ipc ↔ conversation` 的**循环依赖**。
 * 本项目已经为同一类问题抽过 `event-sink.ts`（见那里的注释），这里沿用同一种做法：
 * 依赖方向保持 `conversation ← bootstrap → ipc` 一条直线，接线由 bootstrap 完成。
 * 未接线时**不静默**：降级成一条 error 级日志（至少能在日志里查到）。
 */
let alertSink: ((a: Alert) => void) | null = null

export function setConversationAlertSink(fn: ((a: Alert) => void) | null): void {
  alertSink = fn
}

function raiseAlert(a: Alert): void {
  if (alertSink) { alertSink(a); return }
  log().error(`告警出口未接线：${a.title}`, { code: a.code, detail: a.detail?.slice(0, 200) ?? '' }, 'conversation.alert.no-sink')
}

/**
 * 状态广播出口（同样**注入**）。
 *
 * 用途：让出站消息走 `ipc.ts` 的 `send()`（**带 zod 校验**，形状漂移会被丢弃并记日志），
 * 而不是直接 `broadcast` 一个未经运行时校验的对象。未接线时退回 `broadcast` ——
 * 形状仍由本模块的返回类型在编译期保证，只是少一道运行时校验（降级也不静默）。
 */
let stateSink: ((s: ConversationState) => void) | null = null

export function setConversationStateSink(fn: ((s: ConversationState) => void) | null): void {
  stateSink = fn
}

/**
 * 创建 chat 窗口需要的东西（由 bootstrap 在启动时注入一次）。
 *
 * 为什么不在这里自己拼 preload 路径 / dev server URL：
 *   那两样都由 bootstrap 的 CLI 解析与 `preloadPath()` 决定，
 *   在这里再算一份就等于**第二个真源**（本项目反复踩过契约漂移）。
 */
let chatOptions: ChatWindowOptions | null = null

export function setChatWindowOptions(o: ChatWindowOptions | null): void {
  chatOptions = o
}

interface HotkeyState {
  accelerator: string
  enabled: boolean
  registered: boolean
  error: string | null
}

let open = false
let openCount = 0
let closeCount = 0
let lastSource: ConversationSource | null = null
let hotkey: HotkeyState = { accelerator: '', enabled: false, registered: false, error: null }

/**
 * 最近一次打开是否把焦点送进了输入框、是否同时进入了"听"状态（探针读数）。
 * 保留它们是因为"入口生效了但焦点没进去"是一种**看起来正常**的失败。
 */
let lastOpenFocusInput: boolean | null = null
let lastOpenListen = false

/** `GetWindowRect` 级别的窗口句柄（hwnd）—— 判"复用同一个窗口"的**最强证据** */
function hwndOf(id: number | null): string | null {
  if (id === null) return null
  try {
    const w = BrowserWindow.fromId(id)
    if (!w || w.isDestroyed()) return null
    const buf = w.getNativeWindowHandle()
    // Windows: HWND 是指针宽度的无符号整数（小端）；非 Windows 直接给十六进制字节
    if (process.platform === 'win32') {
      return buf.length >= 8 ? buf.readBigUInt64LE(0).toString() : String(buf.readUInt32LE(0))
    }
    return buf.toString('hex')
  } catch {
    return null
  }
}

/**
 * pet 窗口的几何读数（打开/关闭对话前后各取一次）。
 * 判据要求"chat 窗口打开前后，pet 窗口的尺寸与位置读数**逐位相同**" ——
 * 这里记录，探针直接比对，不需要它自己去猜时序。
 */
let petBoundsBefore: Rect | null = null
let petBoundsAfter: Rect | null = null
/** pet 窗口的模式读数（`panel` / `pet`）；对话开合**不得**改变它 */
let petModeBefore: string | null = null
let petModeAfter: string | null = null

export function conversationPetInvariant(): {
  before: Rect | null, after: Rect | null, identical: boolean | null,
  modeBefore: string | null, modeAfter: string | null, modeIdentical: boolean | null,
} {
  const identical = petBoundsBefore && petBoundsAfter
    ? (petBoundsBefore.x === petBoundsAfter.x && petBoundsBefore.y === petBoundsAfter.y
      && petBoundsBefore.width === petBoundsAfter.width && petBoundsBefore.height === petBoundsAfter.height)
    : null
  const modeIdentical = petModeBefore !== null && petModeAfter !== null ? petModeBefore === petModeAfter : null
  return {
    before: petBoundsBefore ? { ...petBoundsBefore } : null,
    after: petBoundsAfter ? { ...petBoundsAfter } : null,
    identical,
    modeBefore: petModeBefore,
    modeAfter: petModeAfter,
    modeIdentical,
  }
}

/** 只读状态（界面与探针共用同一份读数） */
export function conversationState(): ConversationState {
  const mode = windowMode()
  const b = windowBounds() ?? { x: 0, y: 0, width: 0, height: 0 }
  const diag = chatWindowDiagnostics()
  return {
    open,
    /** ⚠ 只描述 **pet 窗口**自己的形态；与"对话窗口开没开"完全解耦 */
    layout: mode === 'panel' ? 'panel' : 'pet',
    mode,
    bounds: b,
    chat: {
      id: diag.id,
      visible: diag.visible,
      focused: diag.focused,
      minimized: diag.minimized,
      bounds: diag.bounds,
      alwaysOnTop: diag.alwaysOnTop,
      createdCount: diag.createdCount,
      readyToShow: diag.readyToShow,
      boundsSource: diag.boundsSource,
    },
    /**
     * ★★ 桌宠窗口 + 常驻设置的读数（2026-10-09 完善轮）。
     *
     * 为什么放进 `ConversationState`（而不是另开一条广播）：
     * 三处菜单（对话窗口菜单栏 / 托盘 / 桌宠右键）都挂在这个状态上，
     * 而它们的刷新**本来就是**由 `conversation:state` 驱动的
     * （`setConversationStateSink` 里顺手 `refreshTray()`）。
     * 另开一条广播就会出现"设置更新了、可见性那条还没到"的中间态 ——
     * 而那个中间态的界面表现正是"勾选和窗口对不上"（C4 要防的正是它）。
     */
    pet: petMenuState(),
    hotkey: { ...hotkey },
    openCount,
    closeCount,
    lastSource,
  }
}

function publish(): ConversationState {
  const s = conversationState()
  try {
    if (stateSink) stateSink(s)
    else broadcast(IPC.EVT_CONVERSATION_STATE, s)
  } catch (e) {
    // 广播失败不能影响状态机本身（renderer 没起来时也会走这里）
    log().debug('对话状态广播失败', { err: e instanceof Error ? e.message : String(e) }, 'conversation.broadcast-failed')
  }
  return s
}

export interface ConversationToggleResult {
  ok: boolean
  state: ConversationState
  /** 非空 = 这次请求被拒绝的原因（调用方必须把它变成**可见**的提示） */
  refusedReason: string | null
}

/**
 * 打开对话窗口（**显示并聚焦**）。
 *
 * 幂等：已经开着时再调一次**不算失败**，行为是"再聚焦一次"（绝不隐藏）。
 * 若带 `listen` 则仍然把"开始听"发出去（用户按了唤醒词，就该听）。
 */
export function openConversation(source: ConversationSource = 'api', listen = false, focusInput = true): ConversationToggleResult {
  if (!chatOptions) {
    /**
     * 没有装配参数就打不开窗口。这是**装配错误**（bootstrap 漏调 `setChatWindowOptions`），
     * 必须显式拒绝并可见告警 —— 静默返回会让"快捷键不管用"变成一个查不出的问题。
     */
    log().error('对话窗口未装配：bootstrap 没有调用 setChatWindowOptions', { source }, 'conversation.not-wired')
    raiseAlert({
      level: 'error',
      title: '对话窗口无法打开',
      detail: '内部装配缺失（setChatWindowOptions 未调用）。这是缺陷，请上报日志。',
      code: 'CONVERSATION_NOT_WIRED',
      blocking: true,
    })
    return { ok: false, state: publish(), refusedReason: 'not-wired' }
  }

  /** 采样 pet 窗口的"打开前"读数（**只读**，绝不改它） */
  petBoundsBefore = windowBounds()
  petModeBefore = windowMode()

  let created = false
  try {
    const r = showChatWindow(chatOptions)
    created = r.created
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log().error('对话窗口创建/显示失败', { err: msg, source }, 'conversation.open.failed')
    raiseAlert({
      level: 'error',
      title: '对话窗口打开失败',
      detail: msg.slice(0, 400),
      code: 'CONVERSATION_OPEN_FAILED',
      blocking: false,
    })
    return { ok: false, state: publish(), refusedReason: 'window-error' }
  }

  petBoundsAfter = windowBounds()
  petModeAfter = windowMode()
  if (!open) {
    open = true
    openCount += 1
  }
  lastSource = source
  lastOpenFocusInput = focusInput
  lastOpenListen = listen
  log().info('对话窗口已打开（独立窗口）', {
    source, created, petMode: petModeAfter,
    petUnchanged: petBoundsBefore && petBoundsAfter
      ? `${petBoundsBefore.x},${petBoundsBefore.y} ${petBoundsBefore.width}x${petBoundsBefore.height} == ${petBoundsAfter.x},${petBoundsAfter.y} ${petBoundsAfter.width}x${petBoundsAfter.height}`
      : '<unknown>',
  }, 'conversation.open')

  const s = publish()
  if (listen) requestListen(source)
  return { ok: true, state: s, refusedReason: null }
}

/**
 * 关闭对话窗口（**隐藏，不销毁、不退出应用**）。
 *
 * 幂等：已经关着时再调一次不算失败（托盘菜单项按时态禁用，但快捷键/脚本可能重复触发）。
 * ⚠ 这里**不再**有任何"还原窗口尺寸"的逻辑：pet 窗口从头到尾没被动过。
 */
export function closeConversation(source: ConversationSource = 'api'): ConversationToggleResult {
  petBoundsBefore = windowBounds()
  petModeBefore = windowMode()

  let hidden = false
  let windowId: number | null = null
  try {
    const r = hideChatWindow(source)
    hidden = r.hidden
    windowId = r.windowId
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log().error('对话窗口隐藏失败', { err: msg, source }, 'conversation.close.failed')
    raiseAlert({
      level: 'warn',
      title: '对话窗口收起失败',
      detail: msg.slice(0, 400),
      code: 'CONVERSATION_CLOSE_FAILED',
      blocking: false,
    })
    return { ok: false, state: publish(), refusedReason: 'window-error' }
  }

  petBoundsAfter = windowBounds()
  petModeAfter = windowMode()
  if (open) {
    open = false
    closeCount += 1
  }
  lastSource = source
  lastOpenFocusInput = null
  lastOpenListen = false
  log().info('对话窗口已关闭（隐藏；桌宠继续活动）', { source, hidden, windowId, petMode: petModeAfter }, 'conversation.close')
  return { ok: true, state: publish(), refusedReason: null }
}

/**
 * 兼容旧调用点的"切换"语义 —— **只给非用户入口用**。
 *
 * ⚠ 五个用户入口**都不许**调它（它们的语义是"只聚焦"）：
 *   轮盘 / 托盘「开始对话」/ 快捷键 / 双击 / 唤醒词一律调 `openConversation()`。
 *   这个函数保留下来只是为了托盘「结束对话」与脚本化验收的对称性。
 */
export function toggleConversation(source: ConversationSource = 'api'): ConversationToggleResult {
  return open ? closeConversation(source) : openConversation(source)
}

/** renderer 刚刚挂载完时补一次广播 —— 否则"主进程已经打开的对话窗口"在界面上不会出现 */
export function announceConversationState(): void {
  publish()
}

/**
 * 让对话窗口进入"听"状态。
 *
 * ⚠ 这条事件**不打开麦克风**：麦克风的唯一开关仍然是 `hearingEnabled`，
 *   真正去识别的是 renderer 调**已有的** `voice:listen-once`
 *   （规格 §五：不要新建第二条语音链路，不要加第二个麦克风监听）。
 */
export function requestListen(source: ConversationSource): void {
  try {
    broadcast(IPC.EVT_CONVERSATION_LISTEN, { at: Date.now(), source })
  } catch (e) {
    log().debug('“开始听”广播失败', { err: e instanceof Error ? e.message : String(e) }, 'conversation.listen.broadcast-failed')
  }
}

// ───────────────────────────────────────────────────────── 全局快捷键

/**
 * 注册 / 重新注册全局快捷键。
 *
 * **失败必须可见**（规格的硬要求）。三处同时落：
 *   ① `hotkey.error` —— 进诊断快照与 `conversation:state`（探针能机械读到）；
 *   ② `sendAlert(...)` —— 界面上的告警条（用户看得见，且非阻断不会打断使用）；
 *   ③ 结构化日志 —— 排障时能查到"是哪一次注册失败了"。
 *
 * 为什么不用 `globalShortcut.register` 的返回值就完事：它在某些环境下返回 true
 * 但实际没接上（被同会话的另一个进程抢占时），所以再用 `isRegistered()` 复核一次。
 */
export function applyConversationHotkey(): HotkeyState {
  const s = loadSettings()
  const accelerator = s.conversationHotkey
  const enabled = s.conversationHotkeyEnabled

  if (hotkey.registered && hotkey.accelerator) {
    try { globalShortcut.unregister(hotkey.accelerator) } catch { /* 已注销过不算错 */ }
  }
  hotkey = { accelerator, enabled, registered: false, error: null }

  if (!enabled) {
    log().info('全局快捷键已按用户设置关闭', { accelerator }, 'conversation.hotkey.disabled')
    return hotkey
  }

  let failure: string | null = null
  try {
    /**
     * ★ 快捷键语义 = **只聚焦**（返工轮定稿）。
     *   旧实现调 `toggleConversation` ⇒ 窗口开着时按一次就隐藏。
     *   那与"五个入口语义完全一致"冲突（双击、轮盘都不会隐藏），
     *   而且用户按快捷键的意图永远是"我要对话"，不是"我要关掉它"。
     */
    const okReg = globalShortcut.register(accelerator, () => { openConversation('hotkey') })
    if (!okReg) failure = `快捷键「${accelerator}」注册失败：已被其它软件占用（可在设置里改键或关闭）`
    else if (!globalShortcut.isRegistered(accelerator)) failure = `快捷键「${accelerator}」注册后复核失败：系统没有真正接上`
    else hotkey.registered = true
  } catch (e) {
    failure = `快捷键「${accelerator}」注册异常：${e instanceof Error ? e.message : String(e)}`
  }

  if (failure) {
    hotkey.error = failure
    log().error('全局快捷键注册失败', { accelerator, detail: failure }, 'conversation.hotkey.failed')
    raiseAlert({
      level: 'error',
      title: '全局快捷键注册失败',
      detail: `${failure}\n可以在「设置 → 对话」里换一个组合键，或直接关掉它。`,
      code: 'HOTKEY_REGISTER_FAILED',
      blocking: false,
    })
  } else {
    log().info('全局快捷键已注册', { accelerator }, 'conversation.hotkey.registered')
  }
  return hotkey
}

/** 退出时必须注销（否则进程残留占用会让下次启动"注册失败"） */
export function releaseConversationHotkey(): void {
  if (hotkey.accelerator) {
    try { globalShortcut.unregister(hotkey.accelerator) } catch { /* ignore */ }
  }
  hotkey = { ...hotkey, registered: false }
}

/** 设置变更后重新应用（快捷键 + chat 窗口置顶 + 标题） */
export function applyConversationSettings(): void {
  applyConversationHotkey()
  applyChatWindowSettings()
  applyChatWindowTitle()
  announceConversationState()
}

/** 只读诊断（探针 / 诊断快照用；**不含任何内容**） */
export function conversationDiagnostics(): {
  state: ConversationState
  hotkey: HotkeyState
  chat: ReturnType<typeof chatWindowDiagnostics>
  chatHwnd: string | null
  chatWindowId: number | null
  chatCreatedCount: number
  chatReadyToShow: boolean
  chatBoundsSource: ReturnType<typeof chatBoundsSource>
  center: CenterReading | null
  petInvariant: ReturnType<typeof conversationPetInvariant>
  lastOpenFocusInput: boolean | null
  lastOpenListen: boolean
} {
  const diag = chatWindowDiagnostics()
  const id = chatWindowId()
  return {
    state: conversationState(),
    hotkey: { ...hotkey },
    chat: diag,
    chatHwnd: hwndOf(id),
    chatWindowId: id,
    chatCreatedCount: chatCreatedCount(),
    chatReadyToShow: chatReadyToShow(),
    chatBoundsSource: chatBoundsSource(),
    /**
     * 居中读数：优先给**最后一次居中**的真实读数（`lastChatCenterReading`），
     * 它同时含 requested / actual / workArea / cursor，探针据此自己算误差也能核对
     * `centerErrorDip` 不是我们编的。
     */
    center: lastChatCenterReading(),
    petInvariant: conversationPetInvariant(),
    lastOpenFocusInput,
    lastOpenListen,
  }
}

/** 仅供单测：重置状态（不碰真实窗口） */
export function __resetConversationForTest(): void {
  open = false
  openCount = 0
  closeCount = 0
  lastSource = null
  lastOpenFocusInput = null
  lastOpenListen = false
  petBoundsBefore = null
  petBoundsAfter = null
  petModeBefore = null
  petModeAfter = null
  hotkey = { accelerator: '', enabled: false, registered: false, error: null }
}
