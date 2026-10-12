/**
 * apps/desktop/src/main/blocker.ts —— "现在能不能打扰用户"的唯一判定
 *
 * 用户硬要求：**会议、全屏工作、游戏、专注模式、静音时段不弹窗、不发声、不抢焦点**；
 * 提醒进入队列，结束后再通知。
 *
 * 设计要点：
 *   · 这里只**判定**，不负责送达（送达在 `proactive-engine.ts`）—— 两者分开才能单测；
 *   · 判定顺序**必须与 `evaluateBlocker()` 的实现逐条一致**（下面这份就是实现顺序）：
 *       ① 手动静默（用户刚说了"别烦我"，最高优先）
 *       ② 静音时段
 *       ③ **采样不可用**（保守视为不可打扰）
 *       ④ 会议  ⑤ 游戏  ⑥ 全屏  ⑦ 系统专注
 *     顺序固定，`recentDecisions` 里的 `reason` 才有稳定含义。
 *     ⚠ 这份注释曾经写成"静音时段 > 会议 > 游戏 > 全屏 > 专注 > 手动静默"，
 *       与代码不一致（外部复核指出）—— 注释与实现不一致比没有注释更坏，
 *       它会让下一个改这里的人按错的顺序推理。
 *   · **采样不可用时保守处理**：返回不可打扰，而不是 `none` ——
 *     读不到阻断状态时弹窗打断用户，代价比晚一点提醒大得多。
 *     （这是刻意的取舍，写在注释里，免得以后被人"优化"掉。）
 */
import type { ActivityState, BlockReason, Priority, QuietHours, ReminderPolicy } from '@airimate/shared'
import { inTimeRange, hhmm } from '@airimate/shared'
import { inQuietHours, loadQuietHours, loadReminderPolicy } from './quiet-store.js'

export interface BlockerInput {
  activity: ActivityState
  quiet: QuietHours
  now?: Date
}

export interface BlockerVerdict {
  blocked: boolean
  reason: BlockReason
  /** 面向用户的一句话解释（已脱敏；UI 直接显示） */
  text: string
}

const NONE: BlockerVerdict = { blocked: false, reason: 'none', text: '' }

/**
 * 唯一判定入口。
 *
 * 注意 `priority` 参数：**重要级也不会突破"不弹窗、不发声"** —— 它只影响
 * 是否进入队列/角标（`allowImportant`），以及阻断结束后补发的顺序。
 * 这是用户明确写的约束，不要在这里开洞。
 */
export function evaluateBlocker(input: BlockerInput): BlockerVerdict {
  const now = input.now ?? new Date()
  const { activity, quiet } = input

  // ① 用户手动静默：最高优先（用户刚刚说了"别烦我"）
  if (activity.userSilent) {
    return { blocked: true, reason: 'user-silent', text: '静默模式已开启，提醒已排队' }
  }

  // ② 静音时段
  if (quiet.enabled && inTimeRange(hhmm(now), quiet.start, quiet.end)) {
    return { blocked: true, reason: 'quiet-hours', text: `静音时段（${quiet.start}–${quiet.end}），提醒已排队` }
  }

  // ③ 采样不可用 ⇒ 保守视为不可打扰（见文件头注释）
  if (!activity.available) {
    return {
      blocked: true,
      reason: 'focus',
      text: `活动采样不可用（${activity.unavailableReason ?? '未知原因'}），为避免打断已排队`,
    }
  }

  // ④ 会议
  if (quiet.respectMeeting && activity.meeting) {
    return { blocked: true, reason: 'meeting', text: `检测到会议（${activity.meeting}），提醒已排队` }
  }

  // ⑤ 游戏
  if (activity.gameProcess) {
    return { blocked: true, reason: 'game', text: `检测到游戏（${activity.gameProcess}）正在运行，提醒已排队` }
  }

  // ⑥ 全屏（演示/视频）
  if (quiet.respectFullscreen && activity.fullscreen) {
    return { blocked: true, reason: 'fullscreen', text: '你正在全屏（演示/视频），提醒已排队' }
  }

  // ⑦ 系统专注/免打扰
  if (quiet.respectFocus && activity.focusAssist) {
    return { blocked: true, reason: 'focus', text: '系统免打扰已开启，提醒已排队' }
  }

  return NONE
}

/** 便捷入口：用当前设置与采样做一次判定 */
export function isBlockedNow(activity: ActivityState, now = new Date()): BlockerVerdict {
  return evaluateBlocker({ activity, quiet: loadQuietHours(), now })
}

/**
 * 冷却判定。
 *
 * `cooldownMinutes[kind]` 是**每类提醒自己的**冷却（用户要求"所有主动行为必须有冷却时间"）。
 * `lastFiredAt === null` ⇒ 从未送过，不算冷却。
 */
export function inCooldown(
  kind: keyof ReminderPolicy['cooldownMinutes'],
  lastFiredAt: number | null,
  now = Date.now(),
  policy: ReminderPolicy = loadReminderPolicy(),
): { cooling: boolean, untilMs: number | null, remainingMinutes: number } {
  if (lastFiredAt === null) return { cooling: false, untilMs: null, remainingMinutes: 0 }
  const windowMs = policy.cooldownMinutes[kind] * 60_000
  const until = lastFiredAt + windowMs
  if (now >= until) return { cooling: false, untilMs: until, remainingMinutes: 0 }
  return { cooling: true, untilMs: until, remainingMinutes: Math.ceil((until - now) / 60_000) }
}

/**
 * 优先级 → 处置策略。
 *   · `important`：允许弹窗 + 允许进通知中心（阻断时进队列，**不丢**）
 *   · `normal`   ：允许弹窗（气泡/面板内），不进系统通知
 *   · `silent`   ：只进通知中心，不弹窗不发声
 */
export function policyOf(priority: Priority): 'popup' | 'queue' | 'inbox-only' {
  if (priority === 'important') return 'popup'
  if (priority === 'normal') return 'popup'
  return 'inbox-only'
}

/**
 * 是否允许发声。
 *
 * ⚠ 这里**不看** `allowImportant` —— 那个开关只决定"重要级是否仍写进队列/角标"，
 *   不会放开声音。用户在静音时段/会议里被机器念一段话，是比"晚点再说"更糟的体验。
 */
export function maySpeak(priority: Priority, verdict: BlockerVerdict, now = new Date()): boolean {
  if (verdict.blocked) return false
  if (priority === 'silent') return false
  return !inQuietHours(now)
}

/** 是否允许把窗口提到前台（**默认永远不允许** —— 用户要求"不抢焦点"） */
export function mayFocus(): boolean {
  return false
}
