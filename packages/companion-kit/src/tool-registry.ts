/**
 * @airimate/companion-kit/tool-registry —— 结构化工具调用的**统一执行器**（M3 §4/§5/§6 的底座）
 *
 * 用户要求（逐条对应到下面）：
 *   · "电脑操作使用结构化工具调用，分三档权限"        → `decide()` 走 shared 的硬下限
 *   · "禁止自动支付、改密码、读取凭据"                → `PERMISSION_TIER_FLOOR` 把这三类钉死为 blocked
 *   · "所有工具调用包含超时、参数校验、执行结果、失败原因和审计记录" → `invoke()` 五件事全做
 *   · "禁止模型伪造执行成功"                          → `ok` **只由执行器写**；未执行时恒为 null
 *
 * 为什么必须有这一层（而不是让每个工具自己判权限）：
 *   一旦权限判定分散到各工具里，就必然出现"某个工具忘了判" ⇒ 那一条就是缺口。
 *   这里把判定、校验、超时、审计**收在一处**，工具实现只关心"怎么做事"。
 */
import { createHash } from 'node:crypto'
import type { AuditSink, ToolResult, ToolRunContext, ToolSpec } from './types.js'

/** 与 shared 的 `PermissionTier` 同形（避免本包反向依赖 shared 造成循环） */
export type PermissionTier = 'read-only' | 'confirm' | 'blocked'
export type PermissionDecision = 'allow' | 'needs-confirm' | 'denied'

export interface ToolRegistryOptions {
  /** 判定某权限种类的三档结果（主进程注入；**唯一真源**是 permission-store） */
  decide: (permissionKind: string) => PermissionDecision
  /** 审计落盘（主进程注入；实现必须只记长度/哈希，不记正文） */
  audit: AuditSink
  /** 参数摘要函数（默认 sha256 前 12 位 + 原长；**绝不落原文**） */
  digest?: (value: unknown) => string
  /** 时钟（单测注入） */
  now?: () => number
  /** 用户确认回调（主进程注入；返回 false = 用户拒绝，工具**不得执行**） */
  requestConfirm?: (tool: string, permissionKind: string, paramsDigest: string) => Promise<boolean>
}

export interface InvokeResult {
  ok: boolean
  /** 与 `ToolResult.digest` 同源；未执行时为 null */
  digest: string | null
  message: string
  decision: PermissionDecision | 'timeout' | 'error' | 'unknown-tool'
  paramsDigest: string
  durationMs: number | null
  data?: unknown
}

/** 默认摘要：sha256 前 12 位 + 原长。**不落原文**（参数里可能有正文与路径） */
export function defaultDigest(value: unknown): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value ?? null)
  } catch {
    text = '<unserializable>'
  }
  const h = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)
  return `sha256:${h}:len=${text.length}`
}

export interface ToolRegistry {
  register: (spec: ToolSpec) => void
  unregister: (name: string) => boolean
  get: (name: string) => ToolSpec | null
  list: () => Array<{
    name: string
    description: string
    permissionKind: string
    timeoutMs: number
    readOnly: boolean
    /** 当前是否允许调用（**给模型看的**清单也用它；`blocked` 的工具不该出现在可调用清单里） */
    decision: PermissionDecision
  }>
  /** 统一执行入口：判定 → 校验 → 执行（带超时）→ 审计 */
  invoke: (name: string, params: unknown) => Promise<InvokeResult>
}

export function createToolRegistry(o: ToolRegistryOptions): ToolRegistry {
  const tools = new Map<string, ToolSpec>()
  const digest = o.digest ?? defaultDigest
  const now = o.now ?? (() => Date.now())

  const register: ToolRegistry['register'] = (spec) => {
    if (!spec.name) throw new Error('工具必须有 name')
    if (!(spec.timeoutMs > 0)) throw new Error(`工具 ${spec.name} 必须声明正数 timeoutMs（没有超时的执行会拖住整个应用）`)
    if (!spec.permissionKind) throw new Error(`工具 ${spec.name} 必须声明 permissionKind（否则无法判定权限）`)
    tools.set(spec.name, spec)
  }

  const list: ToolRegistry['list'] = () => [...tools.values()].map(t => ({
    name: t.name,
    description: t.description,
    permissionKind: t.permissionKind,
    timeoutMs: t.timeoutMs,
    readOnly: t.readOnly,
    decision: o.decide(t.permissionKind),
  }))

  /**
   * 统一执行。
   *
   * 顺序**不能变**：先判定权限 → 再校验参数 → 再（必要时）确认 → 才执行。
   * 反过来（先校验参数）会把"这个工具你根本没权限用"变成"你的参数写错了"，
   * 既误导模型也误导用户。
   */
  const invoke: ToolRegistry['invoke'] = async (name, params) => {
    const callId = `tc_${now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    let paramsDigest = '<unavailable>'
    try { paramsDigest = digest(params) } catch { /* 摘要失败不影响判定 */ }

    const spec = tools.get(name)
    if (!spec) {
      o.audit.record({ callId, tool: name, decision: 'denied', reason: 'unknown-tool', ok: null, durationMs: null, paramsDigest, resultDigest: null })
      return { ok: false, digest: null, message: `没有名为 ${name} 的工具`, decision: 'unknown-tool', paramsDigest, durationMs: null }
    }

    // ① 权限（唯一判定入口；硬下限已在 permission-store 里生效）
    const decision = o.decide(spec.permissionKind)
    if (decision === 'denied') {
      o.audit.record({ callId, tool: name, decision: 'denied', reason: `permission-denied:${spec.permissionKind}`, ok: null, durationMs: null, paramsDigest, resultDigest: null })
      return { ok: false, digest: null, message: `权限不足：${spec.permissionKind}（该能力为「禁止」或未启用）`, decision: 'denied', paramsDigest, durationMs: null }
    }

    // ② 参数校验（zod；失败即拒，**不执行**）
    const parsed = spec.params.safeParse(params)
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 4).map(i => `${i.path.join('.') || '<root>'}:${i.message}`).join(' | ')
      o.audit.record({ callId, tool: name, decision: 'error', reason: `schema:${issues}`.slice(0, 300), ok: null, durationMs: null, paramsDigest, resultDigest: null })
      return { ok: false, digest: null, message: `参数校验失败（${issues}）`, decision: 'error', paramsDigest, durationMs: null }
    }

    // ③ 用户确认（confirm 档；用户拒绝 ⇒ 不执行，如实回报）
    let confirmed = false
    if (decision === 'needs-confirm') {
      if (!o.requestConfirm) {
        o.audit.record({ callId, tool: name, decision: 'needs-confirm', reason: 'no-confirm-channel', ok: null, durationMs: null, paramsDigest, resultDigest: null })
        return { ok: false, digest: null, message: '该操作需要你确认，但当前没有可用的确认入口 ⇒ 未执行', decision: 'needs-confirm', paramsDigest, durationMs: null }
      }
      try {
        confirmed = await o.requestConfirm(name, spec.permissionKind, paramsDigest)
      } catch {
        confirmed = false
      }
      if (!confirmed) {
        o.audit.record({ callId, tool: name, decision: 'needs-confirm', reason: 'user-rejected', ok: null, durationMs: null, paramsDigest, resultDigest: null })
        return { ok: false, digest: null, message: '你拒绝了这次操作', decision: 'needs-confirm', paramsDigest, durationMs: null }
      }
    }

    // ④ 执行（**带超时**：超时必须能让执行器停下，否则等于没超时）
    const ctl = new AbortController()
    const started = now()
    let timer: NodeJS.Timeout | null = setTimeout(() => ctl.abort(), spec.timeoutMs)
    const ctx: ToolRunContext = { callId, signal: ctl.signal, confirmed }
    try {
      const r = await Promise.race([
        spec.run(parsed.data, ctx),
        new Promise<never>((_, reject) => {
          ctl.signal.addEventListener('abort', () => reject(new Error(`已超时（${spec.timeoutMs}ms）`)), { once: true })
        }),
      ]) as ToolResult
      const durationMs = Math.max(0, now() - started)
      const resultDigest = r.digest || digest(r.message)
      o.audit.record({
        callId, tool: name, decision: 'allow',
        reason: r.ok ? null : r.message.slice(0, 300),
        ok: r.ok === true, durationMs, paramsDigest, resultDigest,
      })
      return { ok: r.ok === true, digest: resultDigest, message: r.message, decision: 'allow', paramsDigest, durationMs, data: r.data }
    } catch (e) {
      const durationMs = Math.max(0, now() - started)
      const aborted = ctl.signal.aborted
      const msg = aborted ? `已超时（${spec.timeoutMs}ms）` : (e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300))
      const dec: InvokeResult['decision'] = aborted ? 'timeout' : 'error'
      o.audit.record({ callId, tool: name, decision: dec, reason: msg, ok: false, durationMs, paramsDigest, resultDigest: null })
      return { ok: false, digest: null, message: msg, decision: dec, paramsDigest, durationMs }
    } finally {
      if (timer) { clearTimeout(timer); timer = null }
    }
  }

  return {
    register,
    unregister: (name) => tools.delete(name),
    get: (name) => tools.get(name) ?? null,
    list,
    invoke,
  }
}

/**
 * 生成**给模型看的**工具清单。
 *
 * ⚠ `denied` 的工具**不进清单**：把模型根本不能用的工具告诉它，
 *   只会让它反复尝试并给用户"我做不到"的假象 —— 那正是"模型伪造成功"的温床。
 */
export function toolManifestForModel(reg: ToolRegistry): Array<{ name: string, description: string, paramsHint: string }> {
  return reg.list()
    .filter(t => t.decision !== 'denied')
    .map(t => ({
      name: t.name,
      description: t.description,
      paramsHint: `${t.readOnly ? '只读' : '会修改状态'}；${t.decision === 'needs-confirm' ? '需要用户确认' : '可直接执行'}；超时 ${t.timeoutMs}ms`,
    }))
}
