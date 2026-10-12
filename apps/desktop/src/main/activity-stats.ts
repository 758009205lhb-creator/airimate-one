/**
 * apps/desktop/src/main/activity-stats.ts —— 按天的活动汇总（M2）
 *
 * 用途：
 *   · 早安电台的"今日建议"（如"你昨天连续工作了 3 小时，今天记得每小时起来动一下"）；
 *   · M4 自学习的"工作节奏"输入（按小时的活动分布）；
 *   · UI 的"今天的电脑使用情况"。
 *
 * **隐私边界（硬约束）**：
 *   · 只统计**计数与时长**：输入事件数、活跃分钟、连续段长度；
 *   · **不记录按键内容、不记录窗口标题原文**（标题只留哈希与长度，且默认关闭）；
 *   · 不落任何可还原用户操作的字段。
 */
import { z } from 'zod'
import type { ActivityDayStats, ActivityState } from '@airimate/shared'
import { ActivityDayStatsSchema, dateOnly } from '@airimate/shared'
import { createJsonStore } from './json-store.js'

const StoreSchema = z.object({
  version: z.literal(1),
  days: z.array(ActivityDayStatsSchema).max(400),
  /** 最近一次采样时的"当前连续段起点"（重启后仍能算连续使用时长） */
  currentStreakStartAt: z.number().nullable().default(null),
  updatedAt: z.number().default(0),
})
type Store = z.infer<typeof StoreSchema>

const store = createJsonStore<Store>({
  file: 'activity.json',
  schema: StoreSchema,
  fallback: () => ({ version: 1, days: [], currentStreakStartAt: null, updatedAt: 0 }),
  tag: 'activity',
})

/** 保留天数（400 天足够"年度回顾"，又不会无限增长） */
const KEEP_DAYS = 400

export function loadActivity(): Store {
  return store.load()
}

function save(next: Store): void {
  const days = [...next.days].sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, KEEP_DAYS)
  store.save({ ...next, days })
}

function emptyDay(day: string): ActivityDayStats {
  return ActivityDayStatsSchema.parse({ day })
}

export function dayStats(day: string): ActivityDayStats {
  return loadActivity().days.find(d => d.day === day) ?? emptyDay(day)
}

/** 今天的统计（UI 与电台用） */
export function todayStats(now = new Date()): ActivityDayStats {
  return dayStats(dateOnly(now))
}

/**
 * 记录一次采样。
 *
 * 判据：
 *   · `active` = `idleMs < 60_000`（一分钟内有输入）⇒ 该分钟计入 `activeMinutes`，
 *     并把 `inputEvents1m` 累加进 `inputEvents`；
 *   · `blocked` = 该次采样处于阻断状态（会议/全屏/游戏/静音）⇒ `blockedSamples++`；
 *   · 连续段：`active` 时若没有起点就记起点；连续 `idle` 超过 5 分钟就结束当前段，
 *     用段长更新 `longestStreakMinutes`；`idle` 本身用于更新 `longestIdleMinutes`。
 */
export function recordSample(a: ActivityState, now = new Date()): ActivityDayStats {
  const cur = loadActivity()
  const day = dateOnly(now)
  const existing = cur.days.find(d => d.day === day) ?? emptyDay(day)
  const next: ActivityDayStats = { ...existing }

  next.samples += 1
  const active = a.idleMs < 60_000
  if (active) {
    next.activeMinutes += 1
    next.inputEvents += a.inputEvents1m
    next.firstActiveAt = next.firstActiveAt ?? a.at
    next.lastActiveAt = a.at
    const hour = now.getHours()
    const hourly = [...next.hourlyActiveMinutes]
    hourly[hour] = (hourly[hour] ?? 0) + 1
    next.hourlyActiveMinutes = hourly
  }
  const idleMinutes = Math.floor(a.idleMs / 60_000)
  if (idleMinutes > next.longestIdleMinutes) next.longestIdleMinutes = idleMinutes
  if (a.blockReason !== 'none') next.blockedSamples += 1

  // 连续段维护
  let streakStart = cur.currentStreakStartAt
  if (active) {
    if (streakStart === null) streakStart = a.at
    const streak = Math.floor((a.at - streakStart) / 60_000)
    if (streak > next.longestStreakMinutes) next.longestStreakMinutes = streak
  } else if (idleMinutes >= 5 && streakStart !== null) {
    // 空闲 5 分钟以上 ⇒ 连续段结束
    const streak = Math.floor((a.at - streakStart) / 60_000)
    if (streak > next.longestStreakMinutes) next.longestStreakMinutes = streak
    streakStart = null
  }

  const days = cur.days.some(d => d.day === day)
    ? cur.days.map(d => (d.day === day ? next : d))
    : [...cur.days, next]
  save({ ...cur, days, currentStreakStartAt: streakStart, updatedAt: Date.now() })
  return next
}

/** 当前连续使用时长（分钟）；空闲 5 分钟以上算断开 ⇒ 0 */
export function currentStreakMinutes(now = new Date()): number {
  const s = loadActivity().currentStreakStartAt
  if (s === null) return 0
  return Math.max(0, Math.floor((now.getTime() - s) / 60_000))
}

/** 显式断开连续段（用户离开、电脑锁屏/休眠、引擎重启） */
export function resetStreak(): void {
  const cur = loadActivity()
  if (cur.currentStreakStartAt === null) return
  save({ ...cur, currentStreakStartAt: null, updatedAt: Date.now() })
}

/** 最近 N 天的汇总（早安电台 / 今日总结用） */
export function recentDays(n = 7, now = new Date()): ActivityDayStats[] {
  const today = dateOnly(now)
  const all = [...loadActivity().days].sort((a, b) => (a.day < b.day ? 1 : -1))
  return all.filter(d => d.day <= today).slice(0, n)
}

/**
 * 生成"今日建议"的素材（**都是实测读数**，不编造）：
 * 返回 0–3 条基于真实统计的建议。
 */
export function adviceFromStats(now = new Date()): string[] {
  const out: string[] = []
  const today = todayStats(now)
  const yest = recentDays(2, now).find(d => d.day !== dateOnly(now))
  if (today.activeMinutes >= 180) {
    out.push(`今天已经用了 ${Math.round(today.activeMinutes / 60)} 小时电脑，记得每小时站起来活动一下。`)
  }
  if (today.longestStreakMinutes >= 90) {
    out.push(`最长连续时段已经 ${today.longestStreakMinutes} 分钟没有离开座位了。`)
  }
  if (yest && yest.longestStreakMinutes >= 120) {
    out.push(`昨天最长连续工作了 ${Math.round(yest.longestStreakMinutes / 60 * 10) / 10} 小时，今天可以把节奏放慢一点。`)
  }
  if (today.blockedSamples > 0 && today.samples > 0 && today.blockedSamples / today.samples > 0.5) {
    out.push('今天大部分时间你都在全屏/会议里，我把提醒都攒着，等你有空再说。')
  }
  return out.slice(0, 3)
}

/** `privacy:wipe` 用 */
export function destroyActivityStore(): { removed: boolean, bytes: number } {
  return store.destroy()
}

export function activityStorePath(): string {
  return store.filePath()
}

/** 仅供单测：丢弃缓存 */
export function __resetActivityStoreForTest(): void {
  store.__reset()
}
