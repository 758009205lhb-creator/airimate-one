/**
 * apps/desktop/src/main/capabilities/llm-adapter.ts —— 语言模型适配器
 *
 * 把 `chat-client.ts`（OpenAI 兼容 + SSE 流式）与 `provider-store.ts`（用户配置的端点）
 * 包成 `BaseAdapter`，于是"用哪家模型"从"业务代码里的一个函数调用"
 * 变成"注册表里的一个候选"。
 *
 * ⚠ 与 TTS 的关键差别：LLM 适配器的**可用性依赖用户配置**（baseUrl + 密钥），
 *   而不是平台能力。因此：
 *     · 未配置 ⇒ `available:false` + `unavailableReason`（UI 与选型都能看到）；
 *     · 密钥**只存在于闭包里**，绝不放进 `describe()` / 诊断 / 日志；
 *     · `requiresNetwork:true` 如实标注（隐私审查要点）。
 */
import type { BaseAdapter } from '@airimate/companion-kit'
import { firstPartyLicense } from '@airimate/companion-kit'
import { egressAllowed, hostOf, type Provider } from '../provider-store.js'
import { startChat, type ChatCallbacks, type ChatHandle, type ChatMessageIn } from '../chat-client.js'

export interface LlmAdapter extends BaseAdapter {
  kind: 'llm'
  /** 当前配置（**不含密钥**；给 UI 与诊断用） */
  descriptor: () => { id: string, label: string, kind: string, baseUrlHost: string, model: string } | null
  /** 发起一轮流式对话（密钥由闭包提供，调用方拿不到） */
  chat: (o: { messages: ChatMessageIn[], temperature?: number, maxTokens?: number, timeoutMs?: number }, cb: ChatCallbacks) => ChatHandle
}

export interface LlmAdapterDeps {
  /** 取当前生效供应商（每次调用时取，配置改了立即生效） */
  activeProvider: () => Provider | null
  /** 取该供应商的密钥（**只在主进程内存里**） */
  apiKeyOf: (providerId: string) => string | null
}

export function createOpenAiCompatLlmAdapter(d: LlmAdapterDeps): LlmAdapter {
  const adapter: LlmAdapter = {
    id: 'llm.openai-compatible',
    kind: 'llm',
    label: 'OpenAI 兼容端点（用户配置）',
    origin: 'first-party',
    available: false,
    unavailableReason: '尚未初始化',
    capabilities: ['streaming', 'sse', 'openai-compatible', 'user-configured-endpoint'],
    license: firstPartyLicense('本应用自研的 HTTP 客户端；模型与端点由用户自行提供'),
    /** ★ 必须出网（用户配置的端点）—— 隐私审查要点，如实标注 */
    requiresNetwork: true,
    /** 正文会发给模型服务商（这是它的功能），如实标注 */
    writesUserContent: true,
    note: 'DeepSeek / OpenAI / Ollama / 自建端点都提供 /chat/completions 的 SSE 流；密钥只在主进程内存中拼进 header',

    async init() {
      // 可用性 = 有供应商 **且** 有密钥。缺任何一项都如实说明缺什么。
      const p = d.activeProvider()
      if (!p) {
        adapter.available = false
        adapter.unavailableReason = '尚未配置供应商（设置 → 供应商配置）'
        return
      }
      const gate = egressAllowed(`${p.baseUrl.replace(/\/+$/, '')}/chat/completions`)
      if (!gate.ok) {
        adapter.available = false
        adapter.unavailableReason = `端点被出网闸门拒绝：${gate.message}`
        return
      }
      if (!d.apiKeyOf(p.id)) {
        adapter.available = false
        adapter.unavailableReason = `供应商「${p.label}」尚未配置密钥`
        return
      }
      adapter.available = true
      adapter.unavailableReason = null
    },

    descriptor: () => {
      const p = d.activeProvider()
      if (!p) return null
      // ⚠ 只给主机名，不给完整 URL（URL 里可能有查询串）
      return { id: p.id, label: p.label, kind: p.kind, baseUrlHost: hostOf(p.baseUrl), model: p.model }
    },

    chat: (o, cb) => {
      const p = d.activeProvider()
      if (!p) {
        // 不抛异常：回调式失败（与 chat-client 的契约一致）
        queueMicrotask(() => cb.onError({ code: 'no-provider', message: '尚未配置供应商', retryable: false }))
        return { abort: () => { /* 已结束 */ }, id: 'llm-noop' }
      }
      const key = d.apiKeyOf(p.id)
      // 每次调用都重新走一遍闸门（配置可能在两次调用之间被改过）
      const gate = egressAllowed(`${p.baseUrl.replace(/\/+$/, '')}/chat/completions`)
      if (!gate.ok) {
        queueMicrotask(() => cb.onError({ code: 'bad-response', message: gate.message, retryable: false }))
        return { abort: () => { /* 已结束 */ }, id: 'llm-blocked' }
      }
      return startChat({
        provider: p,
        apiKey: key,
        messages: o.messages,
        ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
        ...(o.maxTokens !== undefined ? { maxTokens: o.maxTokens } : {}),
        ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
      }, cb)
    },
  }
  return adapter
}
