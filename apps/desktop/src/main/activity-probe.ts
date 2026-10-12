/**
 * apps/desktop/src/main/activity-probe.ts —— 活动/阻断状态采样（主进程）
 *
 * 实现方式（为什么不直接在 Node 里做）：
 *   · "全局空闲时间"（`GetLastInputInfo`）与"前台窗口矩形/类名"只有 Win32 提供，
 *     Electron/Node 没有对应 API；
 *   · 因此调一次 `tools/qa/activity-probe.ps1`（**只读、用完即退**，
 *     见该脚本顶部的隐私边界说明），把结果解析成 `ActivityState`。
 *
 * 纪律：
 *   · **不驻留、不挂钩子、不录内容**；只拿计数与窗口摘要（哈希 + 长度）；
 *   · 采样失败必须**如实标注** `available:false` + `unavailableReason`，
 *     绝不把"读不到"当成"没有阻断"（那样用户在开会时会被弹窗打断）；
 *   · 摄像头/麦克风的注册表读数**不可信**（强杀进程会留下永久的 0）⇒ 只作为诊断字段上报，
 *     **不参与阻断判定**（实测踩到过这个假阳性，见脚本内注释）。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ActivityState } from '@airimate/shared'
import { appPaths } from './paths.js'
import { log } from './log.js'

const PROBE_TIMEOUT_MS = 8000
const CACHE_MS = 5_000

/** 解析后的探针原始输出（字段名与脚本一一对应） */
export interface ProbeReading {
  available: boolean
  reason: string | null
  idleMs: number
  fullscreen: boolean
  foregroundPid: number
  foregroundIsShell: boolean
  foregroundVisible: boolean
  windowClass: string
  titleDigest: string | null
  titleChars: number
  focusAssist: boolean | null
  cameraInUse: boolean
  microphoneInUse: boolean
  cameraInUseStrong: boolean
  microphoneInUseStrong: boolean
  gameProcess: string | null
  meeting: string | null
  at: number
}

export interface ActivityProbeOptions {
  /** 覆盖探针路径（单测用） */
  scriptPath?: string
  /** 覆盖解释器（单测用；默认找 `powershell.exe`） */
  shellPath?: string
  /** 是否扫描进程名（游戏/会议检测；关掉可省 ~200ms） */
  scanProcesses?: boolean
  timeoutMs?: number
}

let cached: { at: number, reading: ProbeReading } | null = null
let inFlight: Promise<ProbeReading> | null = null
let lastInputCounter = 0

/** 找 Windows PowerShell（5.1 一定在；PowerShell 7 优先，装了就用它） */
export function resolveShell(): string | null {
  const envOverride = process.env.AIRIMATE_POWERSHELL
  if (envOverride && existsSync(envOverride)) return envOverride
  const candidates = [
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

export function probeScriptPath(): string {
  return join(appPaths().workspaceRoot, 'tools', 'qa', 'activity-probe.ps1')
}

function unavailable(reason: string): ProbeReading {
  return {
    available: false, reason,
    idleMs: 0, fullscreen: false, foregroundPid: 0, foregroundIsShell: false,
    foregroundVisible: false, windowClass: '', titleDigest: null, titleChars: 0,
    focusAssist: null, cameraInUse: false, microphoneInUse: false,
    cameraInUseStrong: false, microphoneInUseStrong: false,
    gameProcess: null, meeting: null, at: Date.now(),
  }
}

/** 只接受探针输出的**已知字段**（多余字段一律丢弃，避免脚本一改就多出未契约字段） */
export function parseReading(stdout: string): ProbeReading {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(line) as Record<string, unknown>
  } catch {
    return unavailable('探针输出不是合法 JSON')
  }
  const bool = (v: unknown, d = false): boolean => (typeof v === 'boolean' ? v : d)
  const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v.slice(0, 200) : null)
  return {
    available: bool(raw.available),
    reason: str(raw.reason),
    idleMs: Math.max(0, Math.round(num(raw.idleMs))),
    fullscreen: bool(raw.fullscreen),
    foregroundPid: Math.round(num(raw.foregroundPid)),
    foregroundIsShell: bool(raw.foregroundIsShell),
    foregroundVisible: bool(raw.foregroundVisible),
    windowClass: (str(raw.windowClass) ?? '').slice(0, 120),
    titleDigest: str(raw.titleDigest),
    titleChars: Math.max(0, Math.round(num(raw.titleChars))),
    focusAssist: typeof raw.focusAssist === 'boolean' ? raw.focusAssist : null,
    cameraInUse: bool(raw.cameraInUse),
    microphoneInUse: bool(raw.microphoneInUse),
    cameraInUseStrong: bool(raw.cameraInUseStrong),
    microphoneInUseStrong: bool(raw.microphoneInUseStrong),
    gameProcess: str(raw.gameProcess),
    meeting: str(raw.meeting),
    at: Math.round(num(raw.at, Date.now())),
  }
}

/**
 * 跑一次探针（不缓存）。失败一律返回 `available:false` —— 调用方必须据此**保守处理**。
 */
export async function runProbe(o: ActivityProbeOptions = {}): Promise<ProbeReading> {
  const script = o.scriptPath ?? probeScriptPath()
  if (!existsSync(script)) return unavailable(`探针脚本不存在（${script}）`)
  const shell = o.shellPath ?? resolveShell()
  if (!shell) return unavailable('找不到 PowerShell 解释器')
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script]
  if (o.scanProcesses === false) args.push('-SkipProcessScan')

  return await new Promise<ProbeReading>((resolve) => {
    let done = false
    const child = spawn(shell, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const finish = (r: ProbeReading): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { child.kill() } catch { /* 已退出 */ }
      resolve(r)
    }
    const timer = setTimeout(() => finish(unavailable(`探针超时（${o.timeoutMs ?? PROBE_TIMEOUT_MS}ms）`)), o.timeoutMs ?? PROBE_TIMEOUT_MS)
    timer.unref?.()
    child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8'); if (out.length > 64_000) out = out.slice(-32_000) })
    child.stderr?.on('data', (d: Buffer) => { err += d.toString('utf8'); if (err.length > 8_000) err = err.slice(-4_000) })
    child.on('error', (e) => finish(unavailable(`探针启动失败：${e.message}`)))
    child.on('close', () => {
      const r = parseReading(out)
      if (!r.available) log().debug('活动采样不可用', { reason: r.reason ?? '', stderr: err.slice(0, 200) }, 'activity.probe.unavailable')
      finish(r)
    })
  })
}

/**
 * 取一次采样（5 秒内复用缓存，避免 tick 与 UI 同时打爆进程创建）。
 * **同时保证同一时刻只有一次在飞**：并发调用共享同一个 promise。
 */
export async function sampleProbe(o: ActivityProbeOptions = {}): Promise<ProbeReading> {
  const now = Date.now()
  if (cached && now - cached.at < CACHE_MS) return cached.reading
  if (inFlight) return await inFlight
  inFlight = runProbe(o).then((r) => {
    cached = { at: Date.now(), reading: r }
    inFlight = null
    return r
  }).catch((e: unknown) => {
    inFlight = null
    const r = unavailable(e instanceof Error ? e.message : String(e))
    cached = { at: Date.now(), reading: r }
    return r
  })
  return await inFlight
}

/**
 * 粗粒度输入事件计数。
 *
 * ⚠ **不记录任何按键内容**：Windows 的 `GetLastInputInfo` 只给"最后一次输入的时间戳"，
 *   它本身不含事件数。这里的 `inputEvents1m` 是**由空闲时间推出来的**近似：
 *     · 空闲时间比上次观测**变小**（= 探测到新的输入）⇒ 计数 +1；
 *     · 空闲时间继续变大 ⇒ 说明这一分钟内没有新输入。
 *   这个近似足以支撑"连续使用 vs 久坐"的判定，且**不可能**还原用户敲了什么。
 */
export function deriveInputEvents(idleMs: number): number {
  if (idleMs < lastInputCounter) {
    lastInputCounter = idleMs
    return 1
  }
  lastInputCounter = idleMs
  return 0
}

export interface SampleOptions extends ActivityProbeOptions {
  /** 用户手动静默模式（来自 settings） */
  userSilent: boolean
  /** 是否把前台窗口标题摘要纳入统计（默认关闭） */
  includeTitleDigest: boolean
  /** 本应用的 pid 集合（前台是本应用时不算"用户在全屏工作"） */
  ownPids?: number[]
}

/** 把探针读数 + 用户设置合成契约里的 `ActivityState` */
export async function sampleActivity(o: SampleOptions): Promise<ActivityState> {
  const r = await sampleProbe(o)
  const own = new Set(o.ownPids ?? [])
  const foregroundIsSelf = own.has(r.foregroundPid)
  return {
    at: r.at || Date.now(),
    idleMs: r.idleMs,
    inputEvents1m: deriveInputEvents(r.idleMs),
    // 本应用自己占满屏幕**不算**全屏工作（否则用户一进面板模式就永远收不到提醒）
    fullscreen: r.available && r.fullscreen && !foregroundIsSelf && !r.foregroundIsShell,
    gameProcess: r.gameProcess,
    meeting: r.meeting,
    focusAssist: r.focusAssist === true,
    userSilent: o.userSilent,
    titleDigest: o.includeTitleDigest ? r.titleDigest : null,
    titleChars: o.includeTitleDigest ? r.titleChars : 0,
    available: r.available,
    unavailableReason: r.reason,
    // 阻断原因由 blocker 统一判定（这里只给"可以打扰"的缺省值）
    blockReason: 'none',
  }
}

/** 诊断用：探针能不能跑 + 探针路径（不暴露任何用户数据） */
export function probeDiagnostics(): { scriptPath: string, scriptExists: boolean, shell: string | null } {
  const scriptPath = probeScriptPath()
  return { scriptPath, scriptExists: existsSync(scriptPath), shell: resolveShell() }
}

/** 仅供单测：清缓存与计数器 */
export function __resetActivityProbeForTest(): void {
  cached = null
  inFlight = null
  lastInputCounter = 0
}
