/**
 * apps/desktop/src/main/capabilities/future-adapters.ts —— M3 适配器（**已接线**）
 *
 * 历史：本文件最初是"M3 尚未落地能力的诚实占位"。
 * M3 落地后，这里的 STT / 语音唤醒 / 屏幕理解 / 文件读取都已由真实实现替换，
 * 于是它现在只承担两件事：
 *   ① 把 M3 的真实实现**包成适配器**（供能力枚举与 UI 展示）；
 *   ② 登记**永久禁止**的高风险工具 —— 让"本应用存在哪些被禁止的能力"成为
 *      可枚举的事实，而不是文档里的一句承诺。
 *
 * ⚠ 纪律：
 *   · 适配器的 `available` 必须**实测**（`init()` 里探测），不许乐观写 true；
 *   · 禁止类工具的 `run()` **必须抛错**，绝不返回"看起来成功"的空结果 ——
 *     任何"能调用但什么都没做"的工具都是"模型伪造成功"的温床。
 */
import type { BaseAdapter, ToolSpec } from '@airimate/companion-kit'
import { firstPartyLicense, platformLicense } from '@airimate/companion-kit'
import { z } from 'zod'
import { probeVoice, voiceStatus, listenOnce, type VoiceStatus } from '../voice-engine.js'
import { screenStatus, type ScreenUiState } from '../computer-use.js'

/** 未实现的统一失败：**明确说"未实现"**，不返回空结果冒充成功 */
function notImplemented(what: string): never {
  throw new Error(`${what}：尚未实现（当前为占位适配器，不会执行任何操作）`)
}

// ───────────────────────────────────────────────────────── 语音识别（STT）

export interface SttAdapter extends BaseAdapter {
  kind: 'stt'
  /** 识别一句（语音通话循环调它 ⇒ 构成"连续对话"） */
  listenOnce: typeof listenOnce
  status: () => VoiceStatus
}

/**
 * Windows 内置 `System.Speech.Recognition`（经 PowerShell 子进程）。
 *
 * 选型理由与 TTS 完全一致：离线、许可干净（系统组件）、零下载、无需 API Key。
 * `available` 由 `init()` **实测**（枚举本机识别器，**不打开麦克风**）。
 */
export function createWindowsSttAdapter(): SttAdapter {
  const adapter: SttAdapter = {
    id: 'stt.windows-system-speech',
    kind: 'stt',
    label: 'Windows 语音识别（系统内置）',
    origin: 'external-process',
    // 初始 false：只有 init() 探测成功才置 true
    available: false,
    unavailableReason: '尚未检测（未枚举本机语音识别器）',
    capabilities: ['offline', 'no-network', 'dictation', 'single-utterance'],
    license: platformLicense('Windows System.Speech.Recognition', '随 Windows 提供的系统组件，不进入本应用分发载荷'),
    requiresNetwork: false,
    /** 会把麦克风音频交给子进程处理（**只在内存里**，不落盘）⇒ 如实标 true */
    writesUserContent: true,
    note: '默认关闭；启用后显示麦克风状态并支持一键停用。音频不落盘、不经 IPC，只有识别文本在主进程内存里流转',
    async init() {
      const r = await probeVoice()
      adapter.available = r.ok
      adapter.unavailableReason = r.ok ? null : (r.reason ?? '本机没有可用的语音识别器')
      adapter.capabilities = r.ok
        ? ['offline', 'no-network', 'dictation', 'single-utterance', `recognizers:${r.count}`]
        : ['unavailable', `recognizers:${r.count}`]
    },
    listenOnce,
    status: voiceStatus,
  }
  return adapter
}

// ───────────────────────────────────────────────────────── 语音唤醒

export interface WakeWordAdapter extends BaseAdapter {
  kind: 'wakeword'
  setWakeWord: (word: string) => void
  currentWakeWord: () => string
}

/**
 * 语音唤醒。
 *
 * ★ 用户硬要求："语音唤醒默认关闭"。这里的实现方式是：
 *   · 适配器本身可用（前提是 STT 可用）；
 *   · 但**是否真的在听**由 `settings.hearingEnabled` + 用户的一键开关决定；
 *   · `wakeWordEnabled` 默认 false（见 `voice-engine.ts` 的默认状态，有单测钉死）。
 *
 * 也就是说"可用"与"已启用"是**两件事**：能力枚举显示"可用"，而麦克风状态显示"未占用"。
 */
export function createWakeWordAdapter(): WakeWordAdapter {
  const adapter: WakeWordAdapter = {
    id: 'wakeword.windows-dictation',
    kind: 'wakeword',
    label: '语音唤醒（默认关闭）',
    origin: 'first-party',
    available: false,
    unavailableReason: '尚未检测（依赖语音识别是否可用）',
    capabilities: ['requires-microphone', 'default-off', 'user-toggleable'],
    license: firstPartyLicense('唤醒词匹配为本项目自研；识别引擎为系统组件'),
    requiresNetwork: false,
    writesUserContent: true,
    note: '默认**关闭**；启用后必须显示麦克风状态、支持唤醒词设置与一键停用。只在用户显式开启后有子进程，停用即杀',
    async init() {
      // 唤醒依赖识别能力：识别不可用时唤醒也如实标为不可用（不假装能听）
      const s = voiceStatus()
      adapter.available = s.available
      adapter.unavailableReason = s.available ? null : (s.unavailableReason ?? '语音识别不可用')
    },
    setWakeWord: (word) => {
      // 走 voice-engine 的配置入口（长度限制也在那里，避免两处各写一份）
      const { setVoiceConfig } = require('../voice-engine.js') as typeof import('../voice-engine.js')
      setVoiceConfig({ wakeWord: word })
    },
    currentWakeWord: () => voiceStatus().wakeWord,
  }
  return adapter
}

// ───────────────────────────────────────────────────────── 屏幕理解

export interface ScreenAdapter extends BaseAdapter {
  kind: 'avatar' extends never ? never : 'tool'
  status: () => ScreenUiState
}

/**
 * 屏幕理解能力（截图工具本体注册在工具表里，见 `computer-use.ts`）。
 *
 * ⚠ 它登记为 `tool` 类而不是新加一类：能力种类是**冻结的枚举**
 *   （`CAPABILITY_KINDS`，单测会校验枚举与硬下限表一致），
 *   "屏幕理解"在语义上就是"一个需要权限的工具"，没必要为它加一类。
 *   这里存在的意义是让能力枚举能如实显示"屏幕理解当前是可用的/被暂停的"。
 */
export function createScreenToolAdapter(): ScreenAdapter {
  const adapter: ScreenAdapter = {
    id: 'screen.desktop-capturer',
    kind: 'tool',
    label: '屏幕理解（按需截图，非持续录屏）',
    origin: 'platform',
    available: false,
    unavailableReason: '尚未检测',
    capabilities: ['on-demand', 'not-continuous', 'exclude-regions', 'redaction'],
    license: platformLicense('Electron desktopCapturer', '截图由操作系统与 Electron 运行时提供'),
    requiresNetwork: false,
    writesUserContent: true,
    note: '**按需触发**：只在工具被调用时截一次，本模块不注册任何定时器；截图前推提示，排除区打码，位图不出主进程',
    async init() {
      // 可用性 = 权限是否开启（截图能力本身一定有，受限的是"用户许不许用"）
      const s = screenStatus()
      adapter.available = s.permitted
      adapter.unavailableReason = s.permitted ? null : '屏幕理解未启用（需要在设置 → 权限里显式开启 screen-capture）'
      adapter.capabilities = [
        'on-demand', 'not-continuous', 'exclude-regions', 'redaction',
        ...(s.paused ? ['paused'] : []),
        `excluded-blocks:${s.excludeRegions.length}`,
      ]
    },
    status: screenStatus,
  }
  return adapter
}

// ───────────────────────────────────────────────────────── 永久禁止的工具

/**
 * 高风险工具的登记（永远 `blocked`）。
 *
 * 它们**注册进框架但永远不会出现在给模型的清单里**（`toolManifestForModel` 过滤 `denied`）。
 * 保留登记的意义：让"本应用存在哪些被永久禁止的能力"成为**可枚举的事实**，
 * 而不是散落在文档里的一句承诺。
 */
export function createForbiddenTools(): ToolSpec[] {
  const mk = (name: string, description: string, permissionKind: string): ToolSpec => ({
    name,
    description,
    permissionKind,
    params: z.object({}).passthrough(),
    timeoutMs: 1000,
    readOnly: false,
    run: async () => { throw new Error(`${name} 永久禁止执行（权限硬下限）`) },
  })
  return [
    mk('payment.pay', '支付 / 下单（**永久禁止**，不可被任何设置放宽）', 'payment'),
    mk('credential.read', '读取凭据文件（**永久禁止**）', 'credential-access'),
    mk('system.settings', '修改系统设置（**永久禁止**）', 'system-settings'),
    mk('input.simulate', '模拟键鼠（**永久禁止自动执行**）', 'input-simulate'),
    mk('shell.exec', '执行任意命令（**永久禁止**；只允许白名单化的 app.launch）', 'shell-exec'),
    mk('file.write', '写入文件（M3 未实现；即便实现也必须是 confirm 档）', 'file-write'),
  ]
}

/** 供单测导入的 `notImplemented`（保持"占位必须抛错"这条纪律可测） */
export { notImplemented }
