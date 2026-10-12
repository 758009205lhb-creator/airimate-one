/**
 * @airimate/security/logger —— 统一日志（Tech-Spec §7.4）
 *
 * 设计：
 *   - 核心与传输分离：`createLogger(transport)` 可跑在 main（写文件）与 renderer（发 IPC）两侧；
 *   - 每条记录写入前经 `redactText`，命中项只保留长度 + 哈希前缀；
 *   - **不记对话正文**：调用方用 `redactValue('text', …)` 显式传指纹。
 */
import type { LogLevel, LogRecord } from '@airimate/shared'
import { redactText } from './redact.js'

export interface LogTransport {
  write: (record: LogRecord) => void
  /** 传输自身失败时的兜底（不得递归调用 logger） */
  onError?: (message: string) => void
}

export interface LoggerOptions {
  scope: string
  minLevel?: LogLevel
  transport: LogTransport
  /** 额外字段（如 bootId），每条记录都会带上 */
  base?: Record<string, string | number | boolean | null>
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface Logger {
  debug: (msg: string, fields?: Record<string, string | number | boolean | null>, event?: string) => void
  info: (msg: string, fields?: Record<string, string | number | boolean | null>, event?: string) => void
  warn: (msg: string, fields?: Record<string, string | number | boolean | null>, event?: string) => void
  error: (msg: string, fields?: Record<string, string | number | boolean | null>, event?: string) => void
  child: (scope: string) => Logger
}

function sanitizeFields(fields: Record<string, string | number | boolean | null>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v !== 'string') { out[k] = v; continue }
    if (v.length > 400) {
      out[k] = redactText(v.slice(0, 400)).text + '…(truncated)'
    } else {
      out[k] = redactText(v).text
    }
  }
  return out
}

export function createLogger(o: LoggerOptions): Logger {
  const min = LEVEL_ORDER[o.minLevel ?? 'info']

  const emit = (level: LogLevel, msg: string, fields?: Record<string, string | number | boolean | null>, event?: string): void => {
    if (LEVEL_ORDER[level] < min) return
    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      scope: o.scope.slice(0, 48),
      msg: redactText(msg.slice(0, 500)).text,
      fields: sanitizeFields({ ...(o.base ?? {}), ...(fields ?? {}) }),
      ...(event ? { event: event.slice(0, 64) } : {}),
    }
    try {
      o.transport.write(record)
    } catch (e) {
      o.transport.onError?.(`log transport failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return {
    debug: (m, f, e) => emit('debug', m, f, e),
    info: (m, f, e) => emit('info', m, f, e),
    warn: (m, f, e) => emit('warn', m, f, e),
    error: (m, f, e) => emit('error', m, f, e),
    child: (scope) => createLogger({ ...o, scope }),
  }
}

/**
 * 控制台传输：开发期用；生产仍写文件。
 *
 * ⚠ 必须**自禁用**：当 stdout 被关闭（父进程结束、管道断开）时写入会抛 EPIPE，
 *   而 uncaughtException 处理器又会调用 logger → 无限刷屏（实测踩到：日志里几千条 EPIPE）。
 */
export function consoleTransport(prefix = '[airimate]'): LogTransport {
  let disabled = false
  return {
    write(record) {
      if (disabled) return
      const line = `${record.ts} ${record.level.toUpperCase().padEnd(5)} ${record.scope} ${record.msg}${Object.keys(record.fields).length ? ` ${JSON.stringify(record.fields)}` : ''}`
      try {
        if (record.level === 'error') console.error(prefix, line)
        else if (record.level === 'warn') console.warn(prefix, line)
        else console.log(prefix, line)
      } catch {
        // 管道已断：永久关闭控制台输出，绝不递归上报
        disabled = true
      }
    },
  }
}

/** 组合传输：写多处（文件 + 控制台），任意一处失败不影响其它 */
export function composeTransports(...ts: LogTransport[]): LogTransport {
  return {
    write(record) {
      for (const t of ts) {
        try { t.write(record) } catch { /* 忽略单个传输失败 */ }
      }
    },
  }
}
