/**
 * @airimate/companion-kit/types —— 适配层契约（唯一真源）
 *
 * ────────────────────────────────────────────────────────────────
 * 为什么要有这一层（用户 M5 §1）：
 *   "将角色、动作、语音、LLM、工具和存储做成适配层，不让业务代码依赖 Mate 私有资产。"
 *
 * 现状的问题：业务代码直接 `import { createTtsEngine } from './tts-engine.js'`、
 * 直接读 `catalog.json` 的 `avatars[0].path`。于是"换一个允许商用的 VRM"
 * 或"换一个语音引擎"**必须改业务代码** —— 那正是要消除的耦合。
 *
 * 本文件只定义**契约**，不含任何实现：
 *   · 业务代码（bootstrap / ipc / 引擎）只认 `CapabilityRegistry` 与这里的接口；
 *   · 具体实现（SAPI、Windows 录屏、某家 LLM）通过 `register()` 注入；
 *   · 因此 **private-only 的 Mate 资产只是"一个可替换的适配器实现"**，
 *     而不是整个产品的地基。商业版换掉那个适配器即可，业务代码一行不动。
 *
 * 纪律：
 *   · 任何"能力"都必须声明可判定属性（`describe()`），UI 与探针据此如实显示；
 *   · 任何实现都不得在 renderer 侧（否则就等于把特权能力漏出主进程）；
 *   · 不做"假装可用"：`available:false` 时必须给出 `reason`。
 */
import type { z } from 'zod'

// ───────────────────────────────────────────────────────── 能力种类

/**
 * 六类能力。**新增一类必须同时在这里、在 `CAPABILITY_KINDS` 数组里登记** ——
 * 单测会校验两者一致（漏登记会让 `list()` 静默漏掉一整类能力）。
 */
export type CapabilityKind =
  | 'avatar'    // 角色：加载 VRM/vrm 等价体
  | 'motion'    // 动作：clip 来源与解析
  | 'tts'       // 语音合成
  | 'stt'       // 语音识别
  | 'wakeword'  // 语音唤醒
  | 'llm'       // 语言模型（对话与反思）
  | 'tool'      // 电脑操作等结构化工具
  | 'storage'   // 持久化
  | 'privacy'   // 数据主体权利（导出 / 删除）

export const CAPABILITY_KINDS: readonly CapabilityKind[] = [
  'avatar', 'motion', 'tts', 'stt', 'wakeword', 'llm', 'tool', 'storage', 'privacy',
]

// ───────────────────────────────────────────────────────── 资产来源与许可

/**
 * 资产来源分类 —— 决定**能不能随分发给出**。
 *
 *   · `licensed`       随包提供、许可证明确允许再分发与商用（商业版的唯一合法来源）
 *   · `user-provided`  用户自己导入（如用户买的 VRM）；应用只是加载它，不随包分发
 *   · `private-only`   本项目自用资产（Mate Engine DLC）：**允许本机使用，禁止进入分发载荷**
 *   · `builtin-fallback` 内置的极简占位资产（自研、可再分发），保证"什么都没有时也能启动"
 *   · `unknown`        来源不明 ⇒ 按**最保守**处理（等同 private-only）
 */
export type AssetProvenance = 'licensed' | 'user-provided' | 'private-only' | 'builtin-fallback' | 'unknown'

/** 来源的严格程度（越大越保守）；`unknown` 必须比 `private-only` 更保守才安全 */
export const PROVENANCE_ORDER: Record<AssetProvenance, number> = {
  licensed: 0,
  'builtin-fallback': 1,
  'user-provided': 2,
  'private-only': 3,
  unknown: 4,
}

/**
 * 运行形态 —— 决定许可判定的**严格度**。
 *
 *   · `development`：开发者本机构建，允许私有资产（这是私有自用的正常形态）
 *   · `packaged`   ：分发载荷形态，**任何非再分发来源的资产都必须被拒**
 *
 * ⚠ 这个区分不是"给私有资产开后门"：`packaged` 形态下的拒绝是**机械的**，
 *   而且 `scan-dist-payload.mjs` 另有一道"资产文件根本不进载荷"的检查。两道一起才有意义。
 */
export type RuntimeProfile = 'development' | 'packaged'

export interface AssetLicense {
  /** 来源分类 */
  provenance: AssetProvenance
  /** 是否允许再分发（`false` 时绝不允许进入商业分发载荷） */
  redistributable: boolean
  /** 是否允许商用 */
  commercialUse: boolean
  /** 许可名（如 `CC0-1.0` / `MateEngine Pro License v2.1`）；未知必须写 `unknown` */
  license: string
  /** 许可正文或出处（URL / 文件路径 / 说明），合规审查要能追溯 */
  licenseSource: string | null
  /** 权利人 / 作者（署名要求） */
  author: string | null
  /** 是否需要署名（CC-BY 一类） */
  attributionRequired: boolean
  /** 备注（如"该目录内无独立许可文件"） */
  note: string
}

/** 最保守的许可（来源不明时的缺省值） */
export function unknownLicense(note = '来源不明，按最保守处理'): AssetLicense {
  return {
    provenance: 'unknown',
    redistributable: false,
    commercialUse: false,
    license: 'unknown',
    licenseSource: null,
    author: null,
    attributionRequired: true,
    note,
  }
}

export interface LicenseVerdict {
  allowed: boolean
  reason:
    | 'ok-licensed'
    | 'ok-development-private'
    | 'ok-user-provided'
    | 'ok-builtin-fallback'
    | 'denied-packaged-non-redistributable'
    | 'denied-packaged-unknown-license'
    | 'denied-commercial-without-commercial-right'
  /** 面向用户的一句话（已脱敏；UI 直接显示） */
  detail: string
}

/**
 * ★ 许可判定的**唯一实现**。
 *
 * 三档语义（必须精确，判据就靠它）：
 *   ① `profile === 'development'`：允许任何来源（含 private-only）—— 私有自用的正常形态；
 *   ② `profile === 'packaged'` 且 `requireCommercial`：来源必须 `licensed` 且 `commercialUse`；
 *   ③ `profile === 'packaged'` 且不要求商用：来源必须允许再分发（`licensed` / `builtin-fallback`）。
 *
 * `user-provided` 在 packaged 形态下**也可以**（用户自己的资产在用户机器上）；
 * 但"随包分发"这件事由 `scan-dist-payload.mjs` 另行机械拦截。
 */
export function judgeLicense(lic: AssetLicense, profile: RuntimeProfile, requireCommercial = false): LicenseVerdict {
  if (profile === 'development') {
    return { allowed: true, reason: 'ok-development-private', detail: '开发形态：允许本机使用任意来源资产（不得随分发给出）' }
  }
  if (lic.provenance === 'licensed') {
    if (requireCommercial && !lic.commercialUse) {
      return {
        allowed: false, reason: 'denied-commercial-without-commercial-right',
        detail: `资产「${lic.license}」未授予商用权利`,
      }
    }
    return { allowed: true, reason: 'ok-licensed', detail: `许可：${lic.license}` }
  }
  if (lic.provenance === 'builtin-fallback') {
    return { allowed: true, reason: 'ok-builtin-fallback', detail: '内置占位资产（自研，可再分发）' }
  }
  if (lic.provenance === 'user-provided') {
    return { allowed: true, reason: 'ok-user-provided', detail: '用户自备资产（仅在本机加载，不随包分发）' }
  }
  if (lic.provenance === 'unknown') {
    return {
      allowed: false, reason: 'denied-packaged-unknown-license',
      detail: '资产许可未知 ⇒ 分发形态下拒绝加载（请替换为许可明确的资产）',
    }
  }
  return {
    allowed: false, reason: 'denied-packaged-non-redistributable',
    detail: `资产为私有来源（${lic.license}），禁止进入分发载荷；商业版必须替换`,
  }
}

// ───────────────────────────────────────────────────────── 适配器公共形状

/** 一个适配器的自描述（UI / 诊断 / 探针据此显示"到底在用哪个实现"） */
export interface CapabilityDescription {
  id: string
  kind: CapabilityKind
  /** 人读名（如 `Windows SAPI`） */
  label: string
  /** 实现来源：本项目自研 / 第三方包 / 外部程序 */
  origin: 'first-party' | 'third-party' | 'external-process' | 'platform'
  /** 是否可用（**必须实测**，不许乐观返回 true） */
  available: boolean
  /** 不可用原因（`available:false` 时必填） */
  unavailableReason: string | null
  /** 该实现的能力标记（如 `['zh-CN', 'offline']`），供选型与 UI 显示 */
  capabilities: string[]
  /** 许可（第三方适配器必须写；自研写 first-party） */
  license: AssetLicense
  /** 是否需要出网（隐私审查要点） */
  requiresNetwork: boolean
  /** 是否把内容写盘（隐私审查要点） */
  writesUserContent: boolean
  /** 备注 */
  note: string
}

export interface BaseAdapter extends CapabilityDescription {
  /** 初始化（可选）。失败不是致命的：注册表会把 `available` 标成 false 并记原因。 */
  init?: () => Promise<void> | void
  /** 释放资源（可选）。退出时必须幂等。 */
  dispose?: () => Promise<void> | void
}

// ───────────────────────────────────────────────────────── 注册表

export interface RegistryEntry<A extends BaseAdapter = BaseAdapter> {
  adapter: A
  /** 是否被选为当前生效实现 */
  active: boolean
  /** 注册顺序（越小越早注册；选型时先看优先级再看顺序） */
  priority: number
  registeredAt: number
}

export interface RegistryOptions {
  profile: RuntimeProfile
  /** packaged 形态下是否要求商用权利（商业构建用；默认 false） */
  requireCommercial?: boolean
  /** 注册表自身的诊断回调（只记 id / kind / 原因码，不记正文） */
  onEvent?: (e: { kind: CapabilityKind, id: string, event: 'register' | 'activate' | 'select' | 'reject' | 'dispose' | 'init-failed', reason: string }) => void
}

/** 选型结果：**必须能解释为什么选它**（否则"为什么在用这个实现"永远说不清） */
export interface SelectionResult<A extends BaseAdapter = BaseAdapter> {
  adapter: A | null
  reason: string
  /** 被跳过的候选与原因（审计与排障的关键） */
  considered: Array<{ id: string, skipped: string }>
}

/** 解析出的资产：路径 + 完整性 + 许可 + 判定结论 */
export interface ResolvedAsset {
  id: string
  kind: 'avatar' | 'motion' | 'voice-preset'
  /** 绝对路径（**只在主进程内部流转**；renderer 只能拿到 app:// 相对形式或 id） */
  path: string
  sha256: string | null
  bytes: number | null
  license: AssetLicense
  verdict: LicenseVerdict
}

/** 主进程读到的 catalog 形状（与 assets/models/catalog.json 对齐） */
export const CatalogAvatarSchemaShape = {
  id: 'string',
  label: 'string',
  path: 'string',
  sha256: 'string?',
  bytes: 'number?',
  license: 'string?',
  redistributable: 'boolean?',
  source: 'string?',
} as const

/** 供 zod schema 复用的宽松形状（未知字段一律容忍，避免新字段让整份清单一夜失效） */
export interface CatalogAvatarRaw {
  id?: unknown
  label?: unknown
  path?: unknown
  sha256?: unknown
  bytes?: unknown
  license?: unknown
  redistributable?: unknown
  commercialUse?: unknown
  author?: unknown
  licenseSource?: unknown
  source?: unknown
}

export interface CatalogRaw {
  avatars?: unknown
  motions?: unknown
  generatedAt?: unknown
  note?: unknown
}

// ───────────────────────────────────────────────────────── 工具（M3 底座）

/** 参数校验：用 zod 的 `safeParse`（**唯一真源**，执行器与文档共用同一份） */
export interface ToolParamSchema {
  safeParse: (input: unknown) => { success: true, data: unknown } | { success: false, error: { issues: Array<{ path: Array<string | number>, message: string }> } }
}

export interface ToolSpec {
  name: string
  /** 人读说明（**会给模型看**，所以必须写清"能用它做什么、不能做什么"） */
  description: string
  /** 权限种类 —— 决定三档判定与硬下限（见 shared 的 `PERMISSION_TIER_FLOOR`） */
  permissionKind: string
  params: ToolParamSchema
  /** 超时（毫秒）。**必填**：没有超时的工具执行会把整个应用拖住 */
  timeoutMs: number
  /** 是否只读（只读工具不会产生副作用，UI 可据此提示） */
  readOnly: boolean
  /** 执行器：只在主进程；返回结构化结果，**不得抛异常**（由审计层归一化） */
  run: (params: unknown, ctx: ToolRunContext) => Promise<ToolResult>
}

export interface ToolRunContext {
  /** 审计记录 id（执行器应把它带进结果备注） */
  callId: string
  /** 取消信号（超时或用户中止） */
  signal: AbortSignal
  /** 用户是否已确认过（`confirm` 档的工具只有确认后才能拿到 true） */
  confirmed: boolean
}

export interface ToolResult {
  ok: boolean
  /** 结果摘要（**不含用户正文**；长度 + 哈希即可） */
  digest: string
  /** 面向用户的短说明（脱敏） */
  message: string
  /** 结构化数据（可选；必须可 JSON 序列化） */
  data?: unknown
}

/** 审计记录器接口（实现放在主进程；本包只定义形状，便于单测） */
export interface AuditSink {
  record: (entry: {
    callId: string
    tool: string
    decision: 'allow' | 'needs-confirm' | 'denied' | 'timeout' | 'error'
    reason: string | null
    ok: boolean | null
    durationMs: number | null
    paramsDigest: string
    resultDigest: string | null
  }) => void
}

// ───────────────────────────────────────────────────────── 存储（M5 之一）

/** 迁移步骤：`from` 版本的原始数据 → `to` 版本的数据（**必须是纯函数**，便于单测与重放） */
export interface Migration {
  from: number
  to: number
  describe: string
  migrate: (raw: unknown) => unknown
}

export interface StoreDescriptor {
  /** 逻辑名（如 `memory` / `schedules`）—— 落盘文件名由主进程决定，不放这里 */
  name: string
  /** 当前 schema 版本 */
  version: number
  /** 迁移链（按 `from` 升序；注册表会校验链是否连续、有无环） */
  migrations: readonly Migration[]
  /** 是否含用户个人数据（决定 `privacy:wipe` 是否必须删它） */
  personal: boolean
  /** 一句话说明（隐私页要展示"本机存了什么"） */
  description: string
}

/** zod 形状的宽松引用（避免本包强依赖具体 schema 实例） */
export type ZodLike<T> = z.ZodType<T, z.ZodTypeDef, unknown>
