/**
 * @airimate/companion-kit/store-migrator —— 带版本与迁移的存储适配层（M5 §1 的"存储"那一格）
 *
 * 为什么必须有它（不是"以后再说"的基础设施）：
 *   M1/M2 已经落了 12 个 JSON 存储，每个都是 `version: z.literal(1)`。
 *   **`z.literal(1)` 意味着版本一旦变成 2，老文件会直接校验失败** ⇒
 *   `loadJsonStore()` 会回退默认值 ⇒ **用户的记忆、日程、提醒全部消失**。
 *   而 M3/M4 几乎必然要加字段（屏幕区域、唤醒词、学习结果…）。
 *
 * 本模块把"升级"变成一条**声明式迁移链**：
 *
 *   const desc = { name: 'memory', version: 2, personal: true, description: '长期记忆',
 *                  migrations: [{ from: 1, to: 2, describe: '加 source 字段', migrate: m => ({...}) }] }
 *   const r = migrateStore(raw, desc)
 *   // r.ok=true ⇒ r.data 是当前版本；r.steps 记录走了哪几步（审计与排障）
 *
 * 纪律：
 *   · 迁移函数必须是**纯函数**（同输入同输出），这样才能单测与重放；
 *   · **不认识的更高版本**（文件来自更新版应用）一律拒绝读，**绝不清空** ——
 *     用户降级安装后不该丢数据，应用应如实报"这份数据的版本比本程序新"；
 *   · 迁移链必须连续无环（`validateMigrations()` 校验）。
 */
import type { Migration, StoreDescriptor } from './types.js'

export interface MigrationOutcome {
  ok: boolean
  /** 迁移后的数据（`ok:true` 时是当前版本） */
  data: unknown
  /** 起始版本（`null` = 文件里没写版本） */
  fromVersion: number | null
  toVersion: number
  /** 实际走过的迁移步骤（审计：用户数据被怎么改的必须留痕） */
  steps: Array<{ from: number, to: number, describe: string }>
  /** 失败原因（`ok:false` 时） */
  reason: 'ok' | 'no-version-field' | 'invalid-version' | 'future-version' | 'missing-migration' | 'migrate-threw' | 'cycle'
  detail: string
}

/** 校验迁移链：连续、无环、`to` 必须等于 `from + 1`（逐级迁移才可重放） */
export function validateMigrations(migrations: readonly Migration[]): { ok: boolean, reason: string } {
  if (migrations.length === 0) return { ok: true, reason: '无迁移步骤' }
  const sorted = [...migrations].sort((a, b) => a.from - b.from)
  const seen = new Set<number>()
  for (const m of sorted) {
    if (m.to !== m.from + 1) return { ok: false, reason: `迁移必须逐级（${m.from}→${m.to} 跨级了）` }
    if (seen.has(m.from)) return { ok: false, reason: `from=${m.from} 有重复步骤（存在环或冲突）` }
    seen.add(m.from)
  }
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]
    const cur = sorted[i]
    if (!prev || !cur) continue
    if (cur.from !== prev.to) return { ok: false, reason: `迁移链不连续：${prev.from}→${prev.to} 之后跳到了 ${cur.from}` }
  }
  return { ok: true, reason: `${sorted.length} 步，链连续` }
}

function readVersion(raw: unknown): number | null {
  if (raw === null || typeof raw !== 'object') return null
  const v = (raw as Record<string, unknown>).version
  if (typeof v === 'number' && Number.isFinite(v)) return v
  return null
}

/**
 * 把任意版本的数据迁移到 `desc.version`。
 *
 * 三种情况（**必须区分清楚**）：
 *   ① 数据版本 === 目标版本 ⇒ 原样返回（`steps` 空）；
 *   ② 数据版本 < 目标版本 ⇒ 逐级迁移；
 *   ③ 数据版本 > 目标版本 ⇒ **拒绝**（`future-version`），调用方必须**保留原文件**
 *      并如实提示用户"数据来自更新版本"，**不得清空**。
 */
export function migrateStore(raw: unknown, desc: StoreDescriptor): MigrationOutcome {
  const chain = validateMigrations(desc.migrations)
  if (!chain.ok) {
    return { ok: false, data: raw, fromVersion: readVersion(raw), toVersion: desc.version, steps: [], reason: 'cycle', detail: chain.reason }
  }

  const from = readVersion(raw)
  if (from === null) {
    /**
     * 没有 `version` 字段：**只在目标版本为 1 时**接受（`version:1` 的存储里
     * 早期文件可能没写版本）；否则拒绝 —— 猜版本等于猜数据形状，风险太高。
     */
    if (desc.version === 1) {
      return { ok: true, data: raw, fromVersion: null, toVersion: 1, steps: [], reason: 'no-version-field', detail: '文件缺少 version 字段，按 v1 接受' }
    }
    return {
      ok: false, data: raw, fromVersion: null, toVersion: desc.version, steps: [],
      reason: 'no-version-field',
      detail: `文件缺少 version 字段，而当前版本是 ${desc.version}（无法推断形状，拒绝读取并保留原文件）`,
    }
  }
  if (!Number.isInteger(from) || from < 1) {
    return { ok: false, data: raw, fromVersion: from, toVersion: desc.version, steps: [], reason: 'invalid-version', detail: `version 非法：${String(from)}` }
  }
  if (from === desc.version) {
    return { ok: true, data: raw, fromVersion: from, toVersion: desc.version, steps: [], reason: 'ok', detail: '版本一致，无需迁移' }
  }
  if (from > desc.version) {
    return {
      ok: false, data: raw, fromVersion: from, toVersion: desc.version, steps: [],
      reason: 'future-version',
      detail: `数据版本 ${from} 比本程序支持的 ${desc.version} 新（可能装过更新版）—— 已保留原文件，不做任何修改`,
    }
  }

  let cur = raw
  let v = from
  const steps: MigrationOutcome['steps'] = []
  while (v < desc.version) {
    const step = desc.migrations.find(m => m.from === v)
    if (!step) {
      return {
        ok: false, data: raw, fromVersion: from, toVersion: desc.version, steps,
        reason: 'missing-migration',
        detail: `缺少 ${v}→${v + 1} 的迁移步骤（拒绝用默认值覆盖用户数据）`,
      }
    }
    try {
      cur = step.migrate(cur)
    } catch (e) {
      return {
        ok: false, data: raw, fromVersion: from, toVersion: desc.version, steps,
        reason: 'migrate-threw',
        detail: `${v}→${step.to} 迁移抛错：${e instanceof Error ? e.message.slice(0, 200) : '未知错误'}`,
      }
    }
    steps.push({ from: v, to: step.to, describe: step.describe })
    v = step.to
  }
  // 迁移结果必须把 version 对齐（迁移函数可能忘了写；这里兜底，避免"迁完了版本还没改"）
  if (cur !== null && typeof cur === 'object') {
    cur = { ...(cur as Record<string, unknown>), version: desc.version }
  }
  return { ok: true, data: cur, fromVersion: from, toVersion: desc.version, steps, reason: 'ok', detail: `已迁移 ${steps.length} 步` }
}

/**
 * 迁移个案的**可判定证据**（写进日志/诊断；不含任何用户内容）。
 * 只记：存储名、版本、走了几步、失败原因码。
 */
export interface MigrationRecord {
  name: string
  fromVersion: number | null
  toVersion: number
  steps: Array<{ from: number, to: number, describe: string }>
  ok: boolean
  reason: MigrationOutcome['reason']
  at: number
}

export function toRecord(desc: StoreDescriptor, out: MigrationOutcome, at = Date.now()): MigrationRecord {
  return {
    name: desc.name,
    fromVersion: out.fromVersion,
    toVersion: out.toVersion,
    steps: out.steps,
    ok: out.ok,
    reason: out.reason,
    at,
  }
}

/**
 * 生成一份**格式完全相同的**新版本样本（用于"迁移链可跑通"的单测）。
 * 有了它，每个存储都能加一条"v1 样本 → 迁到当前版本 → 关键字段还在"的用例，
 * 而不是等到用户升级后才发现迁移写错了。
 */
export function migrateFixtures(fixtures: Record<number, unknown>, desc: StoreDescriptor): Array<{ from: number, outcome: MigrationOutcome }> {
  return Object.entries(fixtures)
    .map(([k, v]) => ({ from: Number(k), outcome: migrateStore(v, desc) }))
    .sort((a, b) => a.from - b.from)
}
