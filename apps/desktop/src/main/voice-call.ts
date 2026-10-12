/**
 * apps/desktop/src/main/voice-call.ts —— 语音通话链路（M3 §2）
 *
 * 用户要求："语音通话支持 VAD、打断、连续对话、STT → LLM → TTS 全链路"。
 *
 * ⚠ 这个文件是**补一个真实缺口**才出现的：M3 第一版只有"识别一句"与"朗读一段"
 *   两个零件，`onRecognizedText()` **全仓零订阅者**、`voiceListenOnce` 也没有任何
 *   界面在调 —— 也就是说"全链路"当时并不存在（外部复核抓到的）。
 *   零件齐了不等于链路通了；这里把链路显式接上，并让它**可观测**。
 *
 * 链路（单向、无隐藏分支）：
 *
 *   ┌──────────── 一个循环 = 一次"用户说 + 她答" ────────────┐
 *   │ ① 听：`listenOnce()`（Windows 识别器自带静音断句）      │
 *   │ ② 唤醒词剥离（未命中且要求唤醒 ⇒ 回到 ①）              │
 *   │ ③ 想：把文本交给 LLM（注入人设 + 记忆，与打字同一条路）  │
 *   │ ④ 说：把回复交给 TTS（**可被用户打断**）                │
 *   └────────────────────────────────────────────────────┘
 *
 * 三条纪律：
 *   ① **只有主进程能启动循环**，且必须 `settings.hearingEnabled` 为真
 *      （否则一次 IPC 调用就能让麦克风长开 —— 那正是"后台偷听"的形状）；
 *   ② **可打断**：用户在她说的时候再开口（或点"打断"）⇒ 立刻 `tts.stop()` 并
 *      回到"听"的状态，而不是等她说完（用户要求明确包含"打断"）；
 *   ③ **失败必如实**：识别失败/模型失败/朗读失败分别是什么原因，逐条回报，
 *      绝不"看起来在通话但其实什么都没发生"。
 *
 * VAD 说明（口径必须精确）：本实现**使用 Windows 识别器自带的活动检测**
 *   （`InitialSilenceTimeout` / `BabbleTimeout` / `EndSilenceTimeout`，
 *   见 `PS_LISTEN_ONCE_SCRIPT`）来切分"一句"。这是一个**由平台提供的 VAD**，
 *   不是自研的能量阈值 VAD。区别在于：没有独立的"是否有人在说话"信号，
 *   静音时段表现为"这一轮识别返回空文本"。
 */
import { loadSettings } from './settings-store.js'
import { appendMessage, buildPrompt, getPersona, nextMessageId } from './session-store.js'
import { buildMemoryBlock } from './memory-store.js'
import { startChat } from './chat-client.js'
import { activeProvider, egressAllowed } from './provider-store.js'
import { secretStore } from './secrets-store.js'
import { listenOnce, getVoiceTts, onRecognizedText } from './voice-engine.js'
import { parseReply } from './act-parser.js'
import { log } from './log.js'
/**
 * ★ 唤醒词 → 对话（本轮）：依赖方向 `voice-call → conversation → window-manager`，
 *   **单向**（conversation 不 import voice-call），所以这里直接 import 不会成环。
 */
import { openConversation } from './conversation.js'

/**
 * ★ 语音 IO **注入点**（只为让闭环可被机械验证而存在）。
 *
 * 为什么需要它：用户要求 A4「做闭环」，而闭环的两端是**麦克风与扬声器**——
 *   没有注入点的话，"听→想→说 真的接通了"这件事就永远只能靠人工拿着麦克风试，
 *   于是它会一直停在"未验证"里（本项目的 M3 就是这么过来的）。
 *   注入之后，单测可以用**脚本化的假件**（喂一句 → 断言模型被调用 → 断言 TTS 被喂了回复）
 *   把整条链跑穿，**不需要真实设备**。
 *
 * 默认值就是真实实现 ⇒ 生产路径的行为**一字不变**；
 * 唯一的替换入口叫 `__setVoiceIoForTest`，名字里带 `ForTest` 就是为了让它显眼。
 */
interface VoiceIo {
  /**
   * ⚠ `signal` 是**可选**的：真实 `listenOnce()` 目前不支持中途取消
   *   （它等的是子进程，靠超时结束），生产路径不传它、行为不变。
   *   但注入件应当**尊重**它 —— 否则"朗读结束 ⇒ 取消并发的那个听"会让
   *   那个 promise 一直挂着（实测把整个测试套件吊死）。
   */
  listenOnce: (o: { timeoutMs?: number, signal?: AbortSignal }) => Promise<{ ok: boolean, text: string, confidence: number, isWake: boolean, reason: string | null }>
}
let ioListenOnce: VoiceIo['listenOnce'] = (o) => listenOnce(o)

export type CallPhase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error'

export interface VoiceCallState {
  /** 通话是否在进行 */
  active: boolean
  phase: CallPhase
  /** 本轮序号（从 1 开始；用于"第几轮"的可读进度） */
  turn: number
  /** 累计完成轮数 */
  turnsCompleted: number
  /** 最近一次"听到"的字符数（**不是内容**） */
  lastHeardChars: number | null
  /** 最近一次"说出"的字符数（**不是内容**） */
  lastSpokeChars: number | null
  /** 被打断的次数（用户要求"打断"⇒ 必须可计数） */
  interruptions: number
  /** 空识别（VAD 判为静音）的次数 —— 用于解释"为什么没反应" */
  silenceTurns: number
  lastError: string | null
  startedAt: number | null
  /** 待机听唤醒是否在运行（用户要求"说唤醒词就开始对话"） */
  wakeWatchRunning: boolean
  /** 最近一次识别到的字符数（**不是内容**；来自 voice-engine 的订阅） */
  lastRecognizedChars: number | null
  /** 最近一次识别是否为唤醒词命中 */
  lastWasWake: boolean | null
  /** 累计被订阅到的识别次数（证明那条通路真的有人接） */
  recognizedCount: number
  /** 因为听到用户开口而被打断的次数（与"点按钮打断"分开计数） */
  bargeInInterruptions: number
}

const st: VoiceCallState = {
  active: false,
  phase: 'idle',
  turn: 0,
  turnsCompleted: 0,
  lastHeardChars: null,
  lastSpokeChars: null,
  interruptions: 0,
  silenceTurns: 0,
  lastError: null,
  startedAt: null,
  wakeWatchRunning: false,
  lastRecognizedChars: null,
  lastWasWake: null,
  recognizedCount: 0,
  bargeInInterruptions: 0,
}

export function voiceCallState(): VoiceCallState {
  return { ...st }
}

/** 事件出口（由 capabilities 注入；**只有事件与长度，没有内容**） */
export interface CallNotice {
  at: number
  kind: 'call-started' | 'call-stopped' | 'heard' | 'silence' | 'thinking' | 'speaking' | 'interrupted'
    | 'error' | 'wake-activated' | 'wake-watch-started' | 'wake-watch-stopped' | 'wake-watch-ignored' | 'barge-in'
  detail: string
  /** 面向用户的回复文本（**仅用于气泡显示**；不写日志、不进审计） */
  replyText?: string
}
let notifier: ((n: CallNotice) => void) | null = null
export function onCallNotice(fn: (n: CallNotice) => void): void {
  notifier = fn
}
function notice(kind: CallNotice['kind'], detail: string, replyText?: string): void {
  log().info('语音通话事件', { kind, detail: detail.slice(0, 120) }, `voice.call.${kind}`)
  try { notifier?.(replyText !== undefined ? { at: Date.now(), kind, detail, replyText } : { at: Date.now(), kind, detail }) } catch { /* 推送失败不影响链路 */ }
}

// ───────────────────────────────────────────────────────── 循环控制

let loopAbort: AbortController | null = null
let activeChatAbort: (() => void) | null = null
/** 用户点"打断" ⇒ 置位，循环在下一个检查点立刻让出 */
let interruptRequested = false

/**
 * 启动语音通话。
 *
 * 返回 `{ ok:false, reason }` 而不是抛错（IPC 层要把它变成结构化失败）。
 */
export function startVoiceCall(): { ok: boolean, reason: string | null } {
  if (st.active) return { ok: false, reason: '通话已经开始了' }
  const s = loadSettings()
  if (!s.hearingEnabled) {
    return { ok: false, reason: '语音识别未启用（请在设置 → 语音里显式开启；默认关闭）' }
  }
  const provider = activeProvider()
  if (!provider) return { ok: false, reason: '还没有配置供应商，无法进行语音对话（可以只做识别，但通话需要模型）' }

  st.active = true
  st.phase = 'listening'
  st.turn = 0
  st.turnsCompleted = 0
  st.startedAt = Date.now()
  st.lastError = null
  interruptRequested = false
  loopAbort = new AbortController()
  /**
   * ⚠ 通话开始 ⇒ **让待机监听让出麦克风**（两个循环同时听会抢同一个输入设备）。
   *   不停止的话，待机循环会与通话循环各起一个识别子进程。
   */
  if (wakeWatchActive) stopWakeWatch('call-started')
  notice('call-started', '语音通话已开始（随时可以点「打断」或「结束通话」）')
  void runLoop(loopAbort.signal)
  return { ok: true, reason: null }
}

/** 结束通话（幂等）：杀识别子进程 + 停朗读 + 让循环退出 */
export function stopVoiceCall(reason = 'user'): { stopped: boolean } {
  const wasActive = st.active
  st.active = false
  st.phase = 'idle'
  interruptRequested = false
  try { loopAbort?.abort() } catch { /* ignore */ }
  loopAbort = null
  try { activeChatAbort?.() } catch { /* ignore */ }
  activeChatAbort = null
  // 停朗读：她说一半时结束通话，声音必须立刻停（否则用户以为没关掉）
  try { getVoiceTts()?.stop() } catch { /* ignore */ }
  if (wasActive) notice('call-stopped', reason === 'user' ? '语音通话已结束（麦克风与朗读都已释放）' : `语音通话已结束：${reason}`)
  return { stopped: wasActive }
}

/**
 * 打断：立刻停止朗读并回到"听"的状态（**不结束通话**）。
 *
 * 这就是用户要求的"打断"。它与 `stopVoiceCall` 的区别是"继续通话"还是"结束通话" ——
 * 两者都必须是**立刻**生效的（不能让用户等她把话说完）。
 */
export function interruptVoiceCall(): { interrupted: boolean } {
  if (!st.active) return { interrupted: false }
  const wasSpeaking = st.phase === 'speaking'
  interruptRequested = true
  try { activeChatAbort?.() } catch { /* ignore */ }
  activeChatAbort = null
  const stoppedSpeech = (() => {
    try { return getVoiceTts()?.stop() === true } catch { return false }
  })()
  if (wasSpeaking || stoppedSpeech) {
    st.interruptions += 1
    st.phase = 'listening'
    notice('interrupted', '已打断（停止朗读，继续听你说）')
  }
  return { interrupted: wasSpeaking || stoppedSpeech }
}

// ───────────────────────────────────────────────────────── 主循环

async function runLoop(signal: AbortSignal): Promise<void> {
  const s = loadSettings()
  try {
    while (!signal.aborted && st.active) {
      // ── ① 听
      st.phase = 'listening'
      const heard = await ioListenOnce({ timeoutMs: s.voiceListenTimeoutMs })
      if (signal.aborted || !st.active) break

      if (!heard.ok) {
        // 识别本身失败（识别器报错/超时）⇒ 如实记，但**不结束通话**（下一轮再试）
        st.lastError = heard.reason ?? '识别失败'
        notice('error', `这一轮没听清：${st.lastError}`)
        await sleep(600, signal)
        continue
      }
      st.lastHeardChars = heard.text.length

      /**
       * ② 空识别 = 静音那一轮（平台 VAD 判为没人说话）。
       *    这里**明确计数并上报**，因为"没反应"必须有解释 ——
       *    否则用户无法区分"她没听见"与"她坏了"。
       */
      if (heard.text.trim().length === 0) {
        st.silenceTurns += 1
        notice('silence', '这一轮没有听到说话（静音）')
        continue
      }
      notice('heard', `听到一句（${heard.text.length} 字）`)

      // ── ③ 想：交给 LLM（与打字**同一条链路**：人设 + 记忆 + 历史）
      st.phase = 'thinking'
      st.turn += 1
      notice('thinking', `第 ${st.turn} 轮：正在想怎么回答…`)
      const reply = await askModel(heard.text, signal)
      if (signal.aborted || !st.active) break
      if (reply === null) {
        notice('error', '模型没有给出回复（详见错误提示）')
        continue
      }
      if (reply.text.trim().length === 0) {
        notice('error', '模型返回了空回复')
        continue
      }
      st.turnsCompleted += 1

      // ── ④ 说（可被打断）
      st.phase = 'speaking'
      st.lastSpokeChars = reply.text.length
      notice('speaking', `正在说（${reply.text.length} 字）`, reply.text)
      const spoken = await speakReply(reply.text, signal)
      if (signal.aborted || !st.active) break
      if (!spoken) {
        notice('error', '朗读失败（语音合成不可用或未启用）')
      }
      interruptRequested = false
    }
  } catch (e) {
    st.lastError = e instanceof Error ? e.message.slice(0, 200) : String(e)
    notice('error', `通话异常：${st.lastError}`)
  } finally {
    // 循环退出必须把状态清干净（否则界面会显示"通话中"而其实已经结束）
    if (st.active) {
      st.active = false
      st.phase = 'idle'
      notice('call-stopped', '通话循环已退出')
    }
  }
}

/**
 * 问模型（与打字链路完全一致：人设 + 记忆注入 + 历史）。
 *
 * ⚠ **必须走同一条链路**：如果语音对话另写一套提示词组装，
 *   那"她"在语音里与打字里会是两个人（人设/记忆/历史都不一致）。
 *   这里刻意复用 `buildPrompt` / `buildMemoryBlock` / `parseReply`。
 */
async function askModel(text: string, signal: AbortSignal): Promise<{ text: string } | null> {
  const provider = activeProvider()
  if (!provider) { st.lastError = '没有可用的供应商'; return null }
  const key = secretStore().get(provider.id)
  if (!key) { st.lastError = `供应商「${provider.label}」没有密钥`; return null }
  const gate = egressAllowed(`${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`)
  if (!gate.ok) { st.lastError = gate.message; return null }

  // 记进历史（与打字一样），这样语音说过的话在聊天记录里也能看到
  appendMessage({ id: nextMessageId('vu'), role: 'user', text, createdAt: Date.now(), commands: [], origin: 'user' })
  const mem = buildMemoryBlock(text, 5, 800)
  const messages = buildPrompt(text, {
    ...(mem.block ? { extraSystem: mem.block } : {}),
    historyLimit: loadSettings().chatHistoryLimit,
  })

  return await new Promise<{ text: string } | null>((resolve) => {
    let full = ''
    let settled = false
    const done = (v: { text: string } | null): void => {
      if (settled) return
      settled = true
      activeChatAbort = null
      resolve(v)
    }
    const h = startChat({ provider, apiKey: key, messages }, {
      onDelta: (e) => { full += e.delta },
      onDone: (d) => {
        const parsed = parseReply(d.text)
        appendMessage({
          id: nextMessageId('va'), role: 'assistant', text: parsed.displayText, createdAt: Date.now(),
          commands: [], origin: 'user',
        })
        done({ text: parsed.displayText })
      },
      onError: (e) => {
        st.lastError = `${e.code}: ${e.message}`.slice(0, 200)
        done(null)
      },
    })
    activeChatAbort = () => { try { h.abort() } catch { /* ignore */ } }
    if (signal.aborted) { try { h.abort() } catch { /* ignore */ } }
  })
}

/**
 * 朗读回复（受 `ttsEnabled` 控制；未启用时如实返回 false 而不是假装说了）。
 *
 * ★ 2026-10-06（A4）：加了**边听边说**的打断。
 *
 *   为什么这是闭环里最值钱的一块：原来的"打断"只能靠用户点按钮，而真实对话里
 *   人是在**对方还在说的时候开口**的。没有它，"打断"就只是界面上一个按钮，
 *   不是对话能力（用户的原始要求是"语音通话支持 VAD、打断、连续对话"）。
 *
 * ⚠ **默认关闭**，理由是一个真实的声学风险：她说话时麦克风是开着的，
 *   扬声器的声音**可能被自己的麦克风收进去** ⇒ 自触发打断（她把自己的话当成用户在打断）。
 *   这个风险与设备/音量/回声消除有关，**无法在代码里保证不发生**，
 *   所以它由用户显式打开（`settings.voiceBargeIn`），而不是替用户默认开。
 *   打开后由 `listenOnce` 的置信度与静音断句兜一部分，但**不保证**。
 */
async function speakReply(text: string, signal: AbortSignal): Promise<boolean> {
  const s = loadSettings()
  if (!s.ttsEnabled) return false
  const tts = getVoiceTts()
  if (!tts) return false
  try {
    /**
     * 朗读期间并发开一个"听"。三种结局：
     *   · 听到有人说话 ⇒ 立刻打断（含 `tts.stop()`），本次朗读算"被打断"而非失败；
     *   · 朗读先结束   ⇒ 用 abort 让那个"听"尽快退出（不让它挂满整个 timeout）；
     *   · 通话被结束   ⇒ 外层 signal 一起 abort。
     *
     * ⚠ 这里的 abort 只影响**本函数自己起的那个** `listenOnce`，
     *   不会杀掉通话循环后续要用的识别（每次 `listenOnce` 都是独立子进程）。
     */
    const speakAbort = new AbortController()
    const onOuterAbort = (): void => { try { speakAbort.abort() } catch { /* ignore */ } }
    signal.addEventListener('abort', onOuterAbort, { once: true })

    const bargeInEnabled = s.voiceBargeIn === true
    const listener = bargeInEnabled
      ? (async (): Promise<boolean> => {
        const heard = await ioListenOnce({ timeoutMs: 8000, signal: speakAbort.signal })
        if (speakAbort.signal.aborted) return false
        return heard.ok && heard.text.trim().length > 0
      })()
      : null

    let interruptedByVoice = false
    const speakPromise = tts.speak(text, `call-${Date.now().toString(36)}`, { voice: s.ttsVoice ?? null, output: 'device' })
      .then((r) => ({ ok: r.ok === true && (r as { completed?: boolean }).completed === true, interrupted: false }))
      .catch((e) => {
        st.lastError = e instanceof Error ? e.message.slice(0, 200) : String(e)
        return { ok: false, interrupted: false }
      })

    /**
     * ⚠ 判据是"谁先完成"，所以用 `Promise.race` 而不是 await 完再判 ——
     *   否则"听到用户开口"这件事要等她把话**说完**才被处理，那就不是打断了。
     */
    const result = listener
      ? await Promise.race([
        speakPromise,
        listener.then((heardVoice) => ({ ok: true, interrupted: heardVoice })),
      ])
      : await speakPromise

    if (result.interrupted) {
      interruptedByVoice = true
      st.interruptions += 1
      st.bargeInInterruptions += 1
      try { tts.stop() } catch { /* ignore */ }
      notice('barge-in', '听到你开口，已停止朗读')
    }

    // 收拾残局：abort 掉并发的"听"，并摘掉外层监听（避免长命回调）
    try { speakAbort.abort() } catch { /* ignore */ }
    signal.removeEventListener('abort', onOuterAbort)
    /**
     * ⚠ 收尾**必须响应 abort**（本轮实测踩到的一个真缺陷）：
     *
     *   原来写的是 `if (listener) { await listener }` —— 无条件等它自己结束。
     *   于是"朗读先结束"这条**最常见**的路径上，函数会**一直挂到识别超时**才返回：
     *   单测里表现为整个测试套件卡死（`node --test` 默认**无超时** ⇒ 永久挂住）；
     *   生产里表现为"回复已经念完了，但通话循环还以为在说话"，白等最多 8 秒。
     *
     *   现在改成 abort 感知的等待：abort 一发生就立刻返回，不等那个 promise
     *   （它的 rejection 由 `.catch(() => {})` 兜住，不会变成 unhandled rejection）。
     */
    if (listener) { await settleWithin(listener, speakAbort.signal) }
    if (interruptedByVoice) { st.lastError = null; return true }

    if (!result.ok) return false
    return true
  } catch (e) {
    st.lastError = e instanceof Error ? e.message.slice(0, 200) : String(e)
    return false
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
    signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })
}

/**
 * 等一个 promise，但 **signal abort 时立刻返回**（不等它自己结束）。
 *
 * 为什么要单独一个函数（而不是 `await p`）：`await p` 会把调用方**绑死在 p 的时长上**，
 * 哪怕它已经不再需要那个结果了。本项目已经因此吃过一次亏
 * （朗读结束后还白等识别超时 ⇒ 测试套件挂死、生产里循环空转）。
 * 这里把"我不再需要这个结果了"变成一次真正的提前返回。
 *
 * ⚠ p 的失败必须在这里被**吃掉**：否则提前返回之后它会变成 unhandled rejection。
 */
function settleWithin<T>(p: Promise<T>, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false
    const finish = (): void => { if (!done) { done = true; resolve() } }
    p.then(finish, finish)
    if (signal.aborted) { finish(); return }
    signal.addEventListener('abort', finish, { once: true })
  })
}

/**
 * 把"识别文本 → 处理"的外部订阅也接上（`voice-engine.onRecognizedText`）。
 *
 * ★★ 2026-10-06（用户裁定 A4「做闭环」）——**这个函数曾经是假的**：
 *
 *   原实现是：
 *     ```ts
 *     export function bindRecognizedTextSink(fn: (...) => void): void {
 *       fn            // ← 只是"求值一下参数"，没有任何订阅、没有任何保存
 *     }
 *     ```
 *   它**名字在说"绑定"、函数体什么都没绑**，而且全仓零调用者 ⇒
 *   `voice-engine.onRecognizedText()` 那条通路**始终是死的**。
 *   这比"没写"更坏：读代码的人会以为它已经接好了。
 *   （教训：一个叫 `bind*` 却只求值参数的函数，是**伪装的空实现**。）
 *
 * 现在的做法：**真的订阅** `voice-engine` 的 `textHandler`，并接上唤醒监听与打断。
 * 方向是 `voice-call → voice-engine` 单向（本文件本来就 import 了
 * `listenOnce` / `getVoiceTts`），所以不构成环。
 */
export function installVoiceCallBridge(): void {
  /**
   * ⚠ 「线接上了」与「线上跑过东西」是**两件事**，必须分开报：
   *   `bridgeInstalled` 在**订阅那一刻**置真；
   *   `recognizedCount` 才是"收到过多少次识别"。
   *   混成一个字段的后果：一条接好但还没人说话的线，看起来像"没接"。
   */
  bridgeInstalled = true
  onRecognizedText((text, isWake) => {
    st.recognizedCount += 1
    st.lastRecognizedChars = text.length
    st.lastWasWake = isWake
    /**
     * ⚠ 这里**不做对话处理**（处理在 `runLoop` 里，它自己持有 `listenOnce` 的结果）。
     *   本订阅者的职责只有两件：
     *     ① 让"识别到文本"有一个**明确的消费者**（避免再次出现"没人接的线"）；
     *     ② 在**待机监听**期间把唤醒词变成"开始通话"的动作。
     *   重复处理会造成同一句话被回答两次。
     */
    if (isWake && wakeWatchActive && !st.active) {
      /**
       * ★ 2026-10-06（本轮「桌宠对话框 + 语音说话」）：唤醒词的第一动作改成
       *   **打开对话框并进入「听」状态**（规格 §二.4）。
       *
       * 为什么优先级这样排：
       *   · 用户说唤醒词的意图是"我要跟她说话"，而现在的对话界面是**对话框**；
       *     只起一个后台通话循环、界面上什么都不出现，等于把对话藏起来了；
       *   · "听"这一步**不在这里开麦克风** —— 它只是发一条
       *     `evt:conversation-listen`，由 renderer 的对话坞去调**已有的**
       *     `voice:listen-once`（规格 §五：不许新建第二条语音链路、不许加第二个麦克风监听）。
       *
       * ⚠ 打开对话失败时**回退**到原来的全链路通话（`startVoiceCall()`）：
       *   那条路径是 2026-10-06 A4 裁定"做闭环"的成果，不能因为新入口而丢掉。
       *   两条分支**都只有一个麦克风消费者**，不存在抢麦。
       */
      const opened = openConversationForWake()
      if (opened.ok) {
        notice('wake-activated', '听到唤醒词，已打开对话框并进入「听」状态')
      } else {
        const r = startVoiceCall()
        notice('wake-activated', r.ok
          ? `听到唤醒词，已开始语音对话（对话框未能打开：${opened.reason ?? '未知原因'}）`
          : `听到唤醒词，但无法开始对话：${r.reason ?? '未知原因'}`)
      }
    }
  })
}

/**
 * 唤醒词 → 打开对话（并请求 renderer 进入"听"状态）。
 *
 * 单独包一层的原因：调用方要的是"打开 + 请求 listen"这**一个**动作与一个可判定的成败，
 * 而 `openConversation('wake', true)` 在窗口恰好处于拖拽态时会**结构化拒绝**
 * （尺寸不能变）—— 那时必须回退到全链路通话，而不是装作打开成功。
 *
 * 依赖方向：`voice-call → conversation → window-manager`，单向，不构成环。
 *
 * ⚠ 它是**可注入**的（`__setConversationOpenerForTest`），理由与 `__setVoiceIoForTest` 相同：
 *   "打开失败 ⇒ 回退到通话"这条分支在无窗口的单测环境里**走不到**（panel 分支永远成功），
 *   没有注入点就只能靠人工拔电源式地造条件 —— 那等于这条分支永远不被验证。
 */
type ConversationOpener = () => { ok: boolean, reason: string | null }

const defaultConversationOpener: ConversationOpener = () => {
  try {
    const r = openConversation('wake', true)
    return { ok: r.ok, reason: r.refusedReason }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

let conversationOpener: ConversationOpener = defaultConversationOpener

function openConversationForWake(): { ok: boolean, reason: string | null } {
  return conversationOpener()
}

// ───────────────────────────────────────────────────────── 待机听唤醒

/**
 * 待机监听：**只有它能让"说唤醒词就开始对话"成立**。
 *
 * 为什么单独一个循环而不是复用通话循环：通话循环的第一件事就是"把听到的话交给模型"，
 * 而待机期间听到的话**不该**被当成对话内容（用户可能只是在跟别人说话）。
 * 两者混在一起 = 隐私事故。
 *
 * 硬约束（三条，缺一个都变成"后台偷听"）：
 *   ① 必须 `settings.hearingEnabled`（语音识别总开关，默认 **false**）；
 *   ② 必须 `settings.wakeWordEnabled`（默认 **false**，由用户显式打开）；
 *   ③ 只能在 `stopWakeWatch()` / 通话开始 / 应用退出时立刻停 —— 不留常驻子进程。
 */
let wakeWatchActive = false
let wakeWatchAbort: AbortController | null = null
/** `voice-engine.onRecognizedText` 是否真的被订阅过（用于证明"那条线有人接"） */
let bridgeInstalled = false

export function startWakeWatch(): { ok: boolean, reason: string | null } {
  if (wakeWatchActive) return { ok: false, reason: '待机监听已经在运行' }
  const s = loadSettings()
  if (!s.hearingEnabled) return { ok: false, reason: '语音识别未启用（设置 → 语音里显式开启）' }
  if (!s.wakeWordEnabled) return { ok: false, reason: '语音唤醒未启用（默认关闭；需在设置里显式打开）' }
  wakeWatchActive = true
  wakeWatchAbort = new AbortController()
  st.wakeWatchRunning = true
  notice('wake-watch-started', '待机监听已开始（只等唤醒词，听到的其它内容不会被处理）')
  void runWakeWatch(wakeWatchAbort.signal)
  return { ok: true, reason: null }
}

export function stopWakeWatch(reason = 'user'): { stopped: boolean } {
  const was = wakeWatchActive
  wakeWatchActive = false
  st.wakeWatchRunning = false
  try { wakeWatchAbort?.abort() } catch { /* ignore */ }
  wakeWatchAbort = null
  if (was) notice('wake-watch-stopped', reason === 'user' ? '待机监听已停止（麦克风已释放）' : `待机监听已停止：${reason}`)
  return { stopped: was }
}

/**
 * ★ 把"待机监听该不该在跑"与**当前设置**对齐（2026-10-06，A4）。
 *
 * 为什么需要它而不是让调用方自己判断：判断条件有**两条**（`hearingEnabled` +
 *   `wakeWordEnabled`），散落在多个调用点（启动时、设置变更时）必然会漂移 ——
 *   而漂移的后果是"麦克风开着但用户以为关了"（或反过来）。
 *   集中成一个幂等函数，调用方只说"现在对齐一下"，不重复判断条件。
 *
 * ⚠ 通话进行中**不启动**待机监听（两个循环抢麦克风，见 `runWakeWatch` 的注释）；
 *   通话结束后由下一次 reconcile（或用户显式打开）再拉起。
 */
export function reconcileWakeWatch(): { shouldRun: boolean, running: boolean, reason: string | null } {
  const s = loadSettings()
  const shouldRun = s.hearingEnabled === true && s.wakeWordEnabled === true
  if (!shouldRun) {
    stopWakeWatch('settings-off')
    return { shouldRun: false, running: false, reason: '语音识别或唤醒未启用（两者都开才会待机监听）' }
  }
  if (st.active) return { shouldRun: true, running: false, reason: '通话进行中，待机监听让出麦克风' }
  if (wakeWatchActive) return { shouldRun: true, running: true, reason: null }
  const r = startWakeWatch()
  return { shouldRun: true, running: r.ok, reason: r.reason }
}

async function runWakeWatch(signal: AbortSignal): Promise<void> {
  try {
    while (!signal.aborted && wakeWatchActive) {
      /**
       * ⚠ 通话一旦开始，待机监听**必须让出麦克风** ——
       *   两个循环同时 `listenOnce` 会各起一个识别子进程抢同一个输入设备。
       *   `installVoiceCallBridge` 里也是靠 `!st.active` 这条守卫避免重复开始通话。
       */
      if (st.active) { await sleep(500, signal); continue }
      const heard = await ioListenOnce({ timeoutMs: loadSettings().voiceListenTimeoutMs })
      if (signal.aborted || !wakeWatchActive) break
      if (!heard.ok) { await sleep(400, signal); continue }
      // 唤醒的**动作**在 `installVoiceCallBridge` 的订阅里做（那里能拿到 isWake）；
      // 这里只负责"持续地听"。听到的非唤醒内容**丢弃**，不入历史、不进日志正文。
      if (!heard.isWake && heard.text.trim().length > 0) {
        notice('wake-watch-ignored', '待机期间听到一句非唤醒内容（已丢弃，未交给模型）')
      }
    }
  } catch (e) {
    st.lastError = e instanceof Error ? e.message.slice(0, 200) : String(e)
    notice('error', `待机监听异常：${st.lastError}`)
  } finally {
    if (wakeWatchActive) {
      wakeWatchActive = false
      st.wakeWatchRunning = false
      notice('wake-watch-stopped', '待机监听循环已退出')
    }
  }
}

/** 供人设/提示词使用的轻量自检：链路所需的前置条件（给 UI 显示"为什么不能通话"） */
export function voiceCallPreflight(): { ready: boolean, reasons: string[] } {
  const s = loadSettings()
  const reasons: string[] = []
  if (!s.hearingEnabled) reasons.push('语音识别未启用')
  if (!s.ttsEnabled) reasons.push('TTS 朗读未启用（她将只说文字不出声）')
  if (!activeProvider()) reasons.push('未配置供应商')
  // TTS 未启用不算"不能通话"，只是没声音 ⇒ 只有前两条里第一条与供应商是硬条件
  const hard = reasons.filter(r => r !== 'TTS 朗读未启用（她将只说文字不出声）')
  return { ready: hard.length === 0, reasons }
}

/** 闭环的**可机械验证**读数（给探针与 UI；**不含任何正文**） */
export function voiceClosedLoopStatus(): {
  bridgeInstalled: boolean
  wakeWatchRunning: boolean
  bargeInEnabled: boolean
  recognizedCount: number
  bargeInInterruptions: number
  /** 闭环四段是否都具备"能跑"的条件（**不等于"跑过了"**） */
  stages: { listen: boolean, think: boolean, speak: boolean, activate: boolean }
} {
  const s = loadSettings()
  return {
    bridgeInstalled,
    wakeWatchRunning: st.wakeWatchRunning,
    bargeInEnabled: s.voiceBargeIn === true,
    recognizedCount: st.recognizedCount,
    bargeInInterruptions: st.bargeInInterruptions,
    stages: {
      listen: s.hearingEnabled,
      /** "想"这一段要求有供应商 + 密钥（否则链路会在第三步断掉） */
      think: activeProvider() !== null,
      speak: s.ttsEnabled,
      /** "能开始"= 唤醒词与识别都开着（否则只能靠界面按钮开始） */
      activate: s.hearingEnabled && s.wakeWordEnabled,
    },
  }
}

/**
 * 仅供单测：替换/还原语音 IO。
 *
 * 名字里带 `ForTest` 是刻意的 —— 它是最容易被误用到生产路径的入口，
 * 所以要让它在 code review 里一眼可见。传 `null` 还原成真实实现。
 */
export function __setVoiceIoForTest(io: { listenOnce?: VoiceIo['listenOnce'] } | null): void {  ioListenOnce = io?.listenOnce ?? ((o) => listenOnce(o))
}

/**
 * 仅供单测：替换"唤醒后打开对话"这一步（传 `null` 还原成真实实现）。
 *
 * 为什么需要它：本轮的规格把唤醒词的第一动作改成"打开对话框并进入听状态"，
 * 而"打开失败就回退到全链路通话"这条分支在无窗口的单测环境里**不可达**
 * （panel 分支永远成功）。没有注入点，那条回退分支就只能靠读代码相信它存在 ——
 * 这正是本项目反复强调要避免的"未验证分支"。
 */
export function __setConversationOpenerForTest(fn: (() => { ok: boolean, reason: string | null }) | null): void {
  conversationOpener = fn ?? defaultConversationOpener
}
/** 仅供单测：还原全部内部状态（避免用例之间互相污染） */
export function __resetVoiceCallForTest(): void {
  stopVoiceCall('test-reset')
  stopWakeWatch('test-reset')
  __setVoiceIoForTest(null)
  __setConversationOpenerForTest(null)
  st.active = false
  st.phase = 'idle'
  st.turn = 0
  st.turnsCompleted = 0
  st.lastHeardChars = null
  st.lastSpokeChars = null
  st.interruptions = 0
  st.silenceTurns = 0
  st.lastError = null
  st.startedAt = null
  st.wakeWatchRunning = false
  st.lastRecognizedChars = null
  st.lastWasWake = null
  st.recognizedCount = 0
  st.bargeInInterruptions = 0
}

export { getPersona }
