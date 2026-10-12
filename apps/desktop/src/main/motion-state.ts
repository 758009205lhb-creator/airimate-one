/**
 * apps/desktop/src/main/motion-state.ts —— 动作资产状态（供诊断与 IPC 读取）
 *
 * 主进程只负责"清单与文件是否就位"，不做任何渲染；解析与播放由 renderer 的
 * `packages/motion-director` + `packages/avatar-stage` 负责。
 *
 * ★ 数据来源**不再**是这里直接读盘，而是**注入的**动作适配器：
 *   `capabilities/index.ts` 在装配时调 `setMotionSource()` 把 `createMotionAdapter()`
 *   接进来。用注入而不是 import，是为了避免
 *   `motion-state → capabilities → motion-state` 形成环
 *   （本工程已经因为 ESM 环踩过一次 TDZ 崩溃，`event-sink.ts` 就是为拆环而抽出来的）。
 *
 *   为什么必须换成适配器：此前这里直接 `readdirSync(appPaths().motionDir)`，
 *   于是"动作从哪来"由业务代码决定，而且**没有任何许可判定** ——
 *   动作是本项目唯一一类能绕过许可闸门的资产（见 `motion-resolver.ts`）。
 *
 * ⚠ 注入缺失时**不假装有动作**：`failed` 里如实写"动作来源未接入"，
 *   而不是回退到自己读盘（回退会让适配层形同虚设，也会让许可闸门被绕过）。
 */
import type { MotionClipManifest } from '@airimate/shared'
import { log } from './log.js'

export interface MotionStatus {
  clipCount: number
  manifestCount: number
  failed: string[]
  /** 实际存在的 `.vrma` 文件名（去扩展名）；动作清单缺失时 renderer 靠它直接加载 */
  clipIds: string[]
  /** 动作许可名（UI 要能回答"这些动作是哪来的、许不许分发"） */
  license: string | null
  /** 动作来源的许可是否允许再分发 */
  redistributable: boolean | null
}

/** 适配器需要提供给本模块的最小接口（结构类型，避免反向 import 造成环） */
export interface MotionSource {
  resolve: () => {
    clips: Array<{ id: string }>
    rejected: Array<{ id: string, reason: string }>
    totalClipFiles: number
    detail: string
    license: { license: string, redistributable: boolean }
  }
  manifests: () => { manifests: MotionClipManifest[], failed: string[] }
  /** 授权根；没有可用动作时适配器自己也会返回 null */
  assetRoot: () => string | null
}

let source: MotionSource | null = null
let cached: MotionStatus | null = null

/** 由 `capabilities/index.ts` 在装配时调用（唯一接线点） */
export function setMotionSource(s: MotionSource | null): void {
  source = s
  cached = null
  log().info('动作来源已接线', { wired: s !== null }, 'motion.source.wired')
}

/** 当前是否已接线（诊断与探针用；"没接线"必须是可观测的事实） */
export function motionSourceWired(): boolean {
  return source !== null
}

export function refreshMotionStatus(): MotionStatus {
  const failed: string[] = []
  if (!source) {
    cached = {
      clipCount: 0, manifestCount: 0,
      failed: ['动作来源未接入（适配器没有接线，按"没有动作"处理）'],
      clipIds: [], license: null, redistributable: null,
    }
    return cached
  }

  let clipIds: string[] = []
  let license: string | null = null
  let redistributable: boolean | null = null
  let manifestCount = 0
  try {
    const res = source.resolve()
    clipIds = res.clips.map(c => c.id)
    license = res.license.license
    redistributable = res.license.redistributable
    /**
     * 被拒的动作也如实进 `failed`：用户看到"只有 3 个动作"时需要知道
     * "另外 12 个是因为许可被拒"，而不是以为文件丢了。
     * `detail` 由 resolver 生成，**不含绝对路径**。
     */
    if (res.rejected.length > 0) failed.push(res.detail)
    const m = source.manifests()
    manifestCount = m.manifests.length
    for (const f of m.failed) failed.push(f)
  } catch (e) {
    failed.push(`动作解析异常：${e instanceof Error ? e.message.slice(0, 160) : String(e)}`)
  }

  cached = { clipCount: clipIds.length, manifestCount, failed, clipIds, license, redistributable }
  if (failed.length) {
    log().warn('动作资产状态异常', {
      clipCount: cached.clipCount, manifestCount, failed: failed.slice(0, 6).join(' | '),
    }, 'motion.status.degraded')
  }
  return cached
}

export function motionStatus(): MotionStatus {
  return cached ?? refreshMotionStatus()
}

/** 读取全部合法 manifest（供 renderer 通过 IPC 获取；非法项被跳过并记录） */
export function loadManifests(): { manifests: MotionClipManifest[], failed: string[] } {
  if (!source) return { manifests: [], failed: ['动作来源未接入（适配器没有接线）'] }
  try {
    return source.manifests()
  } catch (e) {
    return { manifests: [], failed: [`动作清单读取异常：${e instanceof Error ? e.message.slice(0, 160) : String(e)}`] }
  }
}

/**
 * `app://asset/` 的**授权根**：只有在**确实有可用动作**时才给出。
 *
 * ★ 为什么要有这个函数（一处"说了拒、其实还读得到"的不一致）：
 *   `asset-protocol.ts` 原来无条件把 `p.motionDir` 注册成 `asset` 主机名的授权根。
 *   于是打包形态下会出现这种自相矛盾的状态：
 *   适配器判定"这些动作不可再分发 ⇒ 不可用"（`clips: []`），
 *   但协议层**照样**愿意把那个目录里的文件喂给 renderer。
 *   正常路径下 renderer 拿不到 clip id、也就不会去请求，
 *   但"授权根"是一条**独立的**防线 —— 它不该依赖"调用方不知道 id"这种默契。
 *
 *   所以：适配器说没有可用动作 ⇒ 授权根为 `null` ⇒ `asset` 主机名根本不注册 ⇒
 *   `app://asset/...` 一律 404。**判定的结论与能不能读，必须是同一件事。**
 */
export function motionAssetRoot(): string | null {
  if (!source) return null
  const st = motionStatus()
  if (st.clipCount <= 0) return null
  return source.assetRoot()
}
