/**
 * apps/desktop/src/main/tray.ts —— 托盘：桌宠呼出/收回/常驻、对话、模式、开机自启、退出
 *
 * 关闭按钮默认隐藏窗口而不是退出（window-manager 的 'close' 事件里 hide）。
 * 真正退出只能由这里触发（bootstrap 设置 isQuitting 门闩）。
 *
 * ⚠ 2026-10-09 完善轮的三处改动（对齐参考实现 `DockPetWin-Ameath` 的托盘菜单）：
 *   ① 「显示桌宠 / 收回桌宠」两项**按时态禁用**（不是隐藏 —— 位置跳动会让用户以为功能没了）；
 *   ② 「☑ 桌宠常驻」勾选项 —— 勾上/取消都**立即生效并落盘**（`setPetResident`）；
 *   ③ tooltip **如实反映当前状态**（常驻中 / 已呼出 / 已收回），
 *      且与菜单读的是**同一份快照**（`petMenuState()`）——
 *      两处各算一次迟早会出现"菜单说已收回、悬停说已呼出"的自相矛盾读数。
 */
import { Menu, Tray, nativeImage, app } from 'electron'
import { APP_NAME } from '@airimate/shared'
import { log } from './log.js'
import { centerWindow, getWindow, hideWindow, setAlwaysOnTop, showWindow, windowMode } from './window-manager.js'
import { petMenuState, petResident, setPetResident } from './pet-visibility.js'

export interface TrayHooks {
  requestMode: (mode: 'panel' | 'pet') => void
  requestQuit: () => void
  getAutoStart: () => boolean
  setAutoStart: (on: boolean) => Promise<boolean>
  getAlwaysOnTop: () => boolean
  /**
   * ★ 对话（返工轮）：「开始对话 / 结束对话」是**与轮盘、快捷键、语音唤醒同一个开关**。
   * 托盘不自己 setMode / 不自己 setBounds —— 它只把意图交给 `conversation.ts`，
   * 否则"从托盘打开"与"从轮盘打开"会走出两条不同的行为路径。
   */
  isConversationOpen: () => boolean
  requestConversation: (open: boolean) => void
  /** 快捷键注册状态（用于在菜单上**如实**显示"快捷键没注册上"） */
  getHotkeyLabel: () => string
  /**
   * ★★ 桌宠（2026-10-09 完善轮）。
   *
   * 托盘**不自己** `show()/hide()` 窗口、**不自己**写设置 ——
   * 它只调这三个由 bootstrap 注入的回调，真正的状态机在 `pet-visibility.ts`。
   * 为什么：三处菜单（托盘 / 对话窗口 / 桌宠右键）必须走出**完全相同**的行为，
   * 而"托盘顺手多写一个字段"正是三处开始漂移的起点。
   */
  petShow: () => void
  petHide: () => void
  petSetResident: (resident: boolean) => void
  /** 打开管理面板（= 呼出 + panel 模式 + 聚焦） */
  requestPanel: () => void
  /** 请求打开某个界面视图（记忆页 / 日程 / 偏好 / 语音 / 快捷键一览 / 关于） */
  requestView: (action: 'memory' | 'schedule' | 'settings' | 'voice' | 'shortcuts' | 'about') => void
}

let tray: Tray | null = null
/** 菜单重建函数（供外部在对话/桌宠状态变化时刷新勾选态） */
let rebuildMenu: (() => void) | null = null

export function createTray(hooks: TrayHooks): Tray | null {
  if (tray) return tray
  try {
    // 用一个极简内联图标，避免依赖外部美术资源（也避免把第三方图标打进包）
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <circle cx="16" cy="16" r="13" fill="#4f8cff" opacity="0.92"/>
      <circle cx="11.5" cy="13" r="2.1" fill="#fff"/>
      <circle cx="20.5" cy="13" r="2.1" fill="#fff"/>
      <path d="M10.5 20.5c1.8 2.2 9.2 2.2 11 0" stroke="#fff" stroke-width="1.9" fill="none" stroke-linecap="round"/>
    </svg>`
    const icon = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`)
    tray = new Tray(icon.resize({ width: 16, height: 16 }))
  } catch (e) {
    log().warn('托盘创建失败（不影响主功能）', { err: e instanceof Error ? e.message : String(e) }, 'tray.create-failed')
    return null
  }

  const rebuild = (): void => {
    const mode = windowMode()
    const convOpen = hooks.isConversationOpen()
    /**
     * ★ 桌宠状态的**唯一快照**：菜单勾选与 tooltip 都从它读。
     *   不在这里各自 `getWindow()?.isVisible()` —— 那会变成第二、第三个真源。
     */
    const pet = petMenuState()
    const menu = Menu.buildFromTemplate([
      /**
       * ★★ 桌宠三项（2026-10-09 完善轮，对齐参考实现的托盘菜单）。
       *
       * 「显示 / 收回」两项**都常驻、按时态禁用其中一个**：
       * 与「开始/结束对话」同一个理由 —— 菜单项位置会跳，
       * 消失的那一项会让用户以为功能没了。
       */
      { label: '显示桌宠', enabled: !pet.visible || pet.minimized, click: () => hooks.petShow() },
      { label: '收回桌宠', enabled: pet.visible, click: () => hooks.petHide() },
      {
        label: '桌宠常驻（开机/启动即显示）',
        type: 'checkbox',
        checked: pet.resident,
        click: (item) => hooks.petSetResident(item.checked),
      },
      { type: 'separator' },
      /**
       * ★ 开始 / 结束对话（返工轮语义）。
       *
       * 「开始对话」= 显示并聚焦**独立的 chat 窗口**（再次点击只聚焦，不会把它收走）。
       * 「结束对话」= 隐藏它（这是唯一的"关闭"入口之一，另外两个是 chat 窗口的 × 与 Esc）。
       */
      { label: '开始对话', enabled: !convOpen, click: () => hooks.requestConversation(true) },
      { label: '结束对话', enabled: convOpen, click: () => hooks.requestConversation(false) },
      { label: `  快捷键：${hooks.getHotkeyLabel()}`, enabled: false },
      { type: 'separator' },
      { label: '打开管理面板', click: () => hooks.requestPanel() },
      { label: '记忆', click: () => hooks.requestView('memory') },
      { label: '日程与提醒', click: () => hooks.requestView('schedule') },
      { type: 'separator' },
      { label: '面板模式', type: 'radio', checked: mode === 'panel', click: () => hooks.requestMode('panel') },
      { label: '桌宠模式', type: 'radio', checked: mode === 'pet', click: () => hooks.requestMode('pet') },
      { label: '恢复默认位置（居中）', click: () => centerWindow() },
      {
        label: '窗口置顶',
        type: 'checkbox',
        checked: hooks.getAlwaysOnTop(),
        click: (item) => setAlwaysOnTop(item.checked),
      },
      { type: 'separator' },
      { label: '偏好设置', click: () => hooks.requestView('settings') },
      { label: '语音与麦克风', click: () => hooks.requestView('voice') },
      { label: '快捷键一览', click: () => hooks.requestView('shortcuts') },
      { label: '关于', click: () => hooks.requestView('about') },
      {
        label: '开机自动启动',
        type: 'checkbox',
        checked: hooks.getAutoStart(),
        click: (item) => { void hooks.setAutoStart(item.checked).then(() => rebuild()) },
      },
      { type: 'separator' },
      { label: `退出 ${APP_NAME}`, click: () => hooks.requestQuit() },
    ])
    tray?.setContextMenu(menu)
    /**
     * ★ tooltip **如实**反映当前状态（本轮判据之一）。
     *
     * 三种状态必须能分辨：常驻中 / 已呼出（非常驻） / 已收回。
     * 文案来自 `petStatusText()`（与菜单同一个函数），所以不可能和菜单矛盾。
     */
    tray?.setToolTip(`${APP_NAME} · ${pet.statusText}${mode === 'panel' ? ' · 面板模式' : ''}${convOpen ? ' · 对话中' : ''}`)
  }
  rebuildMenu = rebuild

  tray.on('click', () => {
    const w = getWindow()
    if (!w || w.isDestroyed()) return
    if (w.isVisible()) hideWindow(); else showWindow()
    /** 托盘单击改了可见性 ⇒ 菜单勾选与 tooltip 必须跟着变（否则显示的是旧状态） */
    rebuild()
  })
  tray.on('right-click', () => rebuild())

  rebuild()
  log().info('托盘已创建', {
    petResident: petResident(), petVisible: petMenuState().visible,
  }, 'tray.ready')
  return tray
}

export function refreshTray(): void {
  if (!tray) return
  /**
   * 同时刷新菜单与提示：对话开合会改「开始/结束对话」的可用性，桌宠呼出/收回/常驻
   * 会改「显示/收回桌宠」的可用性与「桌宠常驻」的勾选 ——
   * 而托盘菜单在 Windows 上是**每次右键时**读当前 ContextMenu ——
   * 不重建的话，状态变了菜单还是旧的（表现为"点了没反应"）。
   */
  if (rebuildMenu) rebuildMenu()
  else tray.setToolTip(`${APP_NAME} · ${petMenuState().statusText}`)
}

export function destroyTray(): void {
  if (tray) { tray.destroy(); tray = null }
  rebuildMenu = null
}

export function appIsReady(): boolean {
  return app.isReady()
}
