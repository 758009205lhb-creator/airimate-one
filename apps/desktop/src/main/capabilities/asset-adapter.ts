/**
 * apps/desktop/src/main/capabilities/asset-adapter.ts —— 角色/动作资产适配器
 *
 * 现状（要消除的耦合）：`bootstrap.ts` 直接读 `catalog.json` 的 `avatars[0].path`。
 * 本模块把"从哪读、挑哪个、许不许用"收进一个适配器，业务代码只拿**解析结果**。
 *
 * ★ 关键行为（用户 M5 §2/§3）：
 *   · `development` 形态：私有资产（Mate DLC）可用 —— 这是私有自用的正常形态；
 *   · `packaged` 形态：**任何非再分发来源的资产都不许用**，而且这是
 *     `judgeLicense()` 里的机械判定，不是文档约定；
 *   · 与 `scan-dist-payload.mjs` 形成两道：一道拦"运行时加载"，一道拦"进载荷"。
 */
import { dirname } from 'node:path'
import type { BaseAdapter } from '@airimate/companion-kit'
import { firstPartyLicense, privateOnlyLicense, resolveAvatars, readCatalog, type ResolveResult, type RuntimeProfile } from '@airimate/companion-kit'
import { appPaths } from '../paths.js'
import { log } from '../log.js'

export interface AssetAdapter extends BaseAdapter {
  kind: 'avatar'
  /** 解析一次清单（带缓存；`reload()` 强制重读） */
  resolve: (o?: { preferId?: string | null }) => ResolveResult
  /** 强制重读清单（用户换了资产/改了清单时） */
  reload: () => ResolveResult
  /** 当前生效角色的**模型根目录**（`app://model/` 的授权根） */
  modelRoot: () => string | null
  /** 上次解析的原始结论（诊断用；含被拒条目与原因） */
  last: () => ResolveResult | null
}

export function createCatalogAssetAdapter(o: {
  profile: RuntimeProfile
  requireCommercial?: boolean
}): AssetAdapter {
  let cached: ResolveResult | null = null
  let catalogNote = ''

  const doResolve = (preferId?: string | null): ResolveResult => {
    const file = appPaths().catalogFile
    const read = readCatalog(file)
    if (!read.ok) {
      log().warn('角色清单读取失败', { err: read.error.slice(0, 200) }, 'asset.catalog.read-failed')
      catalogNote = read.error
      return { avatars: [], all: [], rejected: [], selected: null, detail: read.error }
    }
    const raw = read.catalog
    catalogNote = typeof raw.note === 'string' ? raw.note : ''
    const res = resolveAvatars({
      catalog: raw,
      catalogDir: dirname(file),
      profile: o.profile,
      requireCommercial: o.requireCommercial ?? false,
      preferId: preferId ?? null,
    })
    // ⚠ 只记计数与原因码，**不记路径**（路径含用户名/目录结构，属于隐私）
    log().info('角色资产已解析', {
      total: res.all.length,
      usable: res.avatars.length,
      rejected: res.rejected.length,
      selected: res.selected?.id ?? '<none>',
      profile: o.profile,
      provenance: res.selected?.license.provenance ?? '<none>',
    }, 'asset.resolve')
    if (res.rejected.length) {
      log().warn('部分角色条目被拒（许可或文件缺失）', {
        reasons: res.rejected.slice(0, 4).map(r => `${r.id}:${r.reason}`).join(' | '),
      }, 'asset.resolve.rejected')
    }
    return res
  }

  const adapter: AssetAdapter = {
    id: 'asset.catalog-vrm',
    kind: 'avatar',
    label: '本地清单 + VRM 角色',
    origin: 'first-party',
    available: false,
    unavailableReason: '尚未初始化',
    capabilities: ['vrm', 'app-protocol', 'path-allowlist', 'license-gated'],
    /**
     * 适配器自身是自研的 ⇒ 可再分发；它**加载的资产**另有许可（见 `resolve()` 的结论）。
     * 这个区分很重要：适配器能进分发载荷 ≠ 它加载的资产能。
     */
    license: firstPartyLicense('加载器自研；被加载资产的许可由 asset-resolver 逐条判定'),
    requiresNetwork: false,
    writesUserContent: false,
    note: '清单只存路径引用与完整性信息，不复制资产；renderer 只能经 app://model/ 读取已授权根下的文件',

    async init() {
      const res = doResolve(null)
      cached = res
      adapter.available = res.selected !== null
      adapter.unavailableReason = res.selected
        ? null
        : (res.detail || '没有任何可用角色（清单为空或全部被许可/存在性拦下）')
    },

    resolve: (opts) => {
      const res = doResolve(opts?.preferId ?? null)
      cached = res
      return res
    },
    reload: () => {
      const res = doResolve(null)
      cached = res
      return res
    },
    modelRoot: () => {
      const p = cached?.selected?.path
      if (!p) return null
      return dirname(p)
    },
    last: () => cached,
  }

  // 把清单备注拼进 note（方便 UI 显示"这份清单是哪来的"）
  Object.defineProperty(adapter, 'note', {
    get: () => `清单：${appPaths().catalogFile}${catalogNote ? `；${catalogNote}` : ''}`,
    configurable: true,
  })

  return adapter
}

/**
 * 私有资产的许可常量（Mate DLC）。
 * 单独抽出来是为了让"这是私有资产"这件事在代码里**只有一处**，
 * 换商业资产时改这一处即可（而不是满仓库找）。
 */
export function matePrivateAssetLicense(note: string): ReturnType<typeof privateOnlyLicense> {
  return privateOnlyLicense('MateEngine Pro License v2.1 / upstream-dlc-asset', note, 'Mate Engine')
}

/**
 * ★ 脱敏：把任意文本里的**绝对路径**替换成占位符。
 *
 * 为什么必须有它（实测抓到的泄漏）：`catalog.json` 的 `source` 字段写着
 * "Mate Engine DLC（F:\deepseek harness\AI女友\repos\Mate-Engine）…"，
 * 而 `inferLicense()` 会把它带进 `license.note` ⇒ **随 `kit:assets` 出参回到 renderer**。
 * 结果就是"renderer 拿不到文件路径"这条设计被一个**说明性字段**绕过了 ——
 * 探针正是靠"投影里不得出现盘符"这条断言抓到它的。
 *
 * 投影边界（主进程 → renderer）必须做这件事，而不是指望每个来源字段都干净。
 */
export function redactPaths(text: string): string {
  if (!text) return text
  const out = text
    // ① Windows 驱动器路径（字符类里**显式允许分隔符**，否则只吃掉盘符那一小段）
    .replace(/[A-Za-z]:[\\/][\w.\\/\u4e00-\u9fff -]*/g, '<path>')
    // ② UNC 路径
    .replace(/\\\\[\w.$ -]+\\[\w.$\\ -]*/g, '<path>')
    // ③ 兜底：中文/空格把路径切碎后残留的"两段以上分隔符"片段
    .replace(/[\w.$-]+(?:[\\/][\w.$\u4e00-\u9fff -]+){2,}/g, '<path>')
    // ④ 类 Unix 多级路径（保守：至少三级，避免误伤普通斜杠文本）
    .replace(/(?<![\w:])\/(?:[\w.-]+\/){2,}[\w.-]+/g, '<path>')
  /**
   * 自查：万一还有残留盘符（正则被改坏时最容易发生），
   * 就把整段换成占位符 —— **宁可少给信息，也不漏路径**。
   */
  return /[A-Za-z]:[\\/]/.test(out) ? '<redacted: contains absolute path>' : out
}

/**
 * 把许可对象投影成**可安全给 renderer 的形状**：所有自由文本都过 `redactPaths`。
 * 返回新对象，不改原对象（原始许可信息在主进程内仍完整，供审计使用）。
 */
export function projectLicenseForRenderer(license: {
  provenance: string, redistributable: boolean, commercialUse: boolean, license: string,
  licenseSource: string | null, author: string | null, attributionRequired: boolean, note: string,
}): typeof license {
  return {
    ...license,
    licenseSource: license.licenseSource === null ? null : redactPaths(license.licenseSource),
    note: redactPaths(license.note),
  }
}

/**
 * ★ **递归**把任意出参里的每一个字符串都过一遍 `redactPaths`。
 *
 * 为什么必须有这个函数（本轮实测踩到的第二次同类缺陷）：
 *   上一次修路径泄漏时，修法是**逐个字段**点名 —— 只投影了 `license.note` 与
 *   `license.licenseSource`。而 `kit:assets` 的出参里还有另外两个自由文本字段：
 *     · `assets.detail`          ← 来自 `readCatalog()` 的 `清单不存在：<绝对路径>`
 *     · `assets.rejected[].detail` ← 来自 `文件不存在：<绝对路径>`
 *   于是同一个洞在**同一批出参里又漏了两个字段**。逐字段修补的问题在于：
 *   它依赖"每次新增字段时都记得再点一次名"，而这正是最容易忘的一步。
 *
 *   所以改成在**唯一的投影边界**上做一次深度清洗：只要值里出现盘符就会被替换，
 *   新增字段自动被覆盖，不需要任何人记得去改这里。
 *
 * 边界（刻意保留的）：
 *   · 只处理 string；number/boolean/null 原样（不可能是路径）；
 *   · 数组与普通对象递归；深度上限防止环状结构把栈打爆；
 *   · **返回新对象**，不改原对象 —— 主进程内部仍持有完整信息（审计要用）。
 */
export function redactDeep<T>(value: T, depth = 0): T {
  if (typeof value === 'string') return redactPaths(value) as unknown as T
  if (value === null || typeof value !== 'object') return value
  // 深度上限：出参都是浅层 JSON，超过就是遇到了异常结构（或环）⇒ 如实返回，不再往下走
  if (depth > 12) return value
  if (Array.isArray(value)) return value.map(v => redactDeep(v, depth + 1)) as unknown as T
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v, depth + 1)
  return out as unknown as T
}
