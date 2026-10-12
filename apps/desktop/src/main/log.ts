/**
 * apps/desktop/src/main/log.ts —— 主进程日志（写 JSONL + 控制台），统一走脱敏
 *
 * 落盘策略：`%APPDATA%\AiriMateOne\logs\airimate-YYYY-MM-DD.jsonl`
 *   - 单文件轮转；保留 7 天；单文件超过 5 MB 时切到 `.1`（各保留一份）
 *   - 写入前经 `@airimate/security` 的 redactText
 */
import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { LogRecord } from '@airimate/shared'
import { composeTransports, consoleTransport, createLogger } from '@airimate/security'
import type { Logger, LogTransport } from '@airimate/security'
import { appPaths, pruneOldFiles } from './paths.js'

const MAX_BYTES = 5 * 1024 * 1024
const KEEP_DAYS = 7

function dayStamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

let cachedFileTransport: LogTransport | null = null

export function fileTransport(): LogTransport {
  if (cachedFileTransport) return cachedFileTransport
  cachedFileTransport = {
    write(record: LogRecord) {
      const dir = appPaths().logsDir
      const file = join(dir, `airimate-${dayStamp()}.jsonl`)
      try {
        if (existsSync(file) && statSync(file).size > MAX_BYTES) {
          try { renameSync(file, `${file}.1`) } catch { /* 轮转失败不致命 */ }
        }
        appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
      } catch {
        // 磁盘满/权限问题：不要递归打日志，静默降级到控制台
      }
    },
  }
  return cachedFileTransport
}

export function pruneLogs(): number {
  return pruneOldFiles(appPaths().logsDir, KEEP_DAYS * 24 * 3600 * 1000)
}

export interface MainLoggerOptions {
  debugEnabled: boolean
  bootId: string
}

let root: Logger | null = null

export function initLogging(o: MainLoggerOptions): Logger {
  root = createLogger({
    scope: 'main',
    minLevel: o.debugEnabled ? 'debug' : 'info',
    base: { bootId: o.bootId },
    transport: composeTransports(fileTransport(), consoleTransport()),
  })
  return root
}

export function log(): Logger {
  if (!root) {
    // 允许在 initLogging 之前安全使用（例如单实例判定阶段）
    root = createLogger({
      scope: 'main',
      minLevel: 'info',
      base: { bootId: 'pre-init' },
      transport: consoleTransport(),
    })
  }
  return root
}
