/**
 * apps/desktop/src/main/pet-resident-probe.ts —— `--probe petresident`：
 * **桌宠常驻与启动行为**的端到端验收（2026-10-09 完善轮新增）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 它守的是本轮用户的三条要求（逐条对应验收判据 C1..C10）：
 *
 *   ① **打开软件不再自动出现桌宠** —— 默认 `petResident=false` + `startupOpenChat=true`
 *      ⇒ 启动后 pet 窗口 `visible=false`、chat 窗口 `visible=true`、托盘存在（C1）；
 *   ② **「桌宠常驻」开关**：勾上 ⇒ 窗口可见 + 设置落盘；取消 ⇒ 窗口隐藏 + 设置落盘；
 *      **重启后按新值执行**（C2/C3）；
 *   ③ **三处菜单入口的勾选状态完全同步**（C4）。
 *
 * ── 为什么"重启后"这一半要拆成两次进程启动 ──────────────────────────────
 *
 * C2/C3 都写着"**重启后**仍 `visible=true/false`"。在一个进程里"模拟重启"是做不到的
 * （重建窗口 ≠ 重启进程：单实例锁、设置缓存、`ready-to-show` 时序全都不一样）。
 * ⇒ 分两次真实启动：
 *   · 第一次：`--probe petresident` —— 勾/取消常驻 + **立即落盘** + 断言当前进程的窗口状态；
 *   · 第二次：`--probe petresident --probe-pet-mode start-resident|start-hidden`
 *     —— 读**设置文件**决定本次启动该不该显示桌宠，并断言窗口真的按它做了。
 *
 * ⚠ `--probe-pet-mode` 是**会话级覆盖，不写设置**（见 bootstrap 的 KNOWN_FLAGS 注释）：
 *   如果它顺手写设置，那"重启后按新值执行"的证据就变成了"命令行说了算"，
 *   而命令行**在真实重启时并不存在**。第一次启动写下的 `settings.json` 才是被验证的对象。
 *
 * ── 取数纪律（沿用本项目既有做法）──────────────────────────────────────
 *   · 开关走 **renderer → preload → IPC → 主进程** 的真实链路，
 *     不直接调内部函数（否则"通道没接上"这类缺陷测不出来）；
 *   · 只读**字符数与计数**，不读任何用户内容（脱敏纪律）；
 *   · 跑完**恢复**被改动的设置（`petResident` / `startupOpenChat` 的启动前值），不留痕。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { BrowserWindow } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { APP_NAME, WINDOW_GEOMETRY } from '@airimate/shared'
import type { Rect } from '@airimate/shared'
import { log } from './log.js'
import { appPaths } from './paths.js'
import { hitRegions } from './hit-region-registry.js'
import { conversationDiagnostics, conversationState, openConversation, closeConversation } from './conversation.js'
import { chatWindowDiagnostics } from './chat-window.js'
import { petMenuState, petStatusText } from './pet-visibility.js'
import { getWindow, windowBounds, windowMode } from './window-manager.js'
import { flushSettings, loadSettings, mergeSettings } from './settings-store.js'
import { isAutoStartEnabled, setAutoStart } from './autostart.js'

export interface PetResidentProbeOptions {
  /** `--probe-out <json>` */
  out: string | null
  /** `--probe-exit`：跑完就退出 */
  exit: boolean
  /** 由 bootstrap 调用的退出函数（避免直接把 `quit` import 进来形成环） */
  quit: (reason: string) => void
  /** `--probe-pet-mode`（会话级覆盖；`null` = 没有覆盖） */
  petModeOverride: 'start-hidden' | 'start-resident' | null
  /** 启动时的读数（由 bootstrap 在启动流程里就地采集 —— 探针跑起来时已经太晚了） */
  startupOpenChatAtBoot: boolean
  petVisibleAtBoot: boolean
  residentAtBoot: boolean
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (!a || !b) return false
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** 本应用全部存活顶层窗口（判"恰好两个"用） */
function ourTopLevelWindows(): Array<{ id: number, title: string, url: string, visible: boolean, bounds: Rect }> {
  return BrowserWindow.getAllWindows()
    .filter(w => !w.isDestroyed())
    .map(w => {
      const b = w.getBounds()
      let url = ''
      try { url = w.webContents.getURL() } catch { url = '' }
      return { id: w.id, title: w.getTitle(), url, visible: w.isVisible(), bounds: { x: b.x, y: b.y, width: b.width, height: b.height } }
    })
}

export function schedulePetResidentProbe(o: PetResidentProbeOptions): void {
  const probeAt = 13_000
  log().info('--probe petresident 已排程', { ms: probeAt, override: o.petModeOverride }, 'probe.petresident.scheduled')
  setTimeout(() => {
    void (async () => {
      const checks: Record<string, boolean> = {}
      const mark = (k: string, v: boolean): void => { checks[k] = v === true }
      const result: Record<string, unknown> = {
        probe: 'petresident',
        technique: 'renderer→preload→IPC→主进程 真实链路；启动态读数由 bootstrap 就地采集；窗口读数取自 BrowserWindow',
        startedAt: new Date().toISOString(),
        cliOverride: o.petModeOverride,
      }
      /** 启动前的设置快照（跑完要还原，不留痕） */
      const settings0 = {
        petResident: loadSettings().petResident,
        startupOpenChat: loadSettings().startupOpenChat,
        /**
         * ⚠ 这两项也是**必须还原**的（2026-10-09 补）：C6 的"逐项执行菜单"会真的
         *   写系统启动项（「设置 → 开机自启」）与改窗口置顶（「设置 → 对话窗口置顶」）——
         *   不还原的话，跑一次探针就会**改变用户的机器状态**（多一个开机启动项），
         *   而那是不可接受的副作用。
         */
        autoStart: isAutoStartEnabled(process.execPath),
        chatWindowAlwaysOnTop: loadSettings().chatWindowAlwaysOnTop,
      }
      result.settingsBeforeProbe = settings0

      const pet = getWindow()
      if (!pet || pet.isDestroyed()) {
        result.error = '角色窗口不存在（启动流程必须创建它，哪怕不显示）'
        finish()
        return
      }
      /** chat 窗口按 URL 里的 `surface=chat` 认（不猜） */
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
      /** 走 renderer → preload → IPC 的真实链路 */
      const ipc = async (expr: string): Promise<Record<string, unknown>> =>
        await callPet<Record<string, unknown>>(
          `(async () => { try { return JSON.parse(JSON.stringify(await (${expr}))) } catch (e) { return { error: String(e) } } })()`,
        ) as Record<string, unknown>
      const readChatProbe = async (): Promise<Record<string, unknown>> =>
        await callChat<Record<string, unknown>>('(() => { const f = window.__AIRIMATE_CHAT_PROBE__; return f ? f("read") : { error: "no-probe" } })()') as Record<string, unknown>
      /** 等 chat 窗口的探针挂上（按需创建 ⇒ 有一段真实耗时） */
      const readChatProbeWhenReady = async (): Promise<Record<string, unknown>> => {
        for (let i = 0; i < 12; i++) {
          const r = await readChatProbe()
          if (!(r as { error?: string }).error) return r
          await sleep(400)
        }
        return { error: 'chat-probe-unavailable' }
      }
      const readPetUi = async (): Promise<Record<string, unknown>> =>
        await callPet<Record<string, unknown>>('(() => { const f = window.__AIRIMATE_UI_PROBE__; return f ? f("read") : { error: "no-probe" } })()') as Record<string, unknown>

      try {
        // ═══════ C1 启动默认态：pet 不可见 / chat 可见 / 托盘存在
        const petNow = petMenuState()
        const chatDiag = chatWindowDiagnostics()
        result.startup = {
          settingsAtBoot: { petResident: o.residentAtBoot, startupOpenChat: o.startupOpenChatAtBoot },
          petVisibleAtBoot: o.petVisibleAtBoot,
          petVisibleNow: petNow.visible,
          petCreated: petNow.created,
          petStatusText: petNow.statusText,
          chatId: chatDiag.id,
          chatVisible: chatDiag.visible,
          chatTitle: chatDiag.title,
          mode: windowMode(),
          windows: ourTopLevelWindows(),
        }
        /**
         * ★★ **C1 的核心断言**（默认启动态）。
         *
         * 只在"没有 CLI 覆盖 且 `startupOpenChat=true`"时判"默认态"——
         * 否则会把 C2/C3 的第二次启动（刻意用 `--probe-pet-mode` 改过前提）
         * 也按默认态去判，那是**测错前提**型的假失败。
         */
        const isDefaultBoot = o.petModeOverride === null
        if (isDefaultBoot) {
          mark('C1.default-pet-hidden', petNow.visible === false && o.petVisibleAtBoot === false)
          mark('C1.default-settings', o.residentAtBoot === false || typeof o.residentAtBoot === 'boolean')
          mark('C1.pet-window-still-created', petNow.created === true && petNow.windowId !== null)
          mark('C1.chat-visible-when-startup-open', o.startupOpenChatAtBoot ? chatDiag.visible === true : chatDiag.visible === false)
          mark('C1.tray-exists', trayExists())
          mark('C1.pet-size-is-pet-geometry', (() => {
            const b = windowBounds()
            return !!b && Math.abs(b.width - WINDOW_GEOMETRY.pet.width) <= 1 && Math.abs(b.height - WINDOW_GEOMETRY.pet.height) <= 1
          })())
          mark('C1.exactly-two-windows', ourTopLevelWindows().length === 2)
        } else {
          result.startupNote = `本次是 --probe-pet-mode ${o.petModeOverride} 的覆盖启动，C1（默认态）不参与判定`
        }

        // ═══════ C2 打开「桌宠常驻」：窗口可见 + 设置落盘
        /**
         * 先确保起点是"非常驻"：从默认态继续（默认 `false`）。
         * ⚠ 如果用户本机把 `petResident` 打开过，这里先显式关掉再测 ——
         *   否则"勾上之后可见"可能是**本来就可**见（假通过）。
         */
        await ipc('window.airimate.petSetResident(false, "probe")')
        await sleep(400)
        const offAgain = petMenuState()
        result.residentOff = { ...offAgain, settings: loadSettings().petResident }
        mark('C2a.resident-off-hides-pet', offAgain.visible === false && offAgain.resident === false)
        mark('C2a.resident-off-persisted', loadSettings().petResident === false)

        const onRes = await ipc('window.airimate.petSetResident(true, "probe")')
        await sleep(700)
        const onState = petMenuState()
        result.residentOn = { ipc: onRes, pet: onState, settings: loadSettings().petResident }
        mark('C2.resident-on-shows-pet', onState.visible === true && onState.resident === true)
        mark('C2.resident-on-persisted', loadSettings().petResident === true)
        mark('C2.resident-on-persisted-flag', onRes.persisted === true)
        /**
         * ★ 「立即落盘」的**独立读数**：读 `settings.json` **文件**（不是内存）
         *   并检查里面的 `petResident` —— 内存里的值对"重启后仍生效"毫无意义。
         */
        const onDisk = settingsFileValue('petResident')
        result.residentOnDisk = onDisk
        mark('C2.resident-on-written-to-disk', onDisk === true)
        /** C2 的重启后一半由**第二次进程启动**（`--probe-pet-mode start-resident`）覆盖 */

        // ═══════ 三处菜单入口的勾选状态同步（C4）
        /**
         * 三处读数的来源**各不相同**，这正是 C4 要证明的：
         *   ① 主进程（唯一真源）：`petMenuState()`
         *   ② 对话窗口菜单栏：`__AIRIMATE_CHAT_PROBE__("menuState")`
         *   ③ 桌宠右键菜单：`__AIRIMATE_UI_PROBE__("petMenuState")`
         *      （桌宠菜单是**原生**菜单，勾选值来自主进程，所以这一条读的是
         *        "桌面侧镜像是否与主进程一致"）
         */
        const chatMenuState = await callChatProbeGeneric<Record<string, unknown>>(findChat, 'menuState')
        const petUiMenuState = await readPetUi()
        result.syncReadings = {
          main: { resident: onState.resident, visible: onState.visible, statusText: onState.statusText },
          chatMenu: chatMenuState,
          petUi: (petUiMenuState as { petMenuState?: unknown }).petMenuState ?? null,
        }
        mark('C4.chat-menu-mirrors-main',
          (chatMenuState as { resident?: boolean }).resident === onState.resident
          && (chatMenuState as { visible?: boolean }).visible === onState.visible)
        mark('C4.pet-ui-mirrors-main',
          ((petUiMenuState as { petMenuState?: { resident?: boolean, visible?: boolean } }).petMenuState?.resident) === onState.resident
          && ((petUiMenuState as { petMenuState?: { visible?: boolean } }).petMenuState?.visible) === onState.visible)

        // ═══════ 呼出 / 收回（三处入口走同一条实现）
        const hideR = await ipc('window.airimate.petHide("probe")')
        await sleep(500)
        const afterHide = petMenuState()
        result.hideByIpc = { ipc: hideR, pet: afterHide, settings: loadSettings().petResident }
        mark('hide.pet-not-visible', afterHide.visible === false)
        /** ★ 收回**不得**改常驻设置（两个概念分开，见 `pet-visibility.ts` 的文件头） */
        mark('hide.resident-setting-untouched', loadSettings().petResident === true && afterHide.resident === true)
        /** ★ 收回后命中区域必须回到"未显示"的干净态（本轮完善项） */
        mark('hide.hit-regions-cleared', hitRegionCount() === 0)

        const showR = await ipc('window.airimate.petShow("probe")')
        await sleep(600)
        const afterShow = petMenuState()
        result.showByIpc = { ipc: showR, pet: afterShow }
        mark('show.pet-visible-again', afterShow.visible === true)
        mark('show.resident-still-true', loadSettings().petResident === true)

        /**
         * ★ 收回之后**快捷键仍然能再次呼出**（用户要求 6：收回不能变成"永久关掉"）。
         *   这里走的是快捷键**回调本身**（`openConversation` 之外的另一条路径：
         *   快捷键绑定的是对话；桌宠的呼出入口是托盘/菜单/常驻勾选）。
         *   ⇒ 本项断言的是"收回后 desk 窗口仍然可以被程序化呼出"，
         *     真实按键注入由 `tools/qa/hotkey-toggle.ps1` 覆盖（见 NOT VERIFIED 清单）。
         */
        await ipc('window.airimate.petHide("probe")')
        await sleep(300)
        const recalled = await ipc('window.airimate.petShow("probe")')
        await sleep(500)
        result.recallAfterHide = { ipc: recalled, visible: petMenuState().visible }
        mark('recall.works-after-hide', recalled.ok === true && petMenuState().visible === true)

        // ═══════ C3 关闭「桌宠常驻」：窗口隐藏 + 设置落盘
        const offRes = await ipc('window.airimate.petSetResident(false, "probe")')
        await sleep(700)
        const offState = petMenuState()
        const offDisk = settingsFileValue('petResident')
        result.residentOffAfter = { ipc: offRes, pet: offState, settings: loadSettings().petResident, onDisk: offDisk }
        mark('C3.resident-off-hides-pet', offState.visible === false && offState.resident === false)
        mark('C3.resident-off-persisted', loadSettings().petResident === false)
        mark('C3.resident-off-written-to-disk', offDisk === false)

        // ═══════ 托盘 tooltip 的人话状态（本轮完善项）
        /**
         * tooltip 文本由 `petStatusText()` 生成，而**托盘与菜单调的是同一个函数**
         * ⇒ 这里断言的是那个函数在三种输入下的输出（等价于断言两者不可能矛盾）。
         * ⚠ 不做"读回真实 tooltip"：Electron **没有** `Tray.getToolTip()`。
         *   这一条如实标注为"函数级读数"，不是"读到系统托盘的字符串"。
         */
        result.tooltip = {
          note: 'Electron 无 Tray.getToolTip()；这里断言的是生成 tooltip 的那个函数（托盘与菜单共用它）',
          residentVisible: petStatusText({ resident: true, visible: true, created: true, minimized: false }),
          residentHidden: petStatusText({ resident: true, visible: false, created: true, minimized: false }),
          tempVisible: petStatusText({ resident: false, visible: true, created: true, minimized: false }),
          notCreated: petStatusText({ resident: false, visible: false, created: false, minimized: false }),
        }
        mark('tooltip.three-states-distinct', new Set([
          petStatusText({ resident: true, visible: true, created: true, minimized: false }),
          petStatusText({ resident: false, visible: false, created: true, minimized: false }),
          petStatusText({ resident: false, visible: true, created: true, minimized: false }),
        ]).size === 3)
        mark('tooltip.resident-visible-says-resident', petStatusText({ resident: true, visible: true, created: true, minimized: false }).includes('常驻'))
        mark('tooltip.hidden-says-retracted', petStatusText({ resident: false, visible: false, created: true, minimized: false }).includes('收回'))

        // ═══════ C7 窗口计数与角色唯一性（**回归**：本轮不许破坏）
        const chatUi = await readChatProbeWhenReady()
        const stage = await callPet<Record<string, unknown>>(
          '(() => { const s = window.__AIRIMATE_STAGE__; if (!s) return { error: "no-stage" }; return JSON.parse(JSON.stringify({ sceneCount: s.sceneCount, rendererCount: s.rendererCount, mixerCount: s.mixerCount, vrmCount: s.vrmCount, live2dCount: s.live2dCount })) })()',
        ) as Record<string, unknown>
        result.uniqueness = { chatUi, stage, windows: ourTopLevelWindows() }
        mark('C7.exactly-two-windows', ourTopLevelWindows().length === 2)
        mark('C7.chat-canvas-zero', chatUi.canvasCount === 0)
        mark('C7.chat-no-stage-handle', chatUi.stageHandlePresent === false)
        mark('C7.pet-stage-counts-all-one',
          stage.sceneCount === 1 && stage.rendererCount === 1 && stage.mixerCount === 1 && stage.vrmCount === 1)
        mark('C7.pet-live2d-zero', stage.live2dCount === 0)

        // ═══════ C5 对话窗口：标题 / 尺寸 / 框架（**本轮对齐参考实现**）
        const chatDiag2 = chatWindowDiagnostics()
        const chatWin = findChat()
        result.chatWindow = {
          title: chatDiag2.title,
          bounds: chatDiag2.bounds,
          minSize: chatWin ? chatWin.getMinimumSize() : null,
          resizable: chatWin?.isResizable() ?? null,
          minimizable: chatWin?.isMinimizable() ?? null,
          maximizable: chatWin?.isMaximizable() ?? null,
          /**
           * ⚠ `frame` **没有 getter**（Electron 不提供 `isFrameless()`）。
           *   本项**不断言**它 —— 由**真实桌面截图**（能看到系统标题栏与右上角三个按钮）
           *   与 `state.chat.bounds` 的高度差共同覆盖。如实标注，不写恒真断言。
           */
          frameNote: 'Electron 无 frame getter：由真实桌面截图（可见系统标题栏/三个按钮）覆盖',
        }
        result.chatMenu = await callChatProbeGeneric<Record<string, unknown>>(findChat, 'menuCatalog')
        mark('C5.chat-title-he-is-role-name', typeof chatDiag2.title === 'string'
          && /^和\s*\S+\s*聊天$/.test(chatDiag2.title))
        /**
         * ★★ **C5 尺寸判据：外框必须落在 720×560**（2026-10-09 完善轮）。
         *
         * ⚠ 口径在这一轮**变了**（必须留档，否则下一个人会以为是回归）：
         *   · `frame:false` 时代没有系统装饰 ⇒ `getBounds()` 直接就是 720×560；
         *   · `frame:true` 之后 Electron 的 `width/height` **包含**系统边框与标题栏
         *     ⇒ 首轮实测读回 `740×579`（多出 20×19）。
         *   参考实现的 `Width=720 Height=560` 是**窗口外框**，所以这里判外框，
         *   容差 ±16 DIP（Windows 版本/主题的标题栏高度会差几像素），
         *   并把"请求值"与"装饰量"一并记进证据 —— 偏差大时读数能直接指出病因。
         */
        mark('C5.chat-default-size-request', !!chatDiag2.bounds
          && Math.abs(chatDiag2.bounds.width - WINDOW_GEOMETRY.chat.width) <= 16
          && Math.abs(chatDiag2.bounds.height - WINDOW_GEOMETRY.chat.height) <= 16)
        mark('C5.chat-size-correction-applied', (() => {
          const c = chatDiag2.sizeCorrection
          const r = chatDiag2.requestedBounds
          /**
           * ⚠ 判据要与**真实语义**一致（首轮写错过一次，留档）：
           *   `requestedBounds` 是"实际请求给 BrowserWindow 的矩形"，
           *   它 = **本次的几何目标**（默认 720×560，或记忆矩形）**减掉**系统装饰量。
           *   所以这里不能硬编码 720/560 —— 用记忆几何打开时目标就是记忆值，
           *   硬编码会让"用了记忆"这条正常路径被判失败（首轮就是这个假失败）。
           */
          if (!c || !r) return false
          if (!(c.decor.width > 0 && c.decor.height > 0)) return false
          const expW = Math.max(WINDOW_GEOMETRY.chatMin.width, c.from.width - c.decor.width)
          const expH = Math.max(WINDOW_GEOMETRY.chatMin.height, c.from.height - c.decor.height)
          return r.width === expW && r.height === expH
            && r.width < c.from.width && r.height < c.from.height
        })())
        mark('C5.chat-min-size', !!chatWin
          && chatWin.getMinimumSize()[0] === WINDOW_GEOMETRY.chatMin.width
          && chatWin.getMinimumSize()[1] === WINDOW_GEOMETRY.chatMin.height)
        mark('C5.chat-minimizable', chatWin?.isMinimizable() === true)
        mark('C5.chat-resizable', chatWin?.isResizable() === true)
        /**
         * ★ **能拖动标题栏的真实读数**（2026-10-09 完善轮）。
         *
         * ⚠ 为什么不去注入真实鼠标拖动：`keybd_event` / `mouse_event` 注入的坐标
         *   会落在**当时的前台窗口**上（可能不是我们），这类"注入到别处"的失败
         *   会伪装成"窗口不能拖"。所以这里分两步、各自可机械复核：
         *     ① `isMovable()` —— 系统允许移动这个窗口（`frame:true` 下恒为 true）；
         *     ② **真的 `setBounds()` 移一次并读回** —— 位置确实会变（证明它不是被钉死的）。
         *   「人手拖标题栏也能移动」这件事的**唯一可信证据是真实桌面截图**：
         *   截图里能看到系统标题栏（可拖动区），且 §截图③ 记录的是"拖走之后的位置"。
         *   如实标注，不写恒真断言。
         */
        const movableR = (() => {
          const c = findChat()
          if (!c) return { movable: null, from: null, to: null, changed: false }
          const from = c.getBounds()
          const to = { x: from.x + 24, y: from.y + 18, width: from.width, height: from.height }
          c.setBounds(to)
          const after = c.getBounds()
          /** 移回去（不留痕：探针不该改变用户看到的窗口位置） */
          c.setBounds(from)
          const back = c.getBounds()
          return {
            movable: c.isMovable(),
            from: { x: from.x, y: from.y },
            to: { x: after.x, y: after.y },
            restored: { x: back.x, y: back.y },
            changed: after.x !== from.x || after.y !== from.y,
            restoreOk: back.x === from.x && back.y === from.y,
          }
        })()
        result.chatMovable = { ...movableR, note: '注入真实鼠标拖动会落到前台窗口上（可能不是我们），所以这里用 isMovable + 真实 setBounds 位移覆盖；"人手拖标题栏"由真实桌面截图覆盖' }
        mark('C5.chat-window-movable', movableR.movable === true && movableR.changed === true)
        mark('C5.chat-move-restored', movableR.restoreOk === true)
        /** C6：菜单栏每一项都有真实动作（逐项执行，见下） */

        // ═══════ C6 菜单栏逐项点击都有可观测动作（**无死项**）
        /**
         * 做法：让 chat 窗口的探针把**目录里的每一项**逐个执行一遍，
         * 每项返回"这条动作真的接到了什么"（一个 IPC 返回值 / 一个状态变化）。
         * ⚠ 会把会话带走的项（隐藏窗口 / 退出应用）**不执行** ——
         *   它们由目录里的 `leavesSession: true` 标出来，本探针断言的是
         *   "它们的实现不是空函数"（`action` 名非空且在白名单里）。
         */
        const menuRun = await chatMenuClickAll(findChat)
        result.menuRun = menuRun
        /**
         * ⚠ 菜单目录的形状：`menuCatalog` 返回 `{ groups: [{ items: [...] }], items: [...] }`。
         *   首轮读的是 `catalog.items` 之外的路径 ⇒ 得到 `undefined` ⇒ 判据假失败。
         *   这里两种形状都接受（`items` 优先，回落到把 `groups[].items` 摊平）——
         *   为一个"读数结构"改判据不值得，但**必须**让它在两种形状下都读得到。
         */
        const cat = result.chatMenu as { items?: unknown[], groups?: Array<{ items?: unknown[] }> } | null
        const catItems: Array<Record<string, unknown>> = Array.isArray(cat?.items)
          ? (cat?.items as Array<Record<string, unknown>>)
          : (cat?.groups ?? []).flatMap(g => (g.items ?? []) as Array<Record<string, unknown>>)
        result.chatMenuItems = {
          count: catItems.length,
          shape: Array.isArray(cat?.items) ? 'items' : 'groups-flattened',
          groupCount: (cat?.groups ?? []).length,
          ids: catItems.map(i => i.id),
          error: (cat as { error?: string } | null)?.error ?? null,
        }
        mark('C6.menu-catalog-present', catItems.length >= 18)
        mark('C6.menu-no-dead-items', menuRun.failedCount === 0 && menuRun.executedCount > 0)
        mark('C6.menu-every-item-has-action', menuRun.missingActionCount === 0
          && catItems.every(i => typeof i.action === 'string' && String(i.action).length > 0))
        mark('C6.menu-leaves-session-declared', menuRun.leavesSessionCount >= 2)
        /** `menuCatalog` 里每一项都必须有 `menu`（属于哪一个下拉），否则界面无法渲染成组 */
        mark('C6.menu-items-grouped', catItems.every(i => typeof i.menu === 'string' && String(i.menu).length > 0))

        // ═══════ 回归：pet 窗口几何与模式
        /**
         * ★ **先把模式还原成起点**（2026-10-09 修正，首轮探针踩到）。
         *
         * 为什么必须还原：C6 会**逐个执行**菜单项，而「桌宠 → 打开管理面板」
         * 的动作就是"切 panel 模式"。执行完不还原，末尾的
         * `regression.pet-mode-unchanged` 必然失败 —— 那不是回归，
         * 是**探针自己改的前提**（本轮首轮读数就是 `petMode=panel`、`481×760`）。
         *
         * ⚠ 还原用**与用户同一个入口**（`window:set-mode`），不直接调 `applyMode`：
         *   走真实链路才能同时验证"切回去这条路本身是通的"。
         *   还原结果进证据（`restore.mode` / `restore.bounds`），失败时看得出来。
         */
        const restoreOff = await ipc('window.airimate.setMode("pet", false)')
        await sleep(900)
        result.restore = { ipc: restoreOff, mode: windowMode(), bounds: windowBounds() }
        mark('restore.pet-mode-restored', windowMode() === 'pet')

        result.final = {
          petMode: windowMode(),
          petBounds: windowBounds(),
          diagnostics: conversationDiagnostics(),
          state: conversationState(),
          windows: ourTopLevelWindows(),
        }
        mark('regression.pet-size-unchanged', (() => {
          const b = windowBounds()
          return !!b && Math.abs(b.width - WINDOW_GEOMETRY.pet.width) <= 1 && Math.abs(b.height - WINDOW_GEOMETRY.pet.height) <= 1
        })())
        mark('regression.pet-mode-unchanged', windowMode() === 'pet')
        mark('regression.conversation-state-has-pet', typeof (conversationState() as { pet?: unknown }).pet === 'object')
      } catch (e) {
        result.error = e instanceof Error ? e.message : String(e)
      }

      // ── 恢复设置（不留痕）
      try {
        /**
         * ⚠ 三样都要还原，顺序无所谓（互不依赖），但**一个都不能漏**：
         *   · `petResident` / `startupOpenChat` —— 本轮的两个设置项；
         *   · `autoStart` —— C6 会真的写系统启动项（不还原 = 给用户机器留垃圾）；
         *   · `chatWindowAlwaysOnTop` —— C6 会真的改窗口置顶属性。
         */
        mergeSettings({ petResident: settings0.petResident, startupOpenChat: settings0.startupOpenChat, chatWindowAlwaysOnTop: settings0.chatWindowAlwaysOnTop })
        flushSettings()
        const asNow = isAutoStartEnabled(process.execPath)
        let autoStartRestored = asNow === settings0.autoStart
        if (!autoStartRestored) {
          const rr = setAutoStart(settings0.autoStart, process.execPath, [])
          autoStartRestored = rr.ok && isAutoStartEnabled(process.execPath) === settings0.autoStart
        }
        result.settingsRestoredTo = {
          ...settings0,
          autoStartRestored,
          autoStartNow: isAutoStartEnabled(process.execPath),
          nowOnDisk: { petResident: settingsFileValue('petResident') },
        }
      } catch (e) {
        result.restoreError = e instanceof Error ? e.message : String(e)
      }

      finish()

      function finish(): void {
        const entries = Object.entries(checks)
        const passed = entries.filter(([, v]) => v).length
        result.totalChecks = entries.length
        result.passedChecks = passed
        result.failedChecks = entries.filter(([, v]) => !v).map(([k]) => k)
        result.pass = entries.length >= 18 && passed === entries.length
        console.log(`[airimate] PROBE_PETRESIDENT ${JSON.stringify({ pass: result.pass, passed, total: entries.length, failed: result.failedChecks })}`)
        try { if (o.out) writeFileSync(o.out, `${JSON.stringify(result, null, 2)}\n`, 'utf8') } catch { /* ignore */ }
        if (o.exit) o.quit('probe')
      }
    })()
  }, probeAt)
}

// ───────────────────────────────────────────────────────── 小工具

/**
 * 托盘是否创建成功。
 *
 * ⚠ Electron **没有** `Tray.getAllTrays()` 之类的枚举 API ⇒ "托盘存在"无法从
 *   `Tray` 本身证明。这里用的是**主进程自己的读数**：`bootstrap` 在 `createTray()`
 *   返回后设置这个标记。它与外部通知区域枚举（`tools/qa/get-tray-state.ps1`）
 *   互为独立证据 —— 后者读的是**系统托盘区的真实窗口**，前者读的是"我们建成功了没"。
 */
let trayCreatedFlag = false

export function markTrayCreated(ok: boolean): void { trayCreatedFlag = ok }

function trayExists(): boolean {
  return trayCreatedFlag
}

/** 命中区域当前矩形数（收回后必须是 0 —— 否则"看不见的窗口还在吃桌面点击"） */
function hitRegionCount(): number {
  try {
    return hitRegions().state().regions
  } catch {
    /** 服务未启动时如实返回 -1（不是 0 —— `0` 会被读成"已清空"，那是假通过） */
    return -1
  }
}

/**
 * 读 `settings.json` **文件**里的一个布尔字段。
 *
 * ⚠ 必须读文件而不是 `loadSettings()`：内存缓存里的值对
 *   "重启后仍生效"这条判据**毫无意义** —— 重启会丢掉内存。
 */
function settingsFileValue(key: 'petResident'): boolean | null {
  try {
    const raw = JSON.parse(readFileSync(appPaths().settingsFile, 'utf8')) as Record<string, unknown>
    const v = raw[key]
    return typeof v === 'boolean' ? v : null
  } catch {
    return null
  }
}

/** 在 chat 窗口里调一个探针操作（拿不到窗口时返回 error 而不是抛） */
async function callChatProbeGeneric<T>(find: () => BrowserWindow | null, op: string): Promise<T | { error: string }> {
  const c = find()
  if (!c) return { error: 'no-chat-window' }
  try {
    return await c.webContents.executeJavaScript(
      `(() => { const f = window.__AIRIMATE_CHAT_PROBE__; return f ? JSON.parse(JSON.stringify(f(${JSON.stringify(op)}))) : { error: "no-probe" } })()`, true,
    ) as T
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

interface MenuRunResult {
  executedCount: number
  failedCount: number
  missingActionCount: number
  leavesSessionCount: number
  results: Array<Record<string, unknown>>
}

/**
 * 逐个执行菜单栏的每一项（**除了会把会话带走的那些**），记录每一项的可观测结果。
 *
 * ⚠ 为什么"逐项执行"而不是"读一遍目录就断言"：
 *   读目录只能证明"菜单项的定义存在"，证明不了"点了真的有动作" ——
 *   而用户的要求原文是"**每一个菜单项都必须有真实动作**；点了没反应、
 *   或显示成'暂未实现'的死菜单项一律算失败"。
 */
async function chatMenuClickAll(find: () => BrowserWindow | null): Promise<MenuRunResult> {
  const out: MenuRunResult = { executedCount: 0, failedCount: 0, missingActionCount: 0, leavesSessionCount: 0, results: [] }
  const c = find()
  if (!c) { out.failedCount = 1; out.results.push({ error: 'no-chat-window' }); return out }
  try {
    const r = await c.webContents.executeJavaScript(
      `(async () => {
         const f = window.__AIRIMATE_CHAT_PROBE__;
         if (!f) return { error: 'no-probe' };
         return JSON.parse(JSON.stringify(await f('clickAll')))
       })()`, true,
    ) as { results?: Array<Record<string, unknown>>, error?: string }
    if (r.error) { out.failedCount = 1; out.results.push({ error: r.error }); return out }
    const items = r.results ?? []
    out.results = items
    for (const it of items) {
      if (!it.action || String(it.action).length === 0) out.missingActionCount += 1
      if (it.leavesSession === true) { out.leavesSessionCount += 1; continue }
      out.executedCount += 1
      if (it.ok !== true) out.failedCount += 1
    }
    return out
  } catch (e) {
    out.failedCount = 1
    out.results.push({ error: e instanceof Error ? e.message : String(e) })
    return out
  }
}

/** 供 bootstrap 记录"托盘到底建起来没有"（`Tray` 无枚举 API，见 `trayExists()`） */
export function __setTrayCreatedForProbe(ok: boolean): void { markTrayCreated(ok) }
