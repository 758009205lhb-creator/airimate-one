/**
 * apps/desktop/src/main/quiet-store.ts —— 静音时段与提醒阈值（M2）
 *
 * 两件事放在一起是有意的：它们都是"引擎在什么条件下允许打扰用户"的输入，
 * 分两个文件会让 `isQuietNow()` 与 `shouldRemind()` 的判定散开，更容易漂移。
 *
 * 硬约束（用户要求）：静音时段 / 会议 / 全屏 / 游戏 / 专注模式下
 *   **不弹窗、不发声、不抢焦点**；提醒进队列，结束后再通知。
 */
import { z } from 'zod'
import type { QuietHours, QuietHoursSet, ReminderPolicy, ReminderPolicySet } from '@airimate/shared'
import { TimeOfDaySchema, inTimeRange, hhmm } from '@airimate/shared'
import { createJsonStore } from './json-store.js'
import { log } from './log.js'

export const QuietHoursSchema = z.object({
  enabled: z.boolean().default(true),
  start: TimeOfDaySchema.default('23:00'),
  end: TimeOfDaySchema.default('07:30'),
  allowImportant: z.boolean().default(true),
  respectFullscreen: z.boolean().default(true),
  respectMeeting: z.boolean().default(true),
  respectFocus: z.boolean().default(true),
  updatedAt: z.number().default(0),
})

export const ReminderPolicySchema = z.object({
  continuousMinutes: z.number().int().min(5).max(600).default(50),
  sedentaryMinutes: z.number().int().min(5).max(600).default(60),
  sedentaryActivityFloor: z.number().int().min(0).max(100000).default(20),
  nightRestAt: TimeOfDaySchema.default('23:30'),
  nightRestEnablesQuietHours: z.boolean().default(false),
  cooldownMinutes: z.object({
    continuous: z.number().int().min(1).max(600).default(60),
    sedentary: z.number().int().min(1).max(600).default(60),
    night: z.number().int().min(1).max(1440).default(720),
    greeting: z.number().int().min(1).max(1440).default(480),
    radio: z.number().int().min(1).max(1440).default(60),
  }),
  maxRetries: z.number().int().min(0).max(10).default(3),
  maxQueue: z.number().int().min(1).max(500).default(50),
  updatedAt: z.number().default(0),
})

const StoreSchema = z.object({
  version: z.literal(1),
  quiet: QuietHoursSchema,
  policy: ReminderPolicySchema,
})
type Store = z.infer<typeof StoreSchema>

const store = createJsonStore<Store>({
  file: 'quiet-hours.json',
  schema: StoreSchema,
  fallback: () => ({
    version: 1,
    quiet: {
      enabled: true, start: '23:00', end: '07:30', allowImportant: true,
      respectFullscreen: true, respectMeeting: true, respectFocus: true, updatedAt: 0,
    },
    policy: {
      continuousMinutes: 50,
      sedentaryMinutes: 60,
      sedentaryActivityFloor: 20,
      nightRestAt: '23:30',
      nightRestEnablesQuietHours: false,
      cooldownMinutes: { continuous: 60, sedentary: 60, night: 720, greeting: 480, radio: 60 },
      maxRetries: 3,
      maxQueue: 50,
      updatedAt: 0,
    },
  }),
  tag: 'quiet-hours',
})

export function loadQuietHours(): QuietHours {
  return store.load().quiet
}

export function loadReminderPolicy(): ReminderPolicy {
  return store.load().policy
}

export function setQuietHours(patch: QuietHoursSet): QuietHours {
  const cur = store.load()
  const next: QuietHours = QuietHoursSchema.parse({ ...cur.quiet, ...patch, updatedAt: Date.now() })
  store.save({ ...cur, quiet: next })
  log().info('静音时段已更新', {
    enabled: next.enabled, start: next.start, end: next.end,
    allowImportant: next.allowImportant, respectFullscreen: next.respectFullscreen,
    respectMeeting: next.respectMeeting, respectFocus: next.respectFocus,
  }, 'quiet.set')
  return next
}

export function setReminderPolicy(patch: ReminderPolicySet): ReminderPolicy {
  const cur = store.load()
  const merged = {
    ...cur.policy,
    ...patch,
    cooldownMinutes: { ...cur.policy.cooldownMinutes, ...(patch.cooldownMinutes ?? {}) },
    updatedAt: Date.now(),
  }
  const next: ReminderPolicy = ReminderPolicySchema.parse(merged)
  store.save({ ...cur, policy: next })
  log().info('提醒阈值已更新', {
    continuousMinutes: next.continuousMinutes, sedentaryMinutes: next.sedentaryMinutes,
    nightRestAt: next.nightRestAt, maxRetries: next.maxRetries, maxQueue: next.maxQueue,
  }, 'reminder.policy.set')
  return next
}

/** 是否处于静音时段（**支持跨午夜**：23:00–07:30） */
export function inQuietHours(now = new Date()): boolean {
  const q = loadQuietHours()
  if (!q.enabled) return false
  return inTimeRange(hhmm(now), q.start, q.end)
}

/** `privacy:wipe` 用 */
export function destroyQuietStore(): { removed: boolean, bytes: number } {
  return store.destroy()
}

export function quietStorePath(): string {
  return store.filePath()
}

/** 仅供单测：丢弃缓存 */
export function __resetQuietStoreForTest(): void {
  store.__reset()
}
