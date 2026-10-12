/**
 * apps/desktop/src/main/capabilities/index.ts —— 主进程侧的适配器装配（**唯一装配点**）
 *
 * 设计意图：
 *   · 业务代码（bootstrap / ipc / 引擎）只拿 `kit` 与"活跃适配器"，
 *     不 import 任何具体实现；
 *   · 换实现 = 换这里的注册行（或新增一行并调 `activate()`）；
 *   · `profile` 由"是不是打包形态"决定，从而决定**许可闸门的严格度**。
 *
 * ⚠ 本文件必须**幂等**：重复 `createCapabilityKit()` 不该注册出两套适配器
 *   （实测踩过的同类问题：引擎被启动两次 ⇒ 两个 tick 循环）。
 */
import { createKit, createToolRegistry, toolManifestForModel, type Kit, type ToolRegistry } from '@airimate/companion-kit'
import type { RuntimeProfile } from '@airimate/companion-kit'
import { existsSync } from 'node:fs'
import { createSapiTtsAdapter, createSilentTtsAdapter, type TtsAdapter } from './tts-adapter.js'
import { createOpenAiCompatLlmAdapter, type LlmAdapter } from './llm-adapter.js'
import { createCatalogAssetAdapter, type AssetAdapter } from './asset-adapter.js'
import { createMotionAdapter, type MotionAdapter } from './motion-adapter.js'
import { createPrivacyAdapter, createStorageAdapter } from './data-adapters.js'
import {
  createForbiddenTools, createScreenToolAdapter, createWakeWordAdapter, createWindowsSttAdapter,
} from './future-adapters.js'
import { computerUseTools, onCaptureNotice, screenStatus } from '../computer-use.js'
import { voiceStatus, onVoiceNotice, setVoiceTts } from '../voice-engine.js'
import { onCallNotice, voiceCallPreflight, voiceCallState } from '../voice-call.js'
import { STORE_DESCRIPTORS } from '@airimate/companion-kit'
import {
  storeMigrationStates, unregisteredStoreTags, registeredStores,
} from '../store-registry.js'
import { activeProvider, getProvider } from '../provider-store.js'
import { privacySummary } from '../privacy.js'
import { appPaths } from '../paths.js'
import { secretStore } from '../secrets-store.js'
import { loadSettings } from '../settings-store.js'
import { decidePermission, getPermission } from '../permission-store.js'
import { digestOf, recordToolCall } from '../tool-audit.js'
import { setMotionSource } from '../motion-state.js'
import { broadcast } from '../event-sink.js'
import { IPC, TtsStateEventSchema } from '@airimate/shared'
import { log } from '../log.js'

export interface CapabilityBundle {
  kit: Kit
  tools: ToolRegistry
  /** 当前生效的 TTS 适配器（**不要自己再造 engine 实例**） */
  tts: () => TtsAdapter
  /** SAPI 适配器本体（即使当前生效的是静音兜底，也拿得到它用于诊断） */
  sapi: () => TtsAdapter
  llm: () => LlmAdapter
  asset: () => AssetAdapter
  /** 给模型看的工具清单（`denied` 的不会出现） */
  toolManifest: () => Array<{ name: string, description: string, paramsHint: string }>
}

let bundle: CapabilityBundle | null = null

/**
 * 两个"出口回调"（由 bootstrap 在 IPC 就绪后注入）。
 *
 * 为什么用回调而不是直接 import：`ipc.ts` 需要 import 本模块来注册四个只读通道，
 * 而截图提示/语音事件要往 renderer 推 —— 直接 import 会形成循环依赖
 * （ESM 下不一定会立刻炸，但那种"能不能跑看求值顺序"的结构本身就是缺陷）。
 */
let confirmRequester: ((tool: string, permissionKind: string, paramsDigest: string) => Promise<boolean>) | null = null
let captureNoticeSink: ((n: unknown) => void) | null = null
let voiceNoticeSink: ((n: unknown) => void) | null = null
let callNoticeSink: ((n: unknown) => void) | null = null

/**
 * 隐私两条通道"到底注册没注册"的**纯读探针**（由 bootstrap 在 IPC 就绪后注入）。
 *
 * ⚠ 为什么又用回调、而不是直接 `import { ... } from '../ipc.js'`：
 *   本工程为拆掉 `ipc → capabilities → ipc` 这个环**专门抽过 `event-sink.ts`**
 *   （见 `ipc.ts` 的注释）。这里再反向 import 一次，等于把刚拆掉的环接回去 ——
 *   而 ESM 下这种环**不一定立刻炸**，只在特定求值顺序下出错，
 *   属于"能不能跑看运气"的结构，正是本项目明确不要的东西。
 *
 * 未注入时按"没接线"算（`privacy` 适配器会如实报不可用）—— 绝不乐观当 true。
 */
let privacyChannelProbe: (() => { exportAvailable: boolean, wipeAvailable: boolean }) | null = null

/** 注入隐私通道探针（**纯读**：只回答"通道注册了没"，不触发任何导出/删除） */
export function setPrivacyChannelProbe(fn: () => { exportAvailable: boolean, wipeAvailable: boolean }): void {
  privacyChannelProbe = fn
}

/** 注入"用户确认"通道（renderer 的确认弹窗）。未注入时 confirm 档一律拒绝执行。 */
export function setConfirmRequester(fn: (tool: string, permissionKind: string, paramsDigest: string) => Promise<boolean>): void {
  confirmRequester = fn
}
/** 注入截图提示出口（用户要求"截图前显示提示"） */
export function setCaptureNoticeSink(fn: (n: unknown) => void): void {
  captureNoticeSink = fn
}
/** 注入语音事件出口（麦克风状态/唤醒提示） */
export function setVoiceNoticeSink(fn: (n: unknown) => void): void {
  voiceNoticeSink = fn
}

/**
 * ★ 一次性接线 M3 的四个出口（在 IPC 就绪后由 bootstrap 调用）。
 *
 * 为什么集中一个函数：四个出口都依赖 `event-sink` / `tool-confirm`，
 * 而这两个模块不能反向 import 本模块（会形成 `ipc → capabilities → ipc` 循环）。
 * 集中注入让"谁负责接哪根线"一眼可见，也避免漏接某一根
 * （漏接的后果是**静默**的：截图提示不显示、确认弹窗不出现）。
 */
export function wireM3Outlets(o: {
  confirm: (tool: string, permissionKind: string, paramsDigest: string) => Promise<boolean>
  screenNotice: (n: unknown) => void
  voiceNotice: (n: unknown) => void
  /** 语音通话事件（含**回复文本**，仅用于气泡显示；不写日志） */
  callNotice: (n: unknown) => void
}): void {
  setConfirmRequester(o.confirm)
  setCaptureNoticeSink(o.screenNotice)
  setVoiceNoticeSink(o.voiceNotice)
  callNoticeSink = o.callNotice
  onCallNotice((n) => { callNoticeSink?.(n) })
}

/**
 * 判定运行形态（**决定许可闸门的严格度，必须想清楚**）。
 *
 * 四种来源，优先级从高到低：
 *   ① `AIRIMATE_PROFILE=packaged|development` —— **显式声明**（发布脚本/商业构建用它）；
 *   ② `AIRIMATE_WORKSPACE` 存在 ⇒ **私有自用安装/开发树** ⇒ `development`；
 *   ③ `app.isPackaged` ⇒ `packaged`；
 *   ④ 其余 ⇒ `development`。
 *
 * ⚠ 这里的顺序是**两次真实失败**换来的，两个坑都记下来：
 *
 *   坑 A：把"存在 `AIRIMATE_WORKSPACE`"**直接**当成 packaged。
 *     后果：私有自用安装被判成"分发形态"，私有 VRM 被许可闸门拒掉 ⇒ **装完没有角色**。
 *
 *   坑 B：只看 `app.isPackaged`，不管 workspace。
 *     后果**一模一样**，而且更隐蔽：本项目把 `electron.exe` **改名**成
 *     `AiriMateOne.exe`，Electron 判定"打包"的依据正是**可执行文件名不是 electron**
 *     ⇒ 组装出来的 `dist-package\AiriMateOne.exe` 即使跑的是工作区里的 `app/main`
 *     （`AIRIMATE_WORKSPACE` 指过去），`isPackaged` 仍为 **true**。
 *     实测就是这个读数：`--probe kit` 在组装载荷里报 `profile=packaged`、
 *     `kit.active-avatar=false`。
 *
 * 所以：**"旁边有工作区"这件事比可执行文件名更能说明这是什么形态**。
 * 语义上也说得通 —— `AIRIMATE_WORKSPACE` 只在"没有打 asar、直接跑工作区产物"时被设置，
 * 那正是私有自用安装与开发树；真正的分发构建不会设它。
 *
 * 要发出去必须**显式**声明 `AIRIMATE_PROFILE=packaged` ⇒ "发布"成了一次有意识的动作，
 * 而不是某个环境变量的副作用。
 */
export function resolveRuntimeProfile(): RuntimeProfile {
  const override = process.env.AIRIMATE_PROFILE
  if (override === 'packaged' || override === 'development') return override
  const ws = process.env.AIRIMATE_WORKSPACE
  if (ws && ws.length > 0) return 'development'
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron') as typeof import('electron')
    if (app?.isPackaged) return 'packaged'
  } catch { /* 单测环境没有 electron ⇒ 按 development */ }
  return 'development'
}

export function createCapabilityKit(): CapabilityBundle {
  if (bundle) return bundle

  const profile = resolveRuntimeProfile()
  const kit = createKit({
    profile,
    // 商业构建可通过环境变量要求"必须允许商用"（缺省不要求，避免私有自用构建被自己挡住）
    requireCommercial: process.env.AIRIMATE_REQUIRE_COMMERCIAL === '1',
    onEvent: (e) => {
      // ⚠ 只记 id / kind / 事件 / 原因码，**不记任何内容**
      log().info('适配层事件', { kind: e.kind, id: e.id, event: e.event, reason: e.reason.slice(0, 120) }, `kit.${e.event}`)
    },
  })

  // ── 角色（许可闸门在这里生效）
  const asset = createCatalogAssetAdapter({ profile, requireCommercial: process.env.AIRIMATE_REQUIRE_COMMERCIAL === '1' })
  kit.register(asset, { priority: 10 })

  // ── 动作（① 里此前**唯一没有适配器**的一类：`byKind.motion.registered = 0`）
  //
  // 补它的理由不是"凑齐六类"，而是：动作资产与本项目的角色资产同源
  // （`catalog.json` 的 motions 块写着"由 .anim 本地转换；转换产物同样不得分发"），
  // 而此前业务代码直接 `readdirSync(motionDir)` ⇒ **动作能绕过许可闸门**。
  // 现在解析与判定都在适配器里，`motion-state.ts` 改为消费注入的结果。
  const motion = createMotionAdapter({ profile, requireCommercial: process.env.AIRIMATE_REQUIRE_COMMERCIAL === '1' })
  kit.register(motion, { priority: 10 })
  /**
   * 接线点：`motion-state.ts` 通过注入拿到动作来源**而不 import 本模块**
   * （否则 `motion-state ↔ capabilities` 成环；本工程为拆环专门抽过 `event-sink.ts`）。
   * 传的是方法而不是适配器本体，结构类型足够 —— 少一层耦合。
   */
  setMotionSource({
    resolve: () => motion.resolve(),
    manifests: () => motion.manifests(),
    assetRoot: () => motion.assetRoot(),
  })

  // ── 语音合成：SAPI 优先，静音兜底（保证调用链永不因 TTS 坏掉而断）
  //
  // `evt:tts-state` 的广播在这里接上：**引擎状态机是唯一真源**，
  // 由适配器持有（而不是让 bootstrap 再建一个引擎来报状态 ——
  // 那样会有两个 SAPI 子进程抢音频设备，tts-engine 的注释里记过这个坑）。
  const tts = createSapiTtsAdapter({
    preferredVoice: () => loadSettings().ttsVoice,
    onState: (e) => {
      // 出站前仍过一遍 schema：状态报文形状漂移必须可见（而不是静默发出去）
      const parsed = TtsStateEventSchema.safeParse(e)
      if (!parsed.success) {
        log().warn('TTS 状态报文校验失败，已丢弃', { state: e.state }, 'tts.state.invalid')
        return
      }
      broadcast(IPC.EVT_TTS_STATE, parsed.data)
    },
  })
  kit.register(tts, { priority: 10 })
  kit.register(createSilentTtsAdapter(), { priority: 900 })

  // ── LLM
  const llm = createOpenAiCompatLlmAdapter({
    activeProvider: () => activeProvider(),
    apiKeyOf: (id) => secretStore().get(id),
  })
  kit.register(llm, { priority: 10 })

  // ── M3：真实实现（语音识别 / 语音唤醒 / 屏幕理解）
  //
  // `available` 全部由各自的 `init()` **实测**决定：
  //   · STT 会枚举本机识别器（**不打开麦克风**）；
  //   · 唤醒依赖 STT 的实测结果；
  //   · 屏幕理解的"可用"= 用户是否授予了 screen-capture 权限（能力本身一定有）。
  kit.register(createWindowsSttAdapter(), { priority: 10 })
  kit.register(createWakeWordAdapter(), { priority: 20 })
  kit.register(createScreenToolAdapter(), { priority: 30 })

  /**
   * ── `storage` 与 `privacy`：框架自身的两条通道
   *
   * ★ 为什么必须注册（`--probe kit` 的实测读数）：`CAPABILITY_KINDS` 声明了 9 类，
   *   而这两类是 **`registered: 0`** —— 界面枚举能力时整类不出现。
   *   这与 `motion` 当年的缺口**同源**：类型里声明了却没人注册，
   *   而探针的 `kinds` 清单也漏列了它们 ⇒ 缺口永远不会被断言发现（本次一并修掉）。
   *
   * ⚠ 它们**不进 `SELECT_KINDS`**：那里是"每类挑一个生效实现"的语义，
   *   而这两类是"一组库 / 两条通道"，没有"选一个"的问题。
   *   但"不选"不等于"不用注册" —— 不注册就等于对用户与探针都不存在。
   *
   * ⚠ 注入的全部是**纯读**函数（`init()` 与诊断都会调它们）：
   *   绝不 mkdir、绝不触发读盘、绝不外泄绝对路径（只给计数与布尔）。
   */
  kit.register(createStorageAdapter({
    catalog: () => STORE_DESCRIPTORS.map(d => ({
      name: d.name, personal: d.personal, version: d.version, migrations: d.migrations.length,
    })),
    unregistered: () => unregisteredStoreTags(),
    registered: () => registeredStores(),
    migrationStates: () => storeMigrationStates(),
    userDataDirExists: () => { try { return existsSync(appPaths().userData) } catch { return false } },
  }), { priority: 40 })
  kit.register(createPrivacyAdapter({
    /**
     * `channels` 必须是**纯读**的：只回答"IPC 通道有没有被注册"，不触发任何导出/删除。
     * 未注入探针 ⇒ 两条都算 `false`（适配器会如实报不可用，而不是假装能用）。
     */
    channels: () => privacyChannelProbe?.() ?? { exportAvailable: false, wipeAvailable: false },
    summary: () => privacySummary(),
  }), { priority: 40 })

  // ── 工具执行器：权限判定与审计都由主进程注入
  const tools = createToolRegistry({
    decide: (permissionKind) => decidePermission(permissionKind as never).decision,
    audit: { record: (entry) => { recordToolCall(entry) } },
    /** 与审计层共用**同一个**摘要函数（格式只有一种，"格式正确"才可机械校验） */
    digest: (v) => digestOf(v),
    requestConfirm: async (tool, permissionKind, paramsDigest) => {
      /**
       * 用户确认入口：转成 renderer 的确认弹窗（`evt:tool-confirm`）。
       * **没有确认通道时一律返回 false**（= 不执行）——
       * 绝不"因为没有入口就直接放行"，那等于把 confirm 档降级成 allow。
       */
      if (!confirmRequester) {
        log().warn('工具需要确认，但没有可用的确认入口 ⇒ 拒绝执行', { tool, permissionKind, paramsDigest }, 'tool.confirm.unavailable')
        return false
      }
      try {
        return await confirmRequester(tool, permissionKind, paramsDigest)
      } catch (e) {
        log().warn('确认入口异常 ⇒ 按拒绝处理', { tool, err: e instanceof Error ? e.message : String(e) }, 'tool.confirm.failed')
        return false
      }
    },
  })

  // M3 真实工具（屏幕/文件/列目录/启动应用/剪贴板/窗口）
  for (const t of computerUseTools()) tools.register(t)
  // 高风险登记（永远 denied，不进给模型的清单）
  for (const t of createForbiddenTools()) tools.register(t)

  /**
   * 屏幕截图提示与语音事件的出口。
   *
   * ⚠ 用**注册回调**而不是直接 import `ipc.ts`：`ipc.ts` 要 import 本模块
   *   （注册四个只读通道），反向 import 会形成循环依赖。
   *   回调由 `bootstrap` 在 IPC 就绪后注入（见那里）。
   */
  onCaptureNotice((n) => { captureNoticeSink?.(n) })
  onVoiceNotice((n) => { voiceNoticeSink?.(n) })

  /**
   * ★ 把语音引擎与 TTS 引擎**接起来**（用户要求的"打断"依赖这条联动）。
   *
   * 为什么在装配点接：`voice-engine` 不能 import `tts-adapter`（会形成
   * `capabilities ↔ voice-engine` 的环），所以由**已经同时持有两者**的这里注入。
   * 漏接的后果是静默的：朗读停不下来，"打断"形同虚设。
   */
  setVoiceTts({
    speak: async (text, utteranceId, o) => {
      const r = await tts.speak(text, utteranceId, o as never)
      return { ok: r.ok === true, completed: (r as { completed?: boolean }).completed === true }
    },
    stop: () => { try { return tts.stop() } catch { return false } },
  })

  bundle = {
    kit,
    tools,
    tts: () => (kit.active<TtsAdapter>('tts') ?? tts),
    sapi: () => tts,
    llm: () => (kit.active<LlmAdapter>('llm') ?? llm),
    asset: () => (kit.active<AssetAdapter>('avatar') ?? asset),
    toolManifest: () => toolManifestForModel(tools),
  }
  return bundle
}

/** 初始化（逐个 init；失败的适配器会被标不可用，不影响其它） */
export async function initCapabilityKit(): Promise<CapabilityBundle> {
  const b = createCapabilityKit()
  await b.kit.init()
  /**
   * 选型：每类各挑一个（被许可挡住的会被跳过，理由记在事件里）。
   *
   * ⚠ 这份清单**必须与真正注册过的种类一致**。原来这里漏了 `motion`，
   *   后果很隐蔽：动作适配器**注册成功、`available: true`，但永远不会被 select** ⇒
   *   `activeId` 恒为 `null` ⇒ 表现为"动作这一类没有生效实现"，
   *   而日志里连一条警告都没有（因为 `registered` 是 1，看起来一切正常）。
   *
   *   同一个"少列一项"的错误在这一轮出现了**三次**：探针的 `kinds` 清单、
   *   这里的选型清单、以及 `AppDiagnosticsSchema` 里根本没有 motion 这一项。
   *   所以补了单测：`CAPABILITY_KINDS` 里声明过的种类，这里必须都出现在选型清单中
   *   （见 `kit-redact.test.cjs` 的源码级断言）。
   */
  for (const kind of SELECT_KINDS) {
    const r = b.kit.select(kind)
    if (!r.adapter) log().warn('该类能力没有可用实现', { kind, reason: r.reason }, 'kit.select.none')
  }
  const d = b.kit.diagnostics()
  log().info('适配层已就绪', {
    profile: d.profile, total: d.total,
    active: Object.entries(d.byKind).filter(([, v]) => v.activeId).map(([k, v]) => `${k}=${v.activeId}`).join(',') || '<none>',
    tools: b.tools.list().length,
    toolsAllowed: b.tools.list().filter(t => t.decision !== 'denied').length,
  }, 'kit.ready')
  return b
}

/**
 * 需要"每类挑一个生效实现"的种类。
 *
 * 为什么做成**导出常量**而不是内联数组：内联时它和探针的清单、类型定义三处各写一遍，
 * 漏一处不会有任何编译错误 —— 本轮就是这么漏掉 `motion` 的。
 * 导出之后单测可以直接断言"它覆盖了 `CAPABILITY_KINDS` 里该覆盖的那些"。
 *
 * `tool` / `storage` / `privacy` 不在这里：它们不是"选一个用"的语义
 * （工具是**一批**、存储是**一组**、隐私是**通道**），由各自的结构承载。
 */
export const SELECT_KINDS = ['avatar', 'motion', 'tts', 'llm', 'stt', 'wakeword'] as const

/** 只读访问已装配的适配层（**不初始化**；需要初始化请用 `initCapabilityKit()`） */
export function capabilityKit(): CapabilityBundle {
  return createCapabilityKit()
}

/** 只读诊断（IPC `kit:capabilities` 用；**不含任何用户内容与密钥**） */
export function capabilityDiagnostics(): Record<string, unknown> {
  const b = createCapabilityKit()
  const d = b.kit.diagnostics()
  return {
    profile: d.profile,
    requireCommercial: d.requireCommercial,
    total: d.total,
    byKind: d.byKind,
    adapters: b.kit.list().map(e => ({
      id: e.adapter.id,
      kind: e.adapter.kind,
      label: e.adapter.label,
      origin: e.adapter.origin,
      available: e.adapter.available,
      unavailableReason: e.adapter.unavailableReason,
      capabilities: e.adapter.capabilities,
      active: e.active,
      requiresNetwork: e.adapter.requiresNetwork,
      writesUserContent: e.adapter.writesUserContent,
      license: {
        provenance: e.adapter.license.provenance,
        redistributable: e.adapter.license.redistributable,
        commercialUse: e.adapter.license.commercialUse,
        license: e.adapter.license.license,
        attributionRequired: e.adapter.license.attributionRequired,
      },
    })),
    tools: b.tools.list(),
    /** 给模型看的清单（denied 的不在内）—— 让"模型能看到哪些工具"成为可机械验证的事实 */
    modelVisibleTools: b.tools.list().filter(t => t.decision !== 'denied').map(t => t.name),
    events: d.events.slice(-40),
    /** M3 的运行态摘要（**不含任何画面/语音内容**） */
    m3: {
      voice: voiceStatus(),
      screen: screenStatus(),
      call: voiceCallState(),
      callPreflight: voiceCallPreflight(),
    },
  }
}

/** 权限摘要（与 `permission-store` 的 digest 不同：这里给的是"适配层看到的判定结果"） */
export function toolPermissionSummary(): Array<{ tool: string, permissionKind: string, decision: string, effective: string }> {
  const b = createCapabilityKit()
  return b.tools.list().map(t => ({
    tool: t.name,
    permissionKind: t.permissionKind,
    decision: t.decision,
    effective: getPermission(t.permissionKind as never).effective,
  }))
}

/** 仅供单测：丢弃单例（避免用例之间互相污染） */
export function __resetCapabilityKitForTest(): void {
  bundle = null
}

export { getProvider }
