/**
 * apps/desktop/src/main/reflection-extract.ts —— 偏好/事实/待办/情绪/节奏的**提取器**（M4 §1/§3/§4）
 *
 * 用户要求：
 *   · "总结当天对话、提取偏好、重要事实、待办和情绪变化"
 *   · "高置信度事实写入长期记忆；低置信度内容必须询问用户确认"
 *   · "可学习日程习惯、称呼偏好、工作节奏、提醒反馈，但**不得自动修改代码、系统提示词、权限或电脑设置**"
 *
 * ★ 两条不可动摇的设计：
 *
 *   ① **置信度由规则强度决定，不由模型自报**。
 *      模型说"我很确定"是没有意义的；"命中了哪条规则、命中了几次"才是可复核的依据。
 *      所以 `confidence` 是**确定性计算**出来的（见 `scoreOf()`），单测能钉死它。
 *
 *   ② **提取结果一律只用于"提议"**：`preference` / `habit` 这类学到的东西
 *      **只是写进记忆或展示给用户看**，绝不自动去改 `systemPrompt`、权限或设置。
 *      这一条在代码里的落点是：本模块**没有任何**写 settings / persona / permission 的调用
 *      （只有 `memory-store` 的写入，且高置信度才自动写）。
 *
 * 纯规则（不依赖模型）是**刻意**的：模型不可用时反思仍要能跑（M4 不能因为离线就整个失效），
 * 只是覆盖面窄一些 —— 这时 `method='heuristic'` 且 `disclosures` 会如实说明。
 */
import type { ActivityDayStats, ChatMessage, ReflectionItemKind } from '@airimate/shared'
import { HIGH_CONFIDENCE } from '@airimate/shared'
import type { StoredMessage } from './session-store.js'

/**
 * 提取片段时**必须停在从句边界**。
 *
 * ⚠ 实测踩到：早期用 `[^。！？!?\n]` 当"一句"，而中文里逗号是最常见的从句分隔符。
 *   于是"我喜欢抹茶，我喜欢抹茶"被**一次**匹配成 `抹茶，我喜欢抹茶`
 *   （一条含两遍的怪句子），`hits` 恒为 1 ⇒ 重复加成永远不生效，
 *   而且提取出的结论会把两句话粘在一起。
 *   规则里一律写成 `[^。！？!?，,\n]`（**含全角与半角逗号**），每个从句各自成一条。
 *
 * 下面这个常量只是给规则表旁边的注释与单测用（正则本体仍用字面量写，便于阅读）。
 */
export const CLAUSE_BOUNDARY = '[^。！？!?，,\\n]'

export interface ExtractRule {
  id: string
  kind: ReflectionItemKind
  /** 命中判定（在**单条用户消息**上跑） */
  test: RegExp
  /** 基础置信度（0–1）。注意：这是"这条规则本身有多可靠"，不是"用户有多确定" */
  base: number
  /** 把命中的句子整理成一条可读结论（**只抽出该句，不改写、不推测**） */
  toItem: (text: string) => string
}

/**
 * 规则表。
 *
 * 置信度分级依据（**可复核**）：
 *   · 0.90 —— 第一人称的明确陈述（"我住在…"、"我的生日是…"）：
 *     用户主动说的身份事实，几乎不会误判；
 *   · 0.80 —— 明确的偏好动词（"我喜欢/我不喜欢"）：句式固定；
 *   · 0.60 —— 待办（"我要…"/"记得…"）：可能是当下的打算，未必是长期事实 ⇒ **低于阈值，必须确认**；
 *   · 0.50 —— 情绪词：一次情绪波动不足以成为"重要事实" ⇒ **必须确认**；
 *   · 0.45 —— 日程习惯的猜测：单次出现太弱 ⇒ **必须确认**。
 *
 * ⚠ `HIGH_CONFIDENCE = 0.75`：所以只有"身份事实"与"明确偏好"会自动写入记忆。
 *   这正是用户要求的分界（"高置信度…写入；低置信度…必须询问"）。
 */
export const EXTRACT_RULES: readonly ExtractRule[] = [
  // ── 身份/重要事实（0.90）
  { id: 'fact-name', kind: 'fact', test: /(?:我|俺)(?:的)?名字(?:是|叫)([^。！？!?，,\n]{1,16})/, base: 0.90, toItem: s => `用户的名字是${firstClause(s)}` },
  { id: 'fact-birthday', kind: 'fact', test: /(?:我|俺)(?:的)?生日(?:是|在)([^。！？!?，,\n]{1,24})/, base: 0.90, toItem: s => `用户的生日是${firstClause(s)}` },
  { id: 'fact-live', kind: 'fact', test: /(?:我|俺)(?:住在|家在|来自)([^。！？!?，,\n]{1,24})/, base: 0.90, toItem: s => `用户住在${firstClause(s)}` },
  { id: 'fact-job', kind: 'fact', test: /(?:我|俺)(?:是|做)(?:一[个名])?([^。！？!?，,\n]{0,12}(?:工程师|设计师|老师|医生|学生|程序员|产品经理|运营|会计|律师))/, base: 0.88, toItem: s => `用户的职业与「${firstClause(s)}」有关` },
  { id: 'fact-allergy', kind: 'fact', test: /(?:我|俺)(?:对)([^。！？!?，,\n]{1,16})(?:过敏)/, base: 0.92, toItem: s => `用户对${firstClause(s)}过敏` },
  { id: 'fact-callme', kind: 'fact', test: /(?:叫|称呼)(?:我)([^。！？!?，,\n]{1,16})/, base: 0.85, toItem: s => `用户希望你称呼他为${firstClause(s)}` },

  // ── 明确偏好（0.78–0.85）
  { id: 'pref-like', kind: 'preference', test: /(?:我|俺)(?:最)?(?:喜欢|爱|偏爱)([^。！？!?，,\n]{1,30})/, base: 0.85, toItem: s => `用户喜欢${firstClause(s)}` },
  { id: 'pref-dislike', kind: 'preference', test: /(?:我|俺)(?:不|讨厌|不喜欢)(?:太)?(?:喜欢|爱)?([^。！？!?，,\n]{1,30})/, base: 0.82, toItem: s => `用户不喜欢${firstClause(s)}` },
  { id: 'pref-habit', kind: 'preference', test: /(?:我|俺)(?:习惯|通常|一般会)([^。！？!?，,\n]{1,30})/, base: 0.78, toItem: s => `用户的习惯是${firstClause(s)}` },
  { id: 'pref-favorite', kind: 'preference', test: /(?:我|俺)(?:最)?(?:喜欢的|最爱)([^。！？!?，,\n]{1,24})/, base: 0.80, toItem: s => `用户最喜欢的是${firstClause(s)}` },

  // ── 待办（0.60–0.65 —— 低于阈值，必须确认）
  /**
   * ⚠ 规则必须覆盖**时间词插在"我"和"要"之间**的形态。
   *   实测踩到：`/(?:我)(?:要|得|需要)/` 匹配不上"我**明天**要交周报" ——
   *   而那恰恰是最自然的说法 ⇒ "待办"这一类几乎永远提取不到。
   *   中文里时间词插在主语与助动词之间是常态，规则要显式容纳它。
   */
  {
    id: 'todo-plan',
    kind: 'todo',
    test: /(?:我)(?:今天|明天|后天|大后天|下周|下个月|这周|本周|周末)?(?:要|得|需要|打算|准备|计划)([^。！？!?，,\n]{1,40})/,
    base: 0.60,
    toItem: s => `用户提到要做：${firstClause(s)}`,
  },
  { id: 'todo-remind', kind: 'todo', test: /(?:提醒我|记得|别忘了)([^。！？!?，,\n]{1,40})/, base: 0.65, toItem: s => `用户希望你提醒：${firstClause(s)}` },
  { id: 'todo-deadline', kind: 'todo', test: /(?:截止|deadline|之前要完成)([^。！？!?，,\n]{1,40})/, base: 0.62, toItem: s => `用户有一个期限：${firstClause(s)}` },

  // ── 情绪（0.45–0.52 —— 必须确认）
  { id: 'emo-tired', kind: 'emotion', test: /(?:累|疲惫|好困|撑不住|精疲力尽)/, base: 0.50, toItem: () => '用户今天提到自己很累' },
  { id: 'emo-happy', kind: 'emotion', test: /(?:开心|高兴|太好了|顺利|成功)/, base: 0.45, toItem: () => '用户今天心情不错' },
  { id: 'emo-stress', kind: 'emotion', test: /(?:压力|焦虑|崩溃|难受|郁闷)/, base: 0.52, toItem: () => '用户今天压力较大' },

  // ── 日程习惯（0.45 —— 必须确认）
  { id: 'habit-schedule', kind: 'habit', test: /(?:每天|每周|早上|晚上|中午)(?:都)?([^。！？!?，,\n]{1,30})/, base: 0.45, toItem: s => `用户提到一个固定习惯：${firstClause(s)}` },
]

/** 只取第一个短句（**不改写、不推测**，避免把用户没说的话"补"进去） */
function firstClause(s: string): string {
  const m = /^([^，。；！？,;!?\n]{1,30})/.exec(s.trim())
  return (m?.[1] ?? s.trim()).slice(0, 30)
}

export interface ExtractResult {
  items: Array<{ kind: ReflectionItemKind, text: string, confidence: number, ruleId: string, messageCount: number }>
  /** 扫描了多少条用户消息 */
  scannedUserMessages: number
}

/**
 * 置信度计算（**确定性**，单测可钉死）。
 *
 * 为什么不是"命中即用 base"：同一件事被说两次，比只说一次可信。
 *   所以 `confidence = base + 0.05 × (命中次数 - 1)`，上限 0.97、下限 0。
 *   但这个加成**幅度很小**（5%），因为"重复说"不等于"说得对"。
 */
export function scoreOf(base: number, hits: number): number {
  const raw = base + 0.05 * Math.max(0, hits - 1)
  return Math.min(0.97, Math.max(0, Math.round(raw * 100) / 100))
}

/**
 * 从消息里提取。
 *
 * `onlyUserMessages`：只扫用户说的话（**不扫她自己的回复** ——
 * 否则"她说的"会被当成"用户的事实"，那是自污染）。
 */
export function extractFromMessages(messages: readonly StoredMessage[]): ExtractResult {
  /** 归一化文本 → 命中信息（用于合并重复） */
  const merged = new Map<string, { kind: ReflectionItemKind, text: string, base: number, ruleId: string, hits: number }>()
  let scanned = 0
  for (const m of messages) {
    if (m.role !== 'user') continue
    scanned++
    for (const rule of EXTRACT_RULES) {
      /**
       * ⚠ 用 `matchAll` + `/g` 副本而不是 `exec` 一次：同一句话里说两遍
       *   （"我喜欢抹茶，我喜欢抹茶"）也要被算作两次命中 ——
       *   否则 `hits` 恒等于 1，`scoreOf()` 的重复加成永远不生效。
       *   这里用 `new RegExp(src, 'g')` 新建实例，避免共享 `lastIndex` 状态。
       */
      const re = new RegExp(rule.test.source, 'g')
      for (const hit of m.text.matchAll(re)) {
        const text = rule.toItem(hit[1] ?? '')
        if (!text || text.length < 4) continue
        const key = `${rule.kind}:${text}`
        const prev = merged.get(key)
        if (prev) prev.hits++
        else merged.set(key, { kind: rule.kind, text, base: rule.base, ruleId: rule.id, hits: 1 })
      }
    }
  }
  const items = [...merged.values()].map(v => ({
    kind: v.kind,
    text: v.text,
    confidence: scoreOf(v.base, v.hits),
    ruleId: v.ruleId,
    messageCount: v.hits,
  }))
  // 排序：高置信度在前（UI 与"自动写入"都按这个顺序处理）
  items.sort((a, b) => b.confidence - a.confidence)
  return { items, scannedUserMessages: scanned }
}

// ───────────────────────────────────────────────────────── 工作节奏

export interface RhythmInput {
  /** 最近 N 天（新的在前） */
  days: readonly ActivityDayStats[]
  /** 参与统计的天数下限（低于它就 `confident:false`） */
  minSampleDays?: number
}

/**
 * 从活动统计算工作节奏。
 *
 * ★ **样本不足时必须说"不确定"**：三天的数据推不出"你的工作节奏"。
 *   `confident:false` 时 UI 不该把它当事实展示 —— 这是"不编造"原则在 M4 的落点。
 */
export function computeRhythm(input: RhythmInput): {
  avgActiveMinutes: number
  maxStreakMinutes: number
  topHours: number[]
  sampleDays: number
  confident: boolean
} {
  const minSampleDays = input.minSampleDays ?? 3
  const days = [...input.days].slice(0, 30)
  const sampleDays = days.filter(d => d.samples > 0).length
  if (sampleDays === 0) {
    return { avgActiveMinutes: 0, maxStreakMinutes: 0, topHours: [], sampleDays: 0, confident: false }
  }
  const active = days.filter(d => d.samples > 0)
  const avgActiveMinutes = Math.round(active.reduce((s, d) => s + d.activeMinutes, 0) / active.length)
  const maxStreakMinutes = active.reduce((s, d) => Math.max(s, d.longestStreakMinutes), 0)
  // 按小时汇总（24 格），取最活跃的前 3 个
  const hourly = new Array<number>(24).fill(0)
  for (const d of active) {
    for (let h = 0; h < 24; h++) hourly[h] = (hourly[h] ?? 0) + (d.hourlyActiveMinutes[h] ?? 0)
  }
  const topHours = hourly
    .map((v, h) => ({ v, h }))
    .filter(x => x.v > 0)
    .sort((a, b) => b.v - a.v)
    .slice(0, 3)
    .map(x => x.h)
    .sort((a, b) => a - b)
  return {
    avgActiveMinutes,
    maxStreakMinutes,
    topHours,
    sampleDays,
    confident: sampleDays >= minSampleDays,
  }
}

// ───────────────────────────────────────────────────────── 总结与建议

export interface SummaryInput {
  day: string
  userMessages: readonly ChatMessage[]
  allMessages: readonly StoredMessage[]
  activity: ActivityDayStats | null
  rhythm: ReturnType<typeof computeRhythm>
  memoryHits: number
}

/**
 * 生成"今日总结"。
 *
 * 纪律：**每一句都对应一个真实读数**（条数、分钟数、小时）。
 *   没有数据时如实说"今天几乎没有记录"，而不是编一段温暖的话。
 */
export function buildDailySummary(i: SummaryInput): string {
  const userCount = i.allMessages.filter(m => m.role === 'user').length
  const assistantCount = i.allMessages.filter(m => m.role === 'assistant' && m.origin === 'user').length
  const proactiveCount = i.allMessages.filter(m => m.role === 'assistant' && m.origin !== 'user').length
  const parts: string[] = []

  if (userCount === 0 && proactiveCount === 0) {
    parts.push(`今天（${i.day}）几乎没有记录 —— 我们没怎么说话。`)
  } else {
    parts.push(`今天我们说了 ${userCount} 句，我回了 ${assistantCount} 次。`)
    if (proactiveCount > 0) parts.push(`另外我主动找过你 ${proactiveCount} 次。`)
  }
  if (i.memoryHits > 0) parts.push(`有 ${i.memoryHits} 次我参考了记着的事。`)
  if (i.activity && i.activity.samples > 0) {
    const mins = i.activity.activeMinutes
    parts.push(`电脑前大约活跃 ${mins} 分钟${i.activity.longestStreakMinutes > 0 ? `，最长连续 ${i.activity.longestStreakMinutes} 分钟` : ''}。`)
  } else {
    parts.push('活动采样今天没有数据（可能没开或采样不可用）。')
  }
  if (i.rhythm.confident && i.rhythm.topHours.length > 0) {
    parts.push(`最近的活跃时段集中在 ${i.rhythm.topHours.map(h => `${h} 点`).join('、')}。`)
  }
  return parts.join('')
}

/**
 * 生成"明日建议"。
 *
 * 纪律：只基于**真实读数**给建议；读数不足就**不给**（而不是给一句万能的鼓励）。
 *   `sampleDays`、`activeMinutes`、`longestStreakMinutes` 都是可从
 *   `activity.json` 复核的量。
 */
export function buildTomorrowAdvice(i: SummaryInput): string[] {
  const out: string[] = []
  const act = i.activity
  if (act && act.samples > 0) {
    if (act.longestStreakMinutes >= 120) {
      out.push(`昨天最长连续 ${Math.round(act.longestStreakMinutes / 60 * 10) / 10} 小时没离开座位，明天记得每小时起来一下。`)
    }
    if (act.activeMinutes >= 300) {
      out.push(`今天电脑前 ${Math.round(act.activeMinutes / 60 * 10) / 10} 小时，明天可以给自己留一段不看屏幕的时间。`)
    }
    if (act.blockedSamples > 0 && act.samples > 0 && act.blockedSamples / act.samples > 0.5) {
      out.push('今天大半时间你都在会议或全屏里 —— 明天我把提醒都攒着，等你有空再说。')
    }
  }
  if (i.rhythm.confident && i.rhythm.avgActiveMinutes >= 180) {
    out.push(`最近平均每天活跃 ${Math.round(i.rhythm.avgActiveMinutes / 60 * 10) / 10} 小时，节奏偏满，明天试着早一点收尾。`)
  }
  // 待办类提取项可以变成建议（**这是"提议"，不是自动排程**）
  const todos = i.userMessages.length
  if (todos > 0) {
    const last = i.userMessages[i.userMessages.length - 1]
    if (last && last.text.length > 0) out.push('如果今天有没做完的事，明天可以直接跟我说，我帮你记着。')
  }
  return out.slice(0, 4)
}
