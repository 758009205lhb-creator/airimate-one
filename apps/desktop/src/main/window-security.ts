/**
 * apps/desktop/src/main/window-security.ts —— 每个 BrowserWindow 都要过的那一套安全装配
 *
 * 为什么把它从 `window-manager.ts` 里抽出来（2026-10-08 返工轮）：
 *   本轮新增了**第二个** BrowserWindow（独立对话窗口）。那段安全代码原本内联在
 *   `createMainWindow()` 里 —— 如果给 chat 窗口"再写一份简化版"，第二个窗口就会成为
 *   整个应用最薄弱的一环，而且**任何一条漏掉都不会有界面表现**：
 *   少一次权限拒绝、少一条导航拦截，看起来完全正常。
 *   所以：装配只有一份，谁建窗口谁调用它。
 *
 * 覆盖的五件事（Tech-Spec §7.1）：
 *   ① 拒绝一切权限请求（麦克风 / 摄像头 / 通知 / 地理位置…）；
 *   ② 导航白名单（只允许 dev server 或 `app://`）+ 拦截所有 `will-attach-webview`；
 *   ③ `setWindowOpenHandler`：外部链接交给系统浏览器，其余一律 deny；
 *   ④ 响应头注入 CSP（只对 `app://` 与 dev server 的响应）；
 *   ⑤ 诊断类事件转发（renderer console / 渲染进程退出 / preload 失败 / 加载失败）——
 *      没有这一步，无头验证时 renderer 里的报错会**整体丢失**。
 */
import type { BrowserWindow } from 'electron'
import { shell } from 'electron'
import { securityHeaders } from '@airimate/security'
import { log } from './log.js'

export interface WindowSecurityOptions {
  /** 开发模式：renderer 由 Vite dev server 提供 */
  devServerUrl: string | null
  /** 在日志里区分是哪个窗口（`pet` / `chat`） */
  label?: string
}

export function applyWindowSecurity(win: BrowserWindow, o: WindowSecurityOptions): void {
  const label = o.label ?? 'pet'

  // ① 权限：一律拒绝。需要时再显式加白名单（"默认拒绝"是唯一安全的默认值）
  win.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    log().warn('权限请求被拒绝', { permission, window: label }, 'security.permission-denied')
    callback(false)
  })
  win.webContents.session.setPermissionCheckHandler(() => false)

  // ② 导航与开窗
  win.webContents.on('will-navigate', (e, url) => {
    const allowed = (o.devServerUrl && url.startsWith(o.devServerUrl)) || url.startsWith('app://')
    if (!allowed) {
      e.preventDefault()
      log().warn('拦截导航', { url: url.slice(0, 120), window: label }, 'security.navigation-blocked')
    }
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    // 外部链接交给系统浏览器（不授予任何 node 能力）
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-attach-webview', (e) => e.preventDefault())

  // ③ CSP 与其它响应头
  win.webContents.session.webRequest.onHeadersReceived((details, cb) => {
    if (!/^app:\/\//.test(details.url) && !(o.devServerUrl && details.url.startsWith(o.devServerUrl))) {
      cb({ responseHeaders: details.responseHeaders })
      return
    }
    const headers = securityHeaders({ devServerOrigin: o.devServerUrl })
    const merged: Record<string, string[]> = { ...(details.responseHeaders ?? {}) }
    for (const [k, v] of Object.entries(headers)) merged[k] = [v]
    cb({ responseHeaders: merged })
  })

  // ④ 诊断转发（脱敏：只留消息前 400 字与文件名）
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const lvl = level >= 3 ? 'error' : (level === 2 ? 'warn' : 'debug')
    const shortSource = String(sourceId ?? '').split(/[\\/]/).pop() ?? ''
    log()[lvl]('renderer console', { message: message.slice(0, 400), at: `${shortSource}:${line}`, window: label }, 'renderer.console')
  })
  win.webContents.on('render-process-gone', (_e, details) => {
    log().error('渲染进程退出', { reason: details.reason, exitCode: details.exitCode, window: label }, 'renderer.gone')
  })
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    log().error('preload 加载失败', {
      preloadPath: String(preloadPath).split(/[\\/]/).pop() ?? '', err: error?.message ?? '', window: label,
    }, 'preload.error')
  })
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log().error('页面加载失败', { code, desc, url: String(url).slice(0, 120), window: label }, 'window.load.failed')
  })
}
