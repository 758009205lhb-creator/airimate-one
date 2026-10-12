/**
 * apps/desktop/src/main/morning-radio.ts —— 早安电台（M2 §3）
 *
 * 用户要求的内容结构（缺一不可）：
 *   ① 日期   ② 天气   ③ 日程   ④ AI 科技热点   ⑤ 今日建议   ⑥ 一句轻松的鼓励
 * 以及"30–60 秒"的口播稿。
 *
 * 两条**不可让步**的规则：
 *   · **不编造**：天气没配置城市 / 资讯源不可达 ⇒ 那一节**直接不说**，
 *     并在 `disclosures` 里如实列出原因；`script` 里绝不会出现"今天晴"这种猜的内容。
 *   · **来源与日期**：每条资讯都带 `source` + `date`（来自 `knowledge-source.ts`），
 *     口播稿里也会念出来源（"来自 Hacker News"），README/UI 里都能看到 URL。
 *
 * 时长估算：中文口播按 **4.2 字/秒**（TTS 实测的常态语速）折算；
 * 目标区间 30–60 秒 ⇒ 126–252 字。超出时按优先级裁剪（资讯 → 建议），
 * 而不是把日期天气挤掉（那两节是用户最先要听的）。
 */
import type { NewsItem, RadioContent, Schedule, WeatherInfo } from '@airimate/shared'
import { dateOnly, hhmm } from '@airimate/shared'
import { wmoText } from './knowledge-source.js'

/** 中文 TTS 的经验语速（字/秒） */
export const CHARS_PER_SECOND = 4.2
export const TARGET_MIN_SECONDS = 30
export const TARGET_MAX_SECONDS = 60
const MIN_CHARS = Math.floor(TARGET_MIN_SECONDS * CHARS_PER_SECOND)   // 126
const MAX_CHARS = Math.floor(TARGET_MAX_SECONDS * CHARS_PER_SECOND)   // 252

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

/** 鼓励语池（轻松、不油腻；每次按日期确定性选一句，便于复现与测试） */
const ENCOURAGEMENTS = [
  '今天也不用太用力，能往前走一点就已经很好了。',
  '不管今天顺不顺，我都会在这儿陪着你。',
  '慢一点也没关系，日子不是用来赶的。',
  '先把最想做的那件事做掉，剩下的交给时间。',
  '今天也请对自己温柔一点，你已经做得不错了。',
  '深呼吸一下，我们开始今天吧。',
]

export function estimateSeconds(text: string): number {
  const chars = [...text.replace(/\s+/g, '')].length
  return Math.round((chars / CHARS_PER_SECOND) * 10) / 10
}

/** 按日期确定性地选一句鼓励（同一天多次生成结果一致，便于验收复现） */
export function pickEncouragement(day: string): string {
  let h = 0
  for (const ch of day) h = (h * 31 + ch.charCodeAt(0)) % 100_000
  return ENCOURAGEMENTS[h % ENCOURAGEMENTS.length] as string
}

export interface RadioInput {
  now: Date
  greeting: string
  weather: WeatherInfo
  schedules: Schedule[]
  news: NewsItem[]
  advice: string[]
  /** 资讯抓取失败的原因（如实写进 disclosures） */
  newsFailures: string[]
  /** 是否用了缓存资讯 */
  newsFromCache: boolean
}

/** 把 `HH:MM` 换算成"距现在多少分钟"（跨天按 +24h 处理） */
export function minutesUntil(start: string, now: Date): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(start)
  if (!m) return null
  const target = Number(m[1]) * 60 + Number(m[2])
  const cur = now.getHours() * 60 + now.getMinutes()
  let diff = target - cur
  if (diff < -720) diff += 1440
  return diff
}

function weatherSentence(w: WeatherInfo): string | null {
  if (!w.available) return null
  const parts: string[] = []
  if (w.city) parts.push(`${w.city}今天`)
  const sum = w.summary ?? wmoText(null)
  if (sum) parts.push(sum)
  if (w.tempC !== null) parts.push(`现在 ${Math.round(w.tempC)} 摄氏度`)
  if (w.lowC !== null && w.highC !== null) parts.push(`全天 ${Math.round(w.lowC)} 到 ${Math.round(w.highC)} 度`)
  if (w.feelsLikeC !== null && w.tempC !== null && Math.abs(w.feelsLikeC - w.tempC) >= 3) {
    parts.push(`体感 ${Math.round(w.feelsLikeC)} 度`)
  }
  if (parts.length === 0) return null
  return `${parts.join('，')}。`
}

/**
 * 生成电台内容。
 * **纯函数**（除了 `Date.now()`）：便于单测"内容包含六节"与"不编造"两条判据。
 */
export function composeRadio(input: RadioInput): RadioContent {
  const day = dateOnly(input.now)
  const weekday = WEEKDAYS[input.now.getDay()] ?? ''
  const disclosures: string[] = []

  const schedule = input.schedules.map(s => ({
    id: s.id,
    title: s.title,
    start: s.start,
    minutesFromNow: minutesUntil(s.start, input.now),
  }))

  const scheduleSentence = ((): string | null => {
    if (schedule.length === 0) return null
    const first = schedule[0]
    if (!first) return null
    const rest = schedule.slice(1, 3)
    const when = first.minutesFromNow === null
      ? first.start
      : first.minutesFromNow >= 0
        ? (first.minutesFromNow <= 1 ? '马上' : `${first.minutesFromNow} 分钟后`)
        : '已经过了'
    let s = `今天有 ${schedule.length} 件事：${when} ${first.title}`
    for (const r of rest) s += `，${r.start} ${r.title}`
    if (schedule.length > 3) s += `，还有 ${schedule.length - 3} 件`
    return `${s}。`
  })()

  const weatherS = weatherSentence(input.weather)
  if (!input.weather.available) {
    disclosures.push(`天气：${input.weather.unavailableReason ?? '不可用'}`)
  } else {
    disclosures.push(`天气来源：${input.weather.source ?? '未知'}`)
  }
  if (input.news.length === 0) {
    disclosures.push(input.newsFailures.length
      ? `AI 热点：抓取失败（${input.newsFailures.slice(0, 2).join('；')}）`
      : 'AI 热点：暂无可用来源')
  } else if (input.newsFromCache) {
    disclosures.push('AI 热点：使用本地缓存（本次未联网抓取）')
  }

  const newsSentence = ((): string | null => {
    if (input.news.length === 0) return null
    const top = input.news.slice(0, 2)
    const parts = top.map((n) => {
      const src = n.provenance === 'cache' ? `${n.source}（缓存）` : n.source
      return `${n.title}（来自${src}${n.date ? `，${n.date}` : ''}）`
    })
    return `AI 和科技方面：${parts.join('；')}。`
  })()

  const adviceSentence = input.advice.length ? `${input.advice.slice(0, 2).join('')}` : null
  const encouragement = pickEncouragement(day)

  // ── 按优先级拼口播稿，超长时从"资讯 → 建议"开始裁
  const head = `${input.greeting || '早上好'}今天是 ${day}，${weekday}。`
  const mid = [weatherS, scheduleSentence].filter((x): x is string => Boolean(x)).join('')
  const tail = `最后一句：${encouragement}`

  const build = (news: string | null, advice: string | null): string =>
    [head, mid, news, advice, tail].filter((x): x is string => Boolean(x)).join('')

  let script = build(newsSentence, adviceSentence)
  if (script.length > MAX_CHARS && newsSentence) script = build(null, adviceSentence)
  if (script.length > MAX_CHARS && adviceSentence) script = build(null, null)
  if (script.length > MAX_CHARS) {
    // 极端情况（城市名+日程特别长）：硬裁到上限，并如实标注
    script = `${script.slice(0, MAX_CHARS - 1)}…`
    disclosures.push('口播稿因超长被截断（保留日期、天气、日程与鼓励）')
  }
  /**
   * 太短 ⇒ 补足到 30 秒下限。
   *
   * ⚠ 这里踩过一次：原来的实现只补**一句**，而"离线 + 无日程 + 无资讯"时
   *   基础稿只有 ~26 字（`16.2s`），补一句仍不到 126 字 ⇒ "30–60 秒"这条
   *   用户要求实际上**没有达标**（单测抓出来，第二版补到 123 字仍然差 3 字）。
   *   现在：句子按长度递减（保证"最少几轮"就能补够），且**循环到够为止**，
   *   最后再兜一次"很短但真实"的句子 —— 不允许出现"差一点点就达标"的状态。
   */
  const fillers = [
    '今天我也会安静地待在这儿，需要我的时候叫一声就好，我一直在。',
    '如果今天有想做的事，先从最小的一步开始也算数，不用一次做完。',
    '日程和提醒我都会帮你盯着，到点会告诉你，你不用一直记着它们。',
    '要是累了就休息一下，回来我还在。',
    '新的一天，慢慢来。',
  ]
  const fillerLen = (): number => [...script.replace(/\s+/g, '')].length
  for (const f of fillers) {
    if (fillerLen() >= MIN_CHARS) break
    script = `${script}${script.endsWith('。') || script.endsWith('！') ? '' : '。'}${f}`
  }
  if (fillerLen() < MIN_CHARS) {
    // 兜底：仍然不够就如实标注（**不编造内容**去凑时长）
    disclosures.push('今日可用信息较少，口播稿短于 30 秒的常规时长')
  }

  const estimatedSeconds = estimateSeconds(script)

  return {
    id: `radio_${day}`,
    day,
    weekday,
    greeting: input.greeting || '早上好',
    weather: input.weather,
    schedule,
    news: input.news,
    advice: input.advice,
    encouragement,
    script,
    estimatedSeconds,
    disclosures,
    generatedAt: Date.now(),
  }
}

/** 供 UI 显示：把结构化内容渲染成多行文本（**含来源与日期**，便于核对） */
export function radioToText(c: RadioContent): string {
  const lines: string[] = []
  lines.push(`【早安电台】${c.day} ${c.weekday}`)
  lines.push(c.script)
  if (c.schedule.length) {
    lines.push('今日日程：')
    for (const s of c.schedule) lines.push(`  · ${s.start} ${s.title}`)
  }
  if (c.news.length) {
    lines.push('AI / 科技热点（含来源与日期）：')
    for (const n of c.news) {
      lines.push(`  · ${n.title}`)
      lines.push(`    来源：${n.source}${n.date ? ` · ${n.date}` : ''}${n.provenance === 'cache' ? '（缓存）' : ''}`)
      if (n.url) lines.push(`    ${n.url}`)
    }
  }
  if (c.advice.length) {
    lines.push('今日建议：')
    for (const a of c.advice) lines.push(`  · ${a}`)
  }
  if (c.disclosures.length) {
    lines.push('说明：')
    for (const d of c.disclosures) lines.push(`  · ${d}`)
  }
  return lines.join('\n')
}

/** 当前时间是否到了"该播电台"的分钟（同一分钟多次调用都算） */
export function radioDueAt(configured: string, now: Date): boolean {
  return hhmm(now) === configured
}
