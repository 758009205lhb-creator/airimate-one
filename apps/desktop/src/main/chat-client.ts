/**
 * apps/desktop/src/main/chat-client.ts —— OpenAI 兼容的**流式**聊天客户端（主进程侧）
 *
 * 边界（Tech-Spec §7）：
 *   · 只在**主进程**发起（密钥永不进 renderer）；
 *   · `redirect: 'error'`（防密钥被重定向到第三方主机）；
 *   · 15s 首字节超时 + 可中断（`AbortController`）；
 *   · 失败只记 code 与主机名，**不记**响应体（可能含敏感内容）。
 *
 * 为什么是"OpenAI 兼容"而不是绑定某家：
 *   DeepSeek / OpenAI / Ollama / 自建端点都提供 `/chat/completions` 的 SSE 流，
 *   同一份实现可覆盖全部——这也是 AIRI 侧 `@xsai` 系列的同一抽象。
 */
import type { ChatError } from '@airimate/shared'
import { log } from './log.js'
import { hostOf, type Provider } from './provider-store.js'

export interface ChatDeltaEvent {
  delta: string
}

export interface ChatCallbacks {
  onDelta: (e: ChatDeltaEvent) => void
  onDone: (full: { text: string, usage: { promptTokens: number | null, completionTokens: number | null } | null }) => void
  onError: (e: Pick<ChatError, 'code' | 'message' | 'retryable'>) => void
}

export interface ChatMessageIn {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface StartChatOptions {
  provider: Provider
  apiKey: string | null
  messages: ChatMessageIn[]
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
}

export interface ChatHandle {
  abort: () => void
  readonly id: string
}

let seq = 0

/**
 * 发起一轮流式对话。**立即返回句柄**，结果通过回调送达。
 */
export function startChat(o: StartChatOptions, cb: ChatCallbacks): ChatHandle {
  seq += 1
  const id = `chat-${seq}`
  const ctl = new AbortController()
  let firstByteTimer: NodeJS.Timeout | null = setTimeout(() => ctl.abort(), o.timeoutMs ?? 30_000)

  const fail = (code: Pick<ChatError, 'code' | 'message' | 'retryable'>): void => {
    if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null }
    cb.onError(code)
  }

  if (!o.apiKey) {
    fail({ code: 'no-provider', message: '该供应商尚未配置密钥', retryable: false })
    return { abort: () => { /* 已结束 */ }, id }
  }

  void (async () => {
    const url = `${o.provider.baseUrl.replace(/\/+$/, '')}/chat/completions`
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${o.apiKey as string}`,
          accept: 'text/event-stream',
        },
        body: JSON.stringify({
          model: o.provider.model,
          messages: o.messages,
          stream: true,
          temperature: o.temperature ?? 0.85,
          ...(o.maxTokens ? { max_tokens: o.maxTokens } : {}),
        }),
        signal: ctl.signal,
        redirect: 'error',
      })

      if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null }

      if (res.status === 401 || res.status === 403) { fail({ code: 'auth', message: `鉴权失败（HTTP ${res.status}）`, retryable: false }); return }
      if (res.status === 429) { fail({ code: 'rate-limit', message: '被限流（HTTP 429）', retryable: true }); return }
      if (!res.ok) { fail({ code: 'bad-response', message: `HTTP ${res.status}`, retryable: res.status >= 500 }); return }
      if (!res.body) { fail({ code: 'bad-response', message: '响应没有 body', retryable: true }); return }

      const reader = res.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buf = ''
      let text = ''
      let usage: { promptTokens: number | null, completionTokens: number | null } | null = null

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        // SSE：事件以空行分隔
        let idx: number
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          for (const line of chunk.split(/\r?\n/)) {
            if (!line.startsWith('data:')) continue
            const payload = line.slice(5).trim()
            if (payload === '[DONE]') continue
            if (!payload) continue
            try {
              const j = JSON.parse(payload) as {
                choices?: Array<{ delta?: { content?: string } }>
                usage?: { prompt_tokens?: number, completion_tokens?: number }
              }
              const d = j.choices?.[0]?.delta?.content
              if (typeof d === 'string' && d.length > 0) { text += d; cb.onDelta({ delta: d }) }
              if (j.usage) {
                usage = { promptTokens: j.usage.prompt_tokens ?? null, completionTokens: j.usage.completion_tokens ?? null }
              }
            } catch {
              // 单块解析失败不致命：跳过这一块（流仍继续）
            }
          }
        }
      }

      cb.onDone({ text, usage })
      log().info('对话完成', { id, chars: text.length, tokens: usage?.completionTokens ?? -1 }, 'chat.done')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const aborted = /abort/i.test(msg)
      log().warn('对话失败', { id, host: hostOf(o.provider.baseUrl), aborted }, 'chat.failed')
      fail(aborted
        ? { code: 'aborted', message: '已中断', retryable: false }
        : { code: 'network', message: '网络不可达', retryable: true })
    }
  })()

  return { abort: () => { try { ctl.abort() } catch { /* ignore */ } }, id }
}
