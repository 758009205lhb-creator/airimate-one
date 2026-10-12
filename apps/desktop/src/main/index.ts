/**
 * apps/desktop/src/main/index.ts —— Electron 入口（生命周期与兜底）
 *
 * `main` 字段指向本文件。所有真正的启动逻辑在 `bootstrap.ts`，本文件只负责：
 *   - 单实例之外的全局兜底（未捕获异常/未处理拒绝不静默）；
 *   - `window-all-closed` 保持存活（托盘负责退出）；
 *   - `before-quit` 释放资源。
 */
import { app, BrowserWindow } from 'electron'
import { bootstrap, quit, quitting } from './bootstrap.js'
import { log } from './log.js'

/**
 * 全局兜底：未捕获异常/未处理拒绝不静默，但**必须限流**。
 *
 * 为什么限流（实测踩到）：父进程关闭 stdout 后，Electron/Node 内部写 stdout 会抛 EPIPE，
 * 而 uncaughtException 处理器又调用 logger 写 stdout ⇒ 无限递归刷屏，单次运行写出 5 MB 日志。
 * 这类"管道断裂"错误对用户毫无价值，直接静音；其它错误最多记 5 条。
 */
let uncaughtLogged = 0
const MAX_UNCAUGHT_LOGS = 5

function isPipeError(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code
  const msg = e instanceof Error ? e.message : String(e)
  return code === 'EPIPE' || code === 'EBADF' || /broken pipe|EPIPE|write EOF/i.test(msg)
}

process.on('uncaughtException', (e) => {
  if (isPipeError(e)) return
  if (uncaughtLogged++ >= MAX_UNCAUGHT_LOGS) return
  try { log().error('未捕获异常', { err: e?.message ?? String(e) }, 'boot.uncaught') } catch { /* ignore */ }
})
process.on('unhandledRejection', (r) => {
  if (isPipeError(r)) return
  if (uncaughtLogged++ >= MAX_UNCAUGHT_LOGS) return
  try { log().error('未处理拒绝', { err: r instanceof Error ? r.message : String(r) }, 'boot.unhandled-rejection') } catch { /* ignore */ }
})

// 托盘常驻：窗口全关也不退出（关闭按钮只隐藏窗口）
app.on('window-all-closed', () => {
  if (quitting()) return
  // 不退出：托盘仍可用（Windows 语义）
})

app.on('before-quit', () => {
  if (!quitting()) quit('before-quit')
})

app.on('activate', () => {
  const wins = BrowserWindow.getAllWindows()
  if (wins.length === 0) return   // 绝不在此创建第二个窗口
  const w = wins[0]
  if (!w) return
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
})

void bootstrap().catch((e: unknown) => {
  const msg = e instanceof Error ? (e.stack ?? e.message) : String(e)
  try { log().error('启动失败', { err: msg.slice(0, 800) }, 'boot.failed') } catch { /* ignore */ }
  // 启动失败必须可见（不能静默）。`--no-dialogs`（QA/自动化）下改为只打日志，避免脚本被弹窗挂住。
  const noDialogs = process.argv.includes('--no-dialogs')
  if (!noDialogs) {
    try {
      const { dialog } = require('electron') as typeof import('electron')
      dialog.showErrorBox('AiriMate One 启动失败', msg.slice(0, 800))
    } catch { /* ignore */ }
  }
  // eslint-disable-next-line no-console
  console.error(`[airimate] BOOT_FAILED ${msg.split('\n')[0] ?? ''}`)
  app.exit(1)
})
