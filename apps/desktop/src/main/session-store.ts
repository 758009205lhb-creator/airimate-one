/**
 * apps/desktop/src/main/session-store.ts —— 会话历史与人设（**不含密钥**）
 *
 * 存储：`%APPDATA%\AiriMateOne\session.json`（原子写 + schema 校验）
 * 纪律：
 *   · 对话正文**只**落这里（本地文件），**不进日志**（logger 只记长度与哈希）；
 *   · 容量上限：默认保留最近 400 条消息，超出丢弃最旧的（避免文件无限增长）；
 *   · 人设的默认值写死在 `DEFAULT_PERSONA`，保证首次运行就有可用人设。
 */
import { z } from 'zod'
import { createJsonStore } from './json-store.js'
import { log } from './log.js'

export const PersonaSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(40),
  /** 她怎么称呼用户（称呼偏好；M1 向导里收集） */
  userTitle: z.string().max(40).default('你'),
  systemPrompt: z.string().max(8000),
  personality: z.string().max(2000),
  speakingStyle: z.string().max(1000),
  greeting: z.string().max(500),
  performance: z.object({
    expressiveness: z.number().min(0).max(1),
    gestureFrequency: z.number().min(0).max(1),
    idleChatter: z.boolean(),
  }),
  updatedAt: z.number(),
})
export type Persona = z.infer<typeof PersonaSchema>

export const StoredMessageSchema = z.object({
  id: z.string().max(64),
  role: z.enum(['system', 'user', 'assistant']),
  text: z.string().max(20000),
  createdAt: z.number(),
  /** 该条回复触发的动作（**只存语义**，不存内部对象） */
  commands: z.array(z.string().max(80)).max(16).default([]),
  /**
   * 消息来源（分清"她主动说的"与"我发起的"）。
   *
   * ⚠ `appendMessage()` 必须**显式传入**这个字段：它一度只写进内存与日志，
   *   而没有进 schema ⇒ zod 在 `loadSession()` 回读时把它**静默重置成 `user`**，
   *   于是重启之后所有主动消息都被当成用户发起的（单测抓出来的）。
   */
  origin: z.enum(['user', 'proactive', 'radio', 'reflection']).default('user'),
})
export type StoredMessage = z.infer<typeof StoredMessageSchema>

const StoreSchema = z.object({
  version: z.literal(1),
  persona: PersonaSchema,
  messages: z.array(StoredMessageSchema).max(2000),
  /**
   * ★★ **上下文起点**（2026-10-09 完善轮新增）。
   *
   * `createdAt < contextResetAt` 的消息算"上一段对话"：
   *   · **不再进提示词**（她"不记得"了 —— 「新建对话」的语义就是这个）；
   *   · **不再出现在对话界面上**（`visibleHistory()`）；
   *   · **但一条都不删** —— 隐私导出 / 记忆页 / 历史总量里它们都还在。
   *
   * 为什么必须有这个字段（而不是把「新建对话」做成一键清空）：
   *   菜单栏里同时有「新建对话」与「清除对话」两项，如果它们做同一件事，
   *   那就是一个**骗人的菜单**。删除有它自己的入口（清空对话，两步确认）。
   *
   * ⚠ 带 `.default(0)`：老的 `session.json` 里没有这个键，
   *   必须仍然能解析（`0` = 从未重置过 ⇒ 全部历史都在上下文里，与旧行为一致）。
   */
  contextResetAt: z.number().min(0).default(0),
})
type Store = z.infer<typeof StoreSchema>

const MAX_MESSAGES = 400

export const DEFAULT_PERSONA: Persona = {
  id: 'default',
  name: 'Lazuli',
  userTitle: '你',
  systemPrompt: [
    '你是用户的桌面伙伴，性格温柔、体贴、略带俏皮。用第一人称、口语化地回应。',
    '回复要简短自然（通常 1–3 句），不要长篇大论，不要列要点。',
    '你可以用动作与表情来表达情绪。可用标记（只能从这里选，不要发明新词）：',
    /**
     * ⚠ `[motion:sleep]` **已临时从清单里移除**（用户 2026-09-27 方案 C）：
     *   该 clip 的根位移放大后是荒谬值，钉死后会呈现"站姿抱臂"这个明显错误的姿态。
     *   把它从提示词里去掉，模型就不会去请求一个必然被拒的动作
     *   （即使请求了也会在 `Stage.requestMotion()` 被挡下并记入 `disabledMotionHits`）。
     *   恢复步骤见 `packages/shared/src/settings.ts` 的 `DISABLED_MOTION_SEMANTICS`。
     */
    '  动作： [motion:idle] [motion:wave] [motion:nod] [motion:shake] [motion:dance once]',
    '        [motion:laugh] [motion:shy] [motion:sit] [motion:stand] [motion:walk] [motion:wake]',
    '  表情： [emotion:happy] [emotion:sad] [emotion:angry] [emotion:relaxed] [emotion:surprised] [emotion:neutral]',
    '标记要**克制**：一次回复最多用一个动作 + 一个表情，放在句首或句尾。',
    '不要解释这些标记，也不要向用户提及标记本身。',
  ].join('\n'),
  personality: '温柔、耐心、会记住用户说过的事，偶尔会害羞。',
  speakingStyle: '口语化、短句、偶尔用语气词。',
  greeting: '你回来啦～我一直在这儿等你呢。',
  performance: { expressiveness: 0.7, gestureFrequency: 0.4, idleChatter: false },
  updatedAt: 0,
}

/**
 * 存储：`%APPDATA%\AiriMateOne\session.json`
 *
 * ⚠ 走统一的 `createJsonStore`：**对话历史**与**人设**是这个应用最不可再生的
 *   用户数据（人设还是用户亲手写的）。手写读写没有迁移能力 ——
 *   `version: z.literal(1)` 一旦升到 2，老文件会直接校验失败并回退默认值，
 *   也就是**历史与自定义人设一起消失**。所以它必须在有升级路径的格式里。
 */
const store = createJsonStore<Store>({
  file: 'session.json',
  schema: StoreSchema,
  storeName: 'session',
  schemaVersion: 1,
  fallback: () => ({ version: 1, persona: { ...DEFAULT_PERSONA, updatedAt: Date.now() }, messages: [], contextResetAt: 0 }),
  tag: 'session',
})

export function loadSession(): Store {
  return store.load()
}

function save(next: Store): void {
  store.save(next)
}

/** 会话文件路径（诊断与验收探针用） */
function storeFile(): string {
  return store.filePath()
}

export function getPersona(): Persona {
  return loadSession().persona
}

export function setPersona(p: Omit<Persona, 'updatedAt'>): Persona {
  const cur = loadSession()
  const next: Persona = { ...p, updatedAt: Date.now() }
  save({ ...cur, persona: next })
  log().info('人设已更新', { id: next.id, name: next.name, promptChars: next.systemPrompt.length }, 'persona.set')
  return next
}

export function appendMessage(m: StoredMessage): void {
  const cur = loadSession()
  /**
   * ⚠ 必须**过一遍 schema** 再落盘。
   *
   * 踩过的坑：这里曾经直接 `save({ ...cur, messages })`，把调用方传进来的对象原样写盘。
   * 于是"缺省字段"不会补全（例如 `commands` 缺省应是 `[]`、`origin` 缺省应是 `'user'`）
   * 而且**字段名写错也不会被发现** —— 单测里 `history()` 读回的 `origin` 恒为 `user`
   * 就是这么来的。`save()` 内部有 schema，但 `loadSession()` 的缓存会先命中，
   * 所以错误数据会一直留在内存里直到重启。
   */
  const parsed = StoredMessageSchema.parse(m)
  const messages = [...cur.messages, parsed]
  // 超限时丢弃最旧的（保留最近 MAX_MESSAGES 条）
  const trimmed = messages.length > MAX_MESSAGES ? messages.slice(messages.length - MAX_MESSAGES) : messages
  save({ ...cur, messages: trimmed })
  // ⚠ 只记长度与哈希前缀，**不记正文**
  log().info('消息已记录', { role: parsed.role, chars: parsed.text.length, commands: parsed.commands.length, origin: parsed.origin }, 'session.append')
}

export function history(limit = 100): StoredMessage[] {
  const all = loadSession().messages
  return all.slice(Math.max(0, all.length - limit))
}

/** 当前上下文起点（`0` = 从未重置过） */
export function contextResetAt(): number {
  return loadSession().contextResetAt ?? 0
}

/**
 * ★ **当前这一段对话**的消息（`createdAt >= contextResetAt`）—— **界面与提示词都读它**。
 *
 * ⚠ 为什么界面也必须读它（而不只是提示词）：如果界面继续显示上一段的文字，
 *   用户看到的是"她说她不记得，可那些话明明还在上面" —— 比不做这个功能更让人困惑。
 *   历史**没有消失**（`history()` / `exportHistory()` 仍然给全量），
 *   只是"当前这一段"从重置点开始算。
 */
export function visibleHistory(limit = 100): StoredMessage[] {
  const at = contextResetAt()
  const cur = at > 0 ? loadSession().messages.filter(m => m.createdAt >= at) : loadSession().messages
  return cur.slice(Math.max(0, cur.length - limit))
}

/**
 * ★★ **只重置上下文，不删历史**（「新建对话」；2026-10-09 完善轮新增）。
 *
 * 与 `clearHistory()` 的区别（两者都必须存在，见 `StoreSchema.contextResetAt` 的说明）：
 *   · `clearHistory()`  —— 真的把 `messages` 清空（不可逆）；
 *   · `resetContext()`  —— 只把"上下文起点"推到此刻，`messages` **一条不动**。
 *
 * 返回值是**如实读数**（不是"成功/失败"）：
 *   · `archivedCount` —— 被划到上一段的消息条数；
 *   · `visibleCount`  —— 重置后仍属当前段的条数（正常是 0，除非写入与重置同毫秒）；
 *   · `totalCount`    —— 历史总条数（`archivedCount + visibleCount`，证明**没删**）。
 */
export function resetContext(now = Date.now()): {
  archivedCount: number, visibleCount: number, totalCount: number, resetAt: number
} {
  const cur = loadSession()
  const archivedCount = cur.messages.length
  save({ ...cur, contextResetAt: now })
  const next = loadSession()
  const visibleCount = next.messages.filter(m => m.createdAt >= now).length
  log().info('对话上下文已重置（历史一条未删）', {
    archivedCount, visibleCount, totalCount: next.messages.length,
  }, 'session.context-reset')
  return { archivedCount, visibleCount, totalCount: next.messages.length, resetAt: now }
}

/** 全量消息（**隐私导出**用；调用方负责写进用户选定的文件） */
export function exportHistory(): StoredMessage[] {
  return loadSession().messages.map(m => ({ ...m }))
}

/** 历史条数（**只给计数**，诊断用；不返回正文） */
export function sessionMessageCount(): number {
  return loadSession().messages.length
}

/**
 * 按 id 删除一条消息（**只有主进程能调**）。
 *
 * 存在理由：renderer 没有伪造历史的通道，所以验收探针要造"对话输入"
 * 就必须从主进程写，写完之后也要能精确清掉 ——
 * 否则探针会把测试文本留在用户的真实历史里。
 *
 * ⚠ 刻意**不暴露给 renderer**：能从界面删单条历史听起来无害，
 *   但它会给"伪造历史"开一条口子。要删历史请用 `clearHistory()` 或隐私页的彻底清除。
 */
export function removeMessageById(id: string): boolean {
  const cur = loadSession()
  const messages = cur.messages.filter(m => m.id !== id)
  if (messages.length === cur.messages.length) return false
  save({ ...cur, messages })
  return true
}

/** 全量读取（**探针清场用**；renderer 走 `history()` 只拿到截断后的尾部） */
export function sessionAllMessages(): StoredMessage[] {
  return loadSession().messages.map(m => ({ ...m }))
}

export function clearHistory(): number {
  const cur = loadSession()
  const n = cur.messages.length
  /** ⚠ 上下文起点**一起清掉**：清空之后历史是空的，留着旧起点只会让"新消息是否在上下文里"变得难以推断 */
  save({ ...cur, messages: [], contextResetAt: 0 })
  log().info('会话历史已清空', { removed: n }, 'session.clear')
  return n
}

let msgSeq = 0
export function nextMessageId(prefix: string): string {
  msgSeq += 1
  return `${prefix}_${Date.now().toString(36)}_${msgSeq}`
}

/**
 * 清空内存缓存（**必须与"删文件"成对调用**）。
 *
 * 踩过的坑：`privacy:wipe` 只删了 `session.json`，但进程内的 `cache` 还在 ——
 * 于是"彻底清除个人数据"之后，界面上、`chat:history` 里**仍然能看到全部对话**
 * （单测抓出来的）。删盘不清内存 = 用户以为删干净了，其实没有。
 */
export function clearSessionCache(): void {
  store.__reset()
}

/** 仅供单测：与 `clearSessionCache()` 同一实现（命名区分用途） */
export function __resetSessionStoreForTest(): void {
  store.__reset()
}

/**
 * 组装发给模型的消息序列：系统人设 + 最近 N 轮历史。
 * `extraSystem` 用于注入记忆摘要与"当前时间/日程"这类上下文。
 *
 * ⚠ 历史条数必须与用户设置一致（`chatHistoryLimit`）：设置里写着"保留 200 条"
 *   而提示词只喂 20 条，是两套口径 —— 这里统一由设置驱动（缺省回退 20）。
 */
export function buildPrompt(userText: string, opts: { historyLimit?: number, extraSystem?: string } = {}): Array<{ role: 'system' | 'user' | 'assistant', content: string }> {
  const p = getPersona()
  const sys: string[] = [p.systemPrompt]
  if (p.personality) sys.push(`性格：${p.personality}`)
  if (p.speakingStyle) sys.push(`说话风格：${p.speakingStyle}`)
  if (p.userTitle && p.userTitle !== '你') sys.push(`你称呼用户为「${p.userTitle}」。`)
  if (opts.extraSystem) sys.push(opts.extraSystem)
  const msgs: Array<{ role: 'system' | 'user' | 'assistant', content: string }> = [{ role: 'system', content: sys.join('\n') }]
  /**
   * ⚠ 这里用 `visibleHistory()` 而**不是** `history()`（2026-10-09 完善轮）：
   *   「新建对话」的语义就是"从此刻起她不再记得之前聊过什么"。
   *   若提示词仍把全部历史喂进去，那个菜单项就只是一个清屏动画 ——
   *   界面空了、她却还记得，是最容易被当成 bug 的形态。
   */
  for (const m of visibleHistory(opts.historyLimit ?? 20)) {
    if (m.role === 'system') continue
    msgs.push({ role: m.role, content: m.text })
  }
  msgs.push({ role: 'user', content: userText })
  return msgs
}
