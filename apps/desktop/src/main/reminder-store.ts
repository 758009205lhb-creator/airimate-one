/**
 * apps/desktop/src/main/reminder-store.ts —— 提醒与队列（M2）
 *
 * 状态机（**持久化**，重启可恢复）：
 *
 *   pending ──引擎到点──► fired          （成功送达）
 *      │                    │
 *      │                    └──用户确认──► done
 *      └──被阻断──► queued ──阻断结束补发──► fired
 *                     │
 *                     └──重试超上限──► failed（记审计，不再无限重试）
 *
 * 三条防重复机制（用户要求"重复触发保护"）：
 *   ① 同一 `kind` 在冷却窗口内不重复产生（冷却由引擎用 `lastFiredOf()` 判定）；
 *   ② 同一天内 `continuous` / `sedentary` / `night` 各只产生一次（`dedupeKey`）；
 *   ③ 状态机本身：只有 `pending` 能被触发，`fired`/`done`/`cancelled` 不再触发。
 *
 * 队列上限：超出时**丢最旧的 `silent` 级**，重要级永远保留（见 `enqueue`）。
 */
import { z } from 'zod'
import type { Priority, Reminder, ReminderKind, ReminderQueueItem, ReminderState, ReminderUpsert, BlockReason } from '@airimate/shared'
import {
  ReminderKindSchema, PrioritySchema, ReminderStateSchema, BlockReasonSchema, dateOnly, minutesOfDay,
} from '@airimate/shared'
import { createJsonStore } from './json-store.js'
import { loadReminderPolicy } from './quiet-store.js'
import { log } from './log.js'

export const ReminderSchema = z.object({
  id: z.string().min(1).max(64),
  kind: ReminderKindSchema,
  title: z.string().min(1).max(200),
  body: z.string().max(2000).default(''),
  priority: PrioritySchema.default('normal'),
  fireAt: z.number(),
  scheduleId: z.string().max(64).nullable().default(null),
  state: ReminderStateSchema.default('pending'),
  blockReason: BlockReasonSchema.default('none'),
  attempts: z.number().int().min(0).default(0),
  lastError: z.string().max(300).nullable().default(null),
  firedAt: z.number().nullable().default(null),
  ackedAt: z.number().nullable().default(null),
  /** 去重键：`kind:YYYY-MM-DD`（用户设定的定时提醒用 `id`，不参与按天去重） */
  dedupeKey: z.string().max(80).default(''),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type StoredReminder = z.infer<typeof ReminderSchema>

const StoreSchema = z.object({
  version: z.literal(1),
  reminders: z.array(ReminderSchema).max(2000),
  /** 已送达但用户未确认的（最近 200 条，供提醒中心显示角标） */
  recentDelivered: z.array(z.string().max(64)).max(200).default([]),
})
type Store = z.infer<typeof StoreSchema>

const store = createJsonStore<Store>({
  file: 'reminders.json',
  schema: StoreSchema,
  fallback: () => ({ version: 1, reminders: [], recentDelivered: [] }),
  tag: 'reminder',
  /** 登记名（迁移链按它查表；**改了它必须同步 STORE_DESCRIPTORS**） */
  storeName: 'reminders',
})

/** 保留上限：太老的已完成提醒会被裁掉（防止文件无限增长） */
const MAX_REMINDERS = 1200
/** 已送达列表的保留条数 */
const MAX_RECENT = 200

export function loadReminders(): Store {
  return store.load()
}

function save(next: Store): void {
  const reminders = next.reminders.length > MAX_REMINDERS
    // 优先裁掉"已完成/已取消"的旧条目；再进行中/待触发的永远保留
    ? [...next.reminders].sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt).slice(next.reminders.length - MAX_REMINDERS)
    : next.reminders
  store.save({ version: 1, reminders, recentDelivered: next.recentDelivered.slice(-MAX_RECENT) })
}

function rank(r: StoredReminder): number {
  if (r.state === 'pending' || r.state === 'queued') return 2
  if (r.state === 'fired') return 1
  return 0
}

let seq = 0
export function nextReminderId(kind: ReminderKind): string {
  seq += 1
  return `r_${kind}_${Date.now().toString(36)}_${seq}`
}

export function getReminder(id: string): StoredReminder | null {
  return loadReminders().reminders.find(r => r.id === id) ?? null
}

export function listReminders(opts: { limit?: number, states?: ReminderState[] } = {}): StoredReminder[] {
  const states = opts.states
  const all = loadReminders().reminders
    .filter(r => (states ? states.includes(r.state) : true))
    .sort((a, b) => (a.state === 'pending' || a.state === 'queued' ? 0 : 1) - (b.state === 'pending' || b.state === 'queued' ? 0 : 1)
      || a.fireAt - b.fireAt)
  return all.slice(0, opts.limit ?? 200)
}

/** 用户新建提醒（定时提醒走这里；引擎产生的走 `createReminder`） */
export function upsertReminder(input: ReminderUpsert): Reminder {
  const cur = loadReminders()
  const now = Date.now()
  const existing = input.id ? cur.reminders.find(r => r.id === input.id) : undefined

  let fireAt = input.fireAt ?? existing?.fireAt ?? 0
  if (input.atTime !== undefined) {
    const base = input.atDate ? new Date(`${input.atDate}T00:00:00`) : new Date(now)
    const mins = minutesOfDay(input.atTime)
    if (mins < 0) throw new Error('时间格式必须是 HH:MM')
    base.setHours(Math.floor(mins / 60), mins % 60, 0, 0)
    fireAt = base.getTime()
    // 只给了时刻、且今天这个点已经过了 ⇒ 顺延到明天（符合直觉；UI 会显示实际时间）
    if (input.atDate === undefined && fireAt <= now) fireAt += 24 * 3600 * 1000
  }
  if (!Number.isFinite(fireAt) || fireAt <= 0) throw new Error('提醒必须有一个有效的触发时间')

  const next: StoredReminder = ReminderSchema.parse({
    id: existing?.id ?? (input.id && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.id) ? input.id : nextReminderId(input.kind)),
    kind: input.kind,
    title: input.title,
    body: input.body ?? existing?.body ?? '',
    priority: input.priority ?? existing?.priority ?? (input.kind === 'scheduled' ? 'normal' : 'normal'),
    fireAt,
    scheduleId: input.scheduleId ?? existing?.scheduleId ?? null,
    state: 'pending',
    blockReason: 'none',
    attempts: existing?.attempts ?? 0,
    lastError: null,
    firedAt: null,
    ackedAt: null,
    dedupeKey: existing?.dedupeKey ?? '',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  })
  const reminders = existing
    ? cur.reminders.map(r => (r.id === next.id ? next : r))
    : [...cur.reminders, next]
  save({ ...cur, reminders })
  log().info('提醒已保存', {
    id: next.id, kind: next.kind, priority: next.priority, chars: next.title.length,
    fireAtHour: new Date(next.fireAt).getHours(), created: !existing,
  }, 'reminder.upsert')
  return next
}

/**
 * 引擎产生一条提醒（带**按天去重键**）。
 * 返回 `null` = 今天已经产生过同类的（不重复），调用方据此记 `skipped: dedupe`。
 */
export function createEngineReminder(input: {
  kind: ReminderKind
  title: string
  body?: string
  priority: Priority
  fireAt?: number
  dedupeKey: string
}): StoredReminder | null {
  const cur = loadReminders()
  if (input.dedupeKey && cur.reminders.some(r => r.dedupeKey === input.dedupeKey)) {
    log().info('提醒已按去重键跳过', { kind: input.kind, key: input.dedupeKey }, 'reminder.dedupe')
    return null
  }
  const now = Date.now()
  const r: StoredReminder = ReminderSchema.parse({
    id: nextReminderId(input.kind),
    kind: input.kind,
    title: input.title,
    body: input.body ?? '',
    priority: input.priority,
    fireAt: input.fireAt ?? now,
    scheduleId: null,
    state: 'pending',
    blockReason: 'none',
    attempts: 0,
    lastError: null,
    firedAt: null,
    ackedAt: null,
    dedupeKey: input.dedupeKey,
    createdAt: now,
    updatedAt: now,
  })
  save({ ...cur, reminders: [...cur.reminders, r] })
  log().info('引擎提醒已创建', { id: r.id, kind: r.kind, priority: r.priority, key: input.dedupeKey }, 'reminder.create')
  return r
}

function update(id: string, patch: Partial<StoredReminder>): StoredReminder | null {
  const cur = loadReminders()
  const target = cur.reminders.find(r => r.id === id)
  if (!target) return null
  const next = { ...target, ...patch, updatedAt: Date.now() }
  save({ ...cur, reminders: cur.reminders.map(r => (r.id === id ? next : r)) })
  return next
}

/** 标记为已送达（`firedAt` 是"到底送出去没有"的唯一证据） */
export function markFired(id: string): StoredReminder | null {
  const cur = loadReminders()
  const target = cur.reminders.find(r => r.id === id)
  if (!target) return null
  const next: StoredReminder = { ...target, state: 'fired', firedAt: Date.now(), blockReason: 'none', lastError: null, updatedAt: Date.now() }
  const recent = cur.recentDelivered.includes(id) ? cur.recentDelivered : [...cur.recentDelivered, id]
  // ⚠ 必须**一次性**写入：先 update 再补 recentDelivered 会把前者覆盖掉
  save({ ...cur, reminders: cur.reminders.map(r => (r.id === id ? next : r)), recentDelivered: recent })
  return next
}

/** 被阻断 → 进队列（**不丢**） */
export function markQueued(id: string, reason: BlockReason): StoredReminder | null {
  const r = update(id, { state: 'queued', blockReason: reason })
  if (r) log().info('提醒进入队列（被阻断）', { id, reason }, 'reminder.queued')
  return r
}

/** 一次送达尝试失败（重试上限内保持 queued，超限转 failed） */
export function markAttemptFailed(id: string, error: string, reason: BlockReason = 'none'): StoredReminder | null {
  const maxRetries = loadReminderPolicy().maxRetries
  const cur = getReminder(id)
  if (!cur) return null
  const attempts = cur.attempts + 1
  const over = attempts > maxRetries
  const r = update(id, {
    attempts,
    lastError: error.slice(0, 300),
    state: over ? 'failed' : 'queued',
    blockReason: reason,
  })
  log().warn('提醒送达失败', { id, attempts, maxRetries, over, reason }, over ? 'reminder.failed' : 'reminder.retry')
  return r
}

export function ackReminder(id: string, acked = true): StoredReminder | null {
  const cur = loadReminders()
  const target = cur.reminders.find(r => r.id === id)
  if (!target) return null
  const next: StoredReminder = {
    ...target,
    ackedAt: acked ? Date.now() : null,
    state: acked ? 'done' : 'fired',
    updatedAt: Date.now(),
  }
  save({
    ...cur,
    reminders: cur.reminders.map(r => (r.id === id ? next : r)),
    recentDelivered: acked ? cur.recentDelivered.filter(x => x !== id) : cur.recentDelivered,
  })
  return next
}

export function deleteReminder(id: string): boolean {
  const cur = loadReminders()
  const reminders = cur.reminders.filter(r => r.id !== id)
  if (reminders.length === cur.reminders.length) return false
  save({ ...cur, reminders, recentDelivered: cur.recentDelivered.filter(x => x !== id) })
  return true
}

/** 取消（保留记录，不改状态以外的字段） */
export function cancelReminder(id: string): StoredReminder | null {
  return update(id, { state: 'cancelled', blockReason: 'none' })
}

/** 到点且仍 `pending` 的提醒（引擎每个 tick 调一次） */
export function dueReminders(now = Date.now()): StoredReminder[] {
  return loadReminders().reminders
    .filter(r => r.state === 'pending' && r.fireAt <= now)
    .sort((a, b) => a.fireAt - b.fireAt)
}

/** 队列里待补发的（按优先级：重要 → 普通 → 静默；同级按时间） */
export function queuedReminders(): StoredReminder[] {
  const rankP: Record<Priority, number> = { important: 0, normal: 1, silent: 2 }
  return loadReminders().reminders
    .filter(r => r.state === 'queued')
    .sort((a, b) => rankP[a.priority] - rankP[b.priority] || a.fireAt - b.fireAt)
}

/**
 * 队列上限控制：超出时丢**最旧的 `silent` 级**。
 * 返回被丢弃的 id 列表（调用方记审计 —— 丢弃必须可见，不能静默）。
 */
export function enforceQueueLimit(): string[] {
  const max = loadReminderPolicy().maxQueue
  const queued = queuedReminders()
  if (queued.length <= max) return []
  const droppable = queued.filter(r => r.priority === 'silent').slice(0, queued.length - max)
  if (droppable.length === 0) {
    // 全是重要/普通级：只记警告，**不丢**（宁可队列长一点也不丢用户的要紧事）
    log().warn('提醒队列超限但无可丢弃项（重要/普通级全部保留）', { queued: queued.length, max }, 'reminder.queue.overflow')
    return []
  }
  const ids = droppable.map(r => r.id)
  const cur = loadReminders()
  save({ ...cur, reminders: cur.reminders.map(r => (ids.includes(r.id) ? { ...r, state: 'cancelled', lastError: '队列超限被丢弃', updatedAt: Date.now() } : r)) })
  log().warn('提醒队列超限：已丢弃最旧的静默级', { dropped: ids.length, queued: queued.length, max }, 'reminder.queue.drop-silent')
  return ids
}

/** 队列快照（UI 提醒中心） */
export function queueSnapshot(): ReminderQueueItem[] {
  const text: Record<BlockReason, string> = {
    none: '',
    'quiet-hours': '静音时段中，结束后补发',
    fullscreen: '你正在全屏（演示/视频），结束后补发',
    game: '检测到游戏正在运行，结束后补发',
    meeting: '检测到会议中，结束后补发',
    focus: '专注模式中，结束后补发',
    'user-silent': '你开了静默模式，关闭后补发',
    disabled: '该能力已关闭',
    cooldown: '冷却中',
  }
  return queuedReminders().map(r => ({ reminder: publicReminder(r), blockedReasonText: text[r.blockReason] || '被阻断，等待补发' }))
}

/** 已送达但未确认的 */
export function unackedReminders(): Reminder[] {
  const set = new Set(loadReminders().recentDelivered)
  return loadReminders().reminders
    .filter(r => r.state === 'fired' && r.ackedAt === null && set.has(r.id))
    .sort((a, b) => (b.firedAt ?? 0) - (a.firedAt ?? 0))
    .map(publicReminder)
}

/** 把内部结构投影成契约类型（**不额外暴露任何字段**） */
function publicReminder(r: StoredReminder): Reminder {
  const { dedupeKey: _drop, ...rest } = r
  return rest
}

/**
 * 某类提醒最近一次**真的送达**的时间（冷却判定）。
 * 只看 `firedAt` —— 冷却针对的是"打扰了用户"，没送出去的提醒不该消耗冷却。
 */
export function lastFiredAtOf(kind: ReminderKind): number | null {
  let best: number | null = null
  for (const r of loadReminders().reminders) {
    if (r.kind !== kind) continue
    if (r.firedAt === null) continue
    if (best === null || r.firedAt > best) best = r.firedAt
  }
  return best
}

/** `privacy:wipe` 用 */
export function destroyReminderStore(): { removed: boolean, bytes: number } {
  return store.destroy()
}

export function reminderStorePath(): string {
  return store.filePath()
}

/** 今日已产生过哪些引擎提醒（去重判定与诊断） */
export function engineRemindersToday(now = new Date()): string[] {
  const day = dateOnly(now)
  return loadReminders().reminders.filter(r => r.dedupeKey.endsWith(day)).map(r => r.kind)
}

/** 仅供单测：丢弃缓存 */
export function __resetReminderStoreForTest(): void {
  store.__reset()
}
