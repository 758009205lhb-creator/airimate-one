/**
 * apps/desktop/src/main/memory-state.ts —— 记忆层"最后一次注入"的只读快照
 *
 * 为什么需要它：记忆注入发生在 `chat:send` 内部（拼进系统提示），
 * 从外面**完全看不见**——验收时无法证明"这次请求真的带上了记忆"。
 * 这里记下可判定的证据，遵循与 `stage-state.ts` / `legacy-state.ts` 相同的
 * "主进程持有状态、验收探针只读"模式。
 *
 * 隐私纪律：**不保存记忆正文**。只保存长度、条数与内容指纹（FNV-1a 8 位十六进制）。
 *   · 指纹足以证明"注入的是这一块内容"（同一输入 → 同一指纹，内容变了指纹就变）；
 *   · 但无法从诊断包还原用户说了什么。
 */
import { createHash } from 'node:crypto'

export interface MemoryInjectionSnapshot {
  /** 本次注入的字符数（0 表示未注入） */
  chars: number
  /** 注入的记忆条数 */
  hits: number
  /** 记忆块内容指纹（sha256 前 12 位）；未注入为 null */
  fingerprint: string | null
  /** 本轮用户输入长度（同样不存正文） */
  queryChars: number
  /** 注入时刻（epoch ms） */
  at: number
  /** 累计注入次数（进程内） */
  totalInjections: number
}

let last: MemoryInjectionSnapshot | null = null
let injections = 0

/** 由 `chat:send` 在拼装提示后调用。`block` 为 null 表示本轮无相关记忆。 */
export function recordMemoryInjection(query: string, block: string | null, hits: number): void {
  injections += 1
  last = {
    chars: block?.length ?? 0,
    hits: block ? hits : 0,
    fingerprint: block ? createHash('sha256').update(block, 'utf8').digest('hex').slice(0, 12) : null,
    queryChars: query.length,
    at: Date.now(),
    totalInjections: injections,
  }
}

export function lastMemoryInjection(): MemoryInjectionSnapshot | null {
  return last
}
