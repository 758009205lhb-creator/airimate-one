/**
 * apps/desktop/src/main/tool-confirm.ts —— `needs-confirm` 档工具的**用户确认通道**（M3 §4）
 *
 * 用户要求："普通操作需确认"。这条要求的实现有一个**最容易做错的点**：
 *   没有确认入口时该怎么办？
 *   如果答案是"那就直接执行"，那 confirm 档就被悄悄降级成了 allow ——
 *   整条三档设计当场失效。所以这里的缺省方向是 **拒绝**：
 *   · 没有确认通道 ⇒ `false`（不执行）；
 *   · 用户没回应（超时）⇒ `false`（不执行）；
 *   · 用户点拒绝 ⇒ `false`（不执行）。
 *   只有**显式点了同意**才是 `true`。三种默认都是"不执行"，这是刻意的。
 *
 * 另一条纪律：确认请求里**只有工具名、权限种类与参数摘要**（摘要本来就是哈希）。
 *   弹窗不需要、也不应该看到参数原文 —— 否则"确认"就变成了把敏感参数
 *   又搬到一个可能被截屏的地方。
 */
import { randomUUID } from 'node:crypto'
import type { ToolConfirmRequest } from '@airimate/shared'
import { ToolConfirmRequestSchema } from '@airimate/shared'
import { log } from './log.js'

/** 发给 renderer 的出口（bootstrap 注入；未注入时 confirm 一律拒绝） */
let sender: ((req: ToolConfirmRequest) => void) | null = null
export function setToolConfirmSender(fn: (req: ToolConfirmRequest) => void): void {
  sender = fn
}

interface Pending {
  tool: string
  permissionKind: string
  resolve: (approved: boolean) => void
  timer: NodeJS.Timeout
  at: number
}

/** 当前挂起的确认（键 = confirmId）。**只接受挂起中的 id**，防重放。 */
const pending = new Map<string, Pending>()

/** 挂起确认上限（防 renderer 刷请求把内存撑爆） */
const MAX_PENDING = 8

/**
 * 请求用户确认。返回 `true` **只表示用户点了同意**。
 *
 * 超时（`timeoutMs`）后自动按拒绝处理 —— 一个忘了关的确认框不该把工具执行
 * 无限期挂住（那会占着超时预算，让真正该失败的操作一直"在跑"）。
 */
export async function requestToolConfirm(
  tool: string,
  permissionKind: string,
  paramsDigest: string,
  o: { timeoutMs?: number, detail?: string } = {},
): Promise<boolean> {
  if (!sender) {
    log().warn('没有确认出口 ⇒ 按拒绝处理（绝不因缺少入口而放行）', { tool, permissionKind }, 'tool.confirm.no-sender')
    return false
  }
  if (pending.size >= MAX_PENDING) {
    log().warn('挂起的确认过多 ⇒ 拒绝新的（避免刷请求）', { pending: pending.size, tool }, 'tool.confirm.too-many')
    return false
  }

  const timeoutMs = Math.min(120_000, Math.max(1000, o.timeoutMs ?? 30_000))
  const confirmId = `cfm_${randomUUID().slice(0, 12)}`
  const req: ToolConfirmRequest = ToolConfirmRequestSchema.parse({
    confirmId,
    tool: tool.slice(0, 64),
    permissionKind: permissionKind.slice(0, 40),
    paramsDigest: paramsDigest.slice(0, 80),
    detail: (o.detail ?? describeAction(tool, permissionKind)).slice(0, 300),
    timeoutMs,
    at: Date.now(),
  })

  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(confirmId)
      log().info('确认超时 ⇒ 按拒绝处理', { tool, timeoutMs }, 'tool.confirm.timeout')
      resolve(false)
    }, timeoutMs)
    timer.unref?.()
    pending.set(confirmId, { tool, permissionKind, resolve, timer, at: Date.now() })
    try {
      sender?.(req)
    } catch (e) {
      // 推送失败 = 用户根本没看到 ⇒ 必须按拒绝处理（不能"推送失败就默认同意"）
      clearTimeout(timer)
      pending.delete(confirmId)
      log().warn('确认请求推送失败 ⇒ 按拒绝处理', { tool, err: e instanceof Error ? e.message : String(e) }, 'tool.confirm.send-failed')
      resolve(false)
    }
    log().info('已请求用户确认', { tool, permissionKind, timeoutMs }, 'tool.confirm.requested')
  })
}

/**
 * 处理 renderer 回传的确认结果。
 * 返回 `false` = 这个 `confirmId` 不存在或已过期（**忽略，不报错** —— 可能只是用户点晚了）。
 */
export function resolveToolConfirm(confirmId: string, approved: boolean): boolean {
  const p = pending.get(confirmId)
  if (!p) return false
  pending.delete(confirmId)
  clearTimeout(p.timer)
  log().info('用户确认结果', {
    tool: p.tool, permissionKind: p.permissionKind, approved,
    waitedMs: Date.now() - p.at,
  }, approved ? 'tool.confirm.approved' : 'tool.confirm.rejected')
  p.resolve(approved)
  return true
}

/** 当前挂起的确认数（诊断/UI 用） */
export function pendingConfirmCount(): number {
  return pending.size
}

/** 清空全部挂起（退出/停用时调；一律按拒绝结算） */
export function cancelAllConfirms(reason = 'shutdown'): number {
  const n = pending.size
  for (const [id, p] of pending) {
    clearTimeout(p.timer)
    pending.delete(id)
    p.resolve(false)
  }
  if (n > 0) log().info('已取消全部挂起确认（按拒绝处理）', { count: n, reason }, 'tool.confirm.cancelled')
  return n
}

/**
 * 面向用户的一句话说明（确认弹窗里显示）。
 * **只说这个操作会做什么**，不回显参数摘要以外的任何东西。
 */
function describeAction(tool: string, permissionKind: string): string {
  const map: Record<string, string> = {
    'app.launch': '启动一个已登记的应用',
    'clipboard.read': '读取当前剪贴板文本（可能含敏感内容）',
    'file.write': '写入文件',
    'shell-exec': '执行命令',
  }
  return `${map[tool] ?? `执行 ${tool}`}（权限：${permissionKind}）`
}

/** 仅供单测 */
export function __resetToolConfirmForTest(): void {
  sender = null
  cancelAllConfirms('test-reset')
  pending.clear()
}
