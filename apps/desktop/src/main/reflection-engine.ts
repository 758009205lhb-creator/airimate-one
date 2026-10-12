/**
 * apps/desktop/src/main/reflection-engine.ts —— 每日反思任务（M4 的执行者）
 *
 * 用户要求（逐条对应）：
 *   · "每天固定时间执行一次反思任务"            → `runReflection()` 由主动引擎在 `selfLearningAt` 触发
 *   · "总结当天对话、提取偏好、重要事实、待办和情绪变化" → `extractFromMessages()` + `buildDailySummary()`
 *   · "高置信度事实写入长期记忆；低置信度内容必须询问用户确认"
 *                                              → ★ 见下面 `writeGate`
 *   · "可学习日程习惯、称呼偏好、工作节奏、提醒反馈，但不得自动修改代码、系统提示词、权限或电脑设置"
 *                                              → 本模块**只写记忆**，绝不碰 settings/persona/permission
 *   · "每天可生成今日总结和明日建议"            → `dailySummary` / `tomorrowAdvice`
 *   · "外部资料必须保留来源与日期"              → `externalRefs`（来自资讯缓存，带 source/date）
 *   · "支持关闭自学习、导出记忆、删除单条记忆和彻底清除个人数据" → 开关 + 既有 privacy 通道 + `reflection:clear`
 *
 * ★ `writeGate` —— 这是 M4 最要紧的一处语义：
 *
 *     confidence >= HIGH_CONFIDENCE(0.75)  ⇒ 自动写入长期记忆（approval='auto'）
 *     否则                                  ⇒ 只保存为待确认项（approval='pending'），**不写记忆**
 *
 *   并且**被用户拒绝过的结论不再重复提问**（指纹表）。
 *   为什么：如果每跑一次就把同一件事再问一遍，用户会把"确认"当成骚扰而全部点掉 ——
 *   那这条防线就失效了。拒绝是一次有意义的信号，必须被记住。
 */
import { randomUUID } from 'node:crypto'
import type { DailyReflection, ReflectionItem } from '@airimate/shared'
import { HIGH_CONFIDENCE, dateOnly, hhmm, localDayKey } from '@airimate/shared'
import {
  KEEP_DAYS, getReflection, reflectionDigest, saveReflection, wasRejected,
} from './reflection-store.js'
import { buildDailySummary, buildTomorrowAdvice, computeRhythm, extractFromMessages } from './reflection-extract.js'
import { history as sessionHistory, sessionMessageCount } from './session-store.js'
import { addMemory, memoryCount } from './memory-store.js'
import { loadActivity, recentDays, todayStats } from './activity-stats.js'
import { loadSettings } from './settings-store.js'
import { loadEngineState, patchEngineState } from './engine-state.js'
import { getNews } from './knowledge-source.js'
import { log } from './log.js'

export interface ReflectionDeps {
  /** 可控时钟（单测注入固定时间） */
  now?: () => Date
  /** 是否真的写记忆（`dryRun` 时为 false —— 探针用，避免污染用户记忆） */
  writeMemory?: boolean
}

export interface ReflectionOutcome {
  reflection: DailyReflection
  /** 本次是否真的执行了（被开关/去重挡住时为 false） */
  ran: boolean
  skippedReason: string | null
}

const nowOf = (d: ReflectionDeps): Date => (d.now ? d.now() : new Date())

/**
 * 跑一次反思。
 *
 * `force:true` **同时**绕过两道闸门（按天去重 + 用户开关）。理由：
 *   `force` 只由**用户显式点击**（"现在反思一次"）或探针传入 ——
 *   那本身就是一次明确的动作，"开关关着"不该阻止用户手动跑一次。
 *   ⚠ 但**自动触发**走的是 `reflectionDue()`，它**严格尊重开关**
 *     （默认 `selfLearningEnabled=false` ⇒ 自动路径永远不跑）。
 *   两者的分工是刻意的：**自动化受开关约束，手动动作不受**。
 *
 * 被挡住时一律**如实返回原因**，不静默跳过。
 */
export async function runReflection(
  o: { force?: boolean, dryRun?: boolean } = {},
  d: ReflectionDeps = {},
): Promise<ReflectionOutcome> {
  const now = nowOf(d)
  const day = dateOnly(now)
  const s = loadSettings()
  const writeMemory = o.dryRun === true ? false : (d.writeMemory !== false)

  if (!o.force && !s.selfLearningEnabled) {
    return { reflection: emptyReflection(day), ran: false, skippedReason: '自学习已在设置里关闭' }
  }
  const st = loadEngineState()
  if (!o.force && st.reflectionDay === day) {
    const existing = getReflection(day)
    return { reflection: existing ?? emptyReflection(day), ran: false, skippedReason: '今天已经反思过了' }
  }

  const started = Date.now()
  const msgs = sessionHistory(500)
  const extract = extractFromMessages(msgs)
  const activity = todayStats(now)
  const rhythm = computeRhythm({ days: recentDays(7, now) })

  const userMsgs = msgs.filter(m => m.role === 'user')
  const assistantMsgs = msgs.filter(m => m.role === 'assistant')
  const proactiveMsgs = assistantMsgs.filter(m => m.origin !== 'user')

  const disclosures: string[] = []
  if (!writeMemory) disclosures.push('本次是演练（dryRun）：没有写入任何长期记忆')
  if (extract.scannedUserMessages === 0) disclosures.push('今天没有用户消息，提取不到偏好或事实')
  if (!s.selfLearningEnabled) disclosures.push('注意：自学习当前是关闭状态（本次为手动触发）')

  // ── 外部资料（若缓存里有就用，**必须带来源与日期**）
  const externalRefs: DailyReflection['externalRefs'] = []
  try {
    const news = await getNews({ limit: 3 })
    for (const n of news.items.slice(0, 3)) {
      externalRefs.push({ title: n.title.slice(0, 300), source: n.source, date: n.date })
    }
    if (news.fromCache && news.items.length > 0) disclosures.push('外部资料来自本地缓存（本次未联网抓取）')
  } catch {
    disclosures.push('外部资料不可用（资讯源不可达）')
  }

  // ── ★ 写入闸门
  const items: ReflectionItem[] = []
  let autoWritten = 0
  for (const e of extract.items) {
    const id = `ri_${randomUUID().slice(0, 10)}`
    /**
     * 被拒绝过的结论**不再提问、也不写入** —— 记为 `skipped` 并留痕。
     * 注意：这里不把"拒绝过"当成"永远不能再学"：用户以后主动说的话会再次命中规则，
     * 那时指纹相同仍会被跳过。这是刻意的（避免反复骚扰），代价是"改主意"需要用户主动说。
     */
    if (wasRejected(e.text)) {
      items.push({
        id, kind: e.kind, text: e.text, confidence: e.confidence, approval: 'skipped',
        evidence: { messageCount: e.messageCount, ruleId: e.ruleId }, memoryId: null, createdAt: started,
      })
      continue
    }
    const high = e.confidence >= HIGH_CONFIDENCE
    if (high && writeMemory) {
      const mem = addMemory({ text: e.text, tags: ['自学习', e.kind], importance: Math.min(1, e.confidence) })
      const wrote = typeof mem?.id === 'string'
      if (wrote) autoWritten++
      items.push({
        id, kind: e.kind, text: e.text, confidence: e.confidence,
        approval: wrote ? 'auto' : 'pending',
        evidence: { messageCount: e.messageCount, ruleId: e.ruleId },
        memoryId: wrote ? mem.id : null,
        createdAt: started,
      })
      if (!wrote) disclosures.push(`有一条高置信度结论未能写入记忆（记忆层拒绝或已存在），已转为待确认`)
    } else if (high && !writeMemory) {
      // 演练：高置信度也**不写**，如实标为待确认（不能让 dryRun 悄悄改变记忆）
      items.push({
        id, kind: e.kind, text: e.text, confidence: e.confidence, approval: 'pending',
        evidence: { messageCount: e.messageCount, ruleId: e.ruleId }, memoryId: null, createdAt: started,
      })
    } else {
      // ★ 低置信度 ⇒ **只入库为待确认，绝不写长期记忆**
      items.push({
        id, kind: e.kind, text: e.text, confidence: e.confidence, approval: 'pending',
        evidence: { messageCount: e.messageCount, ruleId: e.ruleId }, memoryId: null, createdAt: started,
      })
    }
  }

  const pending = items.filter(i => i.approval === 'pending').length

  const summaryInput = {
    day,
    userMessages: userMsgs.map(m => ({
      id: m.id, role: m.role as ChatMessageRole, text: m.text, createdAt: m.createdAt,
      commands: [], origin: (m.origin ?? 'user') as 'user' | 'proactive' | 'radio' | 'reflection',
    })),
    allMessages: msgs,
    activity: activity.samples > 0 ? activity : null,
    rhythm,
    memoryHits: memoryCount(),
  }
  const dailySummary = buildDailySummary(summaryInput)
  const tomorrowAdvice = buildTomorrowAdvice(summaryInput)

  const reflection: DailyReflection = {
    day,
    generatedAt: started,
    summary: dailySummary,
    stats: {
      messages: sessionMessageCount(),
      userMessages: userMsgs.length,
      assistantMessages: assistantMsgs.length,
      proactiveMessages: proactiveMsgs.length,
      memoryHits: memoryCount(),
      activeMinutes: activity.activeMinutes,
    },
    items,
    workRhythm: rhythm,
    dailySummary,
    tomorrowAdvice,
    externalRefs,
    // 纯规则实现 ⇒ 如实标 heuristic（**不谎称用了模型**）
    method: 'heuristic',
    disclosures,
    autoWritten,
    pendingApproval: pending,
  }

  saveReflection(reflection)
  patchEngineState({ reflectionDay: day, reflectionAt: started, reflectionRuns: st.reflectionRuns + 1 })
  log().info('每日反思完成', {
    day, items: items.length, auto: autoWritten, pending,
    scanned: extract.scannedUserMessages, sampleDays: rhythm.sampleDays,
    activeMinutes: activity.activeMinutes, dryRun: !writeMemory,
    ms: Date.now() - started,
  }, 'reflection.done')

  return { reflection, ran: true, skippedReason: null }
}

type ChatMessageRole = 'system' | 'user' | 'assistant' | 'tool'

/** 空反思（被挡住时占位，**不落盘**） */
function emptyReflection(day: string): DailyReflection {
  return {
    day, generatedAt: Date.now(), summary: '', stats: {
      messages: 0, userMessages: 0, assistantMessages: 0, proactiveMessages: 0, memoryHits: 0, activeMinutes: 0,
    },
    items: [], workRhythm: { avgActiveMinutes: 0, maxStreakMinutes: 0, topHours: [], sampleDays: 0, confident: false },
    dailySummary: '', tomorrowAdvice: [], externalRefs: [], method: 'heuristic',
    disclosures: [], autoWritten: 0, pendingApproval: 0,
  }
}

/**
 * 到点该不该跑（主动引擎每个 tick 调一次）。
 *
 * 语义与早安电台一致：**当天只跑一次**，时间到了才跑。
 * `selfLearningEnabled` 默认 false ⇒ 这个函数在默认配置下**永远返回 false**
 * （"支持关闭自学习"是默认状态）。
 */
export function reflectionDue(now = new Date()): boolean {
  const s = loadSettings()
  if (!s.selfLearningEnabled) return false
  if (hhmm(now) !== s.selfLearningAt) return false
  const st = loadEngineState()
  return st.reflectionDay !== localDayKey(now.getTime())
}

/** 反思状态（UI 与探针） */
export function reflectionStatus(): {
  enabled: boolean
  at: string
  lastRunAt: number | null
  lastRunDay: string | null
  runs: number
  keepDays: number
  pendingCount: number
  autoWrittenTotal: number
  rejectedTotal: number
  highConfidence: number
} {
  const s = loadSettings()
  const st = loadEngineState()
  const digest = reflectionDigestSafe()
  return {
    enabled: s.selfLearningEnabled,
    at: s.selfLearningAt,
    lastRunAt: st.reflectionAt,
    lastRunDay: st.reflectionDay,
    runs: st.reflectionRuns,
    // ★ 从存储层 import，绝不在这里再写一个 400 —— 两处各写一遍就会漂移，
    //   那时 UI 显示的保留上限就不是真实行为（见 reflection-store.ts 的 KEEP_DAYS 注释）
    keepDays: KEEP_DAYS,
    pendingCount: digest.pending,
    autoWrittenTotal: digest.autoWrittenTotal,
    rejectedTotal: digest.rejectedTotal,
    highConfidence: HIGH_CONFIDENCE,
  }
}

/** 容错包装：反思存储坏掉不该让状态通道整体失败 */
function reflectionDigestSafe(): { pending: number, autoWrittenTotal: number, rejectedTotal: number } {
  try {
    return reflectionDigest()
  } catch {
    return { pending: 0, autoWrittenTotal: 0, rejectedTotal: 0 }
  }
}

export { loadActivity }
