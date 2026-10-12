/**
 * apps/desktop/src/main/tool-audit.ts —— 工具调用审计（M3 §6 的落点）
 *
 * 用户要求："所有工具调用包含超时、参数校验、执行结果、失败原因和审计记录，
 *           禁止模型伪造执行成功。"
 *
 * 本模块只做一件事：把每次工具调用**落成可判定、可检索、且不含用户内容**的记录。
 *
 * 三条纪律（逐条对应本项目已有的脱敏纪律）：
 *   ① **只记摘要**：参数与结果各记 `sha256:前12位:原长`，**绝不落原文**
 *      （参数里可能有正文与绝对路径）；
 *   ② **`ok` 只由执行器写**：审计层不猜、不推断。未执行时恒为 `null`
 *      （`null` ≠ `false`：前者是"没执行"，后者是"执行了但失败"）；
 *   ③ 环形缓冲 + 落盘：内存里保留最近 N 条供 UI/探针读，同时写日志文件（可事后审计）。
 */
import type { ToolCallRecord } from '@airimate/shared'
import { createHash } from 'node:crypto'
import { log } from './log.js'

/** 内存里保留的最近记录数（UI 的"工具调用审计"页与探针读它） */
const MAX_RECORDS = 200

let records: ToolCallRecord[] = []
let seq = 0

/**
 * 参数/结果的**唯一**摘要格式：`sha256:<12 位十六进制>:len=<原长>`。
 *
 * 为什么不写"用 `companion-kit` 的 defaultDigest 就行"：启动期记账（"哪些工具被
 * 权限挡住了"）没有真正的参数，需要一个**占位摘要**。早期我随手写成
 * `sha256:startup:len=0` —— 于是"每条审计的摘要都是合法格式"这条判据被
 * 探针抓成失败。格式必须**只有一种**，否则"格式正确"就没法机械校验。
 */
export function digestOf(value: unknown): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  } catch {
    text = '<unserializable>'
  }
  const h = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)
  return `sha256:${h}:len=${text.length}`
}

/** 摘要格式校验（探针与单测共用；**一处定义**，避免两处漂移） */
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{12}:len=\d+$/

export function isDigestLike(v: string): boolean {
  return DIGEST_PATTERN.test(v)
}

export interface AuditEntry {
  callId: string
  tool: string
  decision: 'allow' | 'needs-confirm' | 'denied' | 'timeout' | 'error'
  reason: string | null
  ok: boolean | null
  durationMs: number | null
  paramsDigest: string
  resultDigest: string | null
}

/**
 * 记一条审计。
 *
 * ⚠ `reason` 与 `paramsDigest` 都由调用方保证已脱敏；
 *   这里再做一次**长度截断**（防一条超长 reason 把日志与 UI 撑爆）。
 */
export function recordToolCall(e: AuditEntry): ToolCallRecord {
  seq += 1
  const rec: ToolCallRecord = {
    id: e.callId || `tc_${seq}`,
    tool: e.tool.slice(0, 64),
    paramsDigest: e.paramsDigest.slice(0, 80),
    decision: e.decision,
    reason: e.reason === null ? null : e.reason.slice(0, 300),
    ok: e.ok,
    durationMs: e.durationMs,
    resultDigest: e.resultDigest === null ? null : e.resultDigest.slice(0, 80),
    at: Date.now(),
  }
  records.push(rec)
  if (records.length > MAX_RECORDS) records = records.slice(records.length - MAX_RECORDS)

  // 落日志（**只有摘要**；`recordToolCall` 的入参里本来就没有正文）
  const fields = {
    tool: rec.tool,
    decision: rec.decision,
    ok: rec.ok === null ? 'null' : (rec.ok ? 'true' : 'false'),
    ms: rec.durationMs ?? -1,
    params: rec.paramsDigest,
    result: rec.resultDigest ?? '<none>',
    reason: rec.reason ?? '<none>',
  }
  if (rec.decision === 'allow' && rec.ok === true) log().info('工具调用成功', fields, 'tool.call.ok')
  else if (rec.decision === 'denied') log().warn('工具调用被拒（权限）', fields, 'tool.call.denied')
  else if (rec.decision === 'needs-confirm') log().info('工具调用未获确认', fields, 'tool.call.unconfirmed')
  else if (rec.decision === 'timeout') log().warn('工具调用超时', fields, 'tool.call.timeout')
  else log().warn('工具调用失败', fields, 'tool.call.failed')

  return rec
}

/** 最近 N 条（新的在前；UI 与探针读它） */
export function recentToolCalls(limit = 50): ToolCallRecord[] {
  return [...records].reverse().slice(0, Math.max(0, limit))
}

/** 摘要（**只给计数与决策分布**，不含工具名以外的任何信息） */
export function toolAuditDigest(): {
  total: number
  byDecision: Record<string, number>
  neverExecuted: number
  executedOk: number
  executedFailed: number
} {
  const byDecision: Record<string, number> = {}
  for (const r of records) byDecision[r.decision] = (byDecision[r.decision] ?? 0) + 1
  return {
    total: records.length,
    byDecision,
    /** `ok === null` = 没被执行（被拒 / 未确认）—— 这个数必须能看见 */
    neverExecuted: records.filter(r => r.ok === null).length,
    executedOk: records.filter(r => r.ok === true).length,
    executedFailed: records.filter(r => r.ok === false).length,
  }
}

/** 仅供单测 */
export function __resetToolAuditForTest(): void {
  records = []
  seq = 0
}

export type { AuditEntry as ToolAuditEntry }
