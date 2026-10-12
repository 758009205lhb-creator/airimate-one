/**
 * @airimate/shared/errors —— 统一错误码与日志记录形状
 *
 * 纪律：错误对象**永不携带原始敏感值**（密钥、对话正文、绝对路径中的用户名段）。
 */
import { z } from 'zod'

export const ErrorCode = z.enum([
  'ENV_UNAVAILABLE',        // 环境不可用（不是任务失败），例如 Electron 缺失
  'LOCK_HELD',              // 已有实例
  'LEGACY_RUNNING',         // 旧实例在跑（阻断）
  'IPC_SCHEMA',             // 跨进程消息校验失败
  'PATH_REJECTED',          // 路径安全校验拒绝
  'SECRET_BACKEND',         // 密钥后端不可用
  'PROVIDER_MISSING',
  'PROVIDER_AUTH',
  'PROVIDER_NETWORK',
  'PROVIDER_BAD_RESPONSE',
  'MOTION_CLIP_FAILED',     // 动作加载/解析失败（必须可见告警）
  'MOTION_MANIFEST_INVALID',
  'AVATAR_MISSING',
  'AVATAR_LOAD_FAILED',
  'TTS_FAILED',
  'STORAGE_FAILED',
  'INTERNAL',
])
export type ErrorCode = z.infer<typeof ErrorCode>

export class AiriMateError extends Error {
  readonly code: ErrorCode
  readonly detail: Record<string, string | number | boolean | null> | undefined

  constructor(code: ErrorCode, message: string, detail?: Record<string, string | number | boolean | null>) {
    super(message)
    this.name = 'AiriMateError'
    this.code = code
    this.detail = detail
  }

  toResult(): { ok: false, code: ErrorCode, message: string } {
    return { ok: false, code: this.code, message: this.message }
  }
}

export const LogLevel = z.enum(['debug', 'info', 'warn', 'error'])
export type LogLevel = z.infer<typeof LogLevel>

export const LogRecordSchema = z.object({
  ts: z.string(),
  level: LogLevel,
  scope: z.string().max(48),
  msg: z.string().max(500),
  fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  /** 事件名，便于检索（如 'legacy.block'、'motion.load.failed'） */
  event: z.string().max(64).optional(),
})
export type LogRecord = z.infer<typeof LogRecordSchema>

/** 兜底：把任意 thrown 值转成安全字符串（不打印堆栈中的敏感路径以外的内容） */
export function describeError(e: unknown): string {
  if (e instanceof AiriMateError) return `${e.code}: ${e.message}`
  if (e instanceof Error) return `${e.name}: ${e.message}`
  if (typeof e === 'string') return e.slice(0, 300)
  try { return JSON.stringify(e).slice(0, 300) } catch { return '<unstringifiable>' }
}
