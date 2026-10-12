/**
 * apps/desktop/src/main/asset-protocol.ts —— `app://` 自定义协议（Tech-Spec §5）
 *
 * 两个主机名（host 段即"授权根标签"）：
 *   - `app://bundle/…` → renderer 构建产物（只读）
 *   - `app://asset/…`  → 本地资产白名单根（模型 / 动作 / 目录清单；**运行期路径引用，不进分发包**）
 *
 * 安全：所有请求都过 `@airimate/security` 的 `resolveWithinGrants`
 *   （拒绝 NUL、`..`、绝对路径、ADS、设备名；realpath 后再判一次防 symlink 逃逸；扩展名白名单 + 大小上限）。
 * 失败一律 404，**不泄露绝对路径**。
 */
import { protocol, net } from 'electron'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ALLOWED_EXTENSIONS, LIMITS, displayPath, resolveWithinGrants } from '@airimate/security'
import type { RootGrant } from '@airimate/security'
import { appPaths } from './paths.js'
import { motionAssetRoot } from './motion-state.js'
import { log } from './log.js'

export const APP_SCHEME = 'app'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.vrm': 'model/gltf-binary',
  '.vrma': 'model/gltf-binary',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
}

/** 必须在 app.ready 之前调用 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        /**
         * ⚠ `corsEnabled` 必须为 true：renderer 的文档源是 `app://bundle`，而模型/动作来自
         *   `app://model` / `app://asset`（**不同 host**）。Chromium 只允许 chrome/http/https/data
         *   等 scheme 做跨源 fetch，自定义 scheme 不放行就会被 CORS 直接拒绝
         *   （实测：`Cross origin requests are only supported for protocol schemes: ...`）。
         *   放行后由我们在响应里给出精确的 Access-Control-Allow-Origin 白名单。
         */
        corsEnabled: true,
        bypassCSP: false,
      },
    },
  ])
}

/** 允许跨源读取的源（我们自己的三个 host，精确匹配，不用 `*`） */
const ALLOWED_ORIGINS = new Set([`${APP_SCHEME}://bundle`, `${APP_SCHEME}://model`, `${APP_SCHEME}://asset`])

function grants(): Record<string, RootGrant> {
  const p = appPaths()
  const modelRoot = process.env.AIRIMATE_MODEL_ROOT && existsSync(process.env.AIRIMATE_MODEL_ROOT)
    ? process.env.AIRIMATE_MODEL_ROOT
    : null
  const out: Record<string, RootGrant> = {
    bundle: { root: p.rendererDist, extensions: ALLOWED_EXTENSIONS.web, maxFileBytes: LIMITS.webFileBytes, label: 'bundle' },
  }
  /**
   * ★ `asset`（动作）的授权根**跟着动作适配器的判定走**，不再无条件指向 `motionDir`。
   *
   * 为什么（一处"说了拒、其实还读得到"的不一致）：
   *   原来这里写死 `root: p.motionDir`，而动作适配器在打包形态下会判定
   *   "这些动作不可再分发 ⇒ 不可用"（`clips: []`）。两条结论同时成立就是矛盾：
   *   **适配器说不能用，协议层却照样愿意把文件喂出去。**
   *   正常路径下 renderer 拿不到 clip id、不会去请求，但"授权根"是一条**独立防线**，
   *   不该依赖"调用方不知道 id"这种默契。
   *
   * 现在：没有可用动作 ⇒ `motionAssetRoot()` 返回 null ⇒ `asset` 主机名**根本不注册**
   * ⇒ `app://asset/...` 一律 404（`all[host]` 查不到就走 `notFound('unknown-host')`）。
   *
   * 缺失时**不注册**而不是"注册一个空目录"：前者的语义是"这个能力不存在"，
   * 后者在排障时会看起来像"目录配错了"。
   */
  const motionRoot = motionAssetRoot()
  if (motionRoot) {
    out.asset = { root: motionRoot, extensions: ALLOWED_EXTENSIONS.asset, maxFileBytes: LIMITS.assetFileBytes, label: 'asset' }
  }
  if (modelRoot) {
    out.model = { root: modelRoot, extensions: ALLOWED_EXTENSIONS.asset, maxFileBytes: LIMITS.assetFileBytes, label: 'model' }
  }
  return out
}

function notFound(reason: string, url: string): Response {
  log().debug('资源请求被拒绝', { reason, url: url.slice(0, 160) }, 'asset.reject')
  return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
}

/** 在 app.whenReady() 之后调用 */
export function handleAppScheme(): void {
  protocol.handle(APP_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return notFound('bad-url', request.url)
    }
    const host = url.hostname
    const all = grants()
    const grant = all[host]
    if (!grant) return notFound('unknown-host', request.url)

    // 跨源请求（app://bundle → app://model）的预检与放行
    const origin = request.headers.get('origin')
    const cors: Record<string, string> = {}
    if (origin && ALLOWED_ORIGINS.has(origin)) {
      cors['access-control-allow-origin'] = origin
      cors['access-control-allow-methods'] = 'GET, HEAD, OPTIONS'
      cors['access-control-allow-headers'] = 'content-type, range, if-none-match'
      cors['access-control-max-age'] = '600'
      cors['vary'] = 'Origin'
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    const res = resolveWithinGrants(url.pathname, [grant])
    if (!res.ok) return notFound(res.reason, request.url)

    let size = 0
    try {
      const st = statSync(res.path)
      if (!st.isFile()) return notFound('not-a-file', request.url)
      size = st.size
      if (size > grant.maxFileBytes) return notFound('too-large', request.url)
    } catch {
      return notFound('stat-failed', request.url)
    }

    const ext = res.path.slice(res.path.lastIndexOf('.')).toLowerCase()
    const type = MIME[ext] ?? 'application/octet-stream'
    const headers: Record<string, string> = {
      'content-type': type,
      'content-length': String(size),
      'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'bytes',
      ...cors,
    }

    // 用流式读取，避免把 57 MB 模型整体读进内存
    const stream = createReadStream(res.path)
    return new Response(stream as unknown as ReadableStream, { status: 200, headers })
  })

  log().info('app:// 协议已注册', { hosts: Object.keys(grants()).join(','), cors: 'enabled' }, 'asset.protocol.ready')
}

/** 供诊断使用（只读，不触发任何 IO 副作用） */
export function protocolInfo(): { scheme: string, hosts: Array<{ host: string, root: string, label: string }> } {
  const all = grants()
  return {
    scheme: APP_SCHEME,
    hosts: Object.entries(all).map(([host, g]) => ({ host, root: displayPath(g.root), label: g.label })),
  }
}

/** 仅在 QA 探针中使用：把 file:// 转成 app://asset 形式（不改变磁盘状态） */
export function fileToAssetUrl(host: string, absPath: string, root: string): string {
  const rel = absPath.slice(root.length).replace(/\\/g, '/').replace(/^\//, '')
  return `${APP_SCHEME}://${host}/${rel}`
}

/** 保留给未来 "net.fetch 走 file://" 的退路（当前未使用，避免死代码被误判为已启用） */
export const __unusedNetFetch = net.fetch
export const __unusedPathToFileURL = pathToFileURL
export const __unusedJoin = join
