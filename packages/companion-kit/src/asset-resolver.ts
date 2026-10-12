/**
 * @airimate/companion-kit/asset-resolver —— 资产解析与许可闸门（M5 §2 / §3 的落点）
 *
 * 现状（要消除的耦合）：`bootstrap.ts` 直接读 `catalog.json` 的 `avatars[0].path`，
 * 于是"用哪个角色"这件事被写死在业务代码里，而且**没有任何许可判定** ——
 * 私有资产与可再分发资产走的是同一条路径。
 *
 * 本模块把它拆成两件事：
 *   ① **解析**：从清单里挑出可用条目（按优先级 + 许可判定），给出绝对路径与完整性信息；
 *   ② **判定**：`judgeLicense()` 决定这一条在当前运行形态下允不允许被加载。
 *
 * 输出形状**与旧 `catalog.json` 兼容**（`avatars[]` 的字段名不变），
 * 这样 renderer 侧（`AvatarStage.vue` → `app://model/...`）完全不用改。
 * 兼容不是妥协：真正被替换掉的是"谁来挑、凭什么挑"。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type {
  AssetLicense, CatalogAvatarRaw, CatalogRaw, LicenseVerdict, ResolvedAsset, RuntimeProfile,
} from './types.js'
import { judgeLicense, PROVENANCE_ORDER, unknownLicense } from './types.js'

export interface AssetSource {
  id: string
  label: string
  /** 绝对路径（已解析过相对路径） */
  path: string
  sha256: string | null
  bytes: number | null
  license: AssetLicense
  verdict: LicenseVerdict
  /** 该条目本身是否被启用 */
  enabled: boolean
  /** 文件是否存在（**必须实测**：清单里写着路径不等于文件还在） */
  exists: boolean
}

export interface ResolveOptions {
  /** 清单原始内容（调用方读文件；本模块不做 IO 策略） */
  catalog: CatalogRaw
  /** 清单所在目录（用于解析相对路径） */
  catalogDir: string
  profile: RuntimeProfile
  requireCommercial?: boolean
  /** 只看某个 id（不传 = 按优先级自动挑） */
  preferId?: string | null
}

export interface ResolveResult {
  /** 可用的角色（**已过许可与存在性**），按优先级排序 */
  avatars: ResolvedAsset[]
  /** 全部条目（含被拒的），供 UI 与诊断如实展示 */
  all: AssetSource[]
  /** 被拒原因汇总（按 reason 计数）—— 让"为什么没有可用角色"一眼可见 */
  rejected: Array<{ id: string, reason: LicenseVerdict['reason'], detail: string }>
  /** 当前生效角色（null = 一个都没有） */
  selected: ResolvedAsset | null
  /** 面向用户的说明（已脱敏） */
  detail: string
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null
}

/**
 * 从清单条目推断许可。
 *
 * 推断规则（**保守**，宁可少用资产也不能误判许可）：
 *   · 显式写了 `license: 'first-party' | 'CC0-1.0' | ...` 且 `redistributable: true`
 *     ⇒ 视为 `licensed`；
 *   · 写了 `source` 里含 "DLC" / "Mate" 或 `redistributable: false` ⇒ `private-only`；
 *   · 有 `license` 但没说能不能再分发 ⇒ `unknown`（**不猜**）；
 *   · 什么都没有 ⇒ `unknown`。
 */
export function inferLicense(raw: CatalogAvatarRaw): AssetLicense {
  const licenseName = str(raw.license)
  const redistributable = bool(raw.redistributable)
  const commercial = bool(raw.commercialUse)
  const source = str(raw.source) ?? ''
  const author = str(raw.author)
  const licenseSource = str(raw.licenseSource)

  const looksPrivate = /dlc|mate\s*engine|upstream/i.test(source) || /dlc|private|proprietary/i.test(licenseName ?? '')
  if (looksPrivate || redistributable === false) {
    return {
      provenance: 'private-only',
      redistributable: false,
      commercialUse: commercial ?? false,
      license: licenseName ?? 'unstated',
      licenseSource,
      author,
      attributionRequired: true,
      note: str(raw.source) ?? '清单标注为不可再分发',
    }
  }
  if (redistributable === true && licenseName) {
    return {
      provenance: 'licensed',
      redistributable: true,
      commercialUse: commercial ?? false,
      license: licenseName,
      licenseSource,
      author,
      attributionRequired: /^cc-by|mit|apache|bsd/i.test(licenseName) ? true : false,
      note: str(raw.source) ?? '',
    }
  }
  return unknownLicense(licenseName ? `清单声明了 ${licenseName} 但未说明是否可再分发` : '清单未提供许可信息')
}

/** 解析一条清单条目的路径（相对路径按清单目录解析；`file://` 前缀会被剥掉） */
export function resolveAssetPath(p: string, catalogDir: string): string {
  const cleaned = p.startsWith('file://') ? p.slice('file://'.length) : p
  return isAbsolute(cleaned) ? cleaned : resolve(catalogDir, cleaned)
}

function toSource(raw: CatalogAvatarRaw, catalogDir: string, profile: RuntimeProfile, requireCommercial: boolean): AssetSource | null {
  const id = str(raw.id)
  const path = str(raw.path)
  if (!id || !path) return null
  const abs = resolveAssetPath(path, catalogDir)
  let exists = false
  let bytes: number | null = num(raw.bytes)
  try {
    exists = existsSync(abs)
    if (exists && bytes === null) bytes = statSync(abs).size
  } catch { exists = false }
  const license = inferLicense(raw)
  return {
    id,
    label: str(raw.label) ?? id,
    path: abs,
    sha256: str(raw.sha256),
    bytes,
    license,
    verdict: judgeLicense(license, profile, requireCommercial),
    enabled: true,
    exists,
  }
}

/**
 * 解析角色清单。
 *
 * **可用 = 许可允许 + 文件存在**。两者缺一不可：
 *   · 许可不允许 ⇒ 分发形态下绝不能用（否则就是把私有资产打包发出去）；
 *   · 文件不存在 ⇒ 清单写着路径不代表文件还在（实测踩到过 catalog 指向已删除的 VRM）。
 */
export function resolveAvatars(o: ResolveOptions): ResolveResult {
  const requireCommercial = o.requireCommercial ?? false
  const rawAvatars = Array.isArray(o.catalog.avatars) ? o.catalog.avatars : []
  const all: AssetSource[] = []
  const rejected: ResolveResult['rejected'] = []

  for (const item of rawAvatars) {
    if (item === null || typeof item !== 'object') continue
    const src = toSource(item as CatalogAvatarRaw, o.catalogDir, o.profile, requireCommercial)
    if (!src) continue
    all.push(src)
    if (!src.verdict.allowed) rejected.push({ id: src.id, reason: src.verdict.reason, detail: src.verdict.detail })
    else if (!src.exists) rejected.push({ id: src.id, reason: 'denied-packaged-unknown-license', detail: `文件不存在：${src.path}` })
  }

  const usable = all.filter(s => s.verdict.allowed && s.exists)
  // 优先级：许可越宽松越优先（licensed < builtin < user-provided < private-only）
  const ordered = [...usable].sort((a, b) => {
    const d = PROVENANCE_ORDER[a.license.provenance] - PROVENANCE_ORDER[b.license.provenance]
    return d !== 0 ? d : a.id.localeCompare(b.id)
  })

  let picked: AssetSource | null = null
  if (o.preferId) picked = ordered.find(s => s.id === o.preferId) ?? null
  if (!picked) picked = ordered[0] ?? null

  const avatars: ResolvedAsset[] = ordered.map(s => ({
    id: s.id, kind: 'avatar', path: s.path, sha256: s.sha256, bytes: s.bytes,
    license: s.license, verdict: s.verdict,
  }))
  const selected: ResolvedAsset | null = picked
    ? { id: picked.id, kind: 'avatar', path: picked.path, sha256: picked.sha256, bytes: picked.bytes, license: picked.license, verdict: picked.verdict }
    : null

  const detail = ((): string => {
    if (all.length === 0) return '清单里没有任何角色条目'
    if (usable.length === 0) return `清单有 ${all.length} 个角色，但没有一个可用（${rejected.length} 个被拒）`
    if (!selected) return '没有符合 preferId 的可用角色'
    return `可用 ${usable.length} / ${all.length}；当前选中「${selected.id}」（${selected.license.license}）`
  })()

  return { avatars, all, rejected, selected, detail }
}

/**
 * 把解析结果**投影回旧 catalog 形状**（renderer 与 `bootstrap.ts` 无需改动）。
 *
 * `avatars` 只含可用条目，并且**顺序已被优先级决定** —— 旧代码取 `avatars[0]`
 * 就等于"取解析器选中的那一个"，语义天然一致。
 */
export function toLegacyCatalog(res: ResolveResult, extra: { generatedAt?: string, note?: string } = {}): {
  generatedAt: string
  note: string
  avatars: Array<{ id: string, label: string, path: string, sha256?: string, bytes?: number, license: string, redistributable: boolean, source: string }>
  licenseAudit: { total: number, usable: number, rejected: Array<{ id: string, reason: string, detail: string }>, selectedId: string | null }
} {
  return {
    generatedAt: extra.generatedAt ?? new Date().toISOString(),
    note: extra.note ?? '由 companion-kit 的 asset-resolver 解析；只含**许可允许且文件存在**的角色',
    avatars: res.avatars.map(a => ({
      id: a.id,
      label: a.id,
      path: a.path,
      ...(a.sha256 ? { sha256: a.sha256 } : {}),
      ...(a.bytes !== null ? { bytes: a.bytes } : {}),
      license: a.license.license,
      redistributable: a.license.redistributable,
      source: a.license.note,
    })),
    licenseAudit: {
      total: res.all.length,
      usable: res.avatars.length,
      rejected: res.rejected.map(r => ({ id: r.id, reason: r.reason, detail: r.detail })),
      selectedId: res.selected?.id ?? null,
    },
  }
}

/** 读清单文件（**唯一**的读盘入口：路径与解析错误都在这里归一化） */
export function readCatalog(file: string): { ok: true, catalog: CatalogRaw } | { ok: false, error: string } {
  try {
    if (!existsSync(file)) return { ok: false, error: `清单不存在：${file}` }
    return { ok: true, catalog: JSON.parse(readFileSync(file, 'utf8')) as CatalogRaw }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
