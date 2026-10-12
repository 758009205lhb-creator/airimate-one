/**
 * apps/desktop/src/main/session.ts —— 进程内会话状态与"退出/弹窗"回调的注册表
 *
 * 为什么单独一个文件：`ipc.ts` 需要触发退出与告警，但 `bootstrap.ts` 依赖 `ipc.ts`。
 * 用这个极小的注册表打断循环依赖，语义上也不含糊（谁注册谁负责）。
 */
import type { Alert } from '@airimate/shared'

export interface SessionHooks {
  requestQuit: () => void
  /**
   * ★ **重启应用**（2026-10-09 完善轮，桌宠右键菜单「重启应用」）。
   *
   * 为什么与 `requestQuit` 分开：对用户是两件不同的事（"我要退出" vs "我要重开一下"），
   * 对代码也是 —— 重启多了"把新进程拉起来"这一步，而且顺序不能反
   * （先退出就再也没有机会 relaunch 了，表现是"点重启 = 关掉不回来"）。
   * 可选（`?`）：未接线时菜单项应当**不出现**，而不是点了没反应。
   */
  requestRestart?: () => void
  /** 由 bootstrap 注入（用于把告警发到 renderer，并在需要时弹原生对话框） */
  alert: (a: Alert) => void
}

let hooks: SessionHooks | null = null

export function bindSession(h: SessionHooks): void {
  hooks = h
}

export function getSession(): SessionHooks {
  if (!hooks) {
    // 未绑定时的安全兜底：退出请求退化为 app.quit（由 bootstrap 覆写）
    return {
      requestQuit: () => { /* 未绑定：忽略，避免误退出 */ },
      alert: () => { /* 未绑定：忽略 */ },
    }
  }
  return hooks
}
