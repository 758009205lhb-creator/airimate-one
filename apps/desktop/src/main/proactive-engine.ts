/**
 * apps/desktop/src/main/proactive-engine.ts —— 主动陪伴引擎（M2）
 *
 * 一个 tick 循环做完全部主动行为，**判定与送达分离**：
 *
 *   tick ─┬─ ① 就绪判定（网络可达 + 有可用服务）→ 满足才做"开机问候"
 *         ├─ ② 今日日程播报（每天一次）
 *         ├─ ③ 早安电台（到点 + 已就绪 + 每天一次；生成 + 可选朗读）
 *         ├─ ④ 定时提醒到点（dueReminders）
 *         ├─ ⑤ 连续使用 / 久坐 / 夜间休息（阈值来自 reminder policy）
 *         └─ ⑥ 阻断结束时补发队列
 *
 * 硬约束（用户要求，逐条落到代码）：
 *   · **不弹窗、不发声、不抢焦点**：阻断时一律进队列；`focus` 恒为 false（见 blocker.ts）
 *   · **冷却**：每类行为有自己的冷却窗口（`ReminderPolicy.cooldownMinutes`）
 *   · **可关闭**：每个能力都有独立开关（settings），关掉后连"进队列"都不做
 *   · **持久化调度 + 重启恢复**：按天去重与冷却都落在 `engine-state.json`
 *   · **重复触发保护**：三层（冷却 / 按天 dedupeKey / 状态机只触发 pending）
 *   · **失败重试上限**：`markAttemptFailed()` 超限转 `failed` 并记审计
 *
 * 依赖全部通过参数注入（`ProactiveDeps`）⇒ 单测可以在**不启 Electron、不跑 PowerShell**
 * 的前提下把调度逻辑跑穿。
 */
import { randomUUID } from 'node:crypto'
import type {
  ActivityState, ProactiveEvent, ProactiveEventKind, ProactiveStatus, Priority,
  RadioContent, Reminder, SettingsPatch, AppSettings,
} from '@airimate/shared'
import { dateOnly, hhmm, localDayKey, ProactiveEventSchema, RadioContentSchema, ReminderSchema } from '@airimate/shared'
import {
  cooldownUntilOf, loadEngineState, patchEngineState, pruneCooldowns, recordDecision, setCooldown,
} from './engine-state.js'
import { evaluateBlocker, inCooldown, maySpeak, type BlockerVerdict } from './blocker.js'
import { loadQuietHours, loadReminderPolicy, setQuietHours } from './quiet-store.js'
import { inQuietHours } from './quiet-store.js'
import {
  createEngineReminder, dueReminders, enforceQueueLimit, lastFiredAtOf, markAttemptFailed,
  markFired, markQueued, queuedReminders, queueSnapshot, unackedReminders, type StoredReminder,
} from './reminder-store.js'
import { dueSchedules, markScheduleFired, todaySchedules } from './schedule-store.js'
import { adviceFromStats, currentStreakMinutes, recordSample, resetStreak } from './activity-stats.js'
import { getNews, getWeather } from './knowledge-source.js'
import { composeRadio, radioToText } from './morning-radio.js'
import { getPersona } from './session-store.js'
import { reflectionDue, reflectionStatus, runReflection } from './reflection-engine.js'
import { log } from './log.js'

// ───────────────────────────────────────────────────────── 依赖注入

export interface ProactiveDeps {
  /** 读设置（每次读，保证用户刚改的开关立刻生效） */
  settings: () => AppSettings
  /** 写设置（引擎极少写：只用于"夜间提醒后自动进入静音时段"这种用户显式开启的行为） */
  patchSettings: (patch: SettingsPatch) => void
  /** 采样当前活动状态（单测传假实现） */
  sample: () => Promise<ActivityState>
  /** 把"可以送达"的主动事件交给 UI（主进程会转成 `evt:proactive` + 会话消息） */
  emit: (e: ProactiveEvent) => void
  /** 朗读（静音/阻断时调用方不会调它） */
  speak: (text: string, utteranceId: string) => Promise<void>
  /** 就绪判定：网络可达 + 有可用服务（供应商/本地服务） */
  ready: () => Promise<{ network: boolean, provider: boolean, detail: string }>
  /** 可控时钟（单测注入固定时间） */
  now?: () => Date
  /** 事件队列上限（防内存泄漏；默认 50，与 reminder policy 的 maxQueue 一致） */
  maxQueue?: number
  /**
   * tick 间隔毫秒（默认 10s）。
   * `--proactive-fast` 会压到 1s —— 探针不该为了看一次 tick 效果干等 10 秒。
   */
  tickMs?: number
}

export interface EngineHandle {
  stop: () => void
  /** 立刻跑一次 tick（探针与"刚开机"用） */
  runNow: () => Promise<TickResult>
  /** 实际生效的 tick 间隔（诊断与探针据此判断"这个引擎是不是真的在跑"） */
  tickIntervalMs: () => number
  status: () => ProactiveStatus
}

export interface TickResult {
  at: number
  blockReason: string
  /** 本次真正**送达**的事件数 */
  delivered: number
  /** 本次**进队列**的提醒数 */
  queued: number
  /** 本次因去重/冷却/开关而跳过的行为 */
  skipped: string[]
}

const TICK_INTERVAL_MS = 10_000

// ───────────────────────────────────────────────────────── 内部状态

interface QueuedEvent {
  event: ProactiveEvent
  at: number
}

let timer: NodeJS.Timeout | null = null
let running = false
let everStarted = false
/** 引擎启动时刻（用于"启动后 10 分钟内才做开机问候"） */
let startedAt = 0
/** 送达队列（内存态：阻断期间的短暂缓冲，进程退出即丢 —— 提醒本身已落盘） */
const outbox: QueuedEvent[] = []
let lastActivity: ActivityState | null = null
let lastBlocker: BlockerVerdict = { blocked: false, reason: 'none', text: '' }
let busy = false
/**
 * 引擎启动时登记的设置读取器。
 * 为什么要有它：`proactiveStatus()` 是**无参**的只读投影（IPC 与探针都直接调它），
 * 需要回显"各能力开关的真实值"。让引擎把 deps 里的 `settings` 登记下来，
 * 比在每个读状态的地方都传一遍 deps 更不容易漏。
 */
let activeSettings: (() => AppSettings) | null = null
/** 实际生效的 tick 间隔（`--proactive-fast` 会压到 1s） */
let effectiveTickMs = TICK_INTERVAL_MS

const nowOf = (d: ProactiveDeps): Date => (d.now ? d.now() : new Date())

// ───────────────────────────────────────────────────────── 事件构造

function makeEvent(kind: ProactiveEventKind, priority: Priority, title: string, text: string, o: {
  speak: boolean
  payload?: Record<string, unknown> | null
  ttlMs?: number
  source?: string
}): ProactiveEvent {
  return ProactiveEventSchema.parse({
    id: `pe_${kind}_${randomUUID().slice(0, 8)}`,
    kind,
    priority,
    title,
    text,
    payload: o.payload ?? null,
    speak: o.speak,
    focus: false,                     // ← 永不抢焦点（用户硬要求）
    ttlMs: o.ttlMs ?? 20_000,
    at: Date.now(),
    source: o.source ?? 'engine',
  })
}

// ───────────────────────────────────────────────────────── 送达

function clearOutbox(): void {
  outbox.length = 0
}

/** 直接把事件交给 UI（只在未被阻断时调用） */
function deliver(d: ProactiveDeps, e: ProactiveEvent): void {
  try {
    d.emit(e)
  } catch (err) {
    log().warn('主动事件送达失败', { id: e.id, kind: e.kind, err: err instanceof Error ? err.message : String(err) }, 'proactive.emit.failed')
  }
}

/** 进队列（阻断期间的缓冲；`maxQueue` 上限，超出丢最旧的 silent 级） */
function enqueue(e: ProactiveEvent, maxQueue: number): void {
  outbox.push({ event: e, at: Date.now() })
  if (outbox.length <= maxQueue) return
  const idx = outbox.findIndex(q => q.event.priority === 'silent')
  if (idx >= 0) {
    outbox.splice(idx, 1)
    log().warn('主动事件队列超限：丢弃最旧的静默级', { max: maxQueue }, 'proactive.queue.drop')
  } else {
    outbox.shift()
    log().warn('主动事件队列超限且无静默级：丢弃最旧的一条', { max: maxQueue }, 'proactive.queue.drop-oldest')
  }
}

/**
 * 阻断结束后补发：先重要后普通，静默级只进不弹（UI 侧按 priority 决定呈现方式）。
 * `verdict` 由调用方传入 —— **不在这里重新采样**，避免同一 tick 里出现两个不同的阻断判定
 * （那种"不一致"会让"为什么这条补发了那条没补发"变得无法解释）。
 */
function flushOutbox(d: ProactiveDeps, verdict: BlockerVerdict): number {
  if (outbox.length === 0) return 0
  if (verdict.blocked) return 0
  const rank: Record<Priority, number> = { important: 0, normal: 1, silent: 2 }
  const ordered = [...outbox].sort((a, b) => rank[a.event.priority] - rank[b.event.priority] || a.at - b.at)
  clearOutbox()
  for (const q of ordered) deliver(d, q.event)
  log().info('阻断结束，已补发主动事件', { count: ordered.length }, 'proactive.queue.flush')
  return ordered.length
}

function unavailableActivity(): ActivityState {
  return {
    at: Date.now(), idleMs: 0, inputEvents1m: 0, fullscreen: false, gameProcess: null,
    meeting: null, focusAssist: false, userSilent: false, titleDigest: null, titleChars: 0,
    available: false, unavailableReason: '尚未采样', blockReason: 'none',
  }
}

/**
 * 采样一次活动状态并更新引擎的 `lastActivity`。
 *
 * ⚠ **任何要判"能不能打扰"的入口都必须先用它**，不能直接读 `lastActivity`：
 *   `generateRadio()` / `proactive:tick` 都可能在任何时刻被单独调用（IPC、探针），
 *   而 `lastActivity` 初值是 `null` ⇒ `unavailableActivity()` ⇒ 保守阻断 ⇒
 *   "手动生成电台却什么也没发生"（实测踩到：探针单跑该用例时必然失败，
 *   因为它跳过了 `runTick` 的采样步骤）。
 *
 * 采样本身有 5 秒缓存（见 activity-probe.ts），多次调用不会打爆进程创建。
 */
async function freshActivity(d: ProactiveDeps, now: Date): Promise<ActivityState> {
  try {
    const a = await d.sample()
    lastActivity = a
    recordSample(a, now)
    return a
  } catch (e) {
    const a = unavailableActivity()
    a.unavailableReason = e instanceof Error ? e.message.slice(0, 200) : '采样异常'
    lastActivity = a
    return a
  }
}

// ───────────────────────────────────────────────────────── 各类行为

/** ① 开机问候（网络与服务就绪后；每天最多一次；启动 10 分钟内有效） */
async function maybeGreet(d: ProactiveDeps, now: Date): Promise<'fired' | 'queued' | 'skipped'> {
  const s = d.settings()
  if (!s.proactiveEnabled || !s.greetingEnabled) return 'skipped'
  const st = loadEngineState()
  const day = dateOnly(now)
  if (st.greetingDoneDay === day) return 'skipped'
  // 只在"本次启动后的 10 分钟内"问候：用户下午才开机也不该被"早安"问候
  if (startedAt > 0 && now.getTime() - startedAt > 10 * 60_000) {
    patchEngineState({ greetingDoneDay: day })
    recordDecision('greeting', 'skipped', 'none')
    log().info('跳过开机问候（超出启动窗口）', { minutesLate: Math.round((now.getTime() - startedAt) / 60_000) }, 'proactive.greeting.late')
    return 'skipped'
  }
  const ready = await d.ready()
  patchEngineState({ readiness: { network: ready.network, provider: ready.provider, checkedAt: Date.now() } })
  if (!ready.network) return 'skipped'
  // 冷却（跨重启也生效）：问候不在 reminder 表里，用引擎自己记的冷却时间
  const cd = inCooldown('greeting', cdOrNull('greeting'), now.getTime())
  if (cd.cooling) {
    recordDecision('greeting', 'skipped', 'cooldown')
    return 'skipped'
  }

  const greeting = hhmm(now) < '12:00' ? '早上好' : '你回来啦'
  const text = `${greeting}～我在这儿。${ready.provider ? '' : '（提醒：还没配置可用的模型供应商，我现在只能陪你说话）'}`
  const e = makeEvent('greeting', 'normal', '开机问候', text, { speak: s.ttsEnabled && !inQuietHours(now), ttlMs: 15_000 })
  patchEngineState({ greetingDoneDay: day, greetingAt: Date.now() })
  setCooldown('greeting', now.getTime() + loadReminderPolicy().cooldownMinutes.greeting * 60_000)

  const verdict = evaluateBlocker({ activity: lastActivity ?? unavailableActivity(), quiet: loadQuietHours(), now })
  if (verdict.blocked) {
    enqueue({ ...e, speak: false }, d.maxQueue ?? 50)
    recordDecision('greeting', 'queued', verdict.reason)
    return 'queued'
  }
  deliver(d, e)
  recordDecision('greeting', 'fired', 'none')
  return 'fired'
}

/**
 * 冷却记录的读取。
 * `cooldownUntil` 的键是**能力名**（greeting / radio / …），不是 reminder kind ——
 * reminder kind 的冷却走 `lastFiredAtOf()`（看提醒是否真的送达过）。
 */
function cdOrNull(kind: string): number | null {
  const v = cooldownUntilOf(kind)
  return v === null ? null : v
}

/** ② 今日日程播报（每天一次；与问候合并为一条，避免开机被念两遍） */
async function maybeBriefSchedule(d: ProactiveDeps, now: Date): Promise<'fired' | 'queued' | 'skipped'> {
  const s = d.settings()
  if (!s.proactiveEnabled || !s.scheduleBriefEnabled) return 'skipped'
  const day = dateOnly(now)
  const st = loadEngineState()
  if (st.scheduleBriefDay === day) return 'skipped'
  const todays = todaySchedules(now)
  patchEngineState({ scheduleBriefDay: day })
  if (todays.length === 0) {
    recordDecision('schedule-brief', 'skipped', 'none')
    return 'skipped'
  }
  const lines = todays.slice(0, 6).map(x => `${x.start} ${x.title}`)
  const text = `今天有 ${todays.length} 件事：\n${lines.join('\n')}${todays.length > 6 ? `\n…还有 ${todays.length - 6} 件` : ''}`
  const e = makeEvent('schedule-brief', 'normal', '今日日程', text, {
    speak: s.ttsEnabled, ttlMs: 25_000, payload: { count: todays.length },
  })
  const verdict = evaluateBlocker({ activity: lastActivity ?? unavailableActivity(), quiet: loadQuietHours(), now })
  if (verdict.blocked) {
    enqueue({ ...e, speak: false }, d.maxQueue ?? 50)
    recordDecision('schedule-brief', 'queued', verdict.reason)
    return 'queued'
  }
  deliver(d, e)
  recordDecision('schedule-brief', 'fired', 'none')
  return 'fired'
}

/**
 * ③ 早安电台（到点 + 每天一次 + 冷却）
 *
 * ⚠ `content` 在"被跳过"时是 `null` —— 刻意**不**去构造内容：
 *   `buildRadio()` 会打外网（天气 + 资讯），而 `generateRadio({force:false})` 会被
 *   每个 tick 调用一次；在跳过路径上生成内容等于每次 tick 都去抓一遍新闻。
 *   需要看内容的地方（UI 的"预览"、探针）一律传 `force:true`。
 */
export async function generateRadio(d: ProactiveDeps, opts: { force?: boolean, speak?: boolean } = {}): Promise<{ content: RadioContent | null, skippedReason: string | null }> {
  const s = d.settings()
  const now = nowOf(d)
  const st = loadEngineState()
  const day = dateOnly(now)
  if (!opts.force) {
    if (!s.proactiveEnabled || !s.morningRadioEnabled) return { content: null, skippedReason: '早安电台已在设置里关闭' }
    if (st.radioDay === day) return { content: null, skippedReason: '今天已经播报过' }
    const cd = inCooldown('radio', cdOrNull('radio'), now.getTime())
    if (cd.cooling) return { content: null, skippedReason: `冷却中（还有 ${cd.remainingMinutes} 分钟）` }
  }

  const content = await buildRadio(d, now)
  const wantSpeak = opts.force ? (opts.speak === true) : (opts.speak ?? s.morningRadioSpeak)
  patchEngineState({ radioDay: day, radioAt: Date.now() })
  setCooldown('radio', now.getTime() + loadReminderPolicy().cooldownMinutes.radio * 60_000)

  // ★ 用**新鲜采样**判阻断（见 `freshActivity()` 的注释：直接读 lastActivity 会误判）
  const activity = await freshActivity(d, now)
  const verdict = evaluateBlocker({ activity, quiet: loadQuietHours(), now })
  lastBlocker = verdict
  const speakAllowed = maySpeak('normal', verdict, now) && wantSpeak && s.ttsEnabled
  const e = makeEvent('morning-radio', 'normal', '早安电台', radioToText(content), {
    speak: speakAllowed,
    payload: { radio: content },
    ttlMs: 90_000,
    source: 'radio',
  })
  if (verdict.blocked) {
    enqueue({ ...e, speak: false }, d.maxQueue ?? 50)
    recordDecision('morning-radio', 'queued', verdict.reason)
    log().info('电台暂存进队列（被阻断）', { reason: verdict.reason, text: verdict.text }, 'proactive.radio.queued')
    return { content, skippedReason: null }
  }
  deliver(d, e)
  if (speakAllowed) {
    try {
      await d.speak(content.script, `radio-${content.day}`)
    } catch (err) {
      log().warn('早安电台朗读失败', { err: err instanceof Error ? err.message : String(err) }, 'proactive.radio.speak-failed')
    }
  }
  recordDecision('morning-radio', 'fired', 'none')
  log().info('早安电台已播报', {
    day: content.day, news: content.news.length, schedule: content.schedule.length,
    seconds: content.estimatedSeconds, spoken: speakAllowed, disclosures: content.disclosures.length,
  }, 'proactive.radio.fired')
  return { content, skippedReason: null }
}

async function buildRadio(d: ProactiveDeps, now: Date): Promise<RadioContent> {
  const s = d.settings()
  const [weather, news] = await Promise.all([
    getWeather().catch(() => null),
    getNews({ limit: 6 }).catch(() => null),
  ])
  /**
   * 开场白用**用户设定的人设问候语**（`persona.greeting`），不是写死的"早上好"。
   * 人设里没写才回退到按时间打招呼 —— 否则用户精心写的开场白永远用不上。
   */
  const personaGreeting = ((): string => {
    try {
      const g = getPersona().greeting?.trim()
      if (g) return g
    } catch { /* 人设读不到不该挡住电台 */ }
    return hhmm(now) < '12:00' ? '早上好' : '你好'
  })()
  void s
  return RadioContentSchema.parse(composeRadio({
    now,
    greeting: personaGreeting,
    weather: weather ?? {
      available: false, city: null, summary: null, tempC: null, feelsLikeC: null, highC: null,
      lowC: null, humidity: null, windKph: null, source: null, fetchedAt: null,
      unavailableReason: '天气服务不可用',
    },
    schedules: todaySchedules(now),
    news: news?.items ?? [],
    advice: adviceFromStats(now),
    newsFailures: news?.failures ?? ['资讯服务不可用'],
    newsFromCache: news?.fromCache ?? false,
  }))
}

/** ④ 定时提醒到点 */
function processDueReminders(d: ProactiveDeps, now: Date, verdict: BlockerVerdict): { delivered: number, queued: number } {
  let delivered = 0
  let queued = 0
  const due = dueReminders(now.getTime())
  for (const r of due) {
    const e = reminderEvent(r)
    if (verdict.blocked) {
      markQueued(r.id, verdict.reason)
      recordDecision(`reminder:${r.kind}`, 'queued', verdict.reason)
      queued++
      continue
    }
    deliver(d, e)
    markFired(r.id)
    recordDecision(`reminder:${r.kind}`, 'fired', 'none')
    delivered++
  }
  return { delivered, queued }
}

function reminderEvent(r: StoredReminder): ProactiveEvent {
  return makeEvent('reminder', r.priority, r.title, r.body || r.title, {
    speak: false, ttlMs: 30_000, payload: { reminderId: r.id, kind: r.kind }, source: 'reminder',
  })
}

/** ⑤ 阈值型提醒（连续使用 / 久坐 / 夜间）+ 日程到点提醒 */
function processThresholds(d: ProactiveDeps, now: Date, verdict: BlockerVerdict): { delivered: number, queued: number, skipped: string[] } {
  const s = d.settings()
  const policy = loadReminderPolicy()
  const activity = lastActivity
  const skipped: string[] = []
  let delivered = 0
  let queued = 0

  const push = (r: StoredReminder | null, label: string): void => {
    if (!r) { skipped.push(`${label}:dedupe`); return }
    if (verdict.blocked) {
      markQueued(r.id, verdict.reason)
      recordDecision(label, 'queued', verdict.reason)
      queued++
      return
    }
    deliver(d, reminderEvent(r))
    markFired(r.id)
    recordDecision(label, 'fired', 'none')
    delivered++
  }

  // 日程到点（提前量已由 dueSchedules 计算）
  if (s.proactiveEnabled) {
    for (const due of dueSchedules(now)) {
      const sc = due.schedule
      const minutesText = due.startsInMinutes <= 0
        ? '现在开始'
        : `还有 ${due.startsInMinutes} 分钟`
      const r = createEngineReminder({
        kind: 'scheduled',
        title: `日程：${sc.title}`,
        body: `${sc.start} 开始，${minutesText}。${sc.note}`.trim(),
        priority: sc.important ? 'important' : 'normal',
        dedupeKey: `sched:${sc.id}:${dateOnly(now)}`,
      })
      // 无论是否被阻断都要标记"今天已提醒"，否则同一分钟会反复触发
      markScheduleFired(sc.id, now)
      push(r, `schedule:${sc.id}`)
    }
  }

  // 连续使用电脑
  if (s.proactiveEnabled && s.continuousReminderEnabled) {
    const streak = currentStreakMinutes(now)
    if (streak >= policy.continuousMinutes) {
      const cd = inCooldown('continuous', lastFiredAtOf('continuous'), now.getTime(), policy)
      if (cd.cooling) skipped.push('continuous:cooldown')
      else {
        const r = createEngineReminder({
          kind: 'continuous',
          title: `已经连续用电脑 ${streak} 分钟了`,
          body: '起来走两步、喝口水，眼睛也歇一会儿吧。',
          priority: 'normal',
          dedupeKey: `continuous:${localDayKey(now.getTime())}`,
        })
        push(r, 'continuous')
      }
    }
  }

  // 久坐（活动量不足）
  if (s.proactiveEnabled && s.sedentaryReminderEnabled && activity) {
    const idleMinutes = Math.floor(activity.idleMs / 60_000)
    // 久坐 = 在电脑前但没怎么动：不是"离开"，也不是"一直在敲"
    const atDesk = activity.idleMs < 5 * 60_000
    if (atDesk && streakOfDesk(now) >= policy.sedentaryMinutes && idleMinutes >= 3) {
      const cd = inCooldown('sedentary', lastFiredAtOf('sedentary'), now.getTime(), policy)
      if (cd.cooling) skipped.push('sedentary:cooldown')
      else {
        const r = createEngineReminder({
          kind: 'sedentary',
          title: `久坐提醒：已经 ${policy.sedentaryMinutes} 分钟没怎么动了`,
          body: '站起来伸个懒腰，活动一下肩颈。',
          priority: 'normal',
          dedupeKey: `sedentary:${localDayKey(now.getTime())}`,
        })
        push(r, 'sedentary')
      }
    }
  }

  // 夜间休息
  if (s.proactiveEnabled && s.nightReminderEnabled) {
    const nightMin = policy.nightRestAt
    const nowMin = hhmm(now)
    if (nowMin >= nightMin && activity && activity.idleMs < 10 * 60_000) {
      const cd = inCooldown('night', lastFiredAtOf('night'), now.getTime(), policy)
      if (cd.cooling) skipped.push('night:cooldown')
      else {
        const r = createEngineReminder({
          kind: 'night',
          title: `已经不早了（${nightMin}）`,
          body: '该收尾休息了，明天再继续也来得及。',
          priority: 'important',
          dedupeKey: `night:${localDayKey(now.getTime())}`,
        })
        push(r, 'night')
        if (r && policy.nightRestEnablesQuietHours && !inQuietHours(now)) {
          setQuietHours({ enabled: true })
          log().info('夜间提醒后已自动开启静音时段（用户显式开启的策略）', { at: nightMin }, 'proactive.night.quiet-on')
        }
      }
    }
  }

  return { delivered, queued, skipped }
}

/** "在电脑前"的连续时长：与 activity-stats 的连续段一致，但久坐用的是更严的口径 */
function streakOfDesk(now: Date): number {
  return currentStreakMinutes(now)
}

/** ⑥ 阻断结束后补发队列 */
function flushReminderQueue(d: ProactiveDeps, now: Date, verdict: BlockerVerdict): { delivered: number, queued: number } {
  if (verdict.blocked) return { delivered: 0, queued: 0 }
  let delivered = 0
  for (const r of queuedReminders()) {
    deliver(d, reminderEvent(r))
    markFired(r.id)
    recordDecision('queue-flush', 'fired', 'none')
    delivered++
  }
  if (delivered) log().info('队列补发完成', { count: delivered }, 'proactive.queue.reminders-flushed')
  return { delivered, queued: 0 }
}

// ───────────────────────────────────────────────────────── tick

export async function runTick(d: ProactiveDeps): Promise<TickResult> {
  const now = nowOf(d)
  const skipped: string[] = []
  let delivered = 0
  let queued = 0

  const s = d.settings()
  /**
   * ① **先采样，再判阻断** —— 顺序不能反。
   *
   * 踩过的坑：早期版本先判阻断（用上一次的采样结果）再采样，于是"会议刚结束"
   * 这一 tick 仍按 `meeting` 判 ⇒ **队列要等下一个 tick 才补发**；
   * 更糟的是单测里 tick 是瞬间连续的，表现为"补发永远不发生"。
   * 现在的顺序保证：**本 tick 的阻断判定用的是本 tick 的新鲜读数**。
   */
  const activity = await freshActivity(d, now)
  const quiet = loadQuietHours()
  const verdict = evaluateBlocker({ activity, quiet, now })
  lastBlocker = verdict
  if (!s.proactiveEnabled) skipped.push('proactive:disabled')

  // 补发优先（阻断刚结束的那一刻最该做的事）
  const flushed = flushReminderQueue(d, now, verdict)
  delivered += flushed.delivered
  const flushedEvents = flushOutbox(d, verdict)
  delivered += flushedEvents

  if (s.proactiveEnabled) {
    const g = await maybeGreet(d, now)
    if (g === 'fired') delivered++
    else if (g === 'queued') queued++
    else skipped.push('greeting')

    const b = await maybeBriefSchedule(d, now)
    if (b === 'fired') delivered++
    else if (b === 'queued') queued++
    else skipped.push('schedule-brief')

    // 早安电台：到点才做（`force` 走 IPC 手动触发）
    if (s.morningRadioEnabled && hhmm(now) === s.morningRadioAt) {
      const r = await generateRadio(d, { speak: s.morningRadioSpeak })
      if (r.skippedReason === null) delivered++
      else skipped.push(`radio:${r.skippedReason}`)
    }

    /**
     * ★ M4：每日反思（到点 + 每天一次 + **默认关闭**）。
     *
     * 为什么放在这里而不是单独一个定时器：M4 的反思与 M2 的调度共享同一套
     * "按天去重 + 冷却 + 阻断判定"基础设施；另起一个定时器就会出现两套去重逻辑，
     * 那正是本项目反复踩过的"同一语义两处实现"。
     *
     * 反思**不受阻断判定影响**（它不打扰用户 —— 只是后台算一遍并写记忆），
     * 所以只判"到点 + 今天没跑过 + 开关打开"。
     */
    if (reflectionDue(now)) {
      try {
        const r = await runReflection({}, { now: () => now })
        if (r.ran) {
          skipped.push(`reflection:${r.reflection.items.length}items`)
          log().info('每日反思已执行', {
            day: r.reflection.day, auto: r.reflection.autoWritten, pending: r.reflection.pendingApproval,
          }, 'proactive.reflection.ran')
        } else {
          skipped.push(`reflection:${r.skippedReason ?? 'skip'}`)
        }
      } catch (e) {
        // 反思失败**不许把整个 tick 拖垮**（它只是后台任务）
        log().error('每日反思异常（已跳过本轮）', { err: e instanceof Error ? e.message.slice(0, 300) : String(e) }, 'proactive.reflection.error')
        skipped.push('reflection:error')
      }
    } else if (!s.selfLearningEnabled) {
      skipped.push('reflection:disabled')
    }
  }

  const due = processDueReminders(d, now, verdict)
  delivered += due.delivered
  queued += due.queued

  if (s.proactiveEnabled) {
    const th = processThresholds(d, now, verdict)
    delivered += th.delivered
    queued += th.queued
    skipped.push(...th.skipped)
  }

  const dropped = enforceQueueLimit()
  if (dropped.length) skipped.push(`queue-dropped:${dropped.length}`)

  pruneCooldowns(now.getTime())
  const st = loadEngineState()
  patchEngineState({
    ticks: st.ticks + 1,
    lastTickAt: Date.now(),
    everTicked: true,
  })

  return { at: Date.now(), blockReason: verdict.reason, delivered, queued, skipped }
}

// ───────────────────────────────────────────────────────── 生命周期

export function startProactiveEngine(d: ProactiveDeps): EngineHandle {
  if (running) {
    log().warn('主动引擎已在运行，忽略重复启动', {}, 'proactive.engine.duplicate-start')
    return {
      stop: stopProactiveEngine,
      runNow: async () => await runTick(d),
      tickIntervalMs: () => effectiveTickMs,
      status: () => proactiveStatus(),
    }
  }
  running = true
  everStarted = true
  startedAt = Date.now()
  activeSettings = d.settings
  effectiveTickMs = Math.max(500, Math.min(60_000, d.tickMs ?? TICK_INTERVAL_MS))
  // 冷启动时清掉上一次的连续段（昨晚的"连续 8 小时"不该算到今天）
  resetStreak()
  log().info('主动引擎已启动', { tickMs: effectiveTickMs }, 'proactive.engine.start')

  const loop = async (): Promise<void> => {
    if (busy) return
    busy = true
    try {
      await runTick(d)
    } catch (e) {
      log().error('主动引擎 tick 异常', { err: e instanceof Error ? e.message.slice(0, 300) : String(e) }, 'proactive.engine.tick-error')
    } finally {
      busy = false
    }
  }
  timer = setInterval(() => { void loop() }, effectiveTickMs)
  timer.unref?.()
  // 首次 tick 立刻跑一次（不要等一个间隔才问候）
  void loop()

  return {
    stop: stopProactiveEngine,
    runNow: async () => await runTick(d),
    tickIntervalMs: () => effectiveTickMs,
    status: () => proactiveStatus(),
  }
}

export function stopProactiveEngine(): void {
  if (timer) { clearInterval(timer); timer = null }
  running = false
  activeSettings = null
  clearOutbox()
  log().info('主动引擎已停止', {}, 'proactive.engine.stop')
}

export function engineRunning(): boolean {
  return running
}

export function engineEverStarted(): boolean {
  return everStarted
}

/** 当前阻断判定（UI 显示"正在会议中，提醒已排队"） */
export function currentBlocker(): BlockerVerdict {
  return lastBlocker
}

export function currentActivity(): ActivityState | null {
  return lastActivity
}

/** 只读状态（诊断 / 探针 / UI） */
export function proactiveStatus(): ProactiveStatus {
  const st = loadEngineState()
  const queuedList = queueSnapshot()
  const s = activeSettings?.() ?? null
  return {
    running,
    nextTickInMs: running ? effectiveTickMs : -1,
    lastTickAt: st.lastTickAt,
    ticks: st.ticks,
    startupGreeted: st.greetingDoneDay !== null,
    startupGreetedAt: st.greetingAt,
    radioGeneratedAt: st.radioAt,
    cooldownUntil: st.cooldownUntil,
    queueLength: queuedList.length + outbox.length,
    recentDecisions: st.recentDecisions.map(d => ({ at: d.at, kind: d.kind, decision: d.decision, reason: d.reason as never })),
    activeReminders: unackedReminders().length,
    enabled: {
      greeting: s ? s.proactiveEnabled && s.greetingEnabled : false,
      scheduleBrief: s ? s.proactiveEnabled && s.scheduleBriefEnabled : false,
      morningRadio: s ? s.proactiveEnabled && s.morningRadioEnabled : false,
      continuous: s ? s.proactiveEnabled && s.continuousReminderEnabled : false,
      sedentary: s ? s.proactiveEnabled && s.sedentaryReminderEnabled : false,
      night: s ? s.proactiveEnabled && s.nightReminderEnabled : false,
    },
    reflection: {
      enabled: s?.selfLearningEnabled ?? false,
      lastRunAt: st.reflectionAt,
      lastRunDay: st.reflectionDay,
      runs: st.reflectionRuns,
    },
    /** ★ M4：待确认条数（UI 角标）；只给计数，不给内容 */
    pendingReflections: (() => {
      try { return reflectionStatus().pendingCount } catch { return 0 }
    })(),
  }
}

/** 引擎状态 + 队列（`proactive:inbox`） */
export function proactiveInbox(): {
  queued: ReturnType<typeof queueSnapshot>
  unacked: Reminder[]
  recent: Array<{ id: string, kind: ProactiveEventKind, priority: Priority, title: string, at: number }>
} {
  return {
    queued: queueSnapshot(),
    unacked: unackedReminders(),
    recent: outbox.map(q => ({ id: q.event.id, kind: q.event.kind, priority: q.event.priority, title: q.event.title, at: q.event.at })),
  }
}

/** 仅供单测：清空内存态 */
export function __resetEngineForTest(): void {
  if (timer) { clearInterval(timer); timer = null }
  running = false
  everStarted = false
  startedAt = 0
  activeSettings = null
  effectiveTickMs = TICK_INTERVAL_MS
  clearOutbox()
  lastActivity = null
  lastBlocker = { blocked: false, reason: 'none', text: '' }
  busy = false
}

/** 交付给 UI 的"提醒"投影（供会话消息复用） */
export function reminderToPublic(r: StoredReminder): Reminder {
  return ReminderSchema.parse(r)
}
