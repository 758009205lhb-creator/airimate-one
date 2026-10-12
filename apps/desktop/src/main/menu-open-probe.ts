/**
 * apps/desktop/src/main/menu-open-probe.ts —— `--probe menuopen`：
 * **菜单栏展开态**与**桌宠右键菜单**的取证探针（2026-10-09 完善轮新增）
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 它存在的理由（一句话）：**"菜单栏展开"这件事没法靠截屏脚本自己造出来**。
 *
 * 判据 C9 要求两张截图：④ 对话窗口菜单栏展开、⑤ 桌宠右键菜单展开。
 * 而"展开"是**瞬时状态**：
 *   · 对话窗口的下拉是 Vue 的渲染态 —— 外面用 `CopyFromScreen` 的脚本按不到它，
 *     唯一能确定它真的展开了的地方**就在页面里**；
 *   · 桌宠右键菜单是主进程的**原生** `Menu.popup()` —— 要弹它必须调主进程。
 * ⇒ 用**哨兵握手**（`probe-sentinel.ts`，本项目已有机制）：
 *
 *     探针展开菜单 → 写 `<前缀>-<label>.ready` → 外部截图并写 `.done` → 探针继续
 *
 * ⚠ 与"用 `mouse_event` 真点一下"的区别（我选前者的原因）：
 *   注入的系统级鼠标坐标会落在**当时的前台窗口**上（可能是别的应用）——
 *   一次"点到别处"的失败会伪装成"菜单打不开"，而归因方向完全错了。
 *   这里改走**页面内 DOM 路径**（`menuOpen` 探针操作）与
 *   **窗口内输入注入**（`webContents.sendInputEvent`，坐标相对本窗口），
 *   两者都不会碰到别的应用。
 *
 * ⚠ 展开之后会**自己核实**（不是"调了就说展开了"）：
 *   · 对话菜单：读 `.chatw__dropdown` 的分组 id、项数与像素矩形；
 *   · 桌宠菜单：读 `menu.popup()` 的**返回值**（本项目的 `PET_MENU` 通道在
 *     弹出失败时返回 `ok:false`），并把那一刻的 `petMenuState()` 一起记进证据。
 * ════════════════════════════════════════════════════════════════════════════
 */
import { BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { log } from './log.js'
import { sentinel, type SentinelReading } from './probe-sentinel.js'
import { petMenuState } from './pet-visibility.js'
import { getWindow } from './window-manager.js'

export interface MenuOpenProbeOptions {
  /** `--probe-out <json>` */
  out: string | null
  /** `--probe-exit`：跑完就退出 */
  exit: boolean
  /** `--probe-shot <前缀>`：截图握手前缀（**不给前缀 = 这一轮是未执行，不是通过**） */
  shotPrefix: string | null
  /** 由 bootstrap 调用的退出函数 */
  quit: (reason: string) => void
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

export function scheduleMenuOpenProbe(o: MenuOpenProbeOptions): void {
  const probeAt = 12_000
  log().info('--probe menuopen 已排程', { ms: probeAt, shotPrefix: o.shotPrefix ? 'given' : 'none' }, 'probe.menuopen.scheduled')
  setTimeout(() => {
    void (async () => {
      const checks: Record<string, boolean> = {}
      const mark = (k: string, v: boolean): void => { checks[k] = v === true }
      const result: Record<string, unknown> = {
        probe: 'menuopen',
        technique: '对话菜单走页面内 DOM（menuOpen 探针操作）；桌宠菜单走主进程 Menu.popup + 窗口内 sendInputEvent；两张图由外部脚本按哨兵握手截',
        startedAt: new Date().toISOString(),
      }
      const shots: SentinelReading[] = []
      const shot = async (label: string): Promise<void> => {
        const r = await sentinel(o.shotPrefix, label)
        shots.push(r)
        log().info('菜单截图握手完成', { label, observed: r.observed, waitedMs: r.waitedMs, skipped: r.skipped }, 'probe.menuopen.sentinel')
      }

      const pet = getWindow()
      if (!pet || pet.isDestroyed()) {
        result.error = '角色窗口不存在'
        finish()
        return
      }
      const findChat = (): BrowserWindow | null =>
        BrowserWindow.getAllWindows().find(w => {
          if (w.isDestroyed()) return false
          try { return w.webContents.getURL().includes('surface=chat') } catch { return false }
        }) ?? null
      const callChat = async <T>(expr: string): Promise<T | { error: string }> => {
        const c = findChat()
        if (!c) return { error: 'no-chat-window' }
        try { return await c.webContents.executeJavaScript(expr, true) as T } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) }
        }
      }
      /** 等 chat 窗口的探针挂上（按需创建 ⇒ 有一段真实耗时） */
      const waitChatProbe = async (): Promise<boolean> => {
        for (let i = 0; i < 15; i++) {
          const r = await callChat<unknown>('(() => typeof window.__AIRIMATE_CHAT_PROBE__)()')
          if (r === 'function') return true
          await sleep(400)
        }
        return false
      }

      try {
        // ── 0. 前置：对话窗口必须在（本轮默认启动就是开着的；关了就再打开）
        const chatReady = await waitChatProbe()
        result.chatProbeReady = chatReady
        mark('probe.chat-probe-ready', chatReady)
        result.petState = petMenuState()

        // ═══════ ① 对话窗口菜单栏：**每一个下拉都打开一次**并核实 DOM
        /**
         * 为什么逐个菜单都拍/都核实（而不是只拍一个）：
         *   "菜单栏存在"与"每一个下拉都能展开"是两件事 ——
         *   某一个下拉因为渲染条件写错而永远打不开，在只拍一个的取巧做法下**发现不了**。
         *   逐组的读数进证据（组 id / 项数 / 像素矩形）。
         */
        const groups = ['file', 'pet', 'chat', 'memory', 'settings', 'help']
        const menus: Array<Record<string, unknown>> = []
        for (const g of groups) {
          const open = await callChat<Record<string, unknown>>(
            `(() => { const f = window.__AIRIMATE_CHAT_PROBE__; return f ? JSON.parse(JSON.stringify(f("menuOpen", ${JSON.stringify(g)}))) : { error: "no-probe" } })()`,
          ) as Record<string, unknown>
          await sleep(260)
          const read = await callChat<Record<string, unknown>>(
            '(() => { const f = window.__AIRIMATE_CHAT_PROBE__; return f ? JSON.parse(JSON.stringify(f("read"))) : { error: "no-probe" } })()',
          ) as Record<string, unknown>
          const box = await callChat<Record<string, unknown>>(
            '(() => { const el = document.querySelector(".chatw__dropdown"); if (!el) return { present: false }; const r = el.getBoundingClientRect(); return { present: true, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), items: el.querySelectorAll(".chatw__menuitem").length } })()',
          ) as Record<string, unknown>
          menus.push({ group: g, openResult: open, menuBar: read.menuBar ?? null, dropdown: box })
          if (g === 'file') {
            /** 只拍第一组（六张图里那一张就是"菜单栏展开"）；其余组只取读数 */
            await shot('chat-menu-file')
          }
        }
        result.chatMenus = menus
        const allOpened = menus.every(m => (m.dropdown as { present?: boolean } | undefined)?.present === true
          && ((m.dropdown as { items?: number } | undefined)?.items ?? 0) >= 2)
        mark('chatmenu.all-groups-openable', allOpened)
        mark('chatmenu.dropdown-has-pixel-box', menus.every(m => ((m.dropdown as { w?: number } | undefined)?.w ?? 0) > 60))
        /** 关掉所有下拉（不要给后面的截图留下打开着的菜单） */
        await callChat('(() => { const f = window.__AIRIMATE_CHAT_PROBE__; return f ? f("menuClose") : null })()')
        await sleep(200)

        // ═══════ ② 桌宠右键菜单：**窗口内输入注入**（坐标相对本窗口，不碰别的应用）
        const petMenuBefore = petMenuState()
        const size = pet.getContentBounds()
        const px = Math.round(size.width / 2)
        const py = Math.round(size.height * 0.55)
        let injected = false
        try {
          pet.webContents.sendInputEvent({ type: 'mouseMove', x: px, y: py })
          pet.webContents.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'right', clickCount: 1 })
          pet.webContents.sendInputEvent({ type: 'mouseUp', x: px, y: py, button: 'right', clickCount: 1 })
          injected = true
        } catch (e) {
          result.petMenuInjectError = e instanceof Error ? e.message : String(e)
        }
        /**
         * ⚠ 这里**必须**等一拍再截图：`Menu.popup()` 是异步弹出的，
         *   紧接着截图会拍到"菜单还没画出来"的一帧 —— 那张图什么也证明不了。
         */
        await sleep(900)
        result.petMenu = {
          injected,
          point: { x: px, y: py },
          contentBounds: { width: size.width, height: size.height },
          stateBefore: petMenuBefore,
          stateAfter: petMenuState(),
          /**
           * ⚠ **如实标注能力边界**：Electron **没有**"菜单是否正开着"的查询 API
           *   （`Menu` 对象没有 `isOpen()`）。所以这里**不能**断言"菜单真的弹出来了" ——
           *   能断言的是"注入成功 + 那一刻桌宠窗口可见且聚焦 + 截图里能看到菜单"。
           */
          note: 'Electron 无 Menu.isOpen()：注入成功与截图是两条独立证据，不做"菜单已弹出"的机器断言',
        }
        mark('petmenu.injected-into-pet-window', injected)
        await shot('pet-menu-open')
        /** 关掉原生菜单（Esc 送进 pet 窗口） */
        try {
          pet.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
          pet.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
        } catch { /* ignore */ }
        await sleep(300)

        // ═══════ 收尾读数
        const finalWindows = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed()).map(w => ({
          id: w.id, title: w.getTitle(), visible: w.isVisible(),
        }))
        result.finalWindows = finalWindows
        mark('final.exactly-two-windows', finalWindows.length === 2)
      } catch (e) {
        result.error = e instanceof Error ? e.message : String(e)
      }

      result.screenshots = shots
      result.screenshotSummary = {
        requested: shots.length,
        observed: shots.filter(s => s.observed).length,
        skipped: shots.filter(s => s.skipped).length,
        labels: shots.map(s => s.label),
      }
      /**
       * ★ **只在"要截图"的前提下判截图**（2026-10-09 修正，实测踩到）。
       *
       * 首轮读数是 `5/6`，唯一失败的是 `shots.all-observed` —— 而它其实**什么都没测到**：
       * 那次没给 `--probe-shot` 前缀 ⇒ 两处 `sentinel()` 都如实返回 `skipped: true`
       * （"未执行"，不是失败）⇒ 判据把它读成失败。
       * 这正是本项目反复强调的那条纪律：**"没跑"与"跑了但失败"必须分开**。
       * ⇒ 没给前缀时这一条**不参与判定**，但摘要里仍然如实带上 `skipped` 计数。
       */
      if (o.shotPrefix) {
        mark('shots.all-observed', shots.length >= 2 && shots.every(s => s.observed && !s.skipped))
      } else {
        result.shotCheckSkipped = '未给 --probe-shot：截图这一项是**未执行**，不参与判定（不是通过）'
      }

      finish()

      function finish(): void {
        const entries = Object.entries(checks)
        const passed = entries.filter(([, v]) => v).length
        result.totalChecks = entries.length
        result.passedChecks = passed
        result.failedChecks = entries.filter(([, v]) => !v).map(([k]) => k)
        result.pass = entries.length >= 5 && passed === entries.length
        console.log(`[airimate] PROBE_MENUOPEN ${JSON.stringify({ pass: result.pass, passed, total: entries.length, failed: result.failedChecks })}`)
        try { if (o.out) writeFileSync(o.out, `${JSON.stringify(result, null, 2)}\n`, 'utf8') } catch { /* ignore */ }
        if (o.exit) o.quit('probe')
      }
    })()
  }, probeAt)
}
