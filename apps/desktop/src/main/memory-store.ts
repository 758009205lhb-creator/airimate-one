/**
 * apps/desktop/src/main/memory-store.ts —— 长期记忆（本地存储 + 召回）
 *
 * 设计取舍（不引新依赖）：
 *   · **存储**：`%APPDATA%\AiriMateOne\memory.json`（原子写 + schema 校验 + 上限）。
 *   · **召回**：关键词/二元组打分（TF 风格）+ 重要度加权 + 最近使用加成。
 *     不引入向量库/嵌入模型——本机无法确认嵌入模型可用性与体积，
 *     而"关键词 + 重要度"对桌宠场景足够，且**完全可解释、可测试**。
 *     若将来接入嵌入（`@xsai-transformers/embed` 之类），只需替换 `recall()` 的打分函数。
 *   · **隐私**：记忆正文只落本地；日志只记长度与命中数。
 *
 * 中文分词问题：中文没有空格，简单的按词切分会把整句当一个 token。
 * 因此额外生成**二元组（bigram）**作为 token —— 这是无词典情况下最实用的近似。
 */
import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import { appPaths } from './paths.js'
import { createJsonStore } from './json-store.js'
import { log } from './log.js'

export const MemoryEntrySchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(4000),
  tags: z.array(z.string().max(32)).max(16).default([]),
  importance: z.number().min(0).max(1).default(0.5),
  createdAt: z.number(),
  lastUsedAt: z.number().nullable().default(null),
  useCount: z.number().int().min(0).default(0),
})
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>

const StoreSchema = z.object({
  version: z.literal(1),
  entries: z.array(MemoryEntrySchema).max(2000),
})
type Store = z.infer<typeof StoreSchema>

const MAX_ENTRIES = 800

/**
 * 存储：`%APPDATA%\AiriMateOne\memory.json`
 *
 * ⚠ 走**统一的** `createJsonStore`（而不是自己手写读写）：
 *   这样它自动获得 ① 原子写 ② schema 校验 ③ **版本迁移链** ④ `privacy:wipe` 的登记。
 *   手写版本**没有迁移能力** —— 而 `version: z.literal(1)` 一旦改成 2，
 *   老文件会直接校验失败、回退默认值，也就是**用户的长期记忆全部消失**。
 *   记忆是整个产品最不可再生的数据，不能待在没有升级路径的格式里。
 */
const store = createJsonStore<Store>({
  file: 'memory.json',
  schema: StoreSchema,
  storeName: 'memory',
  schemaVersion: 1,
  fallback: () => ({ version: 1, entries: [] }),
  tag: 'memory',
})

function load(): Store {
  return store.load()
}

function save(next: Store): void {
  store.save(next)
}

/** 记忆文件路径（诊断与验收探针用） */
function storeFile(): string {
  return store.filePath()
}

// ───────────────────────────────────────────────────────── 分词（中英混排）

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'of', 'and', 'or', 'in', 'on', 'at', 'for',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'my', 'your', 'me', 'do', 'does', 'did', 'be', 'been',
  '的', '了', '是', '我', '你', '他', '她', '它', '们', '在', '和', '与', '就', '都', '也', '很',
])

/**
 * 把文本切成 token：拉丁词 + 中文二元组。
 * 例：`我喜欢吃拉面` ⇒ `我喜, 喜欢, 欢吃, 吃拉, 拉面`
 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const out: string[] = []
  for (const w of lower.split(/[^a-z0-9_\u4e00-\u9fff]+/)) {
    if (!w) continue
    if (/^[\u4e00-\u9fff]+$/.test(w)) { pushCjkRun(w, out); continue }
    if (!/[\u4e00-\u9fff]/.test(w)) { out.push(w); continue }
    // 混排（如 `星空记忆条目0`、`第3章`）：**必须与纯中文走完全相同的切法**。
    // 这里曾按字符类型再切一次，导致 `星空记忆条目0` 被切成单字后全被长度过滤丢弃
    // （单测 `recallAsSystemBlock` 用例暴露：查询能切出 `星空`，记忆切不出 → 永远召不回）。
    for (const part of w.split(/([\u4e00-\u9fff]+)/)) {
      if (!part) continue
      if (/^[\u4e00-\u9fff]+$/.test(part)) pushCjkRun(part, out)
      else out.push(part)
    }
  }
  return out.filter(t => t.length >= 2 || /[\u4e00-\u9fff]/.test(t)).filter(t => !STOPWORDS.has(t))
}

/** 连续中文段：单字保留、多字切二元组（无词典下的近似分词） */
function pushCjkRun(run: string, out: string[]): void {
  if (run.length === 1) { out.push(run); return }
  for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2))
}

// ───────────────────────────────────────────────────────── 读写

let memSeq = 0
export function nextMemoryId(): string {
  memSeq += 1
  return `m_${Date.now().toString(36)}_${memSeq}`
}

export function addMemory(input: { text: string, tags?: string[], importance?: number }): MemoryEntry {
  const cur = load()
  const entry: MemoryEntry = {
    id: nextMemoryId(),
    text: input.text.slice(0, 4000),
    tags: (input.tags ?? []).slice(0, 16),
    importance: Math.min(1, Math.max(0, input.importance ?? 0.5)),
    createdAt: Date.now(),
    lastUsedAt: null,
    useCount: 0,
  }
  // 去重：文本完全相同则不重复记（提升重要度、刷新时间）
  const dup = cur.entries.find(e => e.text === entry.text)
  let entries: MemoryEntry[]
  let result: MemoryEntry = entry
  if (dup) {
    // 返回值必须是**存储里真实存在的那条**（保留 id / tags / 使用统计）。
    // 这里曾直接 `return entry`，于是调用方拿到一个在列表中根本不存在的 id。
    result = { ...dup, importance: Math.max(dup.importance, entry.importance), createdAt: entry.createdAt }
    entries = cur.entries.map(e => e.id === dup.id ? result : e)
  } else {
    entries = [...cur.entries, entry]
    if (entries.length > MAX_ENTRIES) {
      // 超限：按 (重要度, 创建时间) 淘汰最低者
      entries = [...entries].sort((a, b) => (b.importance - a.importance) || (b.createdAt - a.createdAt)).slice(0, MAX_ENTRIES)
      const kept = entries.find(e => e.id === entry.id)
      if (!kept) return entry   // 新条目本身被淘汰：不落盘，如实返回未存储的条目
      result = kept
    }
  }
  save({ ...cur, entries })
  log().info('记忆已写入', { id: result.id, chars: result.text.length, tags: result.tags.length, total: entries.length, dedup: Boolean(dup) }, 'memory.add')
  return result
}

export function deleteMemory(id: string): boolean {
  const cur = load()
  const entries = cur.entries.filter(e => e.id !== id)
  if (entries.length === cur.entries.length) return false
  save({ ...cur, entries })
  log().info('记忆已删除', { id, total: entries.length }, 'memory.delete')
  return true
}

/**
 * 编辑一条记忆（M1 用户要求"记忆新增/编辑/删除/搜索/召回预览"）。
 *
 * 口径：
 *   · 只有 `text` / `tags` / `importance` 可改（id 与使用统计由存储层掌管 —— 使用统计
 *     是召回打分的输入，允许 renderer 改会让"最近使用加成"失真）；
 *   · 改完 `text` 后**不**重置 `useCount`（同一条记忆，不是新记忆）；
 *   · 找不到 id 返回 `null`（**不静默忽略**，UI 必须能如实提示"该条已不存在"）。
 */
export function updateMemory(input: { id: string, text?: string, tags?: string[], importance?: number }): MemoryEntry | null {
  const cur = load()
  const target = cur.entries.find(e => e.id === input.id)
  if (!target) return null
  const next: MemoryEntry = {
    ...target,
    text: input.text !== undefined ? input.text.slice(0, 4000) : target.text,
    tags: input.tags !== undefined ? input.tags.slice(0, 16) : target.tags,
    importance: input.importance !== undefined ? Math.min(1, Math.max(0, input.importance)) : target.importance,
  }
  save({ ...cur, entries: cur.entries.map(e => (e.id === next.id ? next : e)) })
  // ⚠ 只记长度与字段名，**不记正文**
  log().info('记忆已更新', {
    id: next.id, chars: next.text.length, tags: next.tags.length, importance: next.importance,
    fields: [input.text !== undefined ? 'text' : '', input.tags !== undefined ? 'tags' : '', input.importance !== undefined ? 'importance' : ''].filter(Boolean).join(','),
  }, 'memory.update')
  return next
}

/**
 * 检索（管理与浏览用）：
 *   · `query` 非空 ⇒ 走与 `recall()` 同一套分词打分，但**不写使用统计**
 *     （检索是"我在找东西"，不是"角色想起了这件事"——写统计会污染召回排序）；
 *   · `query` 为空 ⇒ 退化为"按重要度 + 时间"的稳定排序（浏览模式）；
 *   · 支持 `minImportance` 与 `tag` 过滤。
 */
export function searchMemory(o: { query?: string, limit?: number, minImportance?: number, tag?: string | null }): RecallHit[] {
  const limit = Math.min(100, Math.max(1, o.limit ?? 50))
  const minImp = Math.min(1, Math.max(0, o.minImportance ?? 0))
  const tag = o.tag ? o.tag.toLowerCase() : null
  const all = load().entries
  const q = new Set(tokenize(o.query ?? ''))

  let scored: RecallHit[]
  if (q.size === 0) {
    scored = all.map(e => ({ entry: e, score: Number((e.importance * 0.7 + recencyOf(e, Date.now()) * 0.3).toFixed(4)) }))
  } else {
    scored = []
    for (const e of all) {
      const toks = tokenize(e.text)
      let overlap = 0
      for (const t of new Set(toks)) if (q.has(t)) overlap++
      let tagBonus = 0
      for (const tg of e.tags) if (q.has(tg.toLowerCase())) tagBonus++
      if (overlap === 0 && tagBonus === 0) continue
      const score = overlap / Math.sqrt(Math.max(1, q.size))
        + 0.35 * e.importance + 0.10 * recencyOf(e, Date.now()) + 0.05 * Math.min(2, tagBonus)
      scored.push({ entry: e, score: Number(score.toFixed(4)) })
    }
  }
  return scored
    .filter(h => h.entry.importance >= minImp)
    .filter(h => (tag === null ? true : h.entry.tags.some(t => t.toLowerCase() === tag)))
    .sort((a, b) => (b.score - a.score) || (b.entry.createdAt - a.entry.createdAt))
    .slice(0, limit)
}

function recencyOf(e: MemoryEntry, now: number): number {
  const days = Math.max(0, (now - e.createdAt) / 86_400_000)
  return 1 / (1 + days / 30)
}

/** 全量导出（**隐私导出**用；调用方负责把它写进用户选定的文件） */
export function exportMemory(): MemoryEntry[] {
  return load().entries.map(e => ({ ...e }))
}

/** 彻底清除（数据主体权利：`privacy:wipe`） */
export function clearAllMemory(): number {
  const cur = load()
  const n = cur.entries.length
  save({ ...cur, entries: [] })
  log().info('全部记忆已清除', { removed: n }, 'memory.clear-all')
  return n
}

export function listMemory(limit = 200): MemoryEntry[] {
  const all = load().entries
  return [...all].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
}

export function memoryCount(): number {
  return load().entries.length
}

/**
 * 丢弃内存缓存并**重新从磁盘读取**，返回读取后的条目数与读取是否成功。
 *
 * 生产用途：设置面板里的"重新载入记忆"（用户在外部编辑过 `memory.json` 时），
 * 以及验收探针里模拟"冷启动读取"——只测内存缓存读回不能证明**真的落盘了**。
 */
export function reloadFromDisk(): { entries: number, ok: boolean } {
  store.__reset()
  const s = load()
  return { entries: s.entries.length, ok: true }
}

/** 记忆文件是否存在及其正文里是否含指定文本（**只用于验收探针**，不返回其他内容） */
export function memoryFileProbe(needle: string): { exists: boolean, bytes: number, containsTestText: boolean } {
  const file = storeFile()
  try {
    if (!existsSync(file)) return { exists: false, bytes: 0, containsTestText: false }
    const raw = readFileSync(file, 'utf8')
    return { exists: true, bytes: Buffer.byteLength(raw, 'utf8'), containsTestText: raw.includes(needle) }
  } catch {
    return { exists: false, bytes: 0, containsTestText: false }
  }
}

/**
 * 仅供单测：丢弃内存缓存，让下一次访问重新从磁盘读取。
 * 生产代码请用 `reloadFromDisk()`。
 */
export function __resetCacheForTest(): void {
  store.__reset()
}

// ───────────────────────────────────────────────────────── 召回

export interface RecallHit {
  entry: MemoryEntry
  score: number
}

/**
 * 召回与查询最相关的记忆。
 *
 * 打分（可解释、可单测）：
 *   `score = overlap / sqrt(len(queryTokens))  +  0.35 * importance  +  0.10 * recencyBoost  +  0.05 * tagBonus`
 *   · `overlap`：查询 token 与记忆 token 的交集大小（TF 风格，不做 IDF——语料太小，IDF 不稳）；
 *   · `recencyBoost = 1 / (1 + daysSince(createdAt) / 30)`：一个月内基本满额，越久越衰减；
 *   · `tagBonus`：查询里直接出现某个 tag 时加成。
 */
export function recall(query: string, limit = 5): RecallHit[] {
  const q = new Set(tokenize(query))
  if (q.size === 0) return []
  const now = Date.now()
  const hits: RecallHit[] = []
  for (const e of load().entries) {
    const toks = tokenize(e.text)
    let overlap = 0
    for (const t of new Set(toks)) if (q.has(t)) overlap++
    let tagBonus = 0
    for (const tag of e.tags) if (q.has(tag.toLowerCase())) tagBonus += 1
    if (overlap === 0 && tagBonus === 0) continue
    const recency = recencyOf(e, now)
    const score = overlap / Math.sqrt(Math.max(1, q.size)) + 0.35 * e.importance + 0.10 * recency + 0.05 * Math.min(2, tagBonus)
    hits.push({ entry: e, score: Number(score.toFixed(4)) })
  }
  hits.sort((a, b) => b.score - a.score)
  const top = hits.slice(0, limit)

  // 记录使用（lastUsedAt / useCount）——只落盘一次
  if (top.length) {
    const ids = new Set(top.map(h => h.entry.id))
    const cur = load()
    save({
      ...cur,
      entries: cur.entries.map(e => ids.has(e.id) ? { ...e, lastUsedAt: now, useCount: e.useCount + 1 } : e),
    })
  }
  return top
}

/**
 * 组装注入到系统提示的记忆片段（记忆层的对外出口）。
 * 返回 `null` 表示无相关记忆（调用方**不要**塞空段落，避免污染提示）。
 */
export function recallAsSystemBlock(query: string, limit = 5, maxChars = 800): string | null {
  return buildMemoryBlock(query, limit, maxChars).block
}

/**
 * 与 `recallAsSystemBlock` 同一实现，但**同时返回命中条数**。
 *
 * 为什么不让调用方再调一次 `recall()` 数条数：`recall()` 有副作用
 * （回写 `lastUsedAt` / `useCount` 并落盘），调两次就会把使用次数算成两倍，
 * 让"最近使用加成"失真。命中信息只能从这一次召回里取。
 */
export function buildMemoryBlock(query: string, limit = 5, maxChars = 800): { block: string | null, hits: number } {
  const hits = recall(query, limit)
  if (!hits.length) return { block: null, hits: 0 }
  const lines = hits.map(h => `- ${h.entry.text}`)
  let block = `关于用户，你记得这些事（与本次对话相关）：\n${lines.join('\n')}`
  if (block.length > maxChars) block = `${block.slice(0, maxChars)}…`
  log().info('记忆召回', { hits: hits.length, chars: block.length, topScore: hits[0]?.score ?? 0 }, 'memory.recall')
  return { block, hits: hits.length }
}

/**
 * 召回**预览**（M1 用户要求"召回预览"）：既给命中条目，也给真正会被注入的文本。
 *
 * 与 `buildMemoryBlock` 的唯一区别：**不重复召回**（`recall()` 有副作用 —— 它回写
 * `lastUsedAt`/`useCount` 并落盘）。调两次会把使用次数算成两倍，让"最近使用加成"失真，
 * 所以这里从同一次召回里同时取出 `hits` 与 `block`。
 */
export function previewRecall(query: string, limit = 5, maxChars = 800): {
  hits: RecallHit[]
  injectedBlock: string | null
  injectedChars: number
} {
  const hits = recall(query, limit)
  if (!hits.length) return { hits: [], injectedBlock: null, injectedChars: 0 }
  let block = `关于用户，你记得这些事（与本次对话相关）：\n${hits.map(h => `- ${h.entry.text}`).join('\n')}`
  if (block.length > maxChars) block = `${block.slice(0, maxChars)}…`
  return { hits, injectedBlock: block, injectedChars: block.length }
}
