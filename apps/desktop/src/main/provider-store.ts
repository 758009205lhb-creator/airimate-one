/**
 * apps/desktop/src/main/provider-store.ts —— 供应商配置（**不含密钥**）
 *
 * 与密钥的分工（Tech-Spec §7.3）：
 *   · 本文件只管**非机密**字段（baseUrl / model / kind / label / 时间戳）；
 *   · **密钥**一律走 `secrets-store.ts`（safeStorage 加密落盘），
 *     对外只暴露 `{ hasKey, keyFingerprint, keyLength }`；
 *   · renderer **永远拿不到明文密钥**，出网请求全部由主进程发起。
 *
 * 本轮（M1）新增：
 *   · `setActive()` —— 多供应商时用户可显式选"用哪一个"；
 *   · **出网目标校验**（`checkEgressTarget`，唯一实现在 shared）：拒绝内网/明文/异常端口，
 *     否则 renderer 只要写个 `baseUrl` 就能让主进程去打内网（SSRF）；
 *   · `/models` 模型清单拉取（供向导"选择模型"步骤）。
 *
 * ★ 迁移链（外部复核抓到的**最后一个**缺口，本轮补上）：
 *   本文件原来**手写**了"原子写 + schema 校验 + 损坏回退"，和 `settings-store.ts` 一样
 *   没走 `createJsonStore`，但**连 `migrateStore()` 都没接** —— 也就是 `providers.json`
 *   一旦升版（`StoreSchema` 里是 `version: z.literal(1)`），校验立刻失败 ⇒ 回退空配置
 *   ⇒ **用户配置过的供应商全部消失**（要重新填 baseUrl / 模型名）。
 *   现在与 settings / secrets 同一套写法：**先过迁移链 → 再校验形状**，
 *   并额外兼容**旧裸数组格式**（早期 `providers.json` 直接就是 `Provider[]`）。
 *   迁移不了时：**保留原文件**、以空配置运行、如实记原因 —— 绝不清空用户数据。
 */
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { checkEgressTarget } from '@airimate/shared'
import type { ProviderKind, ProviderTestCode } from '@airimate/shared'
import { migrateStore, storeDescriptor } from '@airimate/companion-kit'
import type { MigrationOutcome } from '@airimate/companion-kit'
import { appPaths } from './paths.js'
import { registerMigrationProbe } from './store-registry.js'
import { log } from './log.js'

export const ProviderKindSchema = z.enum(['openai-compatible', 'deepseek', 'openai', 'anthropic-compatible', 'ollama', 'custom'])
export type { ProviderKind }

export const ProviderSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(64),
  kind: ProviderKindSchema,
  baseUrl: z.string().min(1).max(300),
  model: z.string().min(1).max(120),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type Provider = z.infer<typeof ProviderSchema>

const StoreSchema = z.object({
  version: z.literal(1),
  providers: z.array(ProviderSchema).max(32),
  activeId: z.string().max(64).nullable(),
})
type Store = z.infer<typeof StoreSchema>

const EMPTY: Store = { version: 1, providers: [], activeId: null }

const DEFAULT_TIMEOUT_MS = 15_000

function storeFile(): string {
  return join(appPaths().userData, 'providers.json')
}

function atomicWrite(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  const fd = openSync(tmp, 'w')
  try { writeFileSync(fd, text, 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(tmp, file)
}

let cache: Store | null = null
/** 上次读盘时的迁移结论（`null` = 未登记/未发生）；诊断与隐私页读它 */
let lastMigration: MigrationOutcome | null = null

/**
 * 旧格式检测：早期 `providers.json` 直接是 `Provider[]`（没有 `{version, providers, activeId}` 外壳）。
 *
 * 为什么用形状而不是"文件时间/版本号"：文件里根本没有版本字段可用，
 * 而按时间猜必然误判。**形状是唯一可靠依据**（与 `secrets-store.ts` 同一口径）。
 */
function looksLegacyBareList(raw: unknown): raw is unknown[] {
  return Array.isArray(raw)
}

/** 旧裸数组 ⇒ 新格式外壳；逐条过 `ProviderSchema`，坏条目丢掉（不让一条坏数据毁掉整份配置） */
function adoptLegacyList(list: unknown[]): Store {
  const providers: Provider[] = []
  for (const it of list) {
    const one = ProviderSchema.safeParse(it)
    if (one.success) providers.push(one.data)
  }
  if (providers.length > 0) {
    log().info('检测到旧格式供应商配置（裸数组），已按兼容路径读取', { count: providers.length }, 'provider.config.legacy-format')
  }
  return { version: 1, providers, activeId: providers[0]?.id ?? null }
}

export function loadProviders(): Store {
  if (cache) return cache
  const file = storeFile()
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown

      /**
       * ★ ① 先认**旧裸数组格式**（早期 `providers.json` 就是 `Provider[]`）。
       *
       *   为什么必须在迁移链**之前**判：`migrateStore()` 对"没有 version 字段"的输入
       *   在目标版本为 1 时返回 `ok:true` 且**原样透传**（数组进、数组出）——
       *   它只保证"版本可接受"，不保证"形状是对象"。
       *   于是裸数组会一路走到 `StoreSchema` 才失败 ⇒ 回退空配置 ⇒ **用户重填供应商**。
       *   （本轮实测踩到：15 条用例里这一条先红。）
       */
      const adopted = looksLegacyBareList(raw) ? adoptLegacyList(raw) : raw

      /**
       * ★ ② 再过迁移链（`providers` 已在 `STORE_DESCRIPTORS` 登记，`version: 1`）。
       *   顺序与 `settings-store.ts` 一致：**迁移 → 归一化版本 → schema 校验**。
       *   反过来（先校验）会让"版本比程序新"变成"静默回默认值"，那正是丢数据的路径。
       */
      const desc = storeDescriptor('providers')
      let candidate: unknown = adopted
      if (desc) {
        const out = migrateStore(adopted, desc)
        lastMigration = out
        if (out.ok) {
          candidate = out.data
          if (out.steps.length > 0) {
            log().info('供应商配置已迁移', {
              from: out.fromVersion ?? -1, to: out.toVersion, steps: out.steps.length,
              describes: out.steps.map(s => s.describe).join(' | ').slice(0, 200),
            }, 'provider.config.migrated')
          }
        } else if (out.reason === 'no-version-field' && desc.version === 1) {
          // 没有版本字段（用户手工删过 `version`）⇒ 按 v1 接受，形状交给下面的 schema 兜底
          candidate = adopted
        } else {
          /**
           * ⚠ 版本比程序新 / 缺迁移步骤 / 迁移抛错 ⇒ **保留原文件**、以空配置运行。
           *   降级安装不该丢配置：原文件留着，升回去就能读回来。
           */
          log().warn('供应商配置无法迁移 → 以空配置运行（原文件保留）', {
            from: out.fromVersion ?? -1, to: out.toVersion, reason: out.reason, detail: out.detail.slice(0, 200),
          }, 'provider.config.migration-failed')
          cache = { ...EMPTY, providers: [] }
          return cache
        }
      }

      /** 与 `json-store.ts` 的 `normalizeVersion` 同口径：schema 只管形状，版本由迁移链掌管 */
      const normalized = (candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate))
        ? { ...(candidate as Record<string, unknown>), version: 1 }
        : candidate
      const parsed = StoreSchema.safeParse(normalized)
      if (parsed.success) { cache = parsed.data; return cache }
      log().warn('供应商配置文件校验失败 → 使用空配置（原文件保留）', {
        issues: parsed.error.issues.slice(0, 5).map(i => `${i.path.join('.')}:${i.message}`).join(' | '),
      }, 'provider.config.invalid')
    }
  } catch (e) {
    log().warn('供应商配置读取失败', { err: e instanceof Error ? e.message : String(e) }, 'provider.config.read-failed')
  }
  cache = { ...EMPTY, providers: [] }
  return cache
}

/** 上次读盘时的迁移结论（`null` = 未发生 / 尚未读盘）；诊断与探针读它 */
export function lastProviderMigration(): MigrationOutcome | null {
  return lastMigration
}

function save(next: Store): void {
  cache = next
  try { atomicWrite(storeFile(), `${JSON.stringify(next, null, 2)}\n`) }
  catch (e) { log().warn('供应商配置写入失败', { err: e instanceof Error ? e.message : String(e) }, 'provider.config.write-failed') }
}

/** providerId 形态白名单（与 secrets-store 的断言一致，防路径穿越） */
export function safeProviderId(id: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)
}

export function upsertProvider(input: {
  id?: string
  label: string
  kind: ProviderKind
  baseUrl: string
  model: string
}): Provider {
  const now = Date.now()
  const cur = loadProviders()
  // id 由 label+kind 派生并做白名单校验；不接收 renderer 传来的任意 id 作为路径段
  const id = input.id && safeProviderId(input.id)
    ? input.id
    : `p_${now.toString(36)}`
  const existing = cur.providers.find(p => p.id === id)
  const next: Provider = {
    id,
    label: input.label,
    kind: input.kind,
    baseUrl: input.baseUrl.replace(/\/+$/, ''),
    model: input.model,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  const providers = existing
    ? cur.providers.map(p => (p.id === id ? next : p))
    : [...cur.providers, next]
  save({ ...cur, providers, activeId: cur.activeId ?? id })
  log().info('供应商已保存', { id, kind: next.kind, baseUrlHost: hostOf(next.baseUrl), model: next.model }, 'provider.upsert')
  return next
}

export function deleteProvider(id: string): boolean {
  const cur = loadProviders()
  const providers = cur.providers.filter(p => p.id !== id)
  if (providers.length === cur.providers.length) return false
  save({ ...cur, providers, activeId: cur.activeId === id ? (providers[0]?.id ?? null) : cur.activeId })
  return true
}

export function getProvider(id: string): Provider | null {
  return loadProviders().providers.find(p => p.id === id) ?? null
}

export function activeProvider(): Provider | null {
  const s = loadProviders()
  return s.providers.find(p => p.id === s.activeId) ?? s.providers[0] ?? null
}

export function activeProviderId(): string | null {
  return loadProviders().activeId
}

/** 切换生效的供应商。返回 false = 该 id 不存在（**不静默忽略**）。 */
export function setActive(id: string): boolean {
  const cur = loadProviders()
  if (!cur.providers.some(p => p.id === id)) return false
  save({ ...cur, activeId: id })
  log().info('已切换生效供应商', { id, host: hostOf(getProvider(id)?.baseUrl ?? '') }, 'provider.set-active')
  return true
}

/** 主机名（**日志用**，避免把完整 URL 里的查询串写进日志） */
export function hostOf(url: string): string {
  try { return new URL(url).host } catch { return '<invalid>' }
}

function base(p: Provider): string {
  return p.baseUrl.replace(/\/+$/, '')
}

/** 出网前的统一闸门：目标不合规就**根本不发请求**（不是发了再判） */
export function egressAllowed(url: string): { ok: true } | { ok: false, code: ProviderTestCode, message: string } {
  const v = checkEgressTarget(url)
  if (v.ok) return { ok: true }
  return {
    ok: false,
    code: v.reason === 'insecure-url' ? 'insecure-url' : 'blocked-target',
    message: `${v.detail}（host=${v.host || '<empty>'}）`,
  }
}

interface ProbeOutcome {
  code: ProviderTestCode
  latencyMs: number | null
  message: string
  /** 键为模型 id 的集合（仅在成功解析出 `data[].id` 时非空） */
  models: string[]
}

/**
 * 打一次 `GET {baseUrl}/models`。
 *
 * 安全约束：
 *   · 只在**主进程**发起（renderer 不直连外网）；
 *   · 先过 `egressAllowed()`（拒内网/明文/异常端口）；
 *   · 密钥只在内存里拼进 header，**不落日志**（失败时只记 code 与主机名）；
 *   · 15s 超时；`redirect:'error'` 不跟随重定向（避免把密钥带给第三方）。
 */
async function probeModels(p: Provider, apiKey: string | null): Promise<ProbeOutcome> {
  if (!apiKey) return { code: 'no-key', latencyMs: null, message: '该供应商尚未配置密钥', models: [] }
  const url = `${base(p)}/models`
  const gate = egressAllowed(url)
  if (!gate.ok) {
    log().warn('供应商目标被出网闸门拒绝', { host: hostOf(url), code: gate.code }, 'provider.egress.blocked')
    return { code: gate.code, latencyMs: null, message: gate.message, models: [] }
  }
  const started = Date.now()
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), DEFAULT_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: ctl.signal,
      redirect: 'error',
    })
    const latencyMs = Date.now() - started
    if (res.status === 401 || res.status === 403) {
      return { code: 'auth', latencyMs, message: `鉴权失败（HTTP ${res.status}）`, models: [] }
    }
    if (res.status === 429) {
      return { code: 'rate-limit', latencyMs, message: '被限流（HTTP 429）', models: [] }
    }
    if (!res.ok) {
      return { code: 'bad-response', latencyMs, message: `HTTP ${res.status}`, models: [] }
    }
    const text = await res.text()
    const trimmed = text.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return { code: 'bad-response', latencyMs, message: '响应不是 JSON（端点可能不兼容 /models）', models: [] }
    }
    let models: string[] = []
    try {
      const parsed = JSON.parse(trimmed) as unknown
      models = extractModelIds(parsed)
    } catch {
      return { code: 'bad-response', latencyMs, message: '响应不是合法 JSON', models: [] }
    }
    return { code: 'ok', latencyMs, message: `连通（${latencyMs}ms）`, models }
  } catch (e) {
    const latencyMs = Date.now() - started
    const msg = e instanceof Error ? e.message : String(e)
    const timeout = /abort/i.test(msg)
    log().warn('供应商连通性测试失败', { host: hostOf(url), timeout, code: timeout ? 'timeout' : 'network' }, 'provider.test.failed')
    return { code: timeout ? 'timeout' : 'network', latencyMs, message: timeout ? '请求超时（15s）' : '网络不可达', models: [] }
  } finally {
    clearTimeout(timer)
  }
}

/** 从 `/models` 的多种返回形态里抽模型 id（OpenAI 风格 + 宽松兜底） */
export function extractModelIds(payload: unknown): string[] {
  const out: string[] = []
  const push = (v: unknown): void => {
    if (typeof v !== 'string') return
    const s = v.trim()
    if (s && s.length <= 160 && !out.includes(s)) out.push(s)
  }
  const walk = (node: unknown, depth: number): void => {
    if (depth > 3 || node === null || node === undefined) return
    // ⚠ 根就是数组（或 `{result: [...]}` 里直接是字符串数组）也要能取出来：
    //   早期只处理了"数组里的对象带 id"，于是 `{result:['p','q']}` 会抽出空数组，
    //   界面上表现为"端点支持 /models 但一个模型都没列出来"。
    if (Array.isArray(node)) {
      for (const it of node) {
        if (typeof it === 'string') push(it)
        else walk(it, depth + 1)
      }
      return
    }
    if (typeof node !== 'object') return
    const obj = node as Record<string, unknown>
    if (typeof obj.id === 'string') push(obj.id)
    else if (typeof obj.name === 'string' && obj.object === 'model') push(obj.name)
    for (const key of ['data', 'models', 'result']) if (key in obj) walk(obj[key], depth + 1)
  }
  walk(payload, 0)
  return out.slice(0, 500)
}

/** 连通性测试（含模型数） */
export async function testProvider(p: Provider, apiKey: string | null): Promise<{
  ok: boolean
  code: ProviderTestCode
  latencyMs: number | null
  message: string
  modelCount: number | null
}> {
  const r = await probeModels(p, apiKey)
  return {
    ok: r.code === 'ok',
    code: r.code,
    latencyMs: r.latencyMs,
    message: r.message,
    modelCount: r.code === 'ok' ? r.models.length : null,
  }
}

/**
 * 拉取模型清单（向导"选择模型"用）。
 * 端点不支持时返回 `supported:false` 而**不是报错** —— 很多兼容端点没有 `/models`，
 * 用户仍可手输模型名；把它当错误会挡住一条正常路径。
 */
export async function listProviderModels(p: Provider, apiKey: string | null): Promise<{
  supported: boolean
  models: string[]
  code: ProviderTestCode
  message: string
}> {
  const r = await probeModels(p, apiKey)
  if (r.code === 'ok') {
    return { supported: r.models.length > 0, models: r.models, code: r.code, message: r.message }
  }
  if (r.code === 'bad-response') {
    return { supported: false, models: [], code: r.code, message: `${r.message}（可手动输入模型名）` }
  }
  return { supported: false, models: [], code: r.code, message: r.message }
}

/** 仅供单测：丢弃内存缓存（也丢掉上次的迁移结论，否则用例之间会互相污染） */
export function __resetProviderCacheForTest(): void {
  cache = null
  lastMigration = null
}

/**
 * ★ 把供应商配置接进**存储登记表**（本轮补的缺口）。
 *
 * 它没走 `createJsonStore`（要兼容旧裸数组格式），于是 `kit:stores` / 隐私页 / 诊断里
 * 原本**整个看不到** `providers` —— 而"供应商配置消失"正是升级最容易被用户察觉的丢数据。
 * 与 `settings` / `secrets-meta` 同一处理：只登记一个**纯读**的迁移结论探针。
 */
registerMigrationProbe('providers', 'provider', () => lastMigration)

// ───────────────────────────────────────────────────────── 就绪探测（主动引擎用）

/**
 * 就绪判定的结果缓存（60 秒）。
 * 为什么需要：`ready()` 每个 tick 都可能被调用，而它要出网 —— 没有缓存就会
 * 每 10 秒打一次供应商端点（用户会看到配额被莫名消耗）。
 */
let readyCache: { at: number, network: boolean, provider: boolean, detail: string } | null = null
const READY_TTL_MS = 60_000

/**
 * 探测"网络 + 供应商"是否就绪（**有界、短超时、只读**）。
 *
 * 语义：
 *   · 没有配置供应商 ⇒ `provider:false, network:true`（网络没试过，不谎报为 true/false）；
 *   · 有供应商但没密钥 ⇒ `provider:false`，并如实说明原因；
 *   · 有供应商有密钥 ⇒ 打一次 `/models`（3s 超时）；**任何** HTTP 状态码都算
 *     "网络通"（401 也说明打到了服务端）；只有网络层失败才算 `network:false`。
 */
export async function probeReadiness(apiKeyOf: (id: string) => string | null, now = Date.now()): Promise<{ network: boolean, provider: boolean, detail: string }> {
  if (readyCache && now - readyCache.at < READY_TTL_MS) return readyCache
  const p = activeProvider()
  if (!p) {
    const r = { network: true, provider: false, detail: '未配置供应商' }
    readyCache = { at: now, ...r }
    return r
  }
  const key = apiKeyOf(p.id)
  if (!key) {
    const r = { network: true, provider: false, detail: '供应商未配置密钥' }
    readyCache = { at: now, ...r }
    return r
  }
  const url = `${base(p)}/models`
  const gate = egressAllowed(url)
  if (!gate.ok) {
    const r = { network: true, provider: false, detail: `目标被出网闸门拒绝：${gate.message}` }
    readyCache = { at: now, ...r }
    return r
  }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 3000)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: ctl.signal,
      redirect: 'error',
    })
    // 任何 HTTP 状态码都证明"网络可达、服务在响应"
    const r = {
      network: true,
      provider: res.status < 500,
      detail: `HTTP ${res.status}`,
    }
    readyCache = { at: now, ...r }
    return r
  } catch {
    const r = { network: false, provider: false, detail: '网络不可达' }
    /**
     * ⚠ 这里**不是"退避"**，而是**缩短重试间隔**：把缓存时间戳回拨半个 TTL，
     *   于是约 30 秒后就会再探一次（成功路径是 60 秒）。
     *   理由：断网恢复后用户应当尽快被问候，而不是干等一分钟；
     *   而失败本身不消耗外网配额（连不上就是连不上）。
     *   （早期注释写成"失败退避"，与实现相反 —— 已按实际行为改掉。）
     */
    readyCache = { at: now - READY_TTL_MS / 2, ...r }
    return r
  } finally {
    clearTimeout(timer)
  }
}

/** 单测用：清掉就绪缓存 */
export function __resetReadinessCacheForTest(): void {
  readyCache = null
}
