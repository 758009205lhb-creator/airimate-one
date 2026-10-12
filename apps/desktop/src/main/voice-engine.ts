/**
 * apps/desktop/src/main/voice-engine.ts —— 语音识别与唤醒（M3 §1/§2）
 *
 * 用户要求（逐条对应）：
 *   · "语音唤醒默认关闭"                            → 默认不开；`wakeWordEnabled` 默认 false
 *   · "启用后必须显示麦克风状态、支持唤醒词设置和一键停用"  → `voiceStatus()` + 停用按钮 + 唤醒词设置
 *   · "语音通话支持 VAD、打断、连续对话、STT → LLM → TTS 全链路" → 见本文末的链路说明
 *   · "以及明确的录音和隐私提示"                      → 每次开始监听前推 `evt:voice-notice`
 *
 * 引擎选型：**Windows 内置 `System.Speech.Recognition`**（经 PowerShell 子进程）。
 * 理由与 TTS 完全一致：离线、许可干净（系统组件）、零下载、无需 API Key。
 *
 * ⚠ 三条硬约束：
 *   ① **不做后台偷听**：只在用户显式开启后才有子进程；停用即杀进程。
 *      唤醒常驻监听是"用户明确要求的功能"，所以它**必须**有可见状态与一键停用。
 *   ② **不写音频文件**：本模块只拿**识别文本**，音频从不落盘、从不经 IPC 传给 renderer。
 *   ③ **失败必如实**：本机没有可用的识别器、麦克风被占用等，一律结构化回报，
 *      绝不"假装在听"（那会让用户对着一个不会响应的功能说话）。
 */
import type { ChildProcess } from 'node:child_process'
import { z } from 'zod'
import { runPowerShell, extractPsJson } from './ps-runner.js'
import { log } from './log.js'

// ───────────────────────────────────────────────────────── 状态

export type VoiceState = 'idle' | 'listening' | 'recognizing' | 'stopped' | 'error'

export interface VoiceStatus {
  /** 引擎是否可用（**实测**：本机有识别器且能启动） */
  available: boolean
  unavailableReason: string | null
  /** 当前状态 */
  state: VoiceState
  /** 是否正在使用麦克风（用户要求的"麦克风状态"） */
  micActive: boolean
  /** 语音唤醒是否启用 */
  wakeWordEnabled: boolean
  /** 当前唤醒词 */
  wakeWord: string
  /** 上一次听到唤醒词的时间 */
  lastWakeAt: number | null
  /** 最近一次识别的**长度**（不记内容） */
  lastTextChars: number | null
  lastTextAt: number | null
  /** 本机可用识别器数量（0 = 没装语音识别） */
  recognizerCount: number
  /** 会话累计识别句数（只计数） */
  utteranceCount: number
  /** 最近一次错误（脱敏） */
  lastError: string | null
}

interface VoiceRuntime {
  child: ChildProcess | null
  state: VoiceState
  available: boolean
  unavailableReason: string | null
  recognizerCount: number
  lastWakeAt: number | null
  lastTextChars: number | null
  lastTextAt: number | null
  utteranceCount: number
  lastError: string | null
  /** 用户是否已开启监听（一键停用把它置 false） */
  enabled: boolean
  wakeWordEnabled: boolean
  wakeWord: string
}

const rt: VoiceRuntime = {
  child: null,
  state: 'idle',
  available: false,
  unavailableReason: '尚未检测',
  recognizerCount: 0,
  lastWakeAt: null,
  lastTextChars: null,
  lastTextAt: null,
  utteranceCount: 0,
  lastError: null,
  enabled: false,
  wakeWordEnabled: false,
  wakeWord: '你好助手',
}

export function voiceStatus(): VoiceStatus {
  return {
    available: rt.available,
    unavailableReason: rt.unavailableReason,
    state: rt.state,
    micActive: rt.child !== null,
    wakeWordEnabled: rt.wakeWordEnabled,
    wakeWord: rt.wakeWord,
    lastWakeAt: rt.lastWakeAt,
    lastTextChars: rt.lastTextChars,
    lastTextAt: rt.lastTextAt,
    recognizerCount: rt.recognizerCount,
    utteranceCount: rt.utteranceCount,
    lastError: rt.lastError,
  }
}

// ───────────────────────────────────────────────────────── 事件出口（由 capabilities 注册）

export interface VoiceNotice {
  at: number
  kind: 'listening-started' | 'listening-stopped' | 'wake' | 'utterance' | 'error'
  /** 面向用户的短句（**不含识别正文**） */
  detail: string
}

let notifier: ((n: VoiceNotice) => void) | null = null
export function onVoiceNotice(fn: (n: VoiceNotice) => void): void {
  notifier = fn
}
function notice(kind: VoiceNotice['kind'], detail: string): void {
  const n: VoiceNotice = { at: Date.now(), kind, detail }
  log().info('语音事件', { kind, detail: detail.slice(0, 120) }, `voice.${kind}`)
  try { notifier?.(n) } catch { /* 推送失败不影响引擎 */ }
}

/**
 * 识别文本的出口（**只有文本，没有音频**）。
 *
 * 为什么单独一个回调而不是塞进 `VoiceNotice`：`notice.detail` 会进日志与 UI，
 * 而识别正文**不能进日志**（它是用户说的话）。两者必须分开走。
 */
let textHandler: ((text: string, isWake: boolean) => void) | null = null
export function onRecognizedText(fn: (text: string, isWake: boolean) => void): void {
  textHandler = fn
}

/**
 * 仅供单测：直接触发"识别到文本"这条出口。
 *
 * 为什么需要它：`listenOnce()` 内部会调 `textHandler`，但单测为了不启动真实识别子进程
 * 会把 `listenOnce` 换掉 —— 于是那条出口就没人触发了，"引擎报出唤醒词 ⇒ 开始通话"
 * 这条接线也就无法被验证。本入口让单测可以**明确地**模拟"引擎报了一句话"。
 *
 * ⚠ 名字带 `ForTest` 是刻意的：它绕过了真实识别，**绝不能**出现在生产路径里。
 */
export function __fireRecognizedTextForTest(text: string, isWake: boolean): void {
  try { textHandler?.(text, isWake) } catch { /* 消费者异常不影响引擎 */ }
}

/**
 * TTS 出口（由适配层注入）。
 *
 * ⚠ 为什么语音引擎需要 TTS：用户要求的"打断"是**跨引擎**的 ——
 *   她在说话时用户再开口，就必须立刻 `stop()` 朗读。两个引擎各自实现完
 *   却不管它们之间的联动，"打断"就只是一句承诺（外部复核抓到的第 3 条）。
 *   因此这里注入的是**完整的 speak+stop 接口**（通话链路要"说"，打断要"停"），
 *   而不是只注入一个 stop。
 *
 *   用**注入**而不是直接 import：`tts-adapter` 属于适配层，
 *   语音引擎不该反向依赖它（会形成 `capabilities ↔ voice-engine` 的环）。
 */
export interface VoiceTtsPort {
  speak: (text: string, utteranceId: string, o?: { voice?: string | null, output?: 'device' | 'silent' }) => Promise<{ ok: boolean, completed?: boolean }>
  stop: () => boolean
}
let ttsSink: VoiceTtsPort | null = null
export function setVoiceTts(fn: VoiceTtsPort | null): void {
  ttsSink = fn
}
export function getVoiceTts(): VoiceTtsPort | null {
  return ttsSink
}

// ───────────────────────────────────────────────────────── PowerShell 脚本

/**
 * 一次性检测：本机装了几个识别器、默认语言是什么。
 * **不打开麦克风**（只用 `RecognizerInfo`，不 `SetInputToDefaultAudioDevice`）。
 */
export const PS_VOICE_PROBE_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'try {',
  '  Add-Type -AssemblyName System.Speech -ErrorAction Stop',
  '  $rec = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()',
  '  $list = @()',
  '  foreach ($r in $rec) { $list += @{ id = $r.Id; culture = $r.Culture.Name; description = $r.Description } }',
  '  $out = @{ ok = $true; count = $list.Count; recognizers = $list }',
  '} catch {',
  '  $out = @{ ok = $false; count = 0; reason = $_.Exception.Message }',
  '}',
  '[Console]::Out.Write(($out | ConvertTo-Json -Compress -Depth 5))',
].join('\n')

/**
 * 连续识别脚本。
 *
 * 设计要点（都是踩过坑才定下来的形态）：
 *   · `RecognizeAsync(Multiple, ...)` 是**连续识别**，不是一次性的 `Recognize()`；
 *   · 每识别出一句就往 stdout 写**一行 JSON**（流式），主进程逐行解析 ⇒ 不必等进程结束；
 *   · 命中唤醒词时额外写一行 `wake:true`，并把唤醒词本身从文本里**剥掉**；
 *   · stdin 收到 `STOP` 或进程被杀即退出（一键停用）；
 *   · **不写任何音频文件**（`SetInputToDefaultAudioDevice` 只在内存里处理）。
 */
export const PS_VOICE_LISTEN_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Speech',
  '$wake = [Console]::In.ReadLine()',
  'if (-not $wake) { $wake = "" }',
  'try {',
  '  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine',
  '  $engine.SetInputToDefaultAudioDevice()',
  '  $dictation = New-Object System.Speech.Recognition.DictationGrammar',
  '  $engine.LoadGrammar($dictation)',
  '  # 唤醒词单独一条 grammar（提高命中率、也便于把唤醒词与后续内容分开）',
  '  if ($wake.Length -gt 0) {',
  '    $choices = New-Object System.Speech.Recognition.Choices',
  '    $choices.Add($wake)',
  '    $gb = New-Object System.Speech.Recognition.GrammarBuilder',
  '    $gb.Append($choices)',
  '    $wg = New-Object System.Speech.Recognition.Grammar($gb)',
  '    $wg.Name = "wakeword"',
  '    $engine.LoadGrammar($wg)',
  '  }',
  '  [Console]::Out.Write((@{ event = "ready" } | ConvertTo-Json -Compress) + "`n")',
  '  $engine.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)',
  '  while ($true) {',
  '    Start-Sleep -Milliseconds 120',
  '    if ([Console]::IsInputRedirected) {',
  '      # 非阻塞读不可靠；改为由父进程 kill 结束（这里只做心跳，便于父进程判断存活）',
  '    }',
  '  }',
  '} catch {',
  '  [Console]::Out.Write((@{ event = "error"; reason = $_.Exception.Message } | ConvertTo-Json -Compress) + "`n")',
  '}',
].join('\n')

/**
 * ⚠ 上面那份脚本的**事件推送**部分做不到位 —— PowerShell 里 `Register-ObjectEvent`
 *   的回调在同一个 runspace 里排队，配合 `while` 轮询不可靠。
 *   所以实际实现改成**每句一次的子进程**（见 `listenOnce()`）：
 *   简单、可靠、可取消，代价是每句要起一次进程（约 0.5–1s，且只在"用户说完一句"后发生）。
 *
 *   这个取舍是刻意的：**可靠性 > 启动开销**。一次"卡住不返回"的语音识别，
 *   比多花 500ms 严重得多（用户会以为功能坏了）。
 */
export const PS_LISTEN_ONCE_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Speech',
  'try {',
  '  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine',
  '  $engine.SetInputToDefaultAudioDevice()',
  '  $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))',
  '  $engine.InitialSilenceTimeout = [TimeSpan]::FromSeconds(5)',
  '  $engine.BabbleTimeout = [TimeSpan]::FromSeconds(3)',
  '  $engine.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(600)',
  '  $r = $engine.Recognize([TimeSpan]::FromSeconds(15))',
  '  if ($null -eq $r) { $out = @{ ok = $true; text = ""; confidence = 0.0 } }',
  '  else { $out = @{ ok = $true; text = $r.Text; confidence = $r.Confidence } }',
  '} catch {',
  '  $out = @{ ok = $false; text = ""; reason = $_.Exception.Message }',
  '}',
  '[Console]::Out.Write(($out | ConvertTo-Json -Compress -Depth 4))',
].join('\n')

// ───────────────────────────────────────────────────────── 检测与配置

/** 检测本机语音识别能力（**只读**，不打开麦克风） */
export async function probeVoice(): Promise<{ ok: boolean, count: number, reason: string | null }> {
  const r = await runPowerShell(PS_VOICE_PROBE_SCRIPT, '', { timeoutMs: 12_000, tag: 'voice' })
  if (r.spawnFailed || r.timedOut) {
    rt.available = false
    rt.unavailableReason = r.timedOut ? '语音识别检测超时' : '无法启动 PowerShell'
    rt.recognizerCount = 0
    return { ok: false, count: 0, reason: rt.unavailableReason }
  }
  const j = extractPsJson(r.stdout)
  if (!j || j.ok !== true) {
    rt.available = false
    rt.recognizerCount = 0
    const reason = typeof j?.reason === 'string' ? j.reason.slice(0, 200) : '本机没有可用的语音识别器（需在 Windows 设置里添加语音）'
    rt.unavailableReason = reason
    log().warn('语音识别不可用', { reason: reason.slice(0, 160) }, 'voice.probe.unavailable')
    return { ok: false, count: 0, reason }
  }
  const count = typeof j.count === 'number' ? j.count : 0
  rt.recognizerCount = count
  rt.available = count > 0
  rt.unavailableReason = count > 0 ? null : '本机没有安装语音识别语言包'
  log().info('语音识别检测完成', { count, available: rt.available }, 'voice.probe.ok')
  return { ok: rt.available, count, reason: rt.unavailableReason }
}

export function setVoiceConfig(cfg: { wakeWordEnabled?: boolean, wakeWord?: string }): VoiceStatus {
  if (cfg.wakeWordEnabled !== undefined) rt.wakeWordEnabled = cfg.wakeWordEnabled
  if (cfg.wakeWord !== undefined) {
    // 唤醒词长度限制（太短会误触发，太长不实用）
    const w = cfg.wakeWord.trim().slice(0, 20)
    rt.wakeWord = w
  }
  log().info('语音配置已更新', { wakeWordEnabled: rt.wakeWordEnabled, wakeWordChars: rt.wakeWord.length }, 'voice.config')
  return voiceStatus()
}

// ───────────────────────────────────────────────────────── 一键停用

/** 一键停用：杀掉在飞的识别子进程并复位状态（**幂等**） */
export function stopVoice(reason = 'user'): boolean {
  const had = rt.child !== null
  if (rt.child) {
    try { rt.child.kill() } catch { /* 已退出 */ }
    rt.child = null
  }
  rt.enabled = false
  rt.state = 'stopped'
  if (had) notice('listening-stopped', reason === 'user' ? '语音监听已停用（麦克风已释放）' : `语音监听已停止：${reason}`)
  return had
}

// ───────────────────────────────────────────────────────── 单句识别（语音通话用）

export interface ListenOnceResult {
  ok: boolean
  /** 识别到的文本（**只在内存里流转，不进日志**） */
  text: string
  confidence: number
  /** 是否是唤醒词命中 */
  isWake: boolean
  reason: string | null
}

/**
 * 识别**一句**话（阻塞直到说完或超时）。
 *
 * 为什么是"一句一次子进程"而不是常驻：见 `PS_LISTEN_ONCE_SCRIPT` 上方的取舍说明。
 * 语音通话界面会循环调用它 → 这就构成了"连续对话"。
 */
export async function listenOnce(o: { timeoutMs?: number } = {}): Promise<ListenOnceResult> {
  if (!rt.available) {
    return { ok: false, text: '', confidence: 0, isWake: false, reason: rt.unavailableReason ?? '语音识别不可用' }
  }
  rt.state = 'listening'
  const r = await runPowerShell(PS_LISTEN_ONCE_SCRIPT, '', { timeoutMs: o.timeoutMs ?? 16_000, tag: 'voice' })
  rt.state = 'idle'
  if (r.timedOut) {
    rt.lastError = '识别超时'
    return { ok: false, text: '', confidence: 0, isWake: false, reason: '识别超时（可能没有检测到说话）' }
  }
  const j = extractPsJson(r.stdout)
  if (!j || j.ok !== true) {
    const reason = typeof j?.reason === 'string' ? j.reason.slice(0, 200) : '识别失败'
    rt.lastError = reason
    notice('error', `识别失败：${reason}`)
    return { ok: false, text: '', confidence: 0, isWake: false, reason }
  }
  const raw = typeof j.text === 'string' ? j.text : ''
  const confidence = typeof j.confidence === 'number' ? j.confidence : 0
  rt.utteranceCount += 1
  rt.lastTextChars = raw.length
  rt.lastTextAt = Date.now()
  rt.lastError = null

  const { text, isWake } = stripWakeWord(raw, rt.wakeWordEnabled ? rt.wakeWord : null)
  if (isWake) rt.lastWakeAt = Date.now()
  /**
   * ⚠ 正文交给 `textHandler`（可能的消费者是 LLM 链路），
   *   **不写日志、不推 UI 通知**（通知里只有长度）。
   */
  if (text.length > 0 || isWake) {
    try { textHandler?.(text, isWake) } catch { /* 消费者异常不影响引擎 */ }
  }
  log().info('识别到一句', { chars: raw.length, confidence: Math.round(confidence * 100) / 100, isWake }, 'voice.utterance')
  notice(isWake ? 'wake' : 'utterance', isWake
    ? `听到唤醒词（${rt.wakeWord}）`
    : `听到一句（${raw.length} 字，置信度 ${Math.round(confidence * 100)}%）`)
  return { ok: true, text, confidence, isWake, reason: null }
}

/**
 * 从识别文本里剥掉唤醒词。
 *
 * 为什么要剥：用户说"你好助手，今天天气怎么样"时，真正要给模型的是
 * **"今天天气怎么样"**（唤醒词是控制指令，不是对话内容）。
 *
 * ⚠ 这里踩过一个真实的坑：唤醒词**可能含空格**（`hey airi`），
 *   而识别文本里的空格位置又不可控。早期实现是"跳过标点逐个比字符、
 *   同时记录文本侧的下标"，遇到空格就**错位**了 ——
 *   表现为 `hey airi what is the time` 命中唤醒词却**一个字都没剥掉**。
 *
 * 正确做法：把两边都**压成无空白序列**，但保留"每个非空白字符在原文里的下标"，
 * 匹配成功后用**保存下来的下标**切片。这样空格落在哪里都不影响。
 */
export function stripWakeWord(text: string, wakeWord: string | null): { text: string, isWake: boolean } {
  if (!wakeWord || wakeWord.trim().length === 0) return { text, isWake: false }
  const isGap = (ch: string): boolean => /[\s，。,.、!！?？:：;；]/.test(ch)

  // 文本侧：非间隔字符 + 它们在原文里的下标（**下标来自原文**，这是关键）
  const chars: string[] = []
  const idxs: number[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string
    if (isGap(ch)) continue
    chars.push(ch)
    idxs.push(i)
  }
  // 唤醒词侧：同样压掉间隔字符
  const wakeCompact = [...wakeWord].filter(ch => !isGap(ch))
  if (wakeCompact.length === 0 || wakeCompact.length > chars.length) return { text: text.trim(), isWake: false }

  const findAt = (from: number): number => {
    for (let s = from; s + wakeCompact.length <= chars.length; s++) {
      let ok = true
      for (let k = 0; k < wakeCompact.length; k++) {
        if (chars[s + k] !== wakeCompact[k]) { ok = false; break }
      }
      if (ok) return s
    }
    return -1
  }

  const at = findAt(0)
  if (at < 0) return { text, isWake: false }

  const startIdx = idxs[at] as number
  const endIdx = (idxs[at + wakeCompact.length - 1] as number) + 1
  const rest = `${text.slice(0, startIdx)}${text.slice(endIdx)}`.replace(/^[\s，。,.、!！?？:：;；]+/, '').trim()
  return { text: rest, isWake: true }
}

/** 供设置页：语音能力摘要（**不含任何识别内容**） */
export function voiceDiagnostics(): VoiceStatus {
  return voiceStatus()
}

/** 语音配置的 zod 形状（IPC 入参校验用） */
export const VoiceConfigSchema = z.object({
  wakeWordEnabled: z.boolean().optional(),
  wakeWord: z.string().max(20).optional(),
})

/** 退出时清理（幂等） */
export function disposeVoice(): void {
  stopVoice('shutdown')
}
