/**
 * apps/desktop/src/main/capabilities/motion-adapter.ts —— 动作（motion）适配器
 *
 * 现状（要消除的耦合）：`motion-state.ts` 直接 `readdirSync(appPaths().motionDir)`
 * 与 `readdirSync(motionManifestDir)`，业务代码自己决定"动作从哪来"，
 * 而且**完全没有许可判定** —— 动作是本项目唯一一类"能绕过许可闸门"的资产。
 *
 * 本模块把"从哪读、许不许用"收进一个适配器，业务代码只拿解析结果。
 * 与 `asset-adapter.ts`（角色）是同一套路子，差别只有两处：
 *   · 动作没有"选一个"的语义（一个角色可以播很多动作）⇒ 不设 `selected`；
 *   · 动作的许可是**整批共用**的（它们由同一条 `tools/motion-lab/convert-anim.mjs`
 *     管线从 `.anim` 转出来，出处相同）⇒ 判一次即可。
 *
 * ★ 读盘只发生在这里：`motion-state.ts` 改为消费本适配器的结果。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MotionClipManifest } from '@airimate/shared'
import { MotionClipManifestSchema } from '@airimate/shared'
import type { BaseAdapter } from '@airimate/companion-kit'
import {
  firstPartyLicense, readCatalog, resolveMotions, type CatalogMotionBlock, type MotionResolveResult, type RuntimeProfile,
} from '@airimate/companion-kit'
import { appPaths } from '../paths.js'
import { log } from '../log.js'

export interface MotionAdapter extends BaseAdapter {
  kind: 'motion'
  /** 解析一次（带缓存；`reload()` 强制重读） */
  resolve: () => MotionResolveResult
  reload: () => MotionResolveResult
  last: () => MotionResolveResult | null
  /** 动作目录的**授权根**（`app://asset/` 白名单的根）；无可用 clip 时为 null */
  assetRoot: () => string | null
  /** 合法 manifest 列表（非法项被跳过并给出**不含绝对路径**的原因） */
  manifests: () => { manifests: MotionClipManifest[], failed: string[] }
}

export function createMotionAdapter(o: {
  profile: RuntimeProfile
  requireCommercial?: boolean
}): MotionAdapter {
  let cached: MotionResolveResult | null = null
  let cachedManifests: { manifests: MotionClipManifest[], failed: string[] } | null = null

  /** 读 `catalog.json` 的 `motions` 块（读不到就按"来源不明"处理，不猜） */
  const readMotionBlock = (): CatalogMotionBlock | null => {
    const read = readCatalog(appPaths().catalogFile)
    if (!read.ok) return null
    const m = read.catalog.motions
    if (m === null || typeof m !== 'object') return null
    return m as CatalogMotionBlock
  }

  const doResolve = (): MotionResolveResult => {
    const p = appPaths()
    let files: string[] = []
    if (existsSync(p.motionDir)) {
      try { files = readdirSync(p.motionDir) } catch { files = [] }
    }
    const res = resolveMotions({
      files,
      motionDir: p.motionDir,
      motions: readMotionBlock(),
      profile: o.profile,
      requireCommercial: o.requireCommercial ?? false,
    })
    // ⚠ 只记计数与许可名，**不记路径**
    log().info('动作资产已解析', {
      clips: res.clips.length,
      total: res.totalClipFiles,
      rejected: res.rejected.length,
      license: res.license.license,
      provenance: res.license.provenance,
      profile: o.profile,
    }, 'motion.resolve')
    if (res.rejected.length) {
      log().warn('部分动作条目被拒（许可或文件缺失）', {
        reasons: res.rejected.slice(0, 4).map(r => `${r.id}:${r.reason}`).join(' | '),
      }, 'motion.resolve.rejected')
    }
    return res
  }

  const loadManifests = (): { manifests: MotionClipManifest[], failed: string[] } => {
    const p = appPaths()
    const manifests: MotionClipManifest[] = []
    const failed: string[] = []
    if (!existsSync(p.motionManifestDir)) {
      /**
       * ★ 文案里**不放绝对路径**。
       *   原来这里（以及 `motion-state.ts`）写的是 `清单目录不存在: <绝对路径>`，
       *   而它会经 IPC 到 renderer 并**显示在设置页**（`SettingsPanel.vue` 直接
       *   `app.motion.failed.join('\n')`）—— 第三次踩同一个洞。
       *   用户需要知道"哪个目录、缺什么"，不需要知道盘符与用户名。
       */
      return { manifests, failed: ['动作清单目录不存在（工作区的 assets/motion/manifests）'] }
    }
    let entries: string[] = []
    try { entries = readdirSync(p.motionManifestDir).filter(x => x.toLowerCase().endsWith('.json')) } catch (e) {
      return { manifests, failed: [`动作清单目录读不动：${e instanceof Error ? e.message.slice(0, 120) : 'unknown'}`] }
    }
    for (const f of entries) {
      try {
        const raw = JSON.parse(readFileSync(join(p.motionManifestDir, f), 'utf8')) as unknown
        const parsed = MotionClipManifestSchema.safeParse(raw)
        if (parsed.success) manifests.push(parsed.data)
        else failed.push(`${f}: ${parsed.error.issues.slice(0, 3).map(i => i.message).join(';')}`)
      } catch (e) {
        failed.push(`${f}: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`)
      }
    }
    return { manifests, failed }
  }

  const adapter: MotionAdapter = {
    id: 'motion.vrma-catalog',
    kind: 'motion',
    label: '本地 VRMA 动作目录',
    origin: 'first-party',
    available: false,
    unavailableReason: '尚未初始化',
    capabilities: ['vrma', 'app-protocol', 'path-allowlist', 'license-gated'],
    /**
     * 与角色适配器同一个区分：**适配器自研可再分发**，
     * 它加载的动作资产另有许可（由 `resolve()` 逐条判定）。
     */
    license: firstPartyLicense('加载器自研；被加载动作的许可由 motion-resolver 判定'),
    requiresNetwork: false,
    writesUserContent: false,
    note: '只索引动作目录与清单，不复制资产；renderer 只能经 app://asset/ 读取已授权根下的文件',

    async init() {
      cached = doResolve()
      cachedManifests = loadManifests()
      adapter.available = cached.clips.length > 0
      adapter.unavailableReason = adapter.available ? null : cached.detail
    },
    resolve: () => {
      cached = doResolve()
      return cached
    },
    reload: () => {
      cached = doResolve()
      cachedManifests = loadManifests()
      return cached
    },
    last: () => cached,
    assetRoot: () => (cached && cached.clips.length > 0 ? appPaths().motionDir : null),
    manifests: () => {
      if (!cachedManifests) cachedManifests = loadManifests()
      return cachedManifests
    },
  }

  return adapter
}

/** 供适配器与业务共用的一份"动作根"读取（避免业务再直接碰 `appPaths().motionDir`） */
export function motionAssetDir(): string {
  return appPaths().motionDir
}
