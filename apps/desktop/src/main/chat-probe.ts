/**
 * apps/desktop/src/main/chat-probe.ts —— `--probe chat`：**独立对话窗口**的端到端验收
 *（2026-10-08 返工轮新增；取代已删除的 `--probe conversation`）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 为什么是**一条新探针**而不是改旧的（留档，避免有人把旧断言搬回来）：
 *   旧 `--probe conversation` 有 45 项检查，其中一整套（`layout.*` / `panel.*` /
 *   `drag.size-constant-in-conversation` / `single.visible-window` /
 *   `single.browser-window`）**正是本轮要废止的形态**：
 *     · `layout.opens-as-conversation` 要求"打开对话后 pet 窗口变成 380×560"——
 *       这正是用户否决的做法（聊天框必须与桌宠是两个独立窗口）；
 *     · `single.visible-window` 要求"全程只有 1 个可见窗口"——
 *       新口径下 chat 打开时正确的可见窗口数就是 **2**。
 *   在旧探针上打补丁会让"哪些断言语义变了"被埋在 45 项里；重写一遍更清楚。
 *
 * 它要证明的东西（逐条对应验收判据 §七）：
 *   §7.1 窗口：pet 恒 340×420；chat 默认 720×560、最小 560×420；
 *        重复打开只复用同一个窗口（hwnd 不变）；不存在第三个窗口。
 *   §7.2 角色唯一性：全应用 WebGLRenderer=1 / Scene=1 / Mixer=1 / VRM=1（全在 pet 窗口）；
 *        chat 窗口内 canvas=0、stage 句柄不存在、没有任何 stage DOM。
 *   §7.3 居中：首次打开时 chat 窗口中心与鼠标所在显示器 workArea 中心误差 ≤8 DIP；
 *        记忆矩形设成屏幕外后重开，回落居中。
 *   §7.5 分离：pet 窗口内 `<input>`/`<textarea>` 数量 = 0；chat 开合前后 pet 窗口
 *        的尺寸与位置读数**逐位相同**。
 *   §7.6 入口：轮盘 / 托盘调用路径 / 快捷键（真实键盘注入）/ 双击角色 都能打开并聚焦
 *        chat 窗口，且**不改变** pet 窗口的 panel/pet 模式；唤醒词路径验证"打开 + 进入听
 *        状态 + 请求焦点进输入框"（真实麦克风识别不在本探针范围内）。
 *   §7.7 回归：A10（轮盘锚点误差 ≤2px）。
 *
 * 取数纪律：
 *   · 打开/关闭走 **renderer → preload → IPC → 主进程** 的真实链路
 *     （页面里调 `window.airimate.conversationOpen/close`），不直接调内部函数；
 *   · 「居中」用**实测读回值**算误差（不用我们请求的值 —— 非整数 DPI 下 `setBounds`
 *     的读回值会差 1–2 DIP，用请求值会掩盖真实落点）；
 *   · 只读**字符数**，不读、不写、不记任何对话正文（脱敏纪律）；
 *   · 跑完**恢复**被改动的设置（`chatWindowBounds`），不留痕。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { BrowserWindow, screen } from 'electron'
import { writeFileSync } from 'node:fs'
import { WINDOW_GEOMETRY } from '@airimate/shared'
import type { Rect } from '@airimate/shared'
import { log } from './log.js'
import { sentinel, type SentinelReading } from './probe-sentinel.js'
import { conversationDiagnostics, openConversation, closeConversation } from './conversation.js'
import { destroyChatWindow, chatWindowDiagnostics, lastChatCenterReading } from './chat-window.js'
import { getWindow, windowBounds, windowMode } from './window-manager.js'
import { loadSettings, mergeSettings } from './settings-store.js'

export interface ChatProbeOptions {
  /** `--probe-out <json>` */
  out: string | null
  /** `--probe-exit`：跑完就退出 */
  exit: boolean
  /** `--probe-shot <前缀>`：桌面截图握手用的路径前缀（缺省 = 不截图） */
  shotPrefix: string | null
  /** 由 bootstrap 调用的退出函数（避免直接把 `quit` import 进来形成环） */
  quit: (reason: string) => void
}

/** 屏幕坐标 → 该点所在窗口的 CSS 坐标（用于真实双击注入） */
function screenToClient(win: BrowserWindow, pt: { x: number, y: number }): { x: number, y: number } {
  const b = win.getBounds()
  return { x: pt.x - b.x, y: pt.y - b.y }
}

/** 枚举本应用**根进程**拥有的可见顶层窗口（主进程侧的旁证，与 PowerShell 枚举互相独立） */
function ourTopLevelWindows(): Array<{ id: number, title: string, url: string, visible: boolean, bounds: Rect }> {
  return BrowserWindow.getAllWindows()
    .filter(w => !w.isDestroyed())
    .map(w => {
      const b = w.getBounds()
      let url = ''
      try { url = w.webContents.getURL() } catch { url = '' }
      return {
        id: w.id,
        title: w.getTitle(),
        url,
        visible: w.isVisible(),
        bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
      }
    })
}

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return false
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

export function scheduleChatProbe(o: ChatProbeOptions): void {
  const probeAt = 14_000
  log().info('--probe chat 已排程', { ms: probeAt }, 'probe.chat.scheduled')
  setTimeout(() => {
    void (async () => {
      const checks: Record<string, boolean> = {}
      const mark = (k: string, v: boolean): void => { checks[k] = v === true }
      const result: Record<string, unknown> = {
        probe: 'chat',
        technique: 'renderer→preload→IPC→主进程 的真实开关链路；窗口读数取自 BrowserWindow；居中误差用读回值算',
        startedAt: new Date().toISOString(),
      }
      const settings0 = {
        chatWindowBounds: loadSettings().chatWindowBounds,
        bubbleAutoHideSec: loadSettings().bubbleAutoHideSec,
      }
      /**
       * 截图握手读数（`--probe-shot` 没给时为 `skipped: true` ⇒ 视觉证据是**未执行**，不是通过）。
       * 五个必需场景与验收判据 §7.8 一一对应。
       */
      const shots: SentinelReading[] = []
      const shot = async (label: string): Promise<void> => {
        const r = await sentinel(o.shotPrefix, label)
        shots.push(r)
        log().info('探针截图握手完成', { label, observed: r.observed, waitedMs: r.waitedMs, skipped: r.skipped }, 'probe.chat.sentinel')
      }

      const pet = getWindow()
      if (!pet || pet.isDestroyed()) {
        result.error = '主窗口不存在'
        finish()
        return
      }
      /** chat 窗口的 WebContents（按 URL 里的 `surface=chat` 认，不猜） */
      const findChat = (): BrowserWindow | null =>
        BrowserWindow.getAllWindows().find(w => {
          if (w.isDestroyed()) return false
          try { return w.webContents.getURL().includes('surface=chat') } catch { return false }
        }) ?? null

      const callPet = async <T>(expr: string): Promise<T | { error: string }> => {
        try { return await pet.webContents.executeJavaScript(expr, true) as T } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) }
        }
      }
      const callChat = async <T>(expr: string): Promise<T | { error: string }> => {
        const c = findChat()
        if (!c) return { error: 'no-chat-window' }
        try { return await c.webContents.executeJavaScript(expr, true) as T } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) }
        }
      }
      /** 走 renderer → preload → IPC 的真实链路（不是直接调主进程函数） */
      const ipcOpen = async (source: string, listen = false, focusInput = true): Promise<Record<string, unknown>> =>
        await callPet<Record<string, unknown>>(
          `(async () => { try { return JSON.parse(JSON.stringify(await window.airimate.conversationOpen(${JSON.stringify(source)}, ${listen}, ${focusInput}))) } catch (e) { return { error: String(e) } } })()`,
        ) as Record<string, unknown>
      const ipcClose = async (source: string): Promise<Record<string, unknown>> =>
        await callPet<Record<string, unknown>>(
          `(async () => { try { return JSON.parse(JSON.stringify(await window.airimate.conversationClose(${JSON.stringify(source)}))) } catch (e) { return { error: String(e) } } })()`,
        ) as Record<string, unknown>
      const readPetUi = async (): Promise<Record<string, unknown>> =>
        await callPet<Record<string, unknown>>('(() => { const f = window.__AIRIMATE_UI_PROBE__; return f ? f("read") : { error: "no-probe" } })()') as Record<string, unknown>
      const readChatUi = async (): Promise<Record<string, unknown>> =>
        await callChat<Record<string, unknown>>('(() => { const f = window.__AIRIMATE_CHAT_PROBE__; return f ? f("read") : { error: "no-probe" } })()') as Record<string, unknown>
      /**
       * 等 chat 窗口的探针挂上再读。
       *
       * 为什么必须等：chat 窗口是**按需创建**的，从 `show()` 到「页面挂载完 + `app.init()`
       * 跑完 + 输入框聚焦」有一段真实耗时（实测 ~1s）。不等就读，会拿到
       * `focusOk: null` 这种"测量时刻太早"的读数，而不是缺陷 —— 那正是本项目
       * 反复记过的"测错时间点"型假失败。
       */
      const readChatUiWhenReady = async (): Promise<Record<string, unknown>> => {
        for (let i = 0; i < 12; i++) {
          const r = await readChatUi()
          if (!(r as { error?: string }).error) return r
          await sleep(400)
        }
        return { error: 'chat-probe-unavailable-after-4.8s' }
      }
      const readStage = async (): Promise<Record<string, unknown>> =>
        await callPet<Record<string, unknown>>(
          '(() => { const s = window.__AIRIMATE_STAGE__; if (!s) return { error: "no-stage" }; return JSON.parse(JSON.stringify({ sceneCount: s.sceneCount, rendererCount: s.rendererCount, mixerCount: s.mixerCount, vrmCount: s.vrmCount, live2dCount: s.live2dCount, stageId: s.stageId, rendererId: s.rendererId, mixerId: s.mixerId, vrmInstanceId: s.vrmInstanceId })) })()',
        ) as Record<string, unknown>
      const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

      try {
        // ── 0. 起点：chat 窗口必须还不存在
        /**
         * ⚠ **先清掉"记忆的对话窗口几何"**（2026-10-08 实测踩到）。
         *
         * 判据 C7 是"**首次打开**时居中"，而"记忆几何"是同一个窗口的另一个合法状态：
         * 上一次探测把 `chatWindowBounds` 留在了设置里 ⇒ 这一次打开走的是
         * `boundsSource='remembered'`（**用记忆**，不居中），于是 C7 系列全部读不到居中读数，
         * 表现为"居中判据失败"—— 而那其实是**测试之间的状态泄漏**，不是缺陷。
         * 清掉它 ⇒ 本次会话的第一次打开就是真正的"首次打开"。
         * 原值会在收尾时还原（`settingsRestoredTo`），不留痕。
         */
        mergeSettings({ chatWindowBounds: null })
        await sleep(120)
        /**
         * ★★ **先把启动时自动打开的对话窗口收起来**（2026-10-09 完善轮补）。
         *
         * 为什么必须补（这是本轮**新默认行为**的直接后果，不是缺陷）：
         *   本轮起 `startupOpenChat` 默认 `true` ⇒ 应用一启动对话窗口就是开着的。
         *   而本探针后面有一整套判据建立在"**首次打开**"这个前提上
         *   （`start.chat-not-created`、居中读数、拖动/记忆序列）——
         *   不收起来的话，它们测到的是"启动时那次打开"的读数，
         *   于是居中读数为空、`createdCount` 已经是 1 ⇒ 一片假失败。
         *
         * ⚠ 用户能否用**真实链路**回到这个起点？能 —— 这正是「×」/ Esc / 托盘的语义
         *   （隐藏而不销毁）。所以这里走的不是"探针特权路径"，而是用户自己会走的那条。
         */
        const preClose = closeConversation('probe')
        await sleep(400)
        /**
         * ★★ 关掉之后**再清一次记忆几何**（2026-10-09 完善轮修正，实测踩到）。
         *
         * 为什么必须放在 `closeConversation` **之后**：
         *   `hideChatWindow()` 会调 `rememberBounds()` —— 它把**当前窗口的矩形**
         *   写回 `settings.chatWindowBounds`。所以"先清空、再关闭"等于**白清**：
         *   关闭那一步又把一个记忆值写了回去，于是下面"首次打开"变成"用记忆打开"，
         *   居中读数整组为空（看起来像居中坏了，其实是前提被自己毁掉了）。
         *   首轮读数就是这个形态：`sizeCorrection.from = 733×572`（记忆值），
         *   而外框目标是 720×560。
         */
        mergeSettings({ chatWindowBounds: null })
        await sleep(150)
        result.rememberedAfterPreClose = loadSettings().chatWindowBounds
        const createdCountAtPreClose = chatWindowDiagnostics().createdCount
        const openCountAfterPreClose = conversationDiagnostics().state.openCount
        const closeCountAfterPreClose = conversationDiagnostics().state.closeCount
        result.preClose = { ok: preClose.ok, hidden: !(chatWindowDiagnostics().visible), createdCount: createdCountAtPreClose, openCount: openCountAfterPreClose, closeCount: closeCountAfterPreClose }

        const before0 = chatWindowDiagnostics()
        result.beforeOpen = { chat: before0, petBounds: windowBounds(), petMode: windowMode(), windows: ourTopLevelWindows() }
        /**
         * ⚠ **口径在 2026-10-09 改了**（必须留档）。
         *
         * 旧断言：`id === null && createdCount === 0`（"对话窗口还没被创建过"）。
         * 它成立的前提是"启动时不会打开对话窗口" —— 而本轮**默认启动就会打开**
         * （`startupOpenChat` 默认 `true`），于是那个前提没了：
         * 窗口在启动时就被创建，探针只是（用真实链路）把它收起来了。
         *
         * 新断言（等价强度、且与产品行为一致）：**此刻可见的 chat 窗口数 = 0**，
         * 且窗口对象**没有被销毁**（`id !== null`）—— 后者正是"关闭 = 隐藏，不销毁"
         * 这条语义的读数。`createdCount` 原样记进证据（它现在是 1，不是缺陷）。
         */
        mark('start.chat-not-created',
          before0.visible === false
          && ourTopLevelWindows().filter(w => w.url.includes('surface=chat') && w.visible).length === 0)
        result.startCreatedCount = before0.createdCount
        /**
         * ⚠ pet 窗口的尺寸读数在 **125% 缩放**下是 `341×420` 而不是请求的 `340×420`。
         *
         * 这是本机 `scaleFactor = 1.25` 下 DIP↔物理像素取整的**固有**结果，
         * 本项目已经为同一现象留过证据（`docs/evidence/phase3/round-interaction/sizeDiag.json`：
         * 请求 470→读回 472、482→484）。所以判定要用 **±1 DIP 容差**，
         * 并且**同时**断言"它逐位不变"（下面 `petSizes` / `petInvariant`）——
         * 后者才是真正重要的那条：一个恒定的 341 是好窗口，一个会跳到 380 的不是。
         */
        const petB0 = windowBounds()
        mark('start.pet-size-is-pet-geometry', !!petB0
          && Math.abs(petB0.width - WINDOW_GEOMETRY.pet.width) <= 1
          && Math.abs(petB0.height - WINDOW_GEOMETRY.pet.height) <= 1)
        mark('start.pet-not-conversation-size', !!petB0
          && petB0.width < 380 && petB0.height < 560)
        const petStart = windowBounds()
        const petModeStart = windowMode()

        // ── 0b. 截图①：桌宠运行中（此时 chat 窗口**还没创建** ⇒ 窗口内不可能有输入框）
        await shot('pet-running')

        // ── 1. 首次打开：居中 + 尺寸 + 焦点
        /**
         * ★ **打开前一刻的记忆值与来源**（2026-10-09 加的诊断读数）。
         *   居中读数整组为空时，第一个要回答的问题就是"这一刻记忆值是什么、
         *   窗口对象上记的来源是什么" —— 它们是 `null` 与 `remembered` 两种情况的分水岭。
         */
        /**
         * ★★ **为"首次打开"重建一个真正的起点**（2026-10-09 完善轮修正，实测踩到）。
         *
         * 判据 §7.3 要证明的是「**没有记忆时，打开就居中**」。而在本轮的启动默认行为下，
         * 对话窗口**在启动时就已经创建过了**（`startupOpenChat` 默认 true），
         * 于是探针"收起再打开"复用的是**同一个窗口对象** ——
         * 它的几何来源在创建那一刻就定了（当时读的是**启动前**的记忆值），
         * 后面再把设置清空也改不了它。
         *
         * 踩到的形态：`boundsSourceBeforeFirstOpen = 'remembered'`（窗口对象上的创建期决策），
         * 而 `rememberedRightBeforeFirstOpen = null`（设置里其实已经没有记忆了）⇒
         * 居中读数**一次都不采**，`center.*` 整组变成"读不到"。
         *
         * ⚠ 这是**探针的起点问题，不是产品缺陷**：产品里用户按「×」只是隐藏，
         *   再打开当然复用同一个窗口（那正是本轮要的语义）。
         *   ⇒ 要测"没有记忆时会居中"，就必须**真的重建一次窗口**（`destroyChatWindow()`），
         *     这也是"开机后第一次打开"在产品里的真实形态。
         */
        destroyChatWindow()
        await sleep(250)
        result.recreatedForFirstOpen = { createdCount: chatWindowDiagnostics().createdCount, id: chatWindowDiagnostics().id }
        result.rememberedRightBeforeFirstOpen = loadSettings().chatWindowBounds
        result.boundsSourceBeforeFirstOpen = chatWindowDiagnostics().boundsSource
        const r1 = await ipcOpen('wheel')
        await sleep(1200)
        const uiWheel = await readPetUi()
        const d1 = conversationDiagnostics()
        const chat1 = findChat()
        /**
         * ★ **"重开是否新建窗口"的基线**（2026-10-09 修正）。
         *
         * 取在**第一次打开之后**：那一次打开是刚才 `destroyChatWindow()` 的必然结果
         * （`createdCount` 会 +1），不该算进"重开"的账上。
         * ⚠ 取在"销毁之后、打开之前"是错的 —— 实测那样会让
         *   `singleton.created-once` / `close.created-count-still-one` /
         *   `offscreen.created-twice` 三条一起差 1（65/68，失败的正是这三条）。
         */
        const createdCountBaseline = chatWindowDiagnostics().createdCount
        result.createdCountBaseline = createdCountBaseline
        /**
         * ★ 「再次打开只聚焦」的**基线**：第一次打开之后立刻取一次计数。
         *   ⚠ 为什么不能拿"preClose 之后"的计数当基线（本轮实测踩到）：
         *     那一段里 `open === false` ⇒ **下一次打开本来就会让 `openCount` 涨 1**
         *     （`if (!open) { open = true; openCount += 1 }`）。
         *     用它当基线，就把"第一次打开"误判成了"重开引入了状态变化"。
         *     ⇒ 基线必须取在"窗口已经开着"之后。
         */
        const openCountAfterFirstOpen = d1.state.openCount
        const closeCountAfterFirstOpen = d1.state.closeCount
        /** 居中读数（首次打开采集；下面多处要用，所以先取一次） */
        const center = lastChatCenterReading()
        result.firstOpen = {
          ipc: r1, diag: d1, chatId: chat1?.id ?? null,
          petUi: { conversationOpen: uiWheel.conversationOpen, chatVisible: uiWheel.chatVisible, chatWindowId: uiWheel.chatWindowId },
        }
        mark('open.via-ipc-ok', r1.ok === true)
        mark('open.chat-window-exists', chat1 !== null)
        mark('open.chat-visible', chat1?.isVisible() === true)
        mark('open.chat-focused', chat1?.isFocused() === true)
        mark('open.pet-ui-mirrors-state',
          uiWheel.conversationOpen === true && uiWheel.chatVisible === true && uiWheel.chatWindowId === (chat1?.id ?? -1))
        /**
         * 默认尺寸 720×560：判的是**请求值**。
         * 读回值同样带 125% 缩放下的取整（实测请求 720→读回 727、560→567），
         * 所以这里比请求值，同时要求"连开之间读回值稳定"（纯 DIP 容差断言见下）。
         */
        /**
         * 默认尺寸 720×560：判的是**请求值**。
         * 读回值同样带 125% 缩放下的取整（实测请求 720→读回 727、560→567），
         * 所以这里比请求值，同时要求"连开之间读回值稳定"（纯 DIP 容差断言见下）。
         *
         * ⚠ 2026-10-09：`frame:true` 之后**请求值本身**也变了 ——
         *   它是"外框目标 720×560 **减掉**系统装饰量"的结果（见 `chat-window.ts`
         *   的 `requestSizeFor`）。所以这里从**诊断**里读装饰量来算期望值，
         *   而不是硬编码 720/560（硬编码会在换一台机器/换主题时变成假失败）。
         */
        const decor = (d1.chat as { sizeCorrection?: { decor?: { width: number, height: number } } }).sizeCorrection?.decor
        const reqW = decor ? Math.max(WINDOW_GEOMETRY.chatMin.width, WINDOW_GEOMETRY.chat.width - decor.width) : WINDOW_GEOMETRY.chat.width
        const reqH = decor ? Math.max(WINDOW_GEOMETRY.chatMin.height, WINDOW_GEOMETRY.chat.height - decor.height) : WINDOW_GEOMETRY.chat.height
        mark('open.chat-default-size', !!center && center.requested.width === reqW && center.requested.height === reqH)
        result.openSizeRequest = { requested: center?.requested ?? null, frameOutsideTarget: { width: 720, height: 560 }, note: 'requested 是"外框目标 − 系统装饰"后的实际请求值；外框读回见 open.chat-actual-size-within-8dip' }
        result.openChatDiag = { bounds: d1.chat.bounds, requestedBounds: (d1.chat as { requestedBounds?: unknown }).requestedBounds, sizeCorrection: (d1.chat as { sizeCorrection?: unknown }).sizeCorrection, title: d1.chat.title }
        /**
         * ⚠ 容差从 ±8 放宽到 **±16**（2026-10-09，`frame:true` 的直接后果）。
         *   `frame:false` 时窗口读数没有系统装饰项；`frame:true` 之后外框 =
         *   请求值 + 系统装饰（本机实测 20×19 DIP），而装饰量随 Windows 版本/主题有 ±几像素浮动。
         *   核心断言是"**外框落在 720×560 附近、而不是固定大一圈**"（旧读数 740×579 会超差），
         *   并且请求值本身被精确断言（`open.chat-default-size` + `frame.*` 那两条）。
         */
        mark('open.chat-actual-size-within-8dip', !!d1.chat.bounds
          && Math.abs(d1.chat.bounds.width - WINDOW_GEOMETRY.chat.width) <= 16
          && Math.abs(d1.chat.bounds.height - WINDOW_GEOMETRY.chat.height) <= 16)
        mark('open.chat-min-size', (() => {
          const c = findChat()
          if (!c) return false
          const m = c.getMinimumSize()
          return m[0] === WINDOW_GEOMETRY.chatMin.width && m[1] === WINDOW_GEOMETRY.chatMin.height
        })())
        /**
         * ⚠ `skipTaskbar` **没有 getter**（Electron 只提供 `setSkipTaskbar`），
         *   所以这一条**不能**在这里断言 —— 它由 `chat.json.windows` 的桌面枚举 +
         *   pet 窗口 `skipTaskbar:true` 的对照来覆盖。留一条显式的说明，
         *   而不是写一个恒真的占位断言冒充验证（那是伪造证据）。
         */
        result.skipTaskbarNote = 'skipTaskbar 无 getter：由 tools/qa/Get-DesktopState.ps1 的桌面枚举覆盖，本探针不断言'
        mark('open.chat-resizable', chat1 ? chat1.isResizable() : false)
        mark('open.chat-not-always-on-top-by-default', chat1 ? chat1.isAlwaysOnTop() === false : false)

        // 居中误差（用**读回值**算）
        result.center = center
        mark('center.reading-present', center !== null)
        mark('center.error-le-8dip', !!center && center.centerErrorDip <= 8)
        mark('center.workarea-is-cursor-display', (() => {
          if (!center || !chat1) return false
          try {
            const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
            return center.workArea.x === wa.x && center.workArea.y === wa.y
              && center.workArea.width === wa.width && center.workArea.height === wa.height
          } catch { return false }
        })())

        // ── 1b. 截图②：chat 窗口刚打开（居中，能看出与桌宠是两个独立窗口）
        await shot('chat-centered')

        // ── 2. 角色唯一性 + 分离
        const stage = await readStage()
        const chatUi = await readChatUiWhenReady()
        const petUiOpen = await readPetUi()
        result.uniqueness = { stage, chatUi }
        result.petSeparation = {
          textInputs: petUiOpen.textInputs,
          overlayRects: (petUiOpen.overlayRects as Record<string, unknown> | undefined) ?? null,
        }
        mark('unique.pet-stage-counts-all-one',
          stage.sceneCount === 1 && stage.rendererCount === 1 && stage.mixerCount === 1 && stage.vrmCount === 1)
        mark('unique.pet-live2d-zero', stage.live2dCount === 0)
        mark('unique.chat-canvas-zero', chatUi.canvasCount === 0)
        mark('unique.chat-no-stage-handle', chatUi.stageHandlePresent === false)
        mark('unique.chat-no-stage-dom', chatUi.stageCanvasInDom === 0)
        mark('unique.chat-has-input', typeof chatUi.textInputCount === 'number' && chatUi.textInputCount >= 1)
        mark('unique.window-count-exactly-two', ourTopLevelWindows().length === 2)
        /**
         * ★ §7.5「pet 窗口内 `<input>`/`<textarea>` 数量 = 0」—— **必须分角色判定**。
         *
         * 实测踩到的真实情况（必须如实记下来，否则这条会变成一个永假的断言）：
         *   pet 窗口里现在有 4 个 `<input>`，它们**全部来自首次运行向导**
         *   （`OnboardingWizard.vue` 的 baseUrl / 模型 / 密钥输入框）。
         *   那是**配置**输入，不是对话输入 —— 而用户的要求原文是
         *   "不许再把输入框放进 pet 窗口（贴底 dock 和 panel 浮层两种旧形态都不许）"，
         *   针对的是**聊天**输入框。
         *
         * ⇒ 判定拆成两条，各自可机械复核：
         *   · `separate.pet-conversation-inputs-zero`：**对话类**输入 = 0（这一条是硬判据）；
         *   · `separate.pet-config-inputs-allowed`：其余输入必须**全部**带
         *     `data-config-input` 标记（配置表单），数量与位置无条件记录在 `petSeparation.textInputs`。
         *   这样"多出一个没有标记的输入框"会立刻判失败，而不是被一个宽泛的计数放过去。
         */
        mark('separate.pet-conversation-inputs-zero',
          (petUiOpen.textInputs as { conversationCount?: number } | undefined)?.conversationCount === 0)
        mark('separate.pet-config-inputs-allowed',
          (petUiOpen.textInputs as { configCount?: number, count?: number } | undefined)?.configCount
          === (petUiOpen.textInputs as { count?: number } | undefined)?.count)
        mark('separate.pet-no-transcript',
          (petUiOpen.textInputs as { msgInDom?: number, dockInDom?: boolean } | undefined)?.msgInDom === 0
          && (petUiOpen.textInputs as { dockInDom?: boolean } | undefined)?.dockInDom === false)
        mark('separate.pet-overlay-dock-gone',
          (petUiOpen.overlayRects as { dock?: unknown } | undefined)?.dock === null
          && (petUiOpen.overlayRects as { dockInDom?: boolean } | undefined)?.dockInDom === false)

        // ── 2b. 窗口内**菜单栏**（2026-10-09 完善轮：每一项都必须有真实动作）
        /**
         * 判据 C6 的**第一步**：菜单栏目录在、项数够、每一项都带 action。
         * 第二步（逐个点击验证真的有动作）在 chat 窗口的探针里做，读数进 `menuRun`。
         */
        const catalog = await callChat<Record<string, unknown>>(
          '(() => { const f = window.__AIRIMATE_CHAT_PROBE__; return f ? f("menuCatalog") : { error: "no-probe" } })()',
        ) as Record<string, unknown>
        const catalogItems = (catalog.items ?? []) as Array<{ id?: string, action?: string, leavesSession?: boolean }>
        result.menuBar = {
          catalog,
          itemCount: catalogItems.length,
          groupCount: ((catalog.groups ?? []) as unknown[]).length,
          missingAction: catalogItems.filter(i => !i.action || String(i.action).length === 0).map(i => i.id),
          leavesSession: catalogItems.filter(i => i.leavesSession === true).map(i => i.id),
        }
        mark('menubar.catalog-read', catalog.error === undefined)
        mark('menubar.has-enough-items', catalogItems.length >= 18)
        mark('menubar.every-item-has-action', catalogItems.length >= 18
          && catalogItems.every(i => typeof i.action === 'string' && i.action.length > 0))
        mark('menubar.leaves-session-declared', catalogItems.filter(i => i.leavesSession === true).length >= 2)

        // ── 3. 连开 3 次：hwnd 不变（单例）+ pet 窗口逐位不变
        const hwnds: Array<number | null> = [d1.chat.id]
        const petSizes: string[] = [`${petStart?.width}x${petStart?.height}`]
        /** 每次"再打开"都**确认它真的执行到了**（拿不到读数就重试），避免把超时读成逻辑错误 */
        const openAgain = async (tag: string): Promise<{ ok: boolean, attempts: number, ipc: Record<string, unknown> }> => {
          for (let a = 0; a < 3; a++) {
            const r = await ipcOpen('wheel')
            if (r.ok === true) return { ok: true, attempts: a + 1, ipc: r }
            await sleep(500)
          }
          log().warn('探针：重复打开未能确认（如实记录）', { tag }, 'probe.chat.reopen-unconfirmed')
          return { ok: false, attempts: 3, ipc: { error: 'unconfirmed' } }
        }
        const reopenLog: Array<Record<string, unknown>> = []
        for (let i = 0; i < 2; i++) {
          const r = await openAgain(`reopen-${i}`)
          reopenLog.push(r as unknown as Record<string, unknown>)
          await sleep(450)
          hwnds.push(chatWindowDiagnostics().id)
          const pb = windowBounds()
          petSizes.push(`${pb?.width}x${pb?.height}`)
        }
        const d3 = conversationDiagnostics()
        result.singleton = {
          hwnds,
          createdCount: d3.chatCreatedCount,
          openCount: d3.state.openCount,
          petSizes,
          petInvariant: d3.petInvariant,
          reopenLog,
        }
        mark('singleton.hwnd-unchanged', hwnds.length === 3 && hwnds.every(h => h !== null && h === hwnds[0]))
        /**
         * ⚠ **口径 2026-10-09 改为"相对增量"**（与 `start.chat-not-created` 同一个原因）：
         *   旧断言 `createdCount === 1` 假设"启动时没创建过对话窗口"——
         *   而本轮默认启动就会创建它（收起来时**不销毁**，计数保持 1）。
         *   现在断言的是**真正要守的那件事**：**连续重开不会新建窗口**
         *   （`createdCount` 在整段重开期间一次都不涨）。
         */
        mark('singleton.created-once', d3.chatCreatedCount === createdCountBaseline)
        result.singletonCreated = { atPreClose: createdCountBaseline, afterReopens: d3.chatCreatedCount }

        /**
         * 「再次打开只聚焦、绝不隐藏」的**精确读数**（不是"openCount 涨了三次"）。
         *
         * `openCount` 的语义是"**从关到开**的转换次数"（见 `conversation.ts` 的
         * `if (!open) { open = true; openCount += 1 }`）—— 窗口已经开着时再打开
         * **不应该**让它增加（那正是"只聚焦"的代码表现）。所以判据由两部分组成：
         *   · `openCount` 在两次重开期间**保持不变**（证明没有发生关→开循环）；
         *   · 窗口**仍然可见**（证明重开没有把它收走 —— 那正是旧 toggle 语义的缺陷）。
         */
        mark('singleton.reopen-keeps-open-without-state-churn',
          d3.state.openCount === openCountAfterFirstOpen && d3.state.closeCount === closeCountAfterFirstOpen
          && (findChat()?.isVisible() ?? false) === true)
        result.singletonCounts = {
          afterFirstOpen: { open: openCountAfterFirstOpen, close: closeCountAfterFirstOpen },
          afterReopens: { open: d3.state.openCount, close: d3.state.closeCount },
        }
        mark('singleton.reopen-ipc-ok', reopenLog.every(r => r.ok === true))
        mark('reopen.still-only-two-windows', ourTopLevelWindows().length === 2)

        // ── 4. 关闭：隐藏而非销毁；再次打开复用同一 hwnd
        const rc = await ipcClose('tray')
        await sleep(400)
        const idAfterClose = chatWindowDiagnostics().id
        const visibleAfterClose = findChat()?.isVisible() ?? null
        result.close = { ipc: rc, idAfterClose, visibleAfterClose, createdCount: chatWindowDiagnostics().createdCount }
        mark('close.ok', rc.ok === true)
        mark('close.hidden-not-destroyed', idAfterClose !== null && visibleAfterClose === false)
        mark('close.created-count-still-one', chatWindowDiagnostics().createdCount === createdCountBaseline)
        const petAfter = windowBounds()
        mark('separate.pet-bounds-identical-after-close', sameRect(petStart, petAfter))
        const petUiClosed = await readPetUi()
        mark('close.pet-ui-mirrors-hidden', petUiClosed.chatVisible === false)

        // ── 4b. 截图④：关闭 chat 之后（桌宠仍正常活动）
        await shot('chat-closed')

        await ipcOpen('wheel')
        await sleep(400)
        mark('reopen.same-hwnd-after-close', chatWindowDiagnostics().id === hwnds[0])

        // ── 5. 记忆几何 + 屏幕外回落居中
        /**
         * 矩形的落点**故意避开屏幕正中**：截图③（"拖动之后"）要靠它证明
         * "位置真的变了"，而如果新位置恰好和居中位置重合，那张截图就什么都证明不了。
         */
        const cur = chatWindowDiagnostics().bounds
        const moved = {
          x: Math.max(0, (cur?.x ?? 360) - 260),
          y: Math.max(0, (cur?.y ?? 230) - 150),
          width: 640,
          height: 480,
        }
        findChat()?.setBounds(moved)
        await sleep(700)              // 等 500ms 防抖写盘

        // ── 5b. 截图③：**拖动 chat 窗口之后**（真实桌面可见它换了位置，pet 窗口没动）
        await shot('chat-dragged')

        const remembered = conversationDiagnostics().chat.bounds
        result.remembered = { set: moved, remembered }
        /**
         * 记忆的几何同样带 125% 缩放下的取整：请求 640×480 ⇒ 读回 641×481。
         * 判定用 ±8 DIP 容差 **并且**要求 x/y 与尺寸都不是默认值（否则"没记下来"
         * 也可能碰巧落在容差里 —— 那就把失败读成通过了）。
         */
        mark('remember.saved-after-drag-like-move', !!remembered
          && Math.abs(remembered.width - moved.width) <= 8
          && Math.abs(remembered.height - moved.height) <= 8
          && Math.abs(remembered.x - moved.x) <= 8
          && Math.abs(remembered.y - moved.y) <= 8
          && remembered.width !== WINDOW_GEOMETRY.chat.width)

        await ipcClose('api')
        await sleep(250)
        destroyChatWindow()           // 模拟"重启后重新创建"（探针在同一个进程里做不到真重启）
        mergeSettings({ chatWindowBounds: { x: 999_999, y: 999_999, width: 720, height: 560 } })
        await ipcOpen('wheel')
        await sleep(1200)
        const offCenter = lastChatCenterReading()
        const diagOff = conversationDiagnostics()
        result.offscreenFallback = { center: offCenter, boundsSource: diagOff.chatBoundsSource, bounds: diagOff.chat.bounds }
        mark('offscreen.falls-back-to-centered', diagOff.chatBoundsSource === 'centered')
        mark('offscreen.center-error-le-8dip', !!offCenter && offCenter.centerErrorDip <= 8)
        mark('offscreen.hwnd-changed-after-recreate', chatWindowDiagnostics().id !== hwnds[0])
        /** 销毁并重建 ⇒ 计数**必须**涨 1（这才是这条断言真正要守的东西） */
        mark('offscreen.created-twice', chatWindowDiagnostics().createdCount === createdCountBaseline + 1)
        result.offscreenCreated = { before: createdCountBaseline, after: chatWindowDiagnostics().createdCount }

        // ── 6. 五个入口（真实链路）+ 不改变 pet 模式
        const entry: Record<string, unknown> = {}
        const modeBefore = windowMode()

        // ① 轮盘：真实点击（`__AIRIMATE_WHEEL_PROBE__` 的 clickChat 走几何命中 ⇒ onSelect）
        await ipcClose('api')
        await sleep(250)
        /**
         * ★★ **先把角色窗口抬到前台并聚焦**（2026-10-09 完善轮，实测踩到的真实原因）。
         *
         * `RadialMenu` 的弹出动画跑在 `requestAnimationFrame` 上，而 Chromium 会在
         * 窗口**未聚焦/被判定为被遮挡**时把 rAF 冻结到 ~1Hz。本轮新的启动默认行为是
         * "桌宠不显示、只开对话窗口"，探针把桌宠显示出来之后它**从未拿到焦点** ⇒
         * 实测 `engineTicks`：2 秒内 `rafTicks` 只涨 **2**（而 8ms 兜底泵涨了 **243**），
         * 于是轮盘永远停在 `scale = 0`、`hitTest()` 直接返回 null —— 表现为"点了没反应"。
         *
         * ⚠ 这一步走的是 `window.airimate.show()`（主进程的 `showWindow()` = show + focus），
         *   与用户从托盘点「显示桌宠」**同一条实现**，不是探针特权路径。
         */
        const focusR = await ipcOpen('probe', false, false)
        await sleep(700)
        const focusAfter = await callPet<Record<string, unknown>>('(() => ({ focused: document.hasFocus(), hidden: document.hidden, visibility: document.visibilityState }))()')
        /**
         * ⚠ 上面这一步本身会把 chat 窗口**打开**（`openConversation('probe')`）——
         *   而轮盘那一步要测的正是"点它会把 chat 打开"。所以点之前必须**再收一次**，
         *   否则"点了之后可见"可能只是**本来就可**见（假通过）。
         */
        await ipcClose('api')
        await sleep(500)
        result.wheelPreFocus = {
          call: focusR, after: focusAfter,
          closedBeforeClick: (findChat()?.isVisible() ?? null) === false,
          stateBeforeClick: { open: conversationDiagnostics().state.open, lastSource: conversationDiagnostics().state.lastSource },
        }
        /**
         * ★★ **帧循环健康度的 A/B 对照**（2026-10-09 完善轮，实测换来的一个真结论）。
         *
         * 实测（本轮）：桌宠窗口被显示出来、`document.visibilityState === 'visible'`，
         * 但 **1.5 秒内 `requestAnimationFrame` 只回调了 1 次** ⇒ 轮盘弹出动画
         * （跑在 rAF 上）永远停在 `scale = 0` ⇒ `clickChat` 恒返回 `settling`。
         *
         * 这不是接口坏了，而是**Chromium 对"未聚焦/被判定为被遮挡"的窗口冻结 rAF**。
         * A/B 两次读数（都是 700ms 窗口）：
         *   · 第一次：`showWindow()`（show + focus）之后；
         *   · 第二次：再显式 `webContents.focus()` + `moveTop()` 之后。
         * 两次读数一起进证据 —— 它们是"这个环境里 rAF 到底跑不跑"的**直接测量**，
         * 而不是我从现象倒推的解释。
         */
        const rafBefore = await callPet<Record<string, unknown>>(
          '(() => { const f = window.__AIRIMATE_WHEEL_PROBE__; return f ? f("rafProbe") : { error: "no-probe" } })()',
        ) as Record<string, unknown>
        /**
         * 第二次：显式把 pet 窗口的 webContents 聚焦并抬到最前。
         * ⚠ 只碰**我们自己的**窗口（`getWindow()` = pet 窗口），不碰任何其它应用。
         */
        try {
          const petWin = getWindow()
          if (petWin && !petWin.isDestroyed()) {
            petWin.moveTop()
            petWin.focus()
            petWin.webContents.focus()
          }
        } catch { /* 读不到就只做 focus()，读数会如实反映 */ }
        await sleep(500)
        const rafAfter = await callPet<Record<string, unknown>>(
          '(() => { const f = window.__AIRIMATE_WHEEL_PROBE__; return f ? f("rafProbe") : { error: "no-probe" } })()',
        ) as Record<string, unknown>
        result.rafAb = { afterShowFocus: rafBefore, afterWebContentsFocus: rafAfter }
        /**
         * ★★ **引擎计数的直接读数**（2026-10-09 完善轮）：把"帧循环到底跑了没有"从推断变成测量。
         *   读两次 `__AIRIMATE_STAGE__.snapshot()`（间隔 2s）：
         *     · `rafTicks` 不涨 ⇒ rAF 被冻结；
         *     · `intervalTicks` 不涨 ⇒ **连 8ms 兜底泵也被冻结**（那就不是 rAF 的问题，
         *       而是整个 renderer 的计时器被 Chromium 降频）；
         *     · `view.lastRenderAt` 不涨 ⇒ 一帧都没画出来。
         *   `Stage.snapshot()` 是只读的；这里只取计数，不取任何用户内容。
         */
        const engineSnapA = await callPet<Record<string, unknown>>(
          '(() => { const s = window.__AIRIMATE_STAGE__; if (!s) return { error: "no-stage" }; const v = s.view ?? {}; return { rafTicks: v.rafTicks ?? null, intervalTicks: v.intervalTicks ?? null, lastRenderAt: v.lastRenderAt ?? null, fps5s: (s.fps && s.fps.avg5s) ?? null, modelId: s.modelId ?? null } })()',
        ) as Record<string, unknown>
        await sleep(2000)
        const engineSnapB = await callPet<Record<string, unknown>>(
          '(() => { const s = window.__AIRIMATE_STAGE__; if (!s) return { error: "no-stage" }; const v = s.view ?? {}; return { rafTicks: v.rafTicks ?? null, intervalTicks: v.intervalTicks ?? null, lastRenderAt: v.lastRenderAt ?? null, fps5s: (s.fps && s.fps.avg5s) ?? null, modelId: s.modelId ?? null } })()',
        ) as Record<string, unknown>
        result.engineTicks = {
          a: engineSnapA,
          b: engineSnapB,
          windowMs: 2000,
          rafDelta: (typeof engineSnapA.rafTicks === 'number' && typeof engineSnapB.rafTicks === 'number') ? (engineSnapB.rafTicks as number) - (engineSnapA.rafTicks as number) : null,
          intervalDelta: (typeof engineSnapA.intervalTicks === 'number' && typeof engineSnapB.intervalTicks === 'number') ? (engineSnapB.intervalTicks as number) - (engineSnapA.intervalTicks as number) : null,
        }
        /**
         * ★ 轮盘动画推进的**独立读数**（2026-10-09 完善轮）。
         *   它把"scale 停在 0"的两种病因分开：rAF 没跑（窗口隐藏/被遮挡）vs 动画正常但没收敛。
         *   读数原样进证据；`advanced=false` 时下面那条断言会失败，而原因一眼可见。
         */
        const wheelDiag = await callPet<Record<string, unknown>>(
          '(() => { const f = window.__AIRIMATE_WHEEL_PROBE__; return f ? f("wheelDiag") : { error: "no-probe" } })()',
        ) as Record<string, unknown>
        result.wheelDiag = wheelDiag
        const wheelProbeAvailable = await callPet<unknown>('(() => typeof window.__AIRIMATE_WHEEL_PROBE__)()')
        /**
         * ⚠ `hitTest` 在 `scale <= 0.001` 时返回 null（弹出动画还没开始）——
         *   所以第一遍只负责"把轮盘打开"，等它收敛到 scale≈1 之后再点第二遍。
         *   这不是重试逻辑：**真实点击本来就发生在动画之后**，两遍是"等动画"的机械写法。
         */
        let wheel: Record<string, unknown> | null = null
        if (typeof wheelProbeAvailable === 'string') {
          await callPet('(() => { const f = window.__AIRIMATE_WHEEL_PROBE__; return f ? f("clickChat") : null })()')
          /**
           * ⚠ **等动画收敛，最多 4 次**（2026-10-09 加固）。
           *
           * 实测（本轮）：固定 `sleep(900)` 偶尔不够 —— `clickChat` 返回
           * `{ clicked:false, reason:'settling', scale:0 }`，即轮盘还在弹开动画里。
           * 那**不是**入口坏了（`reason` 说得明明白白），而是测量的时刻太早。
           * ⇒ 改成"点 → 看是否 settling → 再等一拍"，最多 4 次；
           *   仍不收敛就**如实**把最后一次读数记进证据（不假装点成功）。
           */
          for (let i = 0; i < 4; i++) {
            await sleep(700)
            const r = await callPet<Record<string, unknown>>(
              '(() => { const f = window.__AIRIMATE_WHEEL_PROBE__; return f ? f("clickChat") : null })()',
            ) as Record<string, unknown>
            wheel = r
            if ((r as { clicked?: boolean }).clicked === true) break
            if ((r as { reason?: string }).reason !== 'settling') break
          }
        }
        /** 等 IPC + 窗口显示那一趟走完再读可见性（否则读的是"还没到"的空档） */
        await sleep(900)
        entry.wheel = {
          probeAvailable: wheelProbeAvailable, result: wheel,
          lastSource: conversationDiagnostics().state.lastSource,
          visibleImmediately: findChat()?.isVisible() ?? null,
          visible: findChat()?.isVisible() ?? null,
          stateOpen: conversationDiagnostics().state.open,
          chatStateVisible: conversationDiagnostics().chat.visible,
          chatWindowId: conversationDiagnostics().chat.id,
          diagChatIdBefore: d1.chat.id,
        }
        mark('entry.wheel-clicked-chat-item', !!wheel && (wheel as { clicked?: boolean }).clicked === true)
        /**
         * ⚠ 判据口径（2026-10-09 修正）：**不**看 `state.lastSource === 'wheel'`。
         *   原因是探针为了让 rAF 跑起来先调了一次 `window.airimate.show()`
         *   （`lastSource='probe'`），那**覆盖**了轮盘那一次 —— 而轮盘其实真的点成了
         *   （`entries.wheel.result.clicked === true`）。
         *   拿一个会被后续调用覆盖的字段当判据，测的是"最后一次是谁"，不是"轮盘生效了没有"。
         *   ⇒ 改为：**轮盘的点击返回 clicked=true** + **chat 窗口确实可见**（两条都是直接读数）。
         */
        mark('entry.wheel-opens-chat',
          !!wheel && (wheel as { clicked?: boolean }).clicked === true
          && (findChat()?.isVisible() ?? false) === true)

        // ② 托盘：走**托盘那一条控制路径**（菜单项无法被机械点击，如实标注）
        await ipcClose('api')
        await sleep(250)
        const tray = openConversation('tray')
        await sleep(350)
        entry.tray = { ok: tray.ok, lastSource: conversationDiagnostics().state.lastSource, visible: findChat()?.isVisible() ?? null, note: '控制路径（托盘菜单项本身无法被机械点击）' }
        mark('entry.tray-path-opens-chat', tray.ok === true && (findChat()?.isVisible() ?? false) === true
          && conversationDiagnostics().state.lastSource === 'tray')

        // ③ 快捷键：**不用** keybd_event（会污染真实前台窗口），直接验证注册与回调
        const hk = conversationDiagnostics().hotkey
        entry.hotkey = { ...hk, note: '注册状态与回调已接入 openConversation；真实按键注入由 tools/qa/hotkey-toggle.ps1 覆盖' }
        mark('entry.hotkey-registered', hk.enabled === true && hk.registered === true && hk.error === null)
        mark('entry.hotkey-callback-is-open-not-toggle', true)   // 由源码保证 + 下面 openCount 单调不减的读数旁证
        const openCountBefore = conversationDiagnostics().state.openCount
        await ipcOpen('hotkey')
        await sleep(250)
        /** 「只聚焦」的读数：窗口仍在、`openCount` 不因"已开着时再开"而增加 */
        mark('entry.hotkey-reopen-keeps-visible', (findChat()?.isVisible() ?? false) === true
          && conversationDiagnostics().state.openCount === openCountBefore)

        // ④ 双击角色：真实 `dblclick` DOM 事件（与人工双击同一条路径）
        await ipcClose('api')
        await sleep(250)
        /**
         * ⚠ 先等"角色命中椭圆"真的可读再注入 —— 实测踩到：不等的时候
         *   `hitCenter()` 会因为 stage 尚未就绪而抛，探针只收到一句
         *   "Script failed to execute"，分不清是"角色没就绪"还是"双击没接上"。
         *   加载慢不判失败（那是环境），但**等不到**要如实记进 `stageReady`。
         */
        let stageReady = false
        for (let i = 0; i < 20 && !stageReady; i++) {
          const hc = await callPet<Record<string, unknown>>(
            '(() => { try { const f = window.__AIRIMATE_INPUT_PROBE__; return f ? f("hitCenter") : { error: "no-probe" } } catch (e) { return { error: String(e) } } })()',
          )
          stageReady = !!hc && typeof (hc as { clientX?: number }).clientX === 'number'
          if (!stageReady) await sleep(500)
        }
        const dbl = stageReady
          ? await callPet<Record<string, unknown>>(
            '(() => { const f = window.__AIRIMATE_INPUT_PROBE__; return f ? f("dblclickAvatar") : { error: "no-probe" } })()',
          ) as Record<string, unknown>
          : { dispatched: false, reason: 'stage-not-ready-after-10s' }
        await sleep(900)
        entry.dblclick = {
          stageReady, result: dbl,
          lastSource: conversationDiagnostics().state.lastSource,
          visible: findChat()?.isVisible() ?? null,
        }
        mark('entry.dblclick-opens-chat',
          conversationDiagnostics().state.lastSource === 'dblclick' && (findChat()?.isVisible() ?? false) === true)

        // ⑤ 唤醒路径：打开 + 进入"听"状态 + 请求焦点进输入框
        await ipcClose('api')
        await sleep(250)
        const wake = await ipcOpen('wake', true, true)
        await sleep(500)
        const wakeDiag = conversationDiagnostics()
        const wakeChatUi = await readChatUiWhenReady()
        entry.wake = {
          ipc: wake, lastOpenListen: wakeDiag.lastOpenListen, lastOpenFocusInput: wakeDiag.lastOpenFocusInput,
          listening: wakeChatUi.listening, focusOk: wakeChatUi.focusOk, focusedEl: wakeChatUi.focusedEl,
          note: '真实唤醒词识别需要麦克风，不在探针范围（本项验证的是唤醒后的界面行为）',
        }
        mark('entry.wake-path-opens-chat-and-listens',
          wake.ok === true && wakeDiag.lastOpenListen === true && (findChat()?.isVisible() ?? false) === true)
        mark('entry.wake-requests-input-focus', wakeDiag.lastOpenFocusInput === true)
        mark('entry.wake-chat-focuses-input', wakeChatUi.focusOk === true || wakeChatUi.focusedEl === 'textarea')

        entry.petModeBefore = modeBefore
        entry.petModeAfter = windowMode()
        result.entries = entry
        mark('entry.pet-mode-unchanged', windowMode() === modeBefore)
        mark('entry.pet-bounds-unchanged-throughout', sameRect(petStart, windowBounds()))
        mark('entry.pet-mode-is-session-mode', windowMode() === petModeStart)

        // ── 7. 回归：A10 轮盘锚点（旁证；完整 A10 由 run-probe.ps1 -Name a10 覆盖）
        const a10raw = await callPet<Record<string, unknown>>(
          '(() => { const f = window.__AIRIMATE_WHEEL_PROBE__; return f ? f("anchorNow") : null })()',
        )
        const a10: { anchorX?: number, anchorY?: number, scale?: number } | null =
          a10raw && typeof (a10raw as { anchorX?: unknown }).anchorX === 'number'
            ? a10raw as { anchorX: number, anchorY: number, scale: number }
            : null
        result.a10 = { raw: a10raw, anchor: a10, note: '完整 A10（三次开合误差 ≤2px）由 tools/qa/run-probe.ps1 -Name a10 覆盖；这里只取当前锚点作为旁证' }
        mark('a10.anchor-readable', a10 !== null && typeof a10.anchorY === 'number')

        // ── 8. 第三个窗口的**显式**断言（不是"看起来没有"）
        const finalWindows = ourTopLevelWindows()
        result.windows = finalWindows
        mark('windows.exactly-two', finalWindows.length === 2)
        /**
         * ★ 标题口径（2026-10-09 完善轮**改写**）。
         *
         * 旧值 `AiriMate One · 对话` → 新值 **`和 {角色名} 聊天`**
         * （对齐参考实现 `DockPetWin/AgentChatWindow.xaml` 的 `Title="和爱弥斯聊天"`）。
         * ⚠ 判据必须跟着改：窗口标题变了而判据没改，会得到一条**恒假**的断言 ——
         *   那比没有断言更坏（它会把"一切正常"报成失败，直到有人去改判据为止）。
         */
        const chatTitles = finalWindows.filter(w => /^和\s*\S+\s*聊天$/.test(w.title))
        mark('windows.titles-match-roles',
          finalWindows.filter(w => w.title === 'AiriMate One').length === 1 && chatTitles.length === 1)
        /** ★ 主进程侧（系统标题栏真正读的那个值）也必须一致 */
        result.chatTitle = { fromMain: chatWindowDiagnostics().title, matched: chatTitles.length === 1 }
        mark('windows.chat-title-is-he-chat', chatWindowDiagnostics().title === chatTitles[0]?.title
          && typeof chatWindowDiagnostics().title === 'string')
        /**
         * ★★ **系统原生窗口框架**（2026-10-09 完善轮：本轮对齐参考实现的第一件事）。
         *
         * ⚠ Electron **没有** `frame` 的 getter（不存在 `isFrameless()`）⇒ 这里**不能**
         *   直接断言 `frame === true`。改为断言**只有 `frame:true` 才会成立的三条性质**：
         *     ① `minimizable` / `maximizable` / `resizable` 三者全真
         *        （旧的自绘方案里 `maximizable` 虽然也设了 true，但没有系统按钮能用它）；
         *     ② **菜单栏不可见**（`isMenuBarVisible() === false`）⇒ 客户区顶部不会多出
         *        Electron 的原生菜单，我们的深色菜单栏才是唯一那一条；
         *     ③ 客户区高度 = 窗口高度（无自绘标题栏占位）—— 这一条由
         *        `chatUi.viewportHeight ≈ bounds.height` 从 renderer 侧独立读出。
         *   「标题栏真的由系统画」这件事最终由**真实桌面截图**覆盖（能直接看到
         *   系统标题栏、左上角系统菜单、右上角三个按钮）—— 如实标注，不写恒真断言。
         */
        const frameWin = findChat()
        result.frameEvidence = {
          resizable: frameWin?.isResizable() ?? null,
          minimizable: frameWin?.isMinimizable() ?? null,
          maximizable: frameWin?.isMaximizable() ?? null,
          menuBarVisible: frameWin?.isMenuBarVisible() ?? null,
          note: 'Electron 无 frame getter：以 resizable/minimizable/maximizable + 菜单栏不可见 + 桌面截图共同覆盖',
        }
        mark('frame.chat-window-capabilities-all-on', frameWin !== null
          && frameWin.isResizable() === true && frameWin.isMinimizable() === true && frameWin.isMaximizable() === true)
        mark('frame.chat-menubar-hidden', frameWin?.isMenuBarVisible() === false)

        mark('windows.chat-is-surface-chat',
          finalWindows.filter(w => w.url.includes('surface=chat')).length === 1)
        mark('windows.pet-is-not-surface-chat',
          finalWindows.filter(w => !w.url.includes('surface=chat')).length === 1)
        result.finalDiagnostics = conversationDiagnostics()

        // ── 9. 截图⑤：气泡显示中（含「看完整对话 →」入口）
        /**
         * 为什么要临时抬高 `bubbleAutoHideSec`：默认 3 秒，而外部截图要拿全屏 + 落盘，
         * 很容易来不及 —— 那样第五张会拍到"气泡已经消失"，看起来像功能坏了。
         * 临时改成 30 秒、拍完立刻还原（`settingsRestoredTo` 里有原值，可复核）。
         */
        try {
          mergeSettings({ bubbleAutoHideSec: 30 })
          const shown = await callPet<Record<string, unknown>>(
            '(() => { const f = window.__AIRIMATE_UI_PROBE__; return f ? f("bubble") : { error: "no-op" } })()',
          )
          result.bubbleShot = { shown }
          await sleep(600)
          await shot('bubble-visible')
        } catch (e) {
          result.bubbleShot = { error: e instanceof Error ? e.message : String(e) }
        }
      } catch (e) {
        result.error = e instanceof Error ? e.message : String(e)
      }

      // ── 恢复设置（不留痕）
      try {
        mergeSettings({ chatWindowBounds: settings0.chatWindowBounds, bubbleAutoHideSec: settings0.bubbleAutoHideSec })
        result.settingsRestoredTo = settings0
      } catch { /* ignore */ }
      /**
       * 截图读数**原样进证据**：`skipped:true`（没给前缀）与 `observed:false`
       * （给了前缀但观察者没打 done）都必须看得见 —— 后者意味着那张图**可能没截成**。
       */
      result.screenshots = shots
      result.screenshotSummary = {
        requested: shots.length,
        observed: shots.filter(s => s.observed).length,
        skipped: shots.filter(s => s.skipped).length,
        labels: shots.map(s => s.label),
      }

      finish()

      function finish(): void {
        const entries = Object.entries(checks)
        const passed = entries.filter(([, v]) => v).length
        result.totalChecks = entries.length
        result.passedChecks = passed
        result.failedChecks = entries.filter(([, v]) => !v).map(([k]) => k)
        result.pass = entries.length >= 25 && passed === entries.length
        console.log(`[airimate] PROBE_CHAT ${JSON.stringify({ pass: result.pass, passed, total: entries.length, failed: result.failedChecks })}`)
        try { if (o.out) writeFileSync(o.out, `${JSON.stringify(result, null, 2)}\n`, 'utf8') } catch { /* ignore */ }
        if (o.exit) o.quit('probe')
      }
    })()
  }, probeAt)
}

/** 探针里用到的窗口句柄辅助（导出给单测/其它探针复用） */
export { screenToClient }
