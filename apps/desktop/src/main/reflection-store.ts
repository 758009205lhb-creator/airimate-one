/**
 * apps/desktop/src/main/reflection-store.ts —— 每日反思的**持久化**（M4 §1/§2/§5）
 *
 * 存什么：每天的反思结果（总结、提取项、工作节奏、总结与建议）。
 * 不存什么：**不存对话正文**。提取项里只有"提取出来的结论"（如"用户喜欢抹茶"），
 *   它是用户可见、可删的东西；原始消息仍只在 `session.json` 里，
 *   删对话不会影响已提取的结论（反之亦然，两者是不同层的数据）。
 *
 * ★ 与长期记忆的关系（M4 的核心语义）：
 *   · 高置信度项 ⇒ **自动写入** `memory-store`，并回填 `memoryId`；
 *   · 低置信度项 ⇒ 留在这里 `approval='pending'`，**用户点确认后才写**；
 *   · 用户拒绝 ⇒ `rejected`，**不再写入**（且下次提取同一件事时会跳过它）。
 *
 *   为什么把"待确认"也持久化：如果只放在内存里，重启后待确认项就消失了 ——
 *   表现为"她问过我但我没看到，然后就没有然后了"（用户会以为功能坏了）。
 */
import { z } from 'zod'
import type { DailyReflection, ReflectionItem } from '@airimate/shared'
import { DateOnlySchema } from '@airimate/shared'
import { createJsonStore } from './json-store.js'
import { log } from './log.js'

export const ReflectionItemSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(['preference', 'fact', 'todo', 'emotion', 'habit']),
  text: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1),
  approval: z.enum(['auto', 'pending', 'rejected', 'skipped']).default('pending'),
  evidence: z.object({
    messageCount: z.number().int().min(0),
    ruleId: z.string().max(40),
  }),
  memoryId: z.string().max(64).nullable().default(null),
  createdAt: z.number(),
})

export const DailyReflectionSchema = z.object({
  day: DateOnlySchema,
  generatedAt: z.number(),
  summary: z.string().max(4000),
  stats: z.object({
    messages: z.number().int().min(0),
    userMessages: z.number().int().min(0),
    assistantMessages: z.number().int().min(0),
    proactiveMessages: z.number().int().min(0),
    memoryHits: z.number().int().min(0),
    activeMinutes: z.number().int().min(0),
  }),
  items: z.array(ReflectionItemSchema).max(80),
  workRhythm: z.object({
    avgActiveMinutes: z.number().min(0),
    maxStreakMinutes: z.number().int().min(0),
    topHours: z.array(z.number().int().min(0).max(23)).max(6),
    sampleDays: z.number().int().min(0),
    confident: z.boolean(),
  }),
  dailySummary: z.string().max(4000),
  tomorrowAdvice: z.array(z.string().max(300)).max(8),
  externalRefs: z.array(z.object({
    title: z.string().max(300),
    source: z.string().max(120),
    date: DateOnlySchema.nullable().default(null),
  })).max(8).default([]),
  method: z.enum(['heuristic', 'llm', 'llm-failed']).default('heuristic'),
  disclosures: z.array(z.string().max(200)).max(12).default([]),
  autoWritten: z.number().int().min(0).default(0),
  pendingApproval: z.number().int().min(0).default(0),
})

const StoreSchema = z.object({
  version: z.literal(1),
  /** 按天存（新的在前；上限由 KEEP 控制） */
  days: z.array(DailyReflectionSchema).max(400),
  /** 累计统计（只记计数，用于 UI 与状态） */
  autoWrittenTotal: z.number().int().min(0).default(0),
  rejectedTotal: z.number().int().min(0).default(0),
  /** 被用户拒绝过的**结论文本指纹**（避免下次又把同一件事提出来问一遍） */
  rejectedFingerprints: z.array(z.string().max(40)).max(500).default([]),
})
type Store = z.infer<typeof StoreSchema>

/**
 * 保留天数上限（400 天，够年度回顾又不会无限增长）。
 *
 * ★ 必须 **export** 并被 `reflectionStatus()` 引用，不能在两处各写一个 400：
 *   写死两遍的话，改了一处忘了另一处，UI 上显示的"保留 400 天"就不再是真实行为 ——
 *   一个只是**看起来**生效的上限，比没有上限更糟（用户会以为旧记录会被自动清掉）。
 *   同一个数字只能有一个来源。
 */
export const KEEP_DAYS = 400

const store = createJsonStore<Store>({
  file: 'reflections.json',
  schema: StoreSchema,
  storeName: 'reflections',
  schemaVersion: 1,
  fallback: () => ({
    version: 1, days: [], autoWrittenTotal: 0, rejectedTotal: 0, rejectedFingerprints: [],
  }),
  tag: 'reflection',
})

export function loadReflections(): Store {
  return store.load()
}

/** 保存一天的反思（同一天覆盖；按天去重的语义在引擎层用 `reflectionDay` 保证） */
export function saveReflection(r: DailyReflection): DailyReflection {
  const cur = store.load()
  const parsed = DailyReflectionSchema.parse(r)
  const days = [parsed, ...cur.days.filter(d => d.day !== parsed.day)]
    .sort((a, b) => (a.day < b.day ? 1 : -1))
    .slice(0, KEEP_DAYS)
  store.save({
    ...cur,
    days,
    autoWrittenTotal: cur.autoWrittenTotal + parsed.autoWritten,
  })
  log().info('每日反思已保存', {
    day: parsed.day, items: parsed.items.length, auto: parsed.autoWritten,
    pending: parsed.pendingApproval, method: parsed.method, messages: parsed.stats.messages,
  }, 'reflection.save')
  return parsed
}

export function getReflection(day: string): DailyReflection | null {
  return loadReflections().days.find(d => d.day === day) ?? null
}

/** 历史（新的在前；`limit` 上限 400） */
export function reflectionHistory(limit = 30): DailyReflection[] {
  return loadReflections().days.slice(0, Math.max(1, Math.min(400, limit)))
}

/** 全部待确认项（跨天；UI 角标与"确认"入口读它） */
export function pendingItems(): Array<ReflectionItem & { day: string }> {
  const out: Array<ReflectionItem & { day: string }> = []
  for (const d of loadReflections().days) {
    for (const it of d.items) {
      if (it.approval === 'pending') out.push({ ...it, day: d.day })
    }
  }
  /**
   * ⚠ 排序必须**全序**：只按 `createdAt` 排时，同一次反思产生的多条时间戳完全相同
   *   ⇒ 顺序不确定 ⇒ "第一条"在不同运行里可能是不同的条目。
   *   依赖"第一条是哪条"的调用方（含单测）就会间歇性失败。
   *   这里补两个次序键（kind、id），让顺序稳定且可复现。
   */
  return out
    .sort((a, b) => (b.createdAt - a.createdAt)
      || a.kind.localeCompare(b.kind)
      || a.id.localeCompare(b.id))
    .slice(0, 200)
}

export function pendingCount(): number {
  return pendingItems().length
}

/**
 * 处理一条待确认项。
 *
 * @returns `{ ok, memoryId }` —— `ok:false` 表示找不到该条（**不静默忽略**）
 */
export function decideItem(
  day: string,
  itemId: string,
  approve: boolean,
  writeMemory: (text: string, item: ReflectionItem) => string | null,
): { ok: boolean, memoryId: string | null, item: ReflectionItem | null } {
  const cur = store.load()
  const targetDay = cur.days.find(d => d.day === day)
  if (!targetDay) return { ok: false, memoryId: null, item: null }
  const target = targetDay.items.find(i => i.id === itemId)
  if (!target || target.approval !== 'pending') return { ok: false, memoryId: null, item: null }

  let memoryId: string | null = null
  let approval: ReflectionItem['approval'] = 'rejected'
  if (approve) {
    memoryId = writeMemory(target.text, target)
    // 写入失败（记忆层拒绝/去重返回 null）时**如实保持 pending**，
    // 而不是假装"已确认" —— 否则用户以为记下了，其实没有
    approval = memoryId === null ? 'pending' : 'auto'
  }

  const updatedItem: ReflectionItem = { ...target, approval, memoryId }
  const days = cur.days.map(d => d.day === day
    ? { ...d, items: d.items.map(i => (i.id === itemId ? updatedItem : i)), pendingApproval: Math.max(0, d.pendingApproval - 1) }
    : d)
  const rejectedFingerprints = approve
    ? cur.rejectedFingerprints
    : [...cur.rejectedFingerprints, fingerprintOf(target.text)].slice(-500)
  store.save({
    ...cur,
    days,
    autoWrittenTotal: approve && memoryId !== null ? cur.autoWrittenTotal + 1 : cur.autoWrittenTotal,
    rejectedTotal: approve ? cur.rejectedTotal : cur.rejectedTotal + 1,
    rejectedFingerprints,
  })
  if (approve && memoryId === null) {
    log().warn('用户确认了，但记忆写入失败 → 保持待确认', { day, itemId }, 'reflection.decide.write-failed')
  } else {
    log().info('反思项已处理', { day, itemId, approve, hasMemoryId: memoryId !== null }, 'reflection.decide')
  }
  return { ok: true, memoryId, item: updatedItem }
}

/**
 * 结论文本的指纹（用于"拒绝过的不再问"）。
 * 简单归一化 + 短哈希：**不存原文**，只存指纹。
 */
export function fingerprintOf(text: string): string {
  const norm = text.replace(/[\s，。,.！!？?、]/g, '').toLowerCase().slice(0, 120)
  let h = 2166136261
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** 这条结论是否曾被用户拒绝（下次提取时跳过，不重复打扰） */
export function wasRejected(text: string): boolean {
  return loadReflections().rejectedFingerprints.includes(fingerprintOf(text))
}

/** 数据主体权利：清空全部反思记录 */
export function clearAllReflections(): number {
  const cur = store.load()
  const n = cur.days.length
  store.save({ version: 1, days: [], autoWrittenTotal: 0, rejectedTotal: 0, rejectedFingerprints: [] })
  log().info('全部反思记录已清除', { removedDays: n }, 'reflection.clear-all')
  return n
}

/** `privacy:wipe` 用 */
export function destroyReflectionStore(): { removed: boolean, bytes: number } {
  return store.destroy()
}

export function reflectionStorePath(): string {
  return store.filePath()
}

/** 摘要（**只给计数**，用于隐私页与诊断） */
export function reflectionDigest(): { days: number, pending: number, autoWrittenTotal: number, rejectedTotal: number } {
  const cur = loadReflections()
  return {
    days: cur.days.length,
    pending: pendingCount(),
    autoWrittenTotal: cur.autoWrittenTotal,
    rejectedTotal: cur.rejectedTotal,
  }
}

/** 仅供单测 */
export function __resetReflectionStoreForTest(): void {
  store.__reset()
}
