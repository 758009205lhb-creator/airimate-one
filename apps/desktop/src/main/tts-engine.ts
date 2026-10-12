/**
 * apps/desktop/src/main/tts-engine.ts —— 语音合成（TTS）主进程实现
 *
 * 引擎：**Windows 内置 SAPI**（`System.Speech.Synthesis.SpeechSynthesizer`），
 *       经 `powershell.exe -NoProfile -NonInteractive` 子进程调用。
 *       选它的理由：离线、许可干净、零下载、Windows 11 自带（本机实测有 zh-CN 声音）。
 *
 * ── 纪律（PRD/Tech-Spec §7，逐条对应）─────────────────────────────────
 *   ① **正文绝不进命令行**：命令行对其他进程可见、会被日志采集。
 *      正文只经子进程 **stdin** 传递；需要落盘的场景也只写
 *      `appPaths().ttsDir`（受限 userData 目录）下的临时文件，用完即删。
 *   ② **分块**：SAPI 的 `Speak()` 是阻塞的，长文本一次说完既不可中断也不可控。
 *      因此按句子边界切成 ≤120 字的块，逐块合成 ⇒ 取消响应快、长回复不挂管线。
 *   ③ **可取消**：`stop()` 杀掉在飞的子进程，speak promise **必定 settle**
 *      （resolve 成 `{ completed: false, reason: 'cancelled' }`），绝不悬挂。
 *   ④ **可观测**：日志只记 `{ chars, chunks, voice, engine, ms }`，
 *      **永不记正文**（本项目有日志脱敏纪律）。
 *   ⑤ 失败一律返回结构化 Result（`TTS_FAILED`），不跨 IPC 抛异常。
 *
 * ── 为什么本文件不 import electron ────────────────────────────────────
 * 分块 / 声音挑选 / 取消状态机都是**纯逻辑**，必须能被 `node --test` 直接单测
 * （测试用 `Module._load` 打桩 electron，纯逻辑模块不参与打桩最稳）。
 * 需要 electron 的路径推导放在 `paths.ts`，由 `ttsDir()` 惰性引入。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from './log.js'
import { appPaths } from './paths.js'

// ───────────────────────────────────────────────────────── 常量

/** 单块最大字符数（判据：SAPI 阻塞 + 取消响应性） */
export const TTS_MAX_CHUNK_CHARS = 120

/** 正文上限（与 `SpeechCommandSchema.text` 的 20000 对齐，取更严的一侧） */
export const TTS_MAX_TEXT_CHARS = 20_000

export const TTS_ENGINE = 'windows-sapi'

/** 声音名 / id 的最大长度（与 `AppSettingsSchema.ttsVoice` 的 max(64) 对齐） */
export const TTS_MAX_VOICE_CHARS = 64

/** 首选语言（zh-CN 优先；没有中文声音时回退到第一个可用声音） */
export const TTS_PREFERRED_LANG = 'zh-CN'

// ───────────────────────────────────────────────────────── 结果类型

export type TtsFailureCode =
  | 'EMPTY_TEXT'
  | 'TEXT_TOO_LONG'
  | 'NO_VOICE'
  | 'ENGINE_UNAVAILABLE'
  | 'TIMEOUT'
  | 'INTERNAL'

/** 一次朗读的终态。**三态互斥**：完整说完 / 被取消 / 失败。 */
export type TtsSpeakResult =
  | {
    ok: true
    completed: true
    reason: 'completed'
    engine: string
    voice: string
    chars: number
    chunks: number
    durationMs: number
  }
  | {
    ok: true
    completed: false
    reason: 'cancelled'
    engine: string
    voice: string
    chars: number
    chunks: number
    /** 取消前已经说完的块数（可观测"取消多快生效"） */
    spokenChunks: number
    durationMs: number
  }
  | {
    ok: false
    completed: false
    reason: 'failed'
    error: { code: TtsFailureCode, message: string }
    engine: string
    voice: string | null
    chars: number
    chunks: number
    spokenChunks: number
    durationMs: number
  }

// ───────────────────────────────────────────────────────── ① 文本分块

export interface ChunkOptions {
  /** 单块上限（字符）。默认 120。给测试留可注入的口子。 */
  maxChars?: number
}

/**
 * 把文本切成 ≤`maxChars` 的块，**优先在句子边界切**。
 *
 * 契约（单测钉死这三条）：
 *   1. `chunks.join('') === text`（外发正文一字不改：不丢字、不插字）；
 *   2. 每块长度 ≤ `maxChars`；
 *   3. **任何输入都必须终止**——包括 1 万字无标点的字符串（防死循环）。
 *      实现上先按标点/空白切段，再把超长段**硬切**，硬切步长恒为正。
 *   4. 纯空白输入返回 `[]`（没有可读内容，不该产生一次合成）。
 */
export function chunkText(text: string, o: ChunkOptions = {}): string[] {
  const maxChars = Math.max(1, Math.floor(o.maxChars ?? TTS_MAX_CHUNK_CHARS))
  const src = typeof text === 'string' ? text : ''
  if (!src.trim()) return []

  return hardSplit(packSegments(splitSentences(src, maxChars), maxChars), maxChars)
}

/**
 * 按句子边界切段：句末标点（中英）后断开，**标点留在前一段**。
 * 换行（含 `\r\n`）视为强边界。返回的段拼起来必须等于原文。
 */
function splitSentences(text: string, maxChars: number): string[] {
  const out: string[] = []
  let buf = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string
    buf += ch
    // 强边界：句末标点 / 换行 / 分号
    const strong = SENTENCE_END.test(ch) || ch === '\n'
    // 弱边界：子句标点（只在当前缓冲已接近上限时才断，避免把句子切碎）
    const weak = buf.length >= maxChars * 0.6 && CLAUSE_END.test(ch)
    if (strong || weak) {
      out.push(buf)
      buf = ''
    }
  }
  if (buf) out.push(buf)
  return out
}

const SENTENCE_END = /[。！？；!?;…]/
const CLAUSE_END = /[，、,：:]/

/** 贪心装箱：相邻段能塞进一块就合并，减少子进程往返次数。 */
function packSegments(segments: string[], maxChars: number): string[] {
  const out: string[] = []
  let buf = ''
  for (const seg of segments) {
    if (!buf) { buf = seg; continue }
    if (buf.length + seg.length <= maxChars) { buf += seg; continue }
    out.push(buf)
    buf = seg
  }
  if (buf) out.push(buf)
  return out
}

/**
 * 硬切：把仍然超长的段按固定步长切开。
 * ⚠ 步长恒为 `maxChars ≥ 1` ⇒ 循环严格递减 ⇒ **不可能死循环**（判据：1 万字无标点输入）。
 */
function hardSplit(pieces: string[], maxChars: number): string[] {
  const out: string[] = []
  for (const p of pieces) {
    if (p.length <= maxChars) { out.push(p); continue }
    for (let i = 0; i < p.length; i += maxChars) out.push(p.slice(i, i + maxChars))
  }
  return out
}

// ───────────────────────────────────────────────────────── ② 文本安全化

/**
 * 清洗待合成文本。**只删不可合成的字符，不改语义**：
 *   · NUL / C0 控制字符（除 \t）：可能截断子进程或 stdin 解析；
 *   · 孤立 UTF-16 代理项：JSON 序列化会产生 `\udXXX` 非法转义，接进 PowerShell 会解析失败；
 *   · U+2028 / U+2029：在部分解析器里等同换行。
 * 返回清洗后的文本；**空输入返回空串**（调用方按 `EMPTY_TEXT` 处理）。
 */
export function sanitizeForSpeech(text: unknown): string {
  if (typeof text !== 'string') return ''
  const stripped = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\u2028\u2029]/g, ' ')
  let out = ''
  for (let i = 0; i < stripped.length; i++) {
    const c = stripped.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = stripped.charCodeAt(i + 1)
      if (n >= 0xdc00 && n <= 0xdfff) { out += stripped[i] as string; out += stripped[i + 1] as string; i++ }
      // 孤立高位代理项：丢弃
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      // 孤立低位代理项：丢弃
    } else {
      out += stripped[i] as string
    }
  }
  return out
}

/**
 * 构造喂给子进程 stdin 的 JSON 载荷。
 *
 * **安全边界**：这是正文离开主进程的唯一出口，且只走 stdin。
 * 返回 `null` = 载荷不可构造（空文本 / 超长），调用方转成结构化失败。
 * `payload.text` 一定是**已清洗**的：子进程侧 `ConvertFrom-Json` 不会因控制字符失败。
 */
export function buildSpeakPayload(input: {
  text: string
  voice: string | null
  rate?: number
  volume?: number
  /**
   * 输出目标。`device`（默认）= 真的出声；`null` = SAPI 合成但不播放。
   *
   * `null` 的用途：验证**多块顺序合成**这条链时不必强迫使用者听完几十秒音频。
   * 实测差异极大（本机 Huihui，240 字）：
   *   · `device` 67002ms（实时播放）  · `null` 419ms（合成即弃）
   * 因此探针用 `null` 跑多块/取消，用 `device` 跑一次短的真出声 —— 两者都覆盖真实链路。
   */
  output?: 'device' | 'null'
}, maxChars = TTS_MAX_TEXT_CHARS): string | null {
  const text = sanitizeForSpeech(input.text)
  if (!text.trim()) return null
  if (text.length > maxChars) return null
  const rate = clampInt(input.rate ?? 0, -10, 10)
  const volume = clampInt(input.volume ?? 100, 0, 100)
  const output = input.output === 'null' ? 'null' : 'device'
  const voice = typeof input.voice === 'string' && input.voice.length > 0 && input.voice.length <= TTS_MAX_VOICE_CHARS
    ? input.voice
    : null
  // 只暴露子进程真正需要的字段；不塞 utterance id、不塞路径（最小权限）
  return JSON.stringify({ text, voice, rate, volume, output })
}

function clampInt(v: number, lo: number, hi: number): number {
  const n = Math.floor(Number.isFinite(v) ? v : lo)
  return Math.min(hi, Math.max(lo, n))
}

// ───────────────────────────────────────────────────────── ③ 声音挑选

/** 一个可用声音的**公开**投影（`tts:voices` 的出参形状，不含任何本机路径） */
export interface VoiceInfo {
  id: string
  label: string
  lang: string
  /** 'Male' / 'Female' / 'Neutral'；未知为 null */
  gender: string | null
}

/** `GetInstalledVoices()` 的原始行（主进程内部形状） */
export interface InstalledVoice {
  name: string
  culture: string
  gender: string | null
  enabled: boolean
}

/**
 * 挑选要用的声音名。
 *
 * 优先级（单测钉死）：
 *   ① `preferred` 精确命中且启用 → 用它（用户显式选择必须尊重）；
 *   ② 语言等于 `lang`（默认 zh-CN）的第一个启用声音；
 *   ③ 语言**前缀**等于 `lang` 主干的第一个启用声音（容忍 zh-CN/zh-TW 差异）；
 *   ④ 第一个启用声音（兜底，保证"有声音就能出声"）；
 *   ⑤ 全被禁用 → 返回 `null`（调用方报 `NO_VOICE`，**不静默假装成功**）。
 *
 * 若 `preferred` 没命中，**不报错**，按 ②–④ 回退（用户可能在另一台机器上同步了设置）。
 */
export function chooseVoice(voices: InstalledVoice[], preferred?: string | null, lang = TTS_PREFERRED_LANG): string | null {
  if (!Array.isArray(voices) || voices.length === 0) return null
  const usable = voices.filter(v => v && v.enabled && typeof v.name === 'string' && v.name.length > 0)
  if (usable.length === 0) return null

  const want = typeof preferred === 'string' ? preferred.trim() : ''
  if (want) {
    const exact = usable.find(v => v.name === want)
    if (exact) return exact.name
    // 大小写/空白不敏感的第二轮匹配
    const loose = usable.find(v => v.name.toLowerCase() === want.toLowerCase())
    if (loose) return loose.name
  }

  const norm = (c: string): string => (typeof c === 'string' ? c.replace(/_/g, '-').toLowerCase() : '')
  const target = norm(lang)
  const base = target.split('-')[0] ?? ''

  const exactLang = usable.find(v => norm(v.culture) === target)
  if (exactLang) return exactLang.name
  const prefixLang = base ? usable.find(v => norm(v.culture).split('-')[0] === base) : undefined
  if (prefixLang) return prefixLang.name
  return usable[0]?.name ?? null
}

/** 内部形状 → 对外公开形状（**不泄漏 VoiceInfo 里的额外字段**） */
export function toVoiceInfo(v: InstalledVoice): VoiceInfo {
  return {
    id: v.name,
    label: v.culture ? `${v.name} (${v.culture})` : v.name,
    lang: v.culture || 'unknown',
    gender: v.gender ?? null,
  }
}

// ───────────────────────────────────────────────────────── ④ 取消状态机

export type TtsStopReason = 'cancelled' | 'failed' | 'completed'

/**
 * 一次朗读的取消账本。**纯状态机**，单测直接驱动它验证状态迁移。
 *
 * 不变式：
 *   · 终态只能写一次（`completed` / `cancelled` / `failed`）；后到的写入被忽略并返回 false；
 *   · 已到终态后再 `attach()` 的子进程会被**立即杀掉** ⇒ 取消与 spawn 的竞态不会漏杀；
 *   · `detach()` 在子进程 `close` 时清空句柄 ⇒ 不会对已退出进程重复计数 kill。
 */
export class TtsRunState {
  private terminal: TtsStopReason | null = null
  private child: ChildProcess | null = null
  private killed = 0

  readonly startedAt = Date.now()

  /** 登记在飞的子进程；若此刻已是终态，**立即**把它杀掉（取消与 spawn 的竞态） */
  attach(child: ChildProcess): void {
    if (this.terminal !== null) {
      try { if (child.exitCode === null && child.signalCode === null) { child.kill(); this.killed += 1 } } catch { /* ignore */ }
      return
    }
    this.child = child
  }

  /**
   * 注销已退出的子进程。
   * ⚠ 必须在 `close` 时调用：否则后续 `cancel()` 会对着**已退出**的进程句柄
   *   重复计数 kill，让「正常完成时 killCount 应为 0」这条可观测判据失效。
   */
  detach(child: ChildProcess): void {
    if (this.child === child) this.child = null
  }

  /** 是否已被取消（子进程还活着才需要杀） */
  get cancelled(): boolean {
    return this.terminal === 'cancelled'
  }

  get finished(): boolean {
    return this.terminal !== null
  }

  /** 已发生过的 kill 次数（可观测：正常完成应为 0） */
  get killCount(): number {
    return this.killed
  }

  /** 标记取消。返回 true = 本次调用**首次**置位；false = 已是终态（幂等） */
  cancel(): boolean {
    if (this.terminal !== null) return false
    this.terminal = 'cancelled'
    this.killChild()
    return true
  }

  /** 标记正常完成 */
  complete(): boolean {
    if (this.terminal !== null) return false
    this.terminal = 'completed'
    this.child = null
    return true
  }

  /** 标记失败 */
  fail(): boolean {
    if (this.terminal !== null) return false
    this.terminal = 'failed'
    this.killChild()
    return true
  }

  /** 当前终态（null = 仍在飞） */
  get state(): TtsStopReason | null {
    return this.terminal
  }

  get elapsedMs(): number {
    return Date.now() - this.startedAt
  }

  private killChild(): void {
    const c = this.child
    this.child = null
    if (!c) return
    try {
      if (c.exitCode === null && c.signalCode === null) { c.kill(); this.killed += 1 }
    } catch { /* 已退出 / 权限问题：忽略，不能让 kill 失败拖住 stop() */ }
  }
}

// ───────────────────────────────────────────────────────── ⑤ 子进程脚本

/**
 * 跑在 `powershell.exe` 里的脚本。**只经 stdin 拿正文**（`$args` 里没有正文）。
 *
 * 约定：
 *   · 入参（stdin，UTF-8 JSON）：`{ text, voice, rate, volume }`
 *   · 出参（stdout，UTF-8 JSON）：`{ spoken, voice, culture, ms, reason? }`
 *   · 错误一律以 `{ spoken:false, reason:'...' }` + exit 0 返回，
 *     由 Node 侧翻译成结构化失败（**不靠解析 stderr 文案**）。
 *
 * `$ErrorActionPreference='Stop'` + try/catch：PowerShell 的"非终止错误"默认只打红字继续跑，
 * 那样会出现"退出码 0 但其实没出声"的假成功——这里必须把它变成显式失败。
 */
export const PS_SPEAK_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::InputEncoding = [System.Text.Encoding]::UTF8',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'try {',
  '  Add-Type -AssemblyName System.Speech',
  '  $raw = [Console]::In.ReadToEnd()',
  '  $p = $raw | ConvertFrom-Json',
  '  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '  if ($p.voice) { $synth.SelectVoice([string]$p.voice) }',
  '  $synth.Rate = [int]$p.rate',
  '  $synth.Volume = [int]$p.volume',
  // 输出目标：`null` = 只合成不播放（探针验证多块链路时用，不强迫使用者听完整段）
  "  if ($p.output -eq 'null') { $synth.SetOutputToNull() } else { $synth.SetOutputToDefaultAudioDevice() }",
  '  $sw = [System.Diagnostics.Stopwatch]::StartNew()',
  '  $synth.Speak([string]$p.text)',
  '  $sw.Stop()',
  '  $out = [ordered]@{ spoken = $true; voice = $synth.Voice.Name; culture = $synth.Voice.Culture.Name; ms = [int]$sw.ElapsedMilliseconds }',
  '  $synth.Dispose()',
  "  [Console]::Out.Write((ConvertTo-Json -Compress -InputObject $out))",
  '} catch {',
  "  [Console]::Out.Write((ConvertTo-Json -Compress -InputObject ([ordered]@{ spoken = \$false; reason = \$_.Exception.Message })))",
  '}',
].join('; ')

/**
 * 枚举本机声音的脚本。只读，`GetInstalledVoices()` 不解锁音频设备，可随时调用。
 * 出参：`[{ name, culture, gender, enabled }]`
 */
export const PS_VOICES_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'try {',
  '  Add-Type -AssemblyName System.Speech',
  '  $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '  $list = @()',
  '  foreach ($v in $synth.GetInstalledVoices()) {',
  '    $i = $v.VoiceInfo',
  '    $list += [ordered]@{ name = $i.Name; culture = $i.Culture.Name; gender = [string]$i.Gender; enabled = [bool]$v.Enabled }',
  '  }',
  '  $synth.Dispose()',
  '  [Console]::Out.Write((ConvertTo-Json -Compress -InputObject ([ordered]@{ ok = $true; voices = $list })))',
  '} catch {',
  "  [Console]::Out.Write((ConvertTo-Json -Compress -InputObject ([ordered]@{ ok = \$false; reason = \$_.Exception.Message })))",
  '}',
].join('; ')

/** 每块预留的超时（毫秒）——SAPI 是实时的，超时算的是"最坏情况"上界 */
const MS_PER_ITEM = 4000
/** 整体固定开销（PowerShell 冷启动 + Add-Type 加载 System.Speech，本机实测约 0.6s） */
const FIXED_OVERHEAD_MS = 10_000

// ───────────────────────────────────────────────────────── ⑥ PowerShell 调用

function powershellExe(): string {
  return process.env.SystemRoot
    ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : 'powershell.exe'
}

interface PsRunResult {
  stdout: string
  exitCode: number | null
  /** 子进程收到了终止信号（被 kill 或超时） */
  killed: boolean
  /** 命中本侧超时 */
  timedOut: boolean
  /** spawn 本身失败（powershell 不存在等） */
  spawnFailed: boolean
}

/**
 * 把脚本编码成 `-EncodedCommand` 需要的 base64(UTF-16LE)。
 *
 * 为什么不用 `-Command "<脚本>"`：脚本里含引号与 `$_`，要穿过
 * Node 的 argv 转义 → CommandLineToArgvW 解析 → PowerShell 自己的
 * `-Command` 再解析，**三层转义**；任何一层差异都会变成"静默产出错误结果"。
 * `-EncodedCommand` 只有一个不透明 token，彻底绕开转义问题。
 * 正文**不在**这里：脚本是常量，正文永远只走 stdin。
 */
function encodePsCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * 起一个 PowerShell，喂 stdin，收 stdout。
 *
 * ⚠ 正文**只**经 stdin：命令行里只有 `-NoProfile -NonInteractive -EncodedCommand <常量>`,
 *   编码内容是脚本本身、**不含任何用户文本** ⇒ 进程列表/命令行日志里拿不到对话内容。
 */
function runPowerShell(
  script: string,
  stdin: string,
  timeoutMs: number,
  state?: TtsRunState,
): Promise<PsRunResult> {
  return new Promise<PsRunResult>((resolve) => {
    // 超时后 Node 收到 stdout 前可能还有缓冲；统一在 close/error 时结算
    const done = (r: PsRunResult): void => resolve(r)

    let child: ChildProcess
    try {
      child = spawn(powershellExe(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePsCommand(script)], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        // 不传 shell：避免 cmd.exe 二次解析
      })
    } catch (e) {
      log().warn('TTS 子进程启动失败', { err: e instanceof Error ? e.message : String(e) }, 'tts.spawn.failed')
      done({ stdout: '', exitCode: null, killed: false, timedOut: false, spawnFailed: true })
      return
    }

    state?.attach(child)

    let stdout = ''
    let settled = false
    let timedOut = false
    let timer: NodeJS.Timeout | null = null

    const finish = (r: PsRunResult): void => {
      if (settled) return
      settled = true
      if (timer) { clearTimeout(timer); timer = null }
      done(r)
    }

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => { stdout += d })
    // stderr 一律丢弃：可能夹带本机路径；失败原因统一由 stdout 的 JSON 承载
    child.stderr?.on('data', () => { /* 丢弃 */ })

    child.on('error', (e) => {
      log().warn('TTS 子进程 error 事件', { err: e.message }, 'tts.child.error')
      state?.detach(child)
      finish({ stdout, exitCode: null, killed: false, timedOut, spawnFailed: true })
    })
    child.on('close', (code, signal) => {
      state?.detach(child)
      finish({ stdout, exitCode: code, killed: signal !== null, timedOut, spawnFailed: false })
    })

    timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch { /* ignore */ }
      // 兜底：若 close 因故不来，也不能让 promise 悬挂
      finish({ stdout, exitCode: null, killed: true, timedOut: true, spawnFailed: false })
    }, timeoutMs)
    timer.unref?.()

    // 写完 stdin 立刻关闭：子进程的 ReadToEnd() 需要 EOF 才返回
    try {
      child.stdin?.on('error', () => { /* EPIPE：子进程已退出，忽略 */ })
      child.stdin?.end(stdin, 'utf8')
    } catch { /* ignore */ }
  })
}

/**
 * 从子进程 stdout 里取出 JSON 载荷。
 *
 * ⚠ **实测踩到的坑**（不要把这里改回 `lastIndexOf('{')`）：
 *   PowerShell 的输出是**嵌套**的 —— `{"ok":true,"voices":[{"name":…},…]}`。
 *   用"最后一个 `{` 到最后一个 `}`"去切，落到的是**数组里最后一个元素**，
 *   切出 `{"name":"Microsoft Zira Desktop",…}]}` —— 恰好以 `}` 结尾，
 *   于是既不抛错也不报空，只是 `JSON.parse` 报
 *   `Unexpected non-whitespace character after JSON at position 84`，
 *   被 catch 吞掉后表现为"枚举失败（exit=0）"，看起来像 PowerShell 的问题。
 *   ⇒ 必须**按括号深度**扫描，取最后一个**完整**的顶层对象/数组。
 *
 * 容忍前后夹带的噪声行（PowerShell 偶尔把 warning 写进 stdout）。
 */
function parsePsJson(stdout: string): Record<string, unknown> | null {
  const t = stdout.replace(/^\uFEFF/, '')
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  let best: string | null = null

  for (let i = 0; i < t.length; i++) {
    const ch = t[i] as string
    if (inString) {
      // 字符串内的括号不参与计数；`\"` 不算结束
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{' || ch === '[') {
      if (depth === 0) start = i
      depth += 1
      continue
    }
    if (ch === '}' || ch === ']') {
      if (depth > 0) {
        depth -= 1
        if (depth === 0 && start >= 0) best = t.slice(start, i + 1)
      }
    }
  }

  if (best === null) return null
  try {
    const v = JSON.parse(best) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
  } catch { return null }
}

/** 解析子进程 stdout 里的 JSON（子进程可能夹带 BOM/空白/噪声行） */
export function extractPsJson(stdout: string): Record<string, unknown> | null {
  return parsePsJson(stdout)
}

// ───────────────────────────────────────────────────────── ⑦ 临时文件（受限目录）

function ttsDir(): string {
  const dir = appPaths().ttsDir
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 把待合成文本写到 `appPaths().ttsDir` 下的临时文件。
 *
 * **仅作受限落盘通道保留**（例如未来接音频回传时给引擎传文件路径）。
 * 路径由 `appPaths()` 推导，绝不手拼；调用方必须在 finally 里 `removeTempUtterance()`。
 */
export function writeTempUtterance(utteranceId: string, text: string): string {
  const safeId = utteranceId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'utt'
  const file = join(ttsDir(), `${safeId}-${Date.now().toString(36)}.txt`)
  writeFileSync(file, text, 'utf8')
  return file
}

/** 删除临时正文文件（幂等；失败不抛，最多留一个残留文件在受限目录里） */
export function removeTempUtterance(file: string | null): boolean {
  if (!file) return false
  // 安全闸：只允许删除 ttsDir 下的文件（防误删其它路径）
  try {
    const dir = appPaths().ttsDir
    if (!file.startsWith(dir)) {
      log().warn('拒绝删除 ttsDir 之外的文件', { chars: file.length }, 'tts.temp.reject')
      return false
    }
    if (!existsSync(file)) return false
    rmSync(file, { force: true })
    return true
  } catch { return false }
}

// ───────────────────────────────────────────────────────── ⑧ 对外 API

const VOICES_TIMEOUT_MS = 20_000

/**
 * 枚举本机可用声音。失败返回 `[]` + 记一条 warn（**不抛**）。
 * 这是只读探针，不解锁音频设备，因此探针/设置页可以随时调。
 */
export async function listVoices(): Promise<{ ok: boolean, voices: InstalledVoice[], engine: string, error?: string }> {
  const r = await runPowerShell(PS_VOICES_SCRIPT, '', VOICES_TIMEOUT_MS)
  const json = parsePsJson(r.stdout)
  if (!json || json.ok !== true || !Array.isArray(json.voices)) {
    const reason = typeof json?.reason === 'string'
      ? json.reason
      : r.spawnFailed
        ? 'powershell.exe 无法启动'
        : r.timedOut
          ? `声音枚举超时（${VOICES_TIMEOUT_MS}ms）`
          : `PowerShell 未返回可解析结果（exit=${String(r.exitCode)}）`
    log().warn('声音枚举失败', { engine: TTS_ENGINE, err: reason }, 'tts.voices.failed')
    return { ok: false, voices: [], engine: TTS_ENGINE, error: reason }
  }
  const voices = (json.voices as Array<Record<string, unknown>>).map(v => ({
    name: typeof v.name === 'string' ? v.name : '',
    culture: typeof v.culture === 'string' ? v.culture : '',
    gender: typeof v.gender === 'string' ? v.gender : null,
    enabled: v.enabled === true,
  })).filter(v => v.name.length > 0)
  return { ok: true, voices, engine: TTS_ENGINE }
}

export interface TtsSpeakOptions {
  /** 本次调用级的声音覆盖（优先于设置里的偏好） */
  voice?: string | null
  /**
   * 输出目标：默认 `device`（真的出声）。
   * `null` 仅供探针/自检使用（合成但不播放），**不暴露给 renderer**。
   */
  output?: 'device' | 'null'
}

export interface TtsEngine {
  /**
   * 开始朗读。**必定 settle**（完成 / 取消 / 失败），绝不悬挂。
   */
  speak(text: string, utteranceId: string, o?: TtsSpeakOptions): Promise<TtsSpeakResult>
  /** 取消在飞朗读。返回 false = 当时没有在飞任务（幂等，可安全重复调）。 */
  stop(): boolean
  /** 是否正在朗读 */
  readonly speaking: boolean
  /** 当前 utteranceId（无则 null），供 `evt:tts-state` 报送 */
  readonly currentUtteranceId: string | null
}

export interface TtsEngineOptions {
  /** 取当前设置里的偏好声音（每次朗读时调用，改设置立即生效） */
  preferredVoice?: () => string | null
  /**
   * 状态回调（`evt:tts-state` 的唯一真源）。
   * 由引擎在**状态机内部**触发，而不是让调用方自己记账 ——
   * 双份记账在"取消/新朗读交错"时必然漂移，这条链上只允许一个真源。
   */
  onState?: (e: { utteranceId: string, state: 'start' | 'end' | 'error', error?: string }) => void
}

/**
 * 建一个 TTS 引擎实例。
 *
 * ⚠ **单实例语义**：同一时刻只允许一次朗读；新的 `speak()` 会先取消旧的
 *   （否则两个 SAPI 子进程会同时抢音频设备，声音交叠且取消语义混乱）。
 *
 * ⚠ `speak()` **同步**登记本次运行（在第一次 await 之前），
 *   否则 `tts:stop` 可能在"枚举声音"的空档里到达、看到 `null` 而返回
 *   "没有在飞任务"——用户按了停止却停不下来。
 */
export function createTtsEngine(o: TtsEngineOptions = {}): TtsEngine {
  let current: { id: string, state: TtsRunState } | null = null

  const emit = (id: string, state: 'start' | 'end' | 'error', error?: string): void => {
    try { o.onState?.(error === undefined ? { utteranceId: id, state } : { utteranceId: id, state, error }) } catch { /* 回调失败不影响朗读 */ }
  }

  const stop = (): boolean => {
    const c = current
    if (!c) return false
    const first = c.state.cancel()
    if (first) log().info('TTS 取消', { engine: TTS_ENGINE, utteranceId: c.id, ms: c.state.elapsedMs }, 'tts.stop')
    return first
  }

  const speak = (text: string, utteranceId: string, o2: TtsSpeakOptions = {}): Promise<TtsSpeakResult> => {
    const started = Date.now()
    const output: 'device' | 'null' = o2.output === 'null' ? 'null' : 'device'
    // 单实例：先停掉上一次（其终态由它自己的 promise 负责上报，不会发到新 id 上）
    stop()

    const clean = sanitizeForSpeech(text)
    const state = new TtsRunState()
    // ★ 同步登记：此后到达的 tts:stop 一定能看到这次运行
    current = { id: utteranceId, state }
    emit(utteranceId, 'start')

    const base = { engine: TTS_ENGINE, chars: clean.length, chunks: 0, spokenChunks: 0 }

    /** 收尾：清空 current（仅当它还是自己）+ 报终态 */
    const finishWith = (r: TtsSpeakResult): TtsSpeakResult => {
      if (current?.state === state) current = null
      if (r.ok && r.completed) emit(utteranceId, 'end')
      else if (!r.ok) emit(utteranceId, 'error', r.error.message)
      // 取消：不发 error（用户主动停止不是错误），发 end 让 UI 收起"正在说话"
      else emit(utteranceId, 'end')
      return r
    }

    // 入参级失败：同步返回，但仍要在入参校验前登记，保证 stop() 语义一致
    if (!clean.trim()) {
      state.fail()
      return Promise.resolve(finishWith({
        ok: false, completed: false, reason: 'failed', voice: null, durationMs: Date.now() - started, ...base,
        error: { code: 'EMPTY_TEXT', message: '没有可朗读的文本' },
      }))
    }
    if (clean.length > TTS_MAX_TEXT_CHARS) {
      state.fail()
      return Promise.resolve(finishWith({
        ok: false, completed: false, reason: 'failed', voice: null, durationMs: Date.now() - started, ...base,
        error: { code: 'TEXT_TOO_LONG', message: `文本超过上限（${clean.length} > ${TTS_MAX_TEXT_CHARS} 字符）` },
      }))
    }

    const promise = (async (): Promise<TtsSpeakResult> => {
      // ① 解析声音：先枚举，再按 zh-CN 优先 / 用户偏好挑选
      // 本次调用级覆盖 > 设置里的偏好 > zh-CN 优先 > 第一个可用
      const preferred = (typeof o2.voice === 'string' && o2.voice.trim())
        ? o2.voice.trim()
        : (o.preferredVoice?.() ?? null)
      const vres = await listVoices()
      // 枚举期间被取消：如实返回取消，不再白跑一次合成
      if (state.cancelled) {
        return finishWith({
          ok: true, completed: false, reason: 'cancelled', engine: TTS_ENGINE, voice: '',
          chars: clean.length, chunks: 0, spokenChunks: 0, durationMs: Date.now() - started,
        })
      }
      const voice = chooseVoice(vres.voices, preferred)
      if (!voice) {
        const message = vres.ok
          ? '本机没有可用的语音合成声音（GetInstalledVoices 为空或全部被禁用）'
          : `语音引擎不可用：${vres.error ?? '未知原因'}`
        state.fail()
        log().warn('TTS 无可用声音', { engine: TTS_ENGINE, chars: clean.length, voices: vres.voices.length }, 'tts.no-voice')
        return finishWith({
          ok: false, completed: false, reason: 'failed', voice: null, durationMs: Date.now() - started, ...base,
          error: { code: vres.ok ? 'NO_VOICE' : 'ENGINE_UNAVAILABLE', message },
        })
      }

      // ② 分块（句子边界优先）
      const chunks = chunkText(clean)
      const cancelledResult = (spokenChunks: number): TtsSpeakResult => ({
        ok: true, completed: false, reason: 'cancelled', engine: TTS_ENGINE, voice,
        chars: clean.length, chunks: chunks.length, spokenChunks, durationMs: Date.now() - started,
      })
      const failed = (code: TtsFailureCode, message: string, spoken: number): TtsSpeakResult => ({
        ok: false, completed: false, reason: 'failed', voice,
        error: { code, message }, engine: TTS_ENGINE, chars: clean.length,
        chunks: chunks.length, spokenChunks: spoken, durationMs: Date.now() - started,
      })

      try {
        let spokenChunks = 0
        for (const chunk of chunks) {
          if (state.cancelled) break
          const payload = buildSpeakPayload({ text: chunk, voice, output })
          if (!payload) continue   // 该块清洗后为空（纯空白），跳过
          // 超时按"本次实际要说的字符数"给，且**至少**覆盖冷启动开销。
          // `null` 输出不走实时播放，同样的字符数快一两个数量级，超时给同一上界仍然安全。
          const timeoutMs = FIXED_OVERHEAD_MS + (chunk.length * MS_PER_ITEM) / 10
          const chunkStartedAt = Date.now()
          const r = await runPowerShell(PS_SPEAK_SCRIPT, payload, timeoutMs, state)
          if (state.cancelled) break
          if (r.timedOut) {
            state.fail()
            log().warn('TTS 单块超时', { engine: TTS_ENGINE, voice, chars: chunk.length, ms: timeoutMs }, 'tts.speak.timeout')
            return finishWith(failed('TIMEOUT', `单块合成超时（${Math.round(timeoutMs)}ms，${chunk.length} 字符）`, spokenChunks))
          }
          const json = parsePsJson(r.stdout)
          if (!json || json.spoken !== true) {
            const reason = typeof json?.reason === 'string'
              ? json.reason
              : r.spawnFailed
                ? 'powershell.exe 无法启动'
                : `SAPI 未确认朗读（exit=${String(r.exitCode)}）`
            state.fail()
            log().warn('TTS 合成失败', { engine: TTS_ENGINE, voice, chars: chunk.length, err: reason.slice(0, 200) }, 'tts.speak.failed')
            return finishWith(failed(r.spawnFailed ? 'ENGINE_UNAVAILABLE' : 'INTERNAL', reason.slice(0, 300), spokenChunks))
          }
          spokenChunks += 1
          /**
           * 逐块可观测（**只记长度与耗时，不记正文**）。
           * 为什么值得记：出现"听着像漏字/顺序不对"时，唯一能定位的就是"第几块、多长、花了多久"。
           */
          log().debug('TTS 单块完成', {
            engine: TTS_ENGINE, voice, index: spokenChunks, of: chunks.length,
            chars: chunk.length, ms: Date.now() - chunkStartedAt, output,
          }, 'tts.chunk.done')
        }

        if (state.cancelled || !state.complete()) {
          // 被取消：**resolve**（不是 reject）——上层拿到结构化终态，promise 不悬挂
          const r = cancelledResult(spokenChunks)
          log().info('TTS 已取消', {
            engine: TTS_ENGINE, voice, chars: clean.length,
            chunks: chunks.length, spokenChunks, ms: r.durationMs,
          }, 'tts.cancelled')
          return finishWith(r)
        }

        const durationMs = Date.now() - started
        // ★ 隐私：只记长度/声音/引擎/耗时，**正文永不进日志**
        log().info('TTS 朗读完成', {
          engine: TTS_ENGINE, voice, chars: clean.length, chunks: chunks.length, ms: durationMs,
        }, 'tts.done')
        return finishWith({
          ok: true, completed: true, reason: 'completed',
          engine: TTS_ENGINE, voice, chars: clean.length, chunks: chunks.length, durationMs,
        })
      } catch (e) {
        // 兜底：任何未预期异常都必须变成结构化失败，绝不让 IPC promise 悬挂
        state.fail()
        const msg = e instanceof Error ? e.message : String(e)
        log().error('TTS 未预期异常', { engine: TTS_ENGINE, err: msg.slice(0, 200) }, 'tts.speak.threw')
        return finishWith(failed('INTERNAL', msg.slice(0, 300), 0))
      }
    })()

    return promise
  }

  return {
    speak,
    stop,
    get speaking(): boolean { return current !== null && !current.state.finished },
    get currentUtteranceId(): string | null { return current?.id ?? null },
  }
}

// ───────────────────────────────────────────────────────── ⑨ 供测试/探针的纯函数出口

/**
 * 给探针用的"只测链路不测音频"口径：跑一次真实 SAPI 但用**最短**文本，
 * 返回可观测字段。探针据此判定 pass/fail。
 */
export const TTS_PROBE_TEXT = '语音自检。'
