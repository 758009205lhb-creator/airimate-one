/**
 * apps/desktop/src/main/schedule-store.ts —— 日程（M2）
 *
 * 能力：
 *   · CRUD + 持久化（`schedules.json`，原子写 + schema 校验）；
 *   · `dueSchedules(now)` —— 到点需要提醒的日程（含 `leadMinutes` 提前量）；
 *   · `todaySchedules(now)` —— 今日日程（早安电台与日程播报的输入）；
 *   · **按天去重**（`lastFiredDay`）：同一日程同一天只触发一次，重启也不会重复触发。
 */
import { z } from 'zod'
import type { Schedule, ScheduleUpsert } from '@airimate/shared'
import { ScheduleRecurrenceSchema, TimeOfDaySchema, DateOnlySchema, dateOnly, minutesOfDay, hhmm } from '@airimate/shared'
import { createJsonStore } from './json-store.js'
import { log } from './log.js'

export const ScheduleSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(120),
  start: TimeOfDaySchema,
  end: TimeOfDaySchema.nullable().default(null),
  leadMinutes: z.number().int().min(0).max(720).default(0),
  recurrence: ScheduleRecurrenceSchema,
  important: z.boolean().default(false),
  announceInRadio: z.boolean().default(true),
  note: z.string().max(500).default(''),
  enabled: z.boolean().default(true),
  lastFiredDay: DateOnlySchema.nullable().default(null),
  createdAt: z.number(),
  updatedAt: z.number(),
})

const StoreSchema = z.object({
  version: z.literal(1),
  schedules: z.array(ScheduleSchema).max(500),
})
type Store = z.infer<typeof StoreSchema>

const store = createJsonStore<Store>({
  file: 'schedules.json',
  schema: StoreSchema,
  fallback: () => ({ version: 1, schedules: [] }),
  tag: 'schedule',
  /** 登记名（迁移链按它查表；**改了它必须同步 STORE_DESCRIPTORS**） */
  storeName: 'schedules',
})

export function loadSchedules(): Store {
  return store.load()
}

function save(schedules: Schedule[]): void {
  store.save({ version: 1, schedules })
}

let seq = 0
function nextId(): string {
  seq += 1
  return `s_${Date.now().toString(36)}_${seq}`
}

export function upsertSchedule(input: ScheduleUpsert): Schedule {
  const cur = loadSchedules()
  const now = Date.now()
  const existing = input.id ? cur.schedules.find(s => s.id === input.id) : undefined
  const rec = ScheduleRecurrenceSchema.parse({ ...(existing?.recurrence ?? {}), ...(input.recurrence ?? {}) })
  // 形态校验：`weekly` 必须有 weekdays；`once` 必须有 date。缺了就**拒绝**而不是静默变成"永不触发"。
  if (rec.kind === 'weekly' && rec.weekdays.length === 0) {
    throw new Error('weekly 日程必须指定至少一个星期几')
  }
  if (rec.kind === 'once' && !rec.date) {
    throw new Error('一次性日程必须指定日期')
  }
  if (rec.kind === 'monthly' && rec.dayOfMonth === null) {
    throw new Error('每月日程必须指定日')
  }
  const next: Schedule = {
    id: existing?.id ?? (input.id && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.id) ? input.id : nextId()),
    title: input.title,
    start: input.start,
    end: input.end ?? existing?.end ?? null,
    leadMinutes: input.leadMinutes ?? existing?.leadMinutes ?? 0,
    recurrence: rec,
    important: input.important ?? existing?.important ?? false,
    announceInRadio: input.announceInRadio ?? existing?.announceInRadio ?? true,
    note: input.note ?? existing?.note ?? '',
    enabled: input.enabled ?? existing?.enabled ?? true,
    // 改了时间/重复规则 ⇒ 重置去重标记（否则"改到明天"会被今天的 fired 记录挡住）
    lastFiredDay: existing && existing.start === input.start && sameRecurrence(existing.recurrence, rec)
      ? existing.lastFiredDay
      : null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  const schedules = existing
    ? cur.schedules.map(s => (s.id === next.id ? next : s))
    : [...cur.schedules, next]
  save(schedules)
  log().info('日程已保存', {
    id: next.id, recurrence: next.recurrence.kind, start: next.start, lead: next.leadMinutes,
    important: next.important, total: schedules.length, created: !existing,
  }, 'schedule.upsert')
  return next
}

function sameRecurrence(a: Schedule['recurrence'], b: Schedule['recurrence']): boolean {
  return a.kind === b.kind && a.date === b.date && a.dayOfMonth === b.dayOfMonth
    && a.weekdays.length === b.weekdays.length && a.weekdays.every((w, i) => w === b.weekdays[i])
}

export function deleteSchedule(id: string): boolean {
  const cur = loadSchedules()
  const schedules = cur.schedules.filter(s => s.id !== id)
  if (schedules.length === cur.schedules.length) return false
  save(schedules)
  log().info('日程已删除', { id, total: schedules.length }, 'schedule.delete')
  return true
}

/** 某一天是否命中该日程的重复规则 */
export function occursOn(s: Schedule, d: Date): boolean {
  if (!s.enabled) return false
  const day = dateOnly(d)
  switch (s.recurrence.kind) {
    case 'once':
      return s.recurrence.date === day
    case 'daily':
      return true
    case 'weekdays':
      return d.getDay() >= 1 && d.getDay() <= 5
    case 'weekly':
      return s.recurrence.weekdays.includes(d.getDay())
    case 'monthly':
      return s.recurrence.dayOfMonth === d.getDate()
    default:
      return false
  }
}

/** 今日日程（按开始时间排序） */
export function todaySchedules(now = new Date()): Schedule[] {
  return loadSchedules().schedules
    .filter(s => occursOn(s, now))
    .sort((a, b) => minutesOfDay(a.start) - minutesOfDay(b.start))
}

export interface DueSchedule {
  schedule: Schedule
  /** 触发时间（= 开始时间 − leadMinutes）对应的 `HH:MM` */
  triggerAt: string
  /** 距现在还有多少分钟（负数 = 已过） */
  minutesFromNow: number
  /** 日程开始距现在还有多少分钟 */
  startsInMinutes: number
}

/**
 * 到点需要提醒的日程。
 *
 * 判定：`now ∈ [start − lead, start − lead + windowMinutes)`，且今天还没触发过。
 * `windowMinutes` 默认 10 —— 窗口太窄会因为引擎 tick 或电脑休眠而漏触发；
 * 太宽会把"早上的日程"在中午又提醒一次。10 分钟是"漏一次可接受、重复一次很烦"之间的折中，
 * 且**重启恢复**也依赖这个窗口（重启后仍在窗口内 ⇒ 补发一次）。
 */
export function dueSchedules(now = new Date(), windowMinutes = 10): DueSchedule[] {
  const out: DueSchedule[] = []
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const day = dateOnly(now)
  for (const s of loadSchedules().schedules) {
    if (!occursOn(s, now)) continue
    if (s.lastFiredDay === day) continue
    const startMin = minutesOfDay(s.start)
    if (startMin < 0) continue
    const triggerMin = startMin - s.leadMinutes
    if (nowMin < triggerMin || nowMin >= triggerMin + windowMinutes) continue
    out.push({
      schedule: s,
      triggerAt: hhmm(new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(triggerMin / 60), triggerMin % 60)),
      minutesFromNow: triggerMin - nowMin,
      startsInMinutes: startMin - nowMin,
    })
  }
  return out.sort((a, b) => a.startsInMinutes - b.startsInMinutes)
}

/** 标记"今天已经为这条日程提醒过了"（去重的唯一写入口） */
export function markScheduleFired(id: string, now = new Date()): boolean {
  const cur = loadSchedules()
  const day = dateOnly(now)
  const target = cur.schedules.find(s => s.id === id)
  if (!target || target.lastFiredDay === day) return false
  save(cur.schedules.map(s => (s.id === id ? { ...s, lastFiredDay: day, updatedAt: Date.now() } : s)))
  log().info('日程已标记为今日已提醒', { id, day }, 'schedule.fired')
  return true
}

/** 仅供单测：丢弃缓存 */
export function __resetScheduleStoreForTest(): void {
  store.__reset()
}
