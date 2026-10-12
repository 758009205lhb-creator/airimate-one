/**
 * apps/desktop/src/main/engine-state.ts —— 主动引擎的**持久化调度状态**（M2）
 *
 * 为什么必须落盘（用户要求"主动任务要有持久化调度、重启恢复、重复触发保护"）：
 *   · `startupGreeted` / `radioLastDay` / `reflectionLastDay` 都是"今天做过没有"的证据，
 *     只在内存里的话，一次崩溃重启就会**重复问候、重复播报**；
 *   · `cooldownUntil` 与 `recentDecisions` 让"为什么刚才没提醒"可事后审计；
 *   · 全部字段**不含用户正文**（只有原因码、时间戳、计数）。
 */
import { z } from 'zod'
import type { BlockReason } from '@airimate/shared'
import { DateOnlySchema } from '@airimate/shared'
import { createJsonStore } from './json-store.js'

export const DecisionSchema = z.object({
  at: z.number(),
  kind: z.string().max(40),
  decision: z.enum(['fired', 'queued', 'skipped']),
  reason: z.string().max(32),
})

const StoreSchema = z.object({
  version: z.literal(1),
  /** 开机问候是否已完成（含日期，跨天要重新问候） */
  greetingDoneDay: DateOnlySchema.nullable().default(null),
  greetingAt: z.number().nullable().default(null),
  /** 今日日程播报（按天去重） */
  scheduleBriefDay: DateOnlySchema.nullable().default(null),
  /** 早安电台（按天去重） */
  radioDay: DateOnlySchema.nullable().default(null),
  radioAt: z.number().nullable().default(null),
  /** 自学习反思（M4；M2 只记录开关与最近一次运行） */
  reflectionDay: DateOnlySchema.nullable().default(null),
  reflectionAt: z.number().nullable().default(null),
  reflectionRuns: z.number().int().min(0).default(0),
  /** 冷却到期时间（键：continuous / sedentary / night / greeting / radio …） */
  cooldownUntil: z.record(z.string().max(32), z.number()).default({}),
  ticks: z.number().int().min(0).default(0),
  lastTickAt: z.number().nullable().default(null),
  /** 最近决策（只留原因码，供 UI/探针解释"为什么没提醒"） */
  recentDecisions: z.array(DecisionSchema).max(64).default([]),
  /** 启动就绪判定（网络 + 服务）的最近一次结果 */
  readiness: z.object({
    network: z.boolean().default(false),
    provider: z.boolean().default(false),
    checkedAt: z.number().nullable().default(null),
  }).default({}),
  /** 引擎是否曾经成功完成过一次 tick（用于诊断"引擎到底跑起来没有"） */
  everTicked: z.boolean().default(false),
})
export type EngineState = z.infer<typeof StoreSchema>

const store = createJsonStore<EngineState>({
  file: 'engine-state.json',
  schema: StoreSchema,
  fallback: () => ({
    version: 1,
    greetingDoneDay: null,
    greetingAt: null,
    scheduleBriefDay: null,
    radioDay: null,
    radioAt: null,
    reflectionDay: null,
    reflectionAt: null,
    reflectionRuns: 0,
    cooldownUntil: {},
    ticks: 0,
    lastTickAt: null,
    recentDecisions: [],
    readiness: { network: false, provider: false, checkedAt: null },
    everTicked: false,
  }),
  tag: 'engine-state',
})

export function loadEngineState(): EngineState {
  return store.load()
}

export function saveEngineState(next: EngineState): void {
  store.save(next)
}

export function patchEngineState(patch: Partial<EngineState>): EngineState {
  const next = { ...store.load(), ...patch }
  store.save(next)
  return next
}

/** 记一条调度决策（只留原因码；**不记正文**） */
export function recordDecision(kind: string, decision: 'fired' | 'queued' | 'skipped', reason: BlockReason): void {
  const cur = store.load()
  const recent = [...cur.recentDecisions, { at: Date.now(), kind: kind.slice(0, 40), decision, reason }].slice(-64)
  store.save({ ...cur, recentDecisions: recent })
}

/** 设置某类冷却到期时间 */
export function setCooldown(key: string, untilMs: number): void {
  const cur = store.load()
  store.save({ ...cur, cooldownUntil: { ...cur.cooldownUntil, [key.slice(0, 32)]: untilMs } })
}

export function cooldownUntilOf(key: string): number | null {
  return store.load().cooldownUntil[key] ?? null
}

/** 清掉已经过期的冷却记录（避免文件里越积越多） */
export function pruneCooldowns(now = Date.now()): void {
  const cur = store.load()
  const next: Record<string, number> = {}
  let changed = false
  for (const [k, v] of Object.entries(cur.cooldownUntil)) {
    if (v > now) next[k] = v
    else changed = true
  }
  if (changed) store.save({ ...cur, cooldownUntil: next })
}

/** `privacy:wipe` 用 */
export function destroyEngineState(): { removed: boolean, bytes: number } {
  return store.destroy()
}

export function engineStatePath(): string {
  return store.filePath()
}

/** 仅供单测：丢弃缓存 */
export function __resetEngineStateForTest(): void {
  store.__reset()
}
