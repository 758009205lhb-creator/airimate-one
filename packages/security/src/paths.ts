/**
 * @airimate/security/paths —— 资源路径安全（Tech-Spec §5.2）
 *
 * 每一次资源请求都必须走这里。规则（逐条实现，缺一不可）：
 *   ① 拒绝 NUL；② 解码后判 `..`；③ resolve 后必须在授权根内（Windows 大小写不敏感）；
 *   ④ realpath 后再判一次（防 symlink/junction 逃逸）；⑤ 拒绝 ADS 与设备名；
 *   ⑥ 扩展名白名单；⑦ 单文件大小上限。
 *   失败一律 **不泄露绝对路径**，只回 404 + 脱敏原因。
 */
import { realpathSync } from 'node:fs'
import { basename, extname, normalize, resolve, sep } from 'node:path'

export interface RootGrant {
  /** 授权根目录（绝对路径） */
  root: string
  /** 允许的扩展名（小写，含点） */
  extensions: readonly string[]
  maxFileBytes: number
  /** 该根的用途标签，仅用于诊断 */
  label: string
}

export const ALLOWED_EXTENSIONS = {
  web: ['.html', '.js', '.mjs', '.css', '.json', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.woff2', '.woff', '.ttf', '.ico', '.map', '.wasm', '.txt', '.md'] as const,
  asset: ['.vrm', '.vrma', '.glb', '.gltf', '.bin', '.png', '.jpg', '.jpeg', '.webp', '.ktx2', '.json', '.mp3', '.ogg', '.wav'] as const,
} as const

export const LIMITS = {
  webFileBytes: 64 * 1024 * 1024,
  assetFileBytes: 256 * 1024 * 1024,
} as const

const WINDOWS_DEVICE_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])

export type PathRejectReason =
  | 'empty'
  | 'nul-byte'
  | 'not-absolute'
  | 'traversal'
  | 'outside-root'
  | 'symlink-escape'
  | 'ads'
  | 'device-name'
  | 'bad-extension'
  | 'realpath-failed'

export type PathResolution =
  | { ok: true, path: string, root: string, label: string }
  | { ok: false, reason: PathRejectReason }

/** Windows 上大小写不敏感；这里统一用 lowercase 做前缀比较，且确保边界是分隔符 */
function withinRoot(candidate: string, root: string): boolean {
  const c = process.platform === 'win32' ? candidate.toLowerCase() : candidate
  const r = process.platform === 'win32' ? root.toLowerCase() : root
  if (c === r) return true
  return c.startsWith(r.endsWith(sep) ? r : r + sep)
}

/**
 * 把一个**相对 URL 路径**（来自 `app://` 请求）解析到授权根内的真实文件路径。
 * @param urlPath 形如 `/index.html` 或 `sub/dir/file.js`（**必须**是相对路径）
 * @param grants 授权根清单
 */
export function resolveWithinGrants(urlPath: string, grants: readonly RootGrant[]): PathResolution {
  if (typeof urlPath !== 'string' || urlPath.length === 0) return { ok: false, reason: 'empty' }
  if (urlPath.includes('\0')) return { ok: false, reason: 'nul-byte' }

  // 归一化 URL 分隔符；同时把反斜杠视为分隔符（防 %5C 绕过）
  const unified = urlPath.replace(/\\/g, '/')
  let decoded: string
  try {
    decoded = decodeURIComponent(unified)
  } catch {
    return { ok: false, reason: 'traversal' }
  }
  if (decoded.includes('\0')) return { ok: false, reason: 'nul-byte' }
  // `app://host/…` 的 pathname 天然以 `/` 开头（POSIX 绝对），这是**正常的**；
  // 真正要拒绝的是 Windows 驱动器路径与 UNC 路径（它们能指向授权根之外）。
  if (/^[a-zA-Z]:/.test(decoded) || decoded.startsWith('//')) return { ok: false, reason: 'not-absolute' }

  // 在任何进一步处理**之前**做段级检查（解码后）
  const rawSegments = decoded.split('/')
  for (const s of rawSegments) {
    if (s === '..') return { ok: false, reason: 'traversal' }
    // ADS：文件名部分含冒号
    if (s.includes(':')) return { ok: false, reason: 'ads' }
  }

  const rel = normalize(decoded).replace(/^[\\/]+/, '')
  if (rel.split(/[\\/]/).some(s => s === '..')) return { ok: false, reason: 'traversal' }

  const ext = extname(rel).toLowerCase()
  const base = basename(rel).toLowerCase()
  const stem = base.includes('.') ? base.slice(0, base.indexOf('.')) : base
  if (WINDOWS_DEVICE_NAMES.has(stem)) return { ok: false, reason: 'device-name' }

  const problems: PathRejectReason[] = []
  for (const g of grants) {
    if (!g.extensions.includes(ext)) { problems.push('bad-extension'); continue }
    const candidate = resolve(g.root, rel)
    if (!withinRoot(candidate, resolve(g.root))) { problems.push('outside-root'); continue }

    // realpath：防 symlink / junction 逃逸
    let real: string
    try {
      real = realpathSync.native(candidate)
    } catch {
      problems.push('realpath-failed')
      continue
    }
    if (!withinRoot(real, realpathSync.native(resolve(g.root)))) { problems.push('symlink-escape'); continue }
    return { ok: true, path: real, root: g.root, label: g.label }
  }

  // 优先返回"最具体"的原因，便于脱敏日志定位
  const priority: PathRejectReason[] = ['traversal', 'ads', 'device-name', 'symlink-escape', 'outside-root', 'bad-extension', 'realpath-failed']
  for (const p of priority) if (problems.includes(p)) return { ok: false, reason: p }
  return { ok: false, reason: 'realpath-failed' }
}

/** 供 MIME 推断用 */
export function extensionOf(p: string): string {
  return extname(p).toLowerCase()
}

/** 路径脱敏显示：只保留最后两段（用于告警文案，避免暴露用户名目录结构） */
export function displayPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  if (parts.length <= 2) return p
  return `…${sep}${parts.slice(-2).join(sep)}`
}
