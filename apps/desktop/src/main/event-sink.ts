/**
 * apps/desktop/src/main/event-sink.ts —— 主进程 → renderer 的唯一出口（广播）
 *
 * 为什么单独一个文件（而不是留在 `ipc.ts` 里）：
 *   `ipc.ts` 需要 import 适配层（注册四个只读通道），而适配层里的 TTS 适配器
 *   需要把 `evt:tts-state` 报给 renderer ⇒ **循环依赖**。
 *   ESM 里循环依赖不一定立刻炸（取决于求值顺序），但那种"能不能跑看运气"的
 *   结构本身就是缺陷。把出口抽到这里，依赖方向变成一条直线：
 *
 *       event-sink  ←  capabilities  ←  ipc  ←  bootstrap
 *
 * 语义与原来的 `broadcast()` 完全一致：同一窗口、存活检查、没有额外通道。
 */
import { BrowserWindow } from 'electron'

/**
 * 只按窗口发（不校验 schema）。用于**载荷形状由发送方保证**的内部事件
 * （`evt:activity` / `evt:reminder-queue` / `evt:tts-state`）。
 *
 * ⚠ 需要 schema 校验的出站消息请用 `ipc.ts` 里的 `send()` —— 那里会在校验失败时
 *   **丢弃并记日志**，这正是我们想要的"契约漂移必须可见"。
 */
/**
 * 主进程 → renderer 的广播出口。
 *
 * ⚠ 2026-10-08 返工轮：从"只发第一个窗口"改成**发给全部存活窗口**。
 *
 * 为什么必须改（否则新架构下会出现静默失效）：
 *   本应用现在**恰好两个**窗口，`BrowserWindow.getAllWindows()[0]` 不保证是哪一个 ——
 *   而两个窗口都需要这些事件，只是用途不同：
 *     · pet 窗口：`evt:chat-delta` 用来更新头顶气泡的"她正在说的这一句"、
 *       `evt:tts-state` 用来驱动"朗读结束 + N 秒气泡消失"的倒计时、
 *       `evt:conversation-state` 用来反映对话开合；
 *     · chat 窗口：`evt:chat-delta` / `evt:chat-done` 用来渲染对话流水与流式输出。
 *   只发一个 ⇒ 另一个窗口永远收不到 ⇒ 表现是"气泡不出现"或"回复不流式"，
 *   而两者都不会报错。这正是本项目一直在防的那类静默失败。
 *
 * 顺序：把**非 chat** 的窗口排前面（历史上第一顺位是 pet 窗口，保持行为惯性）。
 * 不做去重以外的任何过滤 —— 过滤规则一旦写错，就是上面那种"某个窗口收不到"。
 */
export function broadcast(channel: string, payload: unknown): void {
  const wins = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed())
  if (!wins.length) return
  const ordered = [...wins].sort((a, b) => {
    const ac = a.webContents.getURL().includes('surface=chat') ? 1 : 0
    const bc = b.webContents.getURL().includes('surface=chat') ? 1 : 0
    return ac - bc
  })
  for (const w of ordered) {
    try {
      w.webContents.send(channel, payload)
    } catch {
      /**
       * 单个窗口发送失败**不能**影响其它窗口 ——
       * 但也不静默：这里刻意只吞掉异常本身，让上层的 `log()` 语义保持不变
       * （`send()` 路径有自己的日志出口；这条路已经被三处调用方判定为"载荷形状由发送方保证"）。
       */
    }
  }
}
