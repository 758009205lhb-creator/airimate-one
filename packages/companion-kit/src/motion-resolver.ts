/**
 * @airimate/companion-kit/motion-resolver —— 动作（motion）资产的解析与许可闸门
 *
 * ★ 为什么要有这个文件（① 里唯一没落地的一类能力）：
 *   `CapabilityKind` 从第一天起就有 `'motion'`（"动作：clip 来源与解析"），
 *   但**从来没有注册过任何 motion 适配器** —— 实测 `byKind.motion.registered = 0`。
 *   于是"动作从哪来"这件事仍然由业务代码直接读私有目录决定
 *   （`motion-state.ts` 直接 `readdirSync(p.motionDir)`），
 *   而动作资产与角色资产一样是**私有来源**：
 *   `catalog.json` 的 `motions` 块写着
 *   "由 Mate Engine 的 .anim 动捕剪辑本地转换为 VRMA；**转换产物同样不得分发**"。
 *
 *   也就是说：在 ① 的六类里，动作这一类此前既没有适配层，也没有许可判定 ——
 *   它是唯一一个"能绕过许可闸门进分发载荷"的资产类别。
 *
 * 本模块是**纯函数**：调用方把"目录里有哪些文件、清单里写了什么"喂进来，
 * 它给出"哪些 clip 可用、哪些被拒、为什么"。读盘策略留给调用方，
 * 这样许可与存在性判定可以被单测完整覆盖（不依赖本机真的装了哪些动作）。
 */
import { existsSync, statSync } from 'node:fs'
import type { AssetLicense, LicenseVerdict, ResolvedAsset, RuntimeProfile } from './types.js'
import { judgeLicense, unknownLicense } from './types.js'

/** 动作资产在 `catalog.json` 里的 `motions` 块（字段全部可选：容忍旧清单） */
export interface CatalogMotionBlock {
  dir?: unknown
  manifestGlob?: unknown
  license?: unknown
  /** 是否允许再分发；**缺省按不可再分发处理**（保守侧） */
  redistributable?: unknown
  commercialUse?: unknown
  source?: unknown
  author?: unknown
  licenseSource?: unknown
}

export interface ResolveMotionsOptions {
  /** 动作目录里实际存在的文件名（调用方 `readdirSync` 得到；本模块不读目录） */
  files: ReadonlyArray<string>
  /** 解析动作目录时的**基准绝对路径**（用于 `existsSync` 与裁剪输出；不会被写进出参文案） */
  motionDir: string
  /** `catalog.json` 的 `motions` 块（缺失 ⇒ 按"来源不明"最保守处理） */
  motions?: CatalogMotionBlock | null
  profile: RuntimeProfile
  requireCommercial?: boolean
}

export interface MotionResolveResult {
  /** 可用的动作 clip（**已过许可与存在性**） */
  clips: ResolvedAsset[]
  /** 被拒条目与原因 */
  rejected: Array<{ id: string, reason: LicenseVerdict['reason'], detail: string }>
  /** 动作目录里 `.vrma` 的总数（含被拒的），用于"为什么只剩这么几个"的核对 */
  totalClipFiles: number
  /** 面向用户的说明（**不含任何绝对路径**） */
  detail: string
  /** 本次判定用的许可（整批动作共用一份，因为它们是同一条转换管线产出的） */
  license: AssetLicense
}

/** 只有 `.vrma` 算动作 clip；大小写不敏感（Windows 上实测存在 `.VRMA`） */
const CLIP_EXT = '.vrma'

/**
 * 许可文本里**明确写着不许分发**的措辞。
 *
 * 为什么需要它（实测读数逼出来的）：本项目自己的清单写的是
 *   `"license": "由 Mate Engine 的 .anim 动捕剪辑本地转换为 VRMA；转换产物同样不得分发"`
 * —— 它**已经把结论写清楚了**（不得分发）。第一版 `inferMotionLicense()` 只看
 * `redistributable` 字段，没写就归到 `unknown`，于是读数变成
 * `license: "unknown"` —— 比事实**更不确定**，界面上也就无法把
 * "明确私有" 与 "来源不明" 分开。
 *
 * 保守方向没变（两者都不可再分发），但**信息量不该被丢掉**：
 * 判成 `private-only` 之后，打包形态给出的原因码是
 * `denied-packaged-non-redistributable`（"我们知道它是私有资产"），
 * 而不是 `denied-packaged-unknown-license`（"我们什么都不知道"）——
 * 前者才能让用户看懂"要换资产"，后者只会让人以为清单坏了。
 */
const NON_REDISTRIBUTABLE_WORDING = /不得分发|禁止分发|不可再分发|不得再分发|仅限本机|not\s+for\s+redistribution|non-?redistributable|do\s+not\s+distribute/i

/**
 * 推断整批动作资产的许可。
 *
 * 保守规则（与 `inferLicense()` 同精神）：
 *   · `redistributable: true` **且**写了 `license` ⇒ 视为 `licensed`；
 *   · `redistributable: false` ⇒ `private-only`；
 *   · 没写 `redistributable`，但许可文本里**明确写了不许分发** ⇒ `private-only`（见上面常量）；
 *   · 写了 `license` 但既没说能不能再分发、也没有明确措辞 ⇒ `unknown`（**不猜**）；
 *   · 什么都没有 ⇒ `unknown`。
 */
export function inferMotionLicense(raw: CatalogMotionBlock | null | undefined): AssetLicense {
  const block = raw ?? {}
  const licenseName = typeof block.license === 'string' && block.license.trim().length > 0 ? block.license.trim() : null
  const redistributable = typeof block.redistributable === 'boolean' ? block.redistributable : null
  const commercial = typeof block.commercialUse === 'boolean' ? block.commercialUse : null
  const sourceNote = typeof block.source === 'string' && block.source.trim().length > 0 ? block.source.trim() : null
  const author = typeof block.author === 'string' && block.author.trim().length > 0 ? block.author.trim() : null
  const licenseSource = typeof block.licenseSource === 'string' && block.licenseSource.trim().length > 0
    ? block.licenseSource.trim()
    : null

  if (redistributable === true && licenseName) {
    return {
      provenance: 'licensed',
      redistributable: true,
      commercialUse: commercial ?? false,
      license: licenseName,
      licenseSource,
      author,
      attributionRequired: /^cc-by|mit|apache|bsd/i.test(licenseName),
      note: sourceNote ?? '',
    }
  }
  /**
   * `redistributable: false` 是显式声明；许可文本里的"不得分发"是**等价强度的证据**。
   * 两者都进 `private-only` —— 但 `note` 要写清是哪一种，
   * 否则"清单明确声明"与"我们从措辞里读出来的"在排障时就分不开了。
   */
  const explicitFalse = redistributable === false
  const wordingSaysNo = !explicitFalse && licenseName !== null && NON_REDISTRIBUTABLE_WORDING.test(licenseName)
  if (explicitFalse || wordingSaysNo) {
    return {
      provenance: 'private-only',
      redistributable: false,
      commercialUse: commercial ?? false,
      license: licenseName ?? 'unstated',
      licenseSource,
      author,
      attributionRequired: true,
      note: sourceNote ?? (explicitFalse
        ? '清单标注为不可再分发'
        : '许可文本明确写了不得分发（据此判定，而非清单缺字段）'),
    }
  }
  return unknownLicense(licenseName
    ? `清单声明了 ${licenseName} 但未说明是否可再分发`
    : '清单没有 motions 许可信息（按最保守处理）')
}

/**
 * 解析动作资产。
 *
 * **可用 = 许可允许 + 文件存在**，与角色同一把尺子。缺一不可：
 *   · 许可不允许 ⇒ 分发形态下绝不能用（否则私有动捕产物就随包发出去）；
 *   · 文件不存在 ⇒ `readdirSync` 的条目与磁盘状态之间可能有时间差。
 */
export function resolveMotions(o: ResolveMotionsOptions): MotionResolveResult {
  const requireCommercial = o.requireCommercial ?? false
  const license = inferMotionLicense(o.motions ?? null)
  const verdict = judgeLicense(license, o.profile, requireCommercial)

  const clipFiles = o.files.filter(f => f.toLowerCase().endsWith(CLIP_EXT))
  const clips: ResolvedAsset[] = []
  const rejected: MotionResolveResult['rejected'] = []

  for (const file of clipFiles) {
    const id = file.slice(0, -CLIP_EXT.length)
    const abs = joinPath(o.motionDir, file)
    let exists = false
    let bytes: number | null = null
    try {
      exists = existsSync(abs)
      if (exists) bytes = statSync(abs).size
    } catch { exists = false }

    if (!verdict.allowed) {
      /**
       * ⚠ `detail` 里**不放绝对路径**：这个字符串会经 IPC 到 renderer 并显示在设置页。
       *    只给 id 与原因 —— 用户需要知道"哪一个、为什么"，不需要知道盘符。
       */
      rejected.push({ id, reason: verdict.reason, detail: `${id}：${verdict.detail}` })
      continue
    }
    if (!exists) {
      rejected.push({ id, reason: 'denied-packaged-unknown-license', detail: `${id}：文件在动作目录里不存在` })
      continue
    }
    clips.push({
      id, kind: 'motion', path: abs, sha256: null, bytes, license, verdict,
    })
  }

  clips.sort((a, b) => a.id.localeCompare(b.id, 'en'))

  const detail = ((): string => {
    if (clipFiles.length === 0) return '动作目录里没有 .vrma 文件'
    if (!verdict.allowed) {
      return `动作资产为私有来源（${license.license}），当前形态下不可用（${clipFiles.length} 个全部被拒）`
    }
    if (clips.length === 0) return `动作目录有 ${clipFiles.length} 个文件，但没有一个可用`
    return `可用 ${clips.length} / ${clipFiles.length}；许可：${license.license}`
  })()

  return { clips, rejected, totalClipFiles: clipFiles.length, detail, license }
}

/** 拼路径但不引入 `node:path` 之外的行为差异：统一用 `\`，因为动作目录只会在 Windows 上出现 */
function joinPath(dir: string, file: string): string {
  if (dir.endsWith('\\') || dir.endsWith('/')) return `${dir}${file}`
  return `${dir}\\${file}`
}
