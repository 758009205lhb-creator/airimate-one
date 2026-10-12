/**
 * apps/desktop/src/main/knowledge-source.ts —— 外部资料（AI/科技资讯 + 天气）
 *
 * 用户要求（M2 §3）：早安电台要包含"AI 科技热点"，且 **M4 §4：外部资料必须保留来源与日期**。
 *
 * 因此本模块的**唯一硬规则**是：**宁可少讲，不可编造**。
 *   · 每条资讯都带 `source`（站点名）、`url`、`date`、`fetchedAt`、`provenance`；
 *   · 抓不到就返回空数组 + 一条 `disclosure`（"资讯源不可达"），**不生成假新闻**；
 *   · 天气同理：没有配置城市 / 服务不可达 ⇒ `available:false` + `unavailableReason`，
 *     电台里就**不说天气**（而不是猜一个"今天晴"）。
 *
 * 缓存：`%APPDATA%\AiriMateOne\knowledge-cache.json`，默认 6 小时内复用
 * （避免每次开机都打一遍外网，也让离线时仍有"昨天的资讯"可用，并如实标注 `provenance:'cache'`）。
 */
import { z } from 'zod'
import type { NewsItem, WeatherInfo } from '@airimate/shared'
import { dateOnly } from '@airimate/shared'
import { createJsonStore } from './json-store.js'
import { loadSettings } from './settings-store.js'
import { guardedFetch, BUILTIN_EGRESS_ALLOWLIST } from './egress-guard.js'
import { log } from './log.js'

// ───────────────────────────────────────────────────────── 缓存

const NewsItemSchema = z.object({
  title: z.string().min(1).max(300),
  source: z.string().min(1).max(120),
  url: z.string().max(600),
  date: z.string().max(10).nullable().default(null),
  fetchedAt: z.number(),
  provenance: z.enum(['live', 'cache', 'none']).default('live'),
})

/** 天气的形状（与 shared 的 `WeatherInfo` 对齐；本地再声一次是为了**读旧缓存时能收敛**） */
const WeatherInfoSchema = z.object({
  available: z.boolean(),
  city: z.string().max(80).nullable().default(null),
  summary: z.string().max(120).nullable().default(null),
  tempC: z.number().nullable().default(null),
  feelsLikeC: z.number().nullable().default(null),
  highC: z.number().nullable().default(null),
  lowC: z.number().nullable().default(null),
  humidity: z.number().nullable().default(null),
  windKph: z.number().nullable().default(null),
  source: z.string().max(120).nullable().default(null),
  fetchedAt: z.number().nullable().default(null),
  unavailableReason: z.string().max(200).nullable().default(null),
})

const StoreSchema = z.object({
  version: z.literal(1),
  news: z.array(NewsItemSchema).max(200).default([]),
  newsFetchedAt: z.number().nullable().default(null),
  weather: WeatherInfoSchema.nullable().default(null),
  weatherFetchedAt: z.number().nullable().default(null),
  /** 连续失败次数（用于退避，不要把外网打爆） */
  failures: z.number().int().min(0).default(0),
})
type Store = z.infer<typeof StoreSchema>

const store = createJsonStore<Store>({
  file: 'knowledge-cache.json',
  schema: StoreSchema,
  fallback: () => ({ version: 1, news: [], newsFetchedAt: null, weather: null, weatherFetchedAt: null, failures: 0 }),
  tag: 'knowledge',
  /** 登记名（迁移链按它查表；**改了它必须同步 STORE_DESCRIPTORS**） */
  storeName: 'knowledge-cache',
})

/** 缓存有效期：6 小时 */
const CACHE_TTL_MS = 6 * 3600 * 1000
/** 失败退避上限：连续失败时最多等 2 小时再试 */
const BACKOFF_MAX_MS = 2 * 3600 * 1000
const USER_AGENT = 'AiriMateOne/1.0 (+local desktop assistant; contact: local-user)'

/**
 * **仅供单测**：置为 true 后 `getNews` / `getWeather` 直接返回"不可用/缓存"，
 * **完全不出网**。
 *
 * 为什么必须有这个开关：早安电台的单测要验证"没有数据时如实标注而不是编造"，
 * 但如果测试真的去打外网，就会 (a) 慢（每个用例数秒）、(b) 不确定（网络波动 ⇒ 假失败）、
 * (c) 在离线 CI 上直接挂。出网**不该**是单测的前置条件。
 */
let offlineForTest = false
export function __setOfflineForTest(on: boolean): void {
  offlineForTest = on
}

// ───────────────────────────────────────────────────────── 资讯源

interface FeedSource {
  /** 显示名（会原样进入 `NewsItem.source`） */
  name: string
  url: string
  /** `hn` = Hacker News Firebase JSON；`rss` = RSS/Atom */
  kind: 'hn' | 'rss'
}

/**
 * 资讯源清单。
 * 选择理由：全部是**公开可读、无需密钥、允许程序化抓取**的源。
 * 任何一个不可达都不影响其它源（逐个 try）。
 */
const SOURCES: readonly FeedSource[] = [
  { name: 'Hacker News', url: 'https://hacker-news.firebaseio.com/v0/topstories.json', kind: 'hn' },
  { name: 'Hacker News (AI)', url: 'https://hnrss.org/newest?q=AI+OR+LLM+OR+%22machine+learning%22&points=20', kind: 'rss' },
  { name: 'InfoQ 中文', url: 'https://www.infoq.cn/feed', kind: 'rss' },
  { name: 'IT之家', url: 'https://www.ithome.com/rss/', kind: 'rss' },
]

/** 与 AI/科技相关的关键词（HN 是综合站，必须先过滤再进电台） */
const AI_KEYWORDS = /(\bai\b|\bagi\b|llm|gpt|claude|gemini|model|neural|machine learning|deep learning|transformer|agent|robot|chip|gpu|cuda|openai|anthropic|deepseek|qwen|llama|mistral|inference|training|dataset|diffusion|multimodal|embedding|rag\b|token|quantum|semiconductor|nvidia|tsmc|python|rust|kubernetes|open source|开源|人工智能|大模型|智能体|机器人|芯片|算力|算法|深度学|机器学习)/i

/** 日期容错解析（RSS 的 pubDate / Atom 的 updated） */
export function parseFeedDate(raw: string | null | undefined): string | null {
  if (!raw) return null
  const t = Date.parse(raw)
  if (Number.isNaN(t)) return null
  const d = new Date(t)
  // 明显不合理的日期（未来太多 / 1970）一律丢掉，避免"2035 年的资讯"进电台
  if (d.getFullYear() < 2000 || d.getTime() > Date.now() + 48 * 3600 * 1000) return null
  return dateOnly(d)
}

/**
 * 极简 RSS/Atom 解析（**不引依赖**）。
 *
 * 为什么自己写：解析只需要 `<item>` / `<entry>` 的标题、链接、时间三个字段；
 * 引一个 XML 库会为了三个字段拉进一棵依赖树，且 RSS 在真实世界里
 * 大量存在不规范写法（CDATA、命名空间、属性顺序），专用库也照样要兜底。
 * 这里用"正则 + 明确失败"的策略：**解析不出就跳过该条目**，绝不用残缺内容凑数。
 */
export function parseFeed(xml: string, sourceName: string): NewsItem[] {
  const out: NewsItem[] = []
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? []
  for (const block of blocks.slice(0, 40)) {
    const pick = (tag: string): string | null => {
      const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block)
      if (!m) return null
      return decodeEntities(stripTags(m[1] ?? '')).trim() || null
    }
    const title = pick('title')
    if (!title) continue
    // Atom 用 <link href="...">；RSS 用 <link>...</link>
    let url = pick('link') ?? ''
    if (!url) {
      const href = /<link\b[^>]*href=["']([^"']+)["']/i.exec(block)
      if (href) url = decodeEntities(href[1] ?? '')
    }
    const date = parseFeedDate(pick('pubDate') ?? pick('published') ?? pick('updated') ?? pick('dc:date'))
    out.push({ title: title.slice(0, 300), source: sourceName, url: url.slice(0, 600), date, fetchedAt: Date.now(), provenance: 'live' })
  }
  return out
}

function stripTags(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'').replace(/&apos;/g, '\'').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

/** HN：先取 topstories，再取前 N 条的标题/时间（**逐条失败不影响整体**） */
async function fetchHackerNews(limit: number): Promise<NewsItem[]> {
  const top = await guardedFetch('https://hacker-news.firebaseio.com/v0/topstories.json', {
    method: 'GET', headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    allowlist: BUILTIN_EGRESS_ALLOWLIST,
  }, 8000)
  if (!top.ok) return []
  const ids = (await top.res.json()) as unknown
  if (!Array.isArray(ids)) return []
  const picked = ids.slice(0, limit).filter((x): x is number => typeof x === 'number')
  const items: NewsItem[] = []
  for (const id of picked) {
    try {
      const r = await guardedFetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, {
        method: 'GET', headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        allowlist: BUILTIN_EGRESS_ALLOWLIST,
      }, 5000)
      if (!r.ok) continue
      const it = (await r.res.json()) as { title?: unknown, url?: unknown, time?: unknown, type?: unknown }
      if (typeof it.title !== 'string' || !it.title) continue
      if (it.type !== undefined && it.type !== 'story') continue
      if (!AI_KEYWORDS.test(it.title)) continue
      const ts = typeof it.time === 'number' ? it.time * 1000 : Date.now()
      items.push({
        title: it.title.slice(0, 300),
        source: 'Hacker News',
        url: typeof it.url === 'string' ? it.url.slice(0, 600) : `https://news.ycombinator.com/item?id=${id}`,
        date: dateOnly(new Date(ts)),
        fetchedAt: Date.now(),
        provenance: 'live',
      })
      if (items.length >= 4) break
    } catch { /* 单条失败跳过 */ }
  }
  return items
}

/** 抓取一批资讯（多源合并 + 按日期倒排 + 去重） */
export async function fetchNews(limit = 6): Promise<{ items: NewsItem[], failures: string[] }> {
  const failures: string[] = []
  const all: NewsItem[] = []
  const results = await Promise.allSettled(SOURCES.map(async (s) => {
    if (s.kind === 'hn') return await fetchHackerNews(4)
    const r = await guardedFetch(s.url, {
      method: 'GET',
      headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*', 'user-agent': USER_AGENT },
      allowlist: BUILTIN_EGRESS_ALLOWLIST,
    }, 8000)
    if (!r.ok) throw new Error(`${s.name}: ${r.verdict.detail}`)
    if (!r.res.ok) throw new Error(`${s.name}: HTTP ${r.res.status}`)
    const text = await r.res.text()
    return parseFeed(text, s.name)
  }))
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const name = SOURCES[i]?.name ?? 'unknown'
    if (r === undefined) continue
    if (r.status === 'fulfilled') all.push(...r.value)
    else failures.push(`${name}: ${r.reason instanceof Error ? r.reason.message.slice(0, 120) : '抓取失败'}`)
  }
  // 近 7 天优先；日期缺失的排后面（不伪造日期）
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000
  const seen = new Set<string>()
  const deduped = all.filter((n) => {
    if (seen.has(n.title)) return false
    seen.add(n.title)
    return n.date === null || Date.parse(`${n.date}T00:00:00`) >= cutoff
  }).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
  return { items: deduped.slice(0, limit), failures }
}

/**
 * 取资讯（优先缓存）。
 * `provenance` 如实标注：`live` = 本次抓到的，`cache` = 用的旧缓存。
 */
export async function getNews(o: { force?: boolean, limit?: number } = {}): Promise<{ items: NewsItem[], failures: string[], fromCache: boolean }> {
  const cur = store.load()
  if (offlineForTest) {
    return { items: cur.news.map(n => ({ ...n, provenance: 'cache' as const })).slice(0, o.limit ?? 6), failures: ['离线（单测模式）'], fromCache: true }
  }
  const fresh = cur.newsFetchedAt !== null && Date.now() - cur.newsFetchedAt < CACHE_TTL_MS
  if (!o.force && fresh && cur.news.length > 0) {
    return { items: cur.news.map(n => ({ ...n, provenance: 'cache' as const })).slice(0, o.limit ?? 6), failures: [], fromCache: true }
  }
  // 退避：连续失败后不要每次 tick 都打外网
  const backoff = Math.min(BACKOFF_MAX_MS, cur.failures * 10 * 60_000)
  if (!o.force && cur.failures > 0 && cur.newsFetchedAt !== null && Date.now() - cur.newsFetchedAt < backoff) {
    return { items: cur.news.map(n => ({ ...n, provenance: 'cache' as const })).slice(0, o.limit ?? 6), failures: ['退避中（上次抓取失败）'], fromCache: true }
  }
  try {
    const { items, failures } = await fetchNews(o.limit ?? 8)
    if (items.length === 0) {
      store.save({ ...cur, failures: cur.failures + 1 })
      // 抓不到：**保留旧缓存**并如实标注（不编造，也不清空历史）
      return { items: cur.news.map(n => ({ ...n, provenance: 'cache' as const })).slice(0, o.limit ?? 6), failures, fromCache: cur.news.length > 0 }
    }
    store.save({ ...cur, news: items, newsFetchedAt: Date.now(), failures: 0 })
    log().info('资讯已抓取', { count: items.length, failures: failures.length, sources: new Set(items.map(i => i.source)).size }, 'knowledge.news.ok')
    return { items, failures, fromCache: false }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log().warn('资讯抓取失败', { err: msg.slice(0, 200) }, 'knowledge.news.failed')
    store.save({ ...cur, failures: cur.failures + 1 })
    return { items: cur.news.map(n => ({ ...n, provenance: 'cache' as const })).slice(0, o.limit ?? 6), failures: [msg.slice(0, 120)], fromCache: cur.news.length > 0 }
  }
}

// ───────────────────────────────────────────────────────── 天气

/** Open-Meteo 的 WMO 天气代码 → 中文短句（**只做映射，不做推测**） */
export function wmoText(code: number | null): string | null {
  if (code === null) return null
  const m: Record<number, string> = {
    0: '晴', 1: '大致晴朗', 2: '局部多云', 3: '阴',
    45: '有雾', 48: '冻雾',
    51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
    56: '冻毛毛雨', 57: '强冻毛毛雨',
    61: '小雨', 63: '中雨', 65: '大雨',
    66: '冻雨', 67: '强冻雨',
    71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪',
    80: '阵雨', 81: '强阵雨', 82: '暴雨',
    85: '阵雪', 86: '强阵雪',
    95: '雷阵雨', 96: '雷阵雨伴小冰雹', 99: '雷阵雨伴大冰雹',
  }
  return m[code] ?? `天气代码 ${code}`
}

export function unavailableWeather(reason: string): WeatherInfo {
  return {
    available: false, city: null, summary: null, tempC: null, feelsLikeC: null,
    highC: null, lowC: null, humidity: null, windKph: null, source: null,
    fetchedAt: null, unavailableReason: reason,
  }
}

/**
 * 取天气。**没有配置城市就直接返回不可用**（绝不猜地理位置 —— 那需要 IP 定位，
 * 属于"用户没要求的隐私采集"）。
 */
export async function getWeather(o: { force?: boolean } = {}): Promise<WeatherInfo> {
  const city = loadSettings().weatherCity.trim()
  if (offlineForTest) return unavailableWeather('离线（单测模式）')
  if (!city) return unavailableWeather('未配置城市（可在设置 → 主动陪伴里填写）')
  const cur = store.load()
  const cachedWeather = StoreSchema.shape.weather.safeParse(cur.weather)
  const fresh = cur.weatherFetchedAt !== null && Date.now() - cur.weatherFetchedAt < CACHE_TTL_MS
  if (!o.force && fresh && cachedWeather.success && cur.weather !== null) {
    return cachedWeather.data as WeatherInfo
  }

  const settings = loadSettings()
  try {
    const geoUrl = `${settings.geocodeEndpoint}?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`
    const geo = await guardedFetch(geoUrl, {
      method: 'GET', headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      allowlist: BUILTIN_EGRESS_ALLOWLIST,
    }, 8000)
    if (!geo.ok) return cachedOr(unavailableWeather(`地理编码被拒绝：${geo.verdict.detail}`), cachedWeather)
    if (!geo.res.ok) return cachedOr(unavailableWeather(`地理编码失败（HTTP ${geo.res.status}）`), cachedWeather)
    const gj = (await geo.res.json()) as { results?: Array<{ latitude?: unknown, longitude?: unknown, name?: unknown }> }
    const hit = gj.results?.[0]
    const lat = typeof hit?.latitude === 'number' ? hit.latitude : null
    const lon = typeof hit?.longitude === 'number' ? hit.longitude : null
    const resolvedName = typeof hit?.name === 'string' ? hit.name : city
    if (lat === null || lon === null) return cachedOr(unavailableWeather(`找不到城市「${city}」的坐标`), cachedWeather)

    const wxUrl = `${settings.weatherEndpoint}?latitude=${lat}&longitude=${lon}`
      + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m'
      + '&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1'
    const wx = await guardedFetch(wxUrl, {
      method: 'GET', headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      allowlist: BUILTIN_EGRESS_ALLOWLIST,
    }, 8000)
    if (!wx.ok) return cachedOr(unavailableWeather(`天气服务被拒绝：${wx.verdict.detail}`), cachedWeather)
    if (!wx.res.ok) return cachedOr(unavailableWeather(`天气服务失败（HTTP ${wx.res.status}）`), cachedWeather)
    const wj = (await wx.res.json()) as {
      current?: Record<string, unknown>
      daily?: { temperature_2m_max?: unknown[], temperature_2m_min?: unknown[] }
    }
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null)
    const info: WeatherInfo = {
      available: true,
      city: resolvedName,
      summary: wmoText(num(wj.current?.weather_code)),
      tempC: num(wj.current?.temperature_2m),
      feelsLikeC: num(wj.current?.apparent_temperature),
      highC: num(wj.daily?.temperature_2m_max?.[0]),
      lowC: num(wj.daily?.temperature_2m_min?.[0]),
      humidity: num(wj.current?.relative_humidity_2m),
      windKph: num(wj.current?.wind_speed_10m),
      source: 'Open-Meteo',
      fetchedAt: Date.now(),
      unavailableReason: null,
    }
    store.save({ ...store.load(), weather: info, weatherFetchedAt: Date.now() })
    log().info('天气已获取', { city: resolvedName, hasTemp: info.tempC !== null, source: 'open-meteo' }, 'knowledge.weather.ok')
    return info
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log().warn('天气获取失败', { err: msg.slice(0, 200) }, 'knowledge.weather.failed')
    return cachedOr(unavailableWeather(`天气服务不可达（${msg.slice(0, 80)}）`), cachedWeather)
  }
}

/** 抓不到时：有旧数据就用旧数据（并如实标注时间），否则返回不可用 */
function cachedOr(fallback: WeatherInfo, cached: { success: boolean, data?: unknown }): WeatherInfo {
  if (cached.success && cached.data) {
    const w = cached.data as WeatherInfo
    if (w.available) {
      return { ...w, unavailableReason: `${fallback.unavailableReason ?? '本次抓取失败'}（显示的是缓存数据）` }
    }
  }
  return fallback
}

/** `privacy:wipe` 用 */
export function destroyKnowledgeStore(): { removed: boolean, bytes: number } {
  return store.destroy()
}

export function knowledgeStorePath(): string {
  return store.filePath()
}

/** 仅供单测：丢弃缓存 */
export function __resetKnowledgeStoreForTest(): void {
  store.__reset()
}
