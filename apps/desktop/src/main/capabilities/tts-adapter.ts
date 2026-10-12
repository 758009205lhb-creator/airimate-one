/**
 * apps/desktop/src/main/capabilities/tts-adapter.ts —— 语音合成适配器
 *
 * 把现有的 `tts-engine.ts`（Windows SAPI）**包成**一个 `BaseAdapter`，
 * 于是它从"业务代码硬依赖的实现"变成"一个可替换的候选"。
 *
 * 换引擎（或换声音资产）时只需要新写一个适配器并 `register()`，
 * `bootstrap` / `ipc` / 主动引擎**一行都不用改** —— 这正是 M5 §1 要的效果。
 */
import type { BaseAdapter } from '@airimate/companion-kit'
import { platformLicense, firstPartyLicense } from '@airimate/companion-kit'
import {
  chooseVoice, createTtsEngine, listVoices, TTS_ENGINE, TTS_MAX_CHUNK_CHARS, TTS_MAX_TEXT_CHARS,
  type InstalledVoice, type TtsEngine, type TtsSpeakOptions, type TtsSpeakResult,
} from '../tts-engine.js'

export interface TtsAdapter extends BaseAdapter {
  kind: 'tts'
  /** 底层引擎实例（**只在主进程使用**；适配层不暴露给 renderer） */
  readonly engine: TtsEngine
  /** 本机可用声音（只读枚举；不含任何本机路径） */
  voices: () => Promise<{ ok: boolean, voices: InstalledVoice[], error?: string }>
  /** 当前会选中的声音（zh-CN 优先 + 用户偏好） */
  selectedVoice: (preferred: string | null) => Promise<string | null>
  speak: (text: string, utteranceId: string, o?: TtsSpeakOptions) => Promise<TtsSpeakResult>
  stop: () => boolean
}

export function createSapiTtsAdapter(o: {
  preferredVoice: () => string | null
  onState?: (e: { utteranceId: string, state: 'start' | 'end' | 'error', error?: string }) => void
}): TtsAdapter {  const engine = createTtsEngine({ preferredVoice: o.preferredVoice, onState: o.onState })

  const adapter: TtsAdapter = {
    id: 'tts.windows-sapi',
    kind: 'tts',
    label: 'Windows SAPI（系统内置）',
    origin: 'external-process',
    // 初始为 false：**只有 init() 实测枚举成功后才置 true**（禁止乐观可用）
    available: false,
    unavailableReason: '尚未初始化（未实测声音枚举）',
    capabilities: ['offline', 'no-network', 'chunked'],
    /**
     * 许可用 `platformLicense` 而不是 `firstPartyLicense`：
     * 引擎本体随 Windows 提供，**我们不分发它** ⇒ `redistributable:false`
     * 但 `commercialUse:true`（系统组件可商用）。这个区分在合规审查时是必要的。
     */
    license: platformLicense('Windows SAPI (Microsoft Speech API)', '随 Windows 提供的系统组件，不进入本应用分发载荷'),
    requiresNetwork: false,
    /** 正文经 stdin 交给子进程并落临时文件，所以如实标 true（日志里只记长度） */
    writesUserContent: true,
    note: `单块上限 ${TTS_MAX_CHUNK_CHARS} 字，全文上限 ${TTS_MAX_TEXT_CHARS} 字；正文经 stdin 传入，命令行里没有正文`,

    /**
     * 初始化 = **实测**枚举一次声音。
     * 不实测就写 `available:true` 是本项目明令禁止的"乐观可用"。
     */
    async init() {
      const r = await listVoices()
      const ok = r.ok && r.voices.length > 0
      adapter.available = ok
      adapter.unavailableReason = ok ? null : (r.error ?? '本机没有可用的语音合成声音')
      adapter.capabilities = [
        ...(r.voices.some(v => /^zh/i.test(v.culture)) ? ['has-zh-CN'] : ['no-zh-CN']),
        'offline', 'no-network', 'chunked',
      ]
    },

    get engine() { return engine },
    voices: async () => {
      const r = await listVoices()
      return r.ok
        ? { ok: true, voices: r.voices }
        : { ok: false, voices: [], error: r.error ?? '声音枚举失败' }
    },
    selectedVoice: async (preferred) => {
      const r = await listVoices()
      return r.ok ? chooseVoice(r.voices, preferred) : null
    },
    speak: (text, utteranceId, opts) => engine.speak(text, utteranceId, opts),
    stop: () => engine.stop(),
    async dispose() {
      try { engine.stop() } catch { /* 退出路径不抛 */ }
    },
  }
  return adapter
}

/**
 * 「静音」兜底适配器：**总是可用**。
 *
 * 为什么需要它：TTS 不可用时如果 `select('tts')` 返回 null，上层每个调用点都要判空；
 * 有了它，语义变成"选中了一个什么都不做的实现" —— 调用点代码不变，
 * 而 `describe()` 会**如实**告诉用户"当前没有语音输出"（不是假装成功）。
 */
export function createSilentTtsAdapter(): TtsAdapter {
  /**
   * 失败结果必须是**结构化**的（`error` 是 `{code, message}`，不是裸字符串）——
   * 这与 TTS 引擎的契约一致；写成字符串会在调用方解析时炸掉（实测被 tsc 拦下）。
   */
  const failed = (why: string): TtsSpeakResult => ({
    ok: false, completed: false, reason: 'failed',
    error: { code: 'ENGINE_UNAVAILABLE', message: why },
    engine: 'silent', voice: null, chars: 0, chunks: 0, spokenChunks: 0, durationMs: 0,
  })
  return {
    id: 'tts.silent',
    kind: 'tts',
    label: '静音（无语音输出）',
    origin: 'first-party',
    available: true,
    unavailableReason: null,
    capabilities: ['silent'],
    license: firstPartyLicense('不产生任何输出'),
    requiresNetwork: false,
    writesUserContent: false,
    note: '兜底实现：TTS 不可用时保证调用链不中断，并如实回报失败原因',
    engine: {
      speak: async () => failed('语音输出不可用（当前为静音兜底实现）'),
      stop: () => false,
      speaking: false,
      currentUtteranceId: null,
    },
    voices: async () => ({ ok: true, voices: [] }),
    selectedVoice: async () => null,
    speak: async () => failed('语音输出不可用（当前为静音兜底实现）'),
    stop: () => false,
  }
}

export { TTS_ENGINE }
