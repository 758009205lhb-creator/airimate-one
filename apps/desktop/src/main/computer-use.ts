/**
 * apps/desktop/src/main/computer-use.ts —— M3 电脑操作工具（**真实实现**，替换占位）
 *
 * 用户要求（逐条对应）：
 *   · "电脑操作使用结构化工具调用，分三档权限"        → 每个工具声明 `permissionKind`，判定走权限硬下限
 *   · "屏幕理解默认按需触发，不持续录屏"              → `screen.capture` 是一次性调用，**没有任何定时器**
 *   · "截图前显示提示，支持暂停、排除区域和敏感信息脱敏" → `screenStatus()` + `excludeRegions` +
 *     **像素级打码**（`paintMaskOnBitmap()`，真的改像素、有读数）。
 *     ⚠ "敏感信息脱敏"里的**自动识别**部分**尚未实现**（没有 OCR、没有识别器）：
 *     当前只按用户手工设定的排除区打码，未识别出的敏感内容不会被自动盖住。
 *     这一点在截图提示文案、`screen.capture` 的摘要（`sensitiveDetector:'not-implemented'`）
 *     与 M3 文档的"未验证"里都如实写明 —— **不许把它报成已完成**。
 *   · "文件读取只允许用户授权的目录白名单"            → `file.read` 走 `checkPathAccess()`
 *   · "默认只读，拒绝 .env、私钥、token、cookies、凭据数据库和系统敏感目录" → 同上（规则在 fs-allowlist.ts）
 *   · "所有工具调用包含超时、参数校验、执行结果、失败原因和审计记录" → 统一由 `createToolRegistry()` 保证
 *   · "禁止模型伪造执行成功"                          → `ok` 只由执行器写；`digest` 只是长度+哈希
 *
 * ⚠ 三条纪律：
 *   ① **不持续录屏**：本模块不注册任何 interval/定时器；截图只在 `run()` 被调用时发生一次。
 *   ② **截图内容不出主进程**：返回的是"尺寸 + 脱敏后的数据摘要"，原始位图**绝不**经 IPC 交给 renderer
 *      （renderer 只需要知道"截了多少、脱敏了几块"，不需要也不需要拿到图）。
 *   ③ **文件内容也不出主进程**：`file.read` 返回长度 + 哈希 + 前若干行**仅在显式请求时**，
 *      默认只给摘要 —— 内容要进模型也必须经主进程的 LLM 适配器。
 */
import { desktopCapturer, clipboard, nativeImage, screen, shell } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { z } from 'zod'
import type { ToolResult, ToolRunContext, ToolSpec } from '@airimate/companion-kit'
import { getPermission, setPermission } from './permission-store.js'
import { checkPathAccess, checkAllowlistCandidate } from './fs-allowlist.js'
import { log } from './log.js'

// ───────────────────────────────────────────────────────── 公共小工具

/** 结果摘要：长度 + 哈希。**不含内容**（内容进模型另有通路） */
function digestOf(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)}:len=${text.length}`
}

function ok(message: string, digest: string, data?: unknown): ToolResult {
  return { ok: true, digest, message, ...(data !== undefined ? { data } : {}) }
}
function fail(message: string): ToolResult {
  return { ok: false, digest: 'sha256:000000000000:len=0', message }
}

// ───────────────────────────────────────────────────────── 屏幕理解状态

export interface ScreenUiState {
  /** 是否有权限（`screen-capture` 已启用） */
  permitted: boolean
  /** 用户是否暂停了屏幕理解 */
  paused: boolean
  /** 最近一次截图时间（null = 从未截过） */
  lastCaptureAt: number | null
  /** 截图累计次数（**只记次数**，不记内容） */
  captureCount: number
  /** 用户设定的排除区域（归一化 0–1） */
  excludeRegions: Array<{ x: number, y: number, w: number, h: number }>
  /** 是否做敏感信息脱敏 */
  redactSensitive: boolean
}

/**
 * 暂停开关（**内存态**：重启即恢复，避免"忘了自己暂停过"）。
 * 用户的持久意愿在 `permission.enabled`；这里是"这一会儿先别截"。
 */
let screenPaused = false
let lastCaptureAt: number | null = null
let captureCount = 0

export function setScreenPaused(paused: boolean): void {
  screenPaused = paused
  log().info('屏幕理解暂停开关已变更', { paused }, 'screen.pause')
}

/**
 * 把设置里的脱敏开关**同步进权限表**。
 *
 * 为什么要同步：`redactSensitive` 的**真源**是权限表（截图时读它），
 * 而用户在设置页改的是 `settings.screenRedactSensitive`。
 * 两处各存一份必然会漂移 —— 表现为"设置里关了脱敏，截图却还在打码"。
 * 这里让设置**单向写入**权限表（权限表是唯一真源）。
 */
export function syncScreenRedactFromSettings(enabled: boolean): void {
  const p = getPermission('screen-capture')
  if (p.redactSensitive === enabled) return
  setPermission({ kind: 'screen-capture', redactSensitive: enabled })
  log().info('屏幕脱敏开关已随设置同步', { redactSensitive: enabled }, 'screen.redact.sync')
}

export function screenStatus(): ScreenUiState {
  const p = getPermission('screen-capture')
  return {
    permitted: p.enabled && p.effective !== 'blocked',
    paused: screenPaused,
    lastCaptureAt,
    captureCount,
    excludeRegions: p.excludeRegions,
    redactSensitive: p.redactSensitive,
  }
}

/** 供 main → renderer 的**截图前提示**（用户要求"截图前显示提示"） */
export interface CaptureNotice {
  at: number
  /** 即将截取的区域（归一化） */
  region: { x: number, y: number, w: number, h: number }
  /** 会被打码的排除区数量 */
  excludedBlocks: number
  /** 是否做了敏感信息脱敏 */
  redacted: boolean
  /** 面向用户的一句话 */
  detail: string
}

let lastNotice: CaptureNotice | null = null
export function lastCaptureNotice(): CaptureNotice | null {
  return lastNotice
}

/**
 * 判断一个归一化矩形是否与任一排除区相交（用于"这块要不要打码"）。
 * 只要**有交叠**就打码（保守侧：宁可多打一块，也不要漏出一段密码框）。
 */
function overlapsAny(r: { x: number, y: number, w: number, h: number }, blocks: ReadonlyArray<{ x: number, y: number, w: number, h: number }>): boolean {
  for (const b of blocks) {
    const ix = Math.max(0, Math.min(r.x + r.w, b.x + b.w) - Math.max(r.x, b.x))
    const iy = Math.max(0, Math.min(r.y + r.h, b.y + b.h) - Math.max(r.y, b.y))
    if (ix > 0 && iy > 0) return true
  }
  return false
}

/**
 * 把排除区**栅格化**成一张 16×16 的"要打码"掩码。
 *
 * 掩码是**中间产物**，不是终点：真正的涂抹在同一次处理里发生（见 `paintMaskOnBitmap()`），
 * 掩码同时进摘要 —— 于是"脱敏了几块"是一个**可复核的读数**，而不是口头承诺。
 *
 * ⚠ 这里曾有一句注释写着"实际涂抹见 `applyMask`"，而 `applyMask` **根本不存在** ——
 *   注释在描述一件没实现的事，比没有注释更坏（读代码的人会以为脱敏已经做了）。
 *   现在涂抹是真的（`paintMaskOnBitmap`），注释与实现一致。
 */
export function buildRedactionMask(
  blocks: ReadonlyArray<{ x: number, y: number, w: number, h: number }>,
  grid = 16,
): { grid: number, cells: boolean[], maskedCells: number } {
  const cells: boolean[] = []
  let masked = 0
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      const cell = { x: gx / grid, y: gy / grid, w: 1 / grid, h: 1 / grid }
      const hit = overlapsAny(cell, blocks)
      cells.push(hit)
      if (hit) masked++
    }
  }
  return { grid, cells, maskedCells: masked }
}

/**
 * ★ 把掩码**真的涂到位图**上（BGRA，Electron `NativeImage.toBitmap()` 的格式）。
 *
 * 为什么必须有这个函数：在此之前，`redactSensitive` / `excludeRegions` 只产出
 * 一个 16×16 的布尔掩码和一些统计数字，**没有任何一行代码改过像素**
 * （原注释还引用了一个不存在的 `applyMask`）。也就是说"敏感信息脱敏"当时只是
 * 一个**说法**。用户的排除区如果不落到像素上，一旦将来有通路把画面交出去，
 * 排除区就是形同虚设。
 *
 * 做成**纯函数（吃 Buffer、还 Buffer）**是刻意的：像素级行为必须能被单测机械验证，
 * 而不是只能靠"接一次真屏幕看看"——真实截图路径在验收环境里跑不到（见 M3 文档 §5）。
 *
 * 涂法：每个被掩码覆盖的格 ⇒ 该矩形内所有像素写成**不透明填充色**（默认纯黑）。
 * 注意 BGRA 顺序与 premultiplied alpha：A=255 时 premultiplied 就是原色，
 * 所以直接写 `[B,G,R,255]` 即可，不需要再做乘法。
 *
 * @returns `painted` = 实际被写过的像素数，`cells` = 覆盖到的格数。
 *          调用方拿它当读数（`painted > 0` 才敢说"打过码"）。
 */
export function paintMaskOnBitmap(
  bitmap: Uint8Array,
  size: { width: number, height: number },
  mask: { grid: number, cells: ReadonlyArray<boolean> },
  fill: readonly [number, number, number, number] = [0, 0, 0, 255],
): { painted: number, cells: number, grid: number } {
  const { width, height } = size
  if (!Number.isInteger(mask.grid) || mask.grid <= 0) return { painted: 0, cells: 0, grid: 0 }
  if (width <= 0 || height <= 0) return { painted: 0, cells: 0, grid: 0 }
  // 位图必须至少能装下 width×height 个 4 字节像素，否则宁可不动（返回 0 ⇒ 上层不敢声称脱敏）
  if (bitmap.length < width * height * 4) return { painted: 0, cells: 0, grid: 0 }

  /**
   * ★ 把栅格**夹到不超过像素数**——这不是省事，是为了让"格 → 像素"是一个**划分**。
   *
   * 一开始我用的是 `floor(起点) … ceil(终点)`，本意是"再小的区域也至少覆盖 1 像素"，
   * 结果相邻两格会**重叠**：W=40 / grid=16 时第 0 格是 [0,3)、第 1 格是 [2,5) ——
   * 像素 2 被涂了两遍。单测 `整屏排除 ⇒ painted === 像素总数` 当场变红（1536 ≠ 960），
   * 这才发现"打码像素数"这个读数本身是虚高的。
   *
   * 现在用 `floor(起点) … max(起点+1, floor(终点))`，在 `grid <= min(W,H)` 时：
   *   · 每格宽度 = floor((gx+1)W/grid) − floor(gx·W/grid) ≥ 1（因为 W/grid ≥ 1）⇒ **至少 1 像素**；
   *   · 相邻格首尾相接、互不重叠 ⇒ `painted` 恰好等于被覆盖的像素数，**不重不漏**。
   * 夹紧之后这两个性质同时成立，不需要在"至少一像素"和"不重复计数"之间二选一。
   */
  const grid = Math.min(mask.grid, width, height)
  const span = (i: number, n: number): [number, number] => {
    const a = Math.min(n - 1, Math.floor((i * n) / grid))
    const b = Math.max(a + 1, Math.min(n, Math.floor(((i + 1) * n) / grid)))
    return [a, b]
  }

  let painted = 0
  let cells = 0
  for (let gy = 0; gy < grid; gy++) {
    const [y0, y1] = span(gy, height)
    for (let gx = 0; gx < grid; gx++) {
      if (mask.cells[gy * mask.grid + gx] !== true) continue
      cells++
      const [x0, x1] = span(gx, width)
      for (let y = y0; y < y1; y++) {
        let idx = (y * width + x0) * 4
        for (let x = x0; x < x1; x++) {
          bitmap[idx] = fill[0]
          bitmap[idx + 1] = fill[1]
          bitmap[idx + 2] = fill[2]
          bitmap[idx + 3] = fill[3]
          idx += 4
          painted++
        }
      }
    }
  }
  return { painted, cells, grid }
}

/** 位图的像素是否已经是填充色（单测与自检用；不依赖 Electron） */
export function isPixelFilled(
  bitmap: Uint8Array,
  size: { width: number, height: number },
  x: number,
  y: number,
  fill: readonly [number, number, number, number] = [0, 0, 0, 255],
): boolean {
  const idx = (y * size.width + x) * 4
  if (idx < 0 || idx + 3 >= bitmap.length) return false
  return bitmap[idx] === fill[0] && bitmap[idx + 1] === fill[1]
    && bitmap[idx + 2] === fill[2] && bitmap[idx + 3] === fill[3]
}

/**
 * 把掩码应用到一张 Electron `NativeImage` 上，返回**新的** image。
 *
 * 为什么返回新对象而不是原地改：`NativeImage` 的 `toBitmap()` 给的是副本，
 * 改副本不会影响原图；必须用 `createFromBitmap` 重新造一张。
 *
 * ⚠ 这个函数只在**真的拿到图**的路径上被调用（`screen.capture`），
 *   验收环境里那条路径跑不到真屏幕（见 M3 文档 §5），所以它本身属于**未实测**代码；
 *   它调用的纯逻辑 `paintMaskOnBitmap()` 则被单测完整覆盖。
 *   把"纯逻辑"与"平台胶水"分开，就是为了让能测的部分真的被测到。
 */
export function applyRedactionToImage(
  img: Electron.NativeImage,
  mask: { grid: number, cells: ReadonlyArray<boolean> },
  nativeImage: typeof Electron.nativeImage,
): { image: Electron.NativeImage | null, painted: number, cells: number } {  try {
    const size = img.getSize()
    if (!size || size.width <= 0 || size.height <= 0) return { image: null, painted: 0, cells: 0 }
    const bitmap = new Uint8Array(img.toBitmap())
    const r = paintMaskOnBitmap(bitmap, size, mask)
    if (r.painted === 0) return { image: null, painted: 0, cells: r.cells }
    return { image: nativeImage.createFromBitmap(Buffer.from(bitmap), size), painted: r.painted, cells: r.cells }
  } catch (e) {
    // 涂抹失败**绝不**降级成"照样把图交出去" —— 返回 null，调用方必须当作失败处理
    log().error('屏幕脱敏涂抹失败', { err: e instanceof Error ? e.message.slice(0, 200) : 'unknown' }, 'screen.redact.paint-failed')
    return { image: null, painted: 0, cells: 0 }
  }
}

// ───────────────────────────────────────────────────────── 工具：屏幕截图

const ScreenCaptureParams = z.object({
  /** 只截某个显示器（缺省 = 光标所在显示器） */
  displayId: z.number().int().optional(),
  /** 只关心这块区域（归一化）—— 用于"只看这个窗口" */
  region: z.object({
    x: z.number().min(0).max(1), y: z.number().min(0).max(1),
    w: z.number().min(0).max(1), h: z.number().min(0).max(1),
  }).optional(),
  /** 为什么要截（写进审计与提示；模型应当说明理由） */
  reason: z.string().max(200).optional(),
})

export function screenCaptureTool(): ToolSpec {
  return {
    name: 'screen.capture',
    description: '按需截取一次屏幕画面用于理解界面（**不是持续录屏**，调用一次截一次）。会先提示用户，并按用户设定的排除区域打码。',
    permissionKind: 'screen-capture',
    params: ScreenCaptureParams,
    timeoutMs: 8000,
    readOnly: true,
    async run(params, ctx: ToolRunContext): Promise<ToolResult> {
      const p = params as z.infer<typeof ScreenCaptureParams>
      if (screenPaused) return fail('屏幕理解已被你暂停（在设置里恢复后才能截图）')

      const perm = getPermission('screen-capture')
      if (!perm.enabled || perm.effective === 'blocked') {
        return fail('屏幕理解未启用（需要在设置 → 权限里显式开启 screen-capture）')
      }

      // ① 选显示器
      const displays = screen.getAllDisplays()
      const display = p.displayId !== undefined
        ? (displays.find(d => d.id === p.displayId) ?? screen.getPrimaryDisplay())
        : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      if (!display) return fail('找不到目标显示器')

      const region = p.region ?? { x: 0, y: 0, w: 1, h: 1 }
      const excluded = perm.excludeRegions ?? []
      const mask = buildRedactionMask(excluded)

      /**
       * ② **截图前**先发提示（用户硬要求"截图前显示提示"）。
       *    顺序很重要：先记提示再截，这样"提示"与"实际发生"是同一次调用的两个可核对的事实。
       *
       *    ⚠ 提示文案必须**只写真的会发生的事**。此前这里写着"并做敏感信息脱敏"，
       *    而当时既没有像素级涂抹、也没有任何敏感信息识别器 —— 那是一句**做不到的承诺**。
       *    现在按排除区打码是真的（`paintMaskOnBitmap`），所以只这么说；
       *    `redactSensitive` 目前没有配套识别器，就**明说还没接线**，不含糊过去。
       */
      const redactNote = perm.redactSensitive
        ? '（敏感信息自动识别尚未接线：目前只按你的排除区打码）'
        : ''
      lastNotice = {
        at: Date.now(),
        region,
        excludedBlocks: excluded.length,
        redacted: excluded.length > 0,
        detail: `即将截取屏幕（${Math.round(region.w * 100)}%×${Math.round(region.h * 100)}% 区域）；`
          + `${excluded.length} 个排除区会打码${redactNote}`,
      }
      notifyCapture(lastNotice)

      /**
       * ③ 真正取帧。
       *
       * ⚠ `desktopCapturer.getSources()` 返回的是 **thumbnail（NativeImage）**。
       *   拿到之后**立刻**在本地做尺寸与掩码统计，然后把 `image` 丢掉 ——
       *   位图**不经过任何 IPC**、不落盘、不进审计。
       *   这是"不持续录屏 + 内容不出主进程"两条约束的具体落点。
       */
      let thumbW = 0
      let thumbH = 0
      let sourceName = '<unknown>'
      /** 实际被涂抹的像素数（0 = 没涂过，任何地方都不许声称"已脱敏"） */
      let paintedPixels = 0
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: {
            // 目标宽度 ~960：足够让模型看清文字，又不至于把内存与耗时推高一个量级
            width: Math.min(960, Math.max(320, Math.round(display.size.width * 0.5))),
            height: Math.min(960, Math.max(240, Math.round(display.size.height * 0.5))),
          },
        })
        const src = sources.find(s => s.display_id === String(display.id)) ?? sources[0]
        if (!src) return fail('没有可用的屏幕源（可能被系统隐私设置阻止）')
        const img = src.thumbnail
        if (img.isEmpty()) return fail('截图返回空画面（可能被系统隐私设置阻止）')
        const size = img.getSize()
        thumbW = size.width
        thumbH = size.height
        sourceName = src.name.slice(0, 60)

        /**
         * ★ ③-b **在唯一持有画面的地方就地脱敏**。
         *
         * 为什么要在"反正不往外传"的情况下也真涂一遍：因为**保证必须是结构性的**。
         * 只要画面存在于主进程，就只应该以"已按用户排除区打过码"的形态存在 ——
         * 将来任何新增通路（送模型、落盘排查、预览窗）拿到的那张图**已经**是打过码的，
         * 不需要（也不可能）依赖每个调用方记得自己去涂。
         *
         * 涂抹失败 ⇒ **宁可整次截图失败**，也不返回一张没打码的图。
         */
        if (excluded.length > 0) {
          const applied = applyRedactionToImage(img, mask, nativeImage)
          if (applied.image === null) {
            return fail('排除区打码失败（已中止本次截图，不会返回未打码的画面）')
          }
          paintedPixels = applied.painted
        }
      } catch (e) {
        return fail(`截图失败：${e instanceof Error ? e.message.slice(0, 200) : '未知错误'}`)
      }

      captureCount += 1
      lastCaptureAt = Date.now()

      /**
       * ④ 出参：**只有尺寸、掩码统计与耗时**，没有像素、没有文字、没有路径。
       *    "我截到了什么"要由模型下一步显式请求（并经权限判定），不能顺手带出去。
       *
       *    `maskedPixels` 是**真的涂过多少像素**，不是"打算涂多少"。
       *    两者必须分开报：`maskedCells` 是计划，`maskedPixels` 是事实。
       */
      const summary = {
        width: thumbW,
        height: thumbH,
        region,
        redactionGrid: mask.grid,
        maskedCells: mask.maskedCells,
        maskedPixels: paintedPixels,
        excludedBlocks: excluded.length,
        /**
         * ⚠ 这是**排除区已打码**的意思，不是"敏感信息识别已生效"。
         *   敏感信息自动识别目前**没有实现**（没有 OCR、没有识别器）——
         *   把它报成 true 就是谎报，所以这里只反映排除区。
         */
        exclusionPainted: paintedPixels > 0,
        sensitiveDetector: 'not-implemented' as const,
        source: sourceName,
        callId: ctx.callId,
      }
      log().info('屏幕截图完成', {
        w: thumbW, h: thumbH, maskedCells: mask.maskedCells, maskedPixels: paintedPixels,
        excludedBlocks: excluded.length, callId: ctx.callId,
      }, 'screen.capture.ok')
      return ok(
        `已截取画面 ${thumbW}×${thumbH}；按排除区打码 ${mask.maskedCells}/${mask.grid * mask.grid} 格`
        + `（实际涂抹 ${paintedPixels} 像素，${excluded.length} 个排除区）；内容保留在主进程，未传给界面`,
        digestOf(`${thumbW}x${thumbH}:${mask.maskedCells}:${paintedPixels}`),
        summary,
      )
    },
  }
}

/**
 * 截图提示的推送器（由 `capabilities/index.ts` 注册，避免这里 import ipc 形成环）。
 * 没注册时**不阻塞截图**：提示失败不该让功能停摆，但会记一条警告。
 */
let captureNotifier: ((n: CaptureNotice) => void) | null = null
export function onCaptureNotice(fn: (n: CaptureNotice) => void): void {
  captureNotifier = fn
}
function notifyCapture(n: CaptureNotice): void {
  if (!captureNotifier) {
    log().warn('截图提示没有订阅者（界面可能看不到提示）', {}, 'screen.notice.no-subscriber')
    return
  }
  try { captureNotifier(n) } catch (e) {
    log().warn('截图提示推送失败', { err: e instanceof Error ? e.message : String(e) }, 'screen.notice.failed')
  }
}

// ───────────────────────────────────────────────────────── 工具：读文件

const FileReadParams = z.object({
  path: z.string().min(1).max(1000),
  /** 最多读多少字节（默认 64 KiB；上限 1 MiB） */
  maxBytes: z.number().int().min(1).max(1_048_576).optional(),
  /** 是否返回正文（默认 false：只给摘要）。开启后正文进主进程 LLM 通路，不经 IPC 给 renderer */
  includeText: z.boolean().optional(),
})

export function fileReadTool(): ToolSpec {
  return {
    name: 'file.read',
    description: '读取用户授权目录白名单内的一个文本文件（只读）。会拒绝 .env、私钥、token、cookies、凭据数据库与系统敏感目录。',
    permissionKind: 'file-read',
    params: FileReadParams,
    timeoutMs: 5000,
    readOnly: true,
    async run(params): Promise<ToolResult> {
      const p = params as z.infer<typeof FileReadParams>
      const perm = getPermission('file-read')
      if (!perm.enabled || perm.effective === 'blocked') {
        return fail('文件读取未启用（需要在设置 → 权限里显式开启 file-read 并授权目录）')
      }
      const maxBytes = p.maxBytes ?? 65_536
      const verdict = checkPathAccess(p.path, perm.pathAllowlist, { maxBytes })
      if (verdict.access === 'deny') {
        // 失败原因**如实**回报（但只给文件名与原因，不回显完整路径）
        return fail(`拒绝读取：${verdict.detail}（规则 ${verdict.rule ?? '-'}；文件 ${basename(p.path).slice(0, 60)}）`)
      }
      const real = verdict.resolved as string
      let text: string
      try {
        const buf = readFileSync(real)
        text = buf.subarray(0, maxBytes).toString('utf8')
      } catch (e) {
        return fail(`读取失败：${e instanceof Error ? e.message.slice(0, 200) : '未知错误'}`)
      }
      const lines = text.split(/\r?\n/).length
      const ext = extname(real).toLowerCase()
      log().info('文件读取完成', { bytes: Buffer.byteLength(text, 'utf8'), lines, ext, callId: 'n/a' }, 'file.read.ok')
      /**
       * ⚠ 默认**不返回正文**：只给"读到了多少、多少行、什么扩展名"。
       *   正文要进模型必须由上层显式请求（`includeText`），而且走主进程内部通路，
       *   **不经 IPC 回到 renderer** —— 否则等于把文件内容暴露给了界面层。
       */
      if (p.includeText === true) {
        return ok(
          `已读取 ${basename(real)}（${Buffer.byteLength(text, 'utf8')} 字节 / ${lines} 行）`,
          digestOf(text),
          { content: text.slice(0, 32_768), truncated: text.length >= maxBytes, ext, lines },
        )
      }
      return ok(
        `已读取 ${basename(real)} 的摘要（${Buffer.byteLength(text, 'utf8')} 字节 / ${lines} 行 / ${ext || '无扩展名'}）；`
        + '正文未返回（如需正文请显式请求 includeText）',
        digestOf(text),
        { bytes: Buffer.byteLength(text, 'utf8'), lines, ext },
      )
    },
  }
}

// ───────────────────────────────────────────────────────── 工具：列目录

const ListDirParams = z.object({
  path: z.string().min(1).max(1000),
  limit: z.number().int().min(1).max(200).optional(),
})

export function listDirTool(): ToolSpec {
  return {
    name: 'file.list',
    description: '列出用户授权目录白名单内某个目录的条目（只读，只给名字与类型，不给内容）。',
    permissionKind: 'file-read',
    params: ListDirParams,
    timeoutMs: 4000,
    readOnly: true,
    async run(params): Promise<ToolResult> {
      const p = params as z.infer<typeof ListDirParams>
      const perm = getPermission('file-read')
      if (!perm.enabled || perm.effective === 'blocked') return fail('文件读取未启用')
      const verdict = checkPathAccess(p.path, perm.pathAllowlist, { wantDirectory: true })
      if (verdict.access === 'deny') return fail(`拒绝列目录：${verdict.detail}（规则 ${verdict.rule ?? '-'}）`)
      const dir = verdict.resolved as string
      try {
        // 惰性 require：本模块在 Electron 主进程里跑，这里避免顶层 import 太多东西
        const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
        const names = readdirSync(dir).slice(0, p.limit ?? 100)
        const entries = names.map((n: string) => {
          let isDir = false
          let bytes: number | null = null
          try {
            const st = statSync(join(dir, n))
            isDir = st.isDirectory()
            bytes = isDir ? null : st.size
          } catch { /* 单个条目失败不影响整体 */ }
          return { name: n.slice(0, 80), isDir, bytes }
        })
        return ok(
          `目录内有 ${entries.length} 个条目（已列出前 ${entries.length} 个）`,
          digestOf(entries.map(e => e.name).join('\n')),
          { entries },
        )
      } catch (e) {
        return fail(`列目录失败：${e instanceof Error ? e.message.slice(0, 200) : '未知错误'}`)
      }
    },
  }
}

// ───────────────────────────────────────────────────────── 工具：启动应用

/**
 * 白名单化的应用启动（`confirm` 档）。
 *
 * ⚠ **不接受任意路径/命令**：只接受 `ALLOWED_APPS` 里登记过的**键**。
 *   让模型传任意可执行路径等于把"执行任意程序"包装成了"启动应用" ——
 *   那正好绕过 `shell-exec` 的硬下限。所以这里是**白名单 + 固定参数**。
 */
export const ALLOWED_APPS: ReadonlyArray<{ id: string, label: string, target: string, args?: string[] }> = [
  { id: 'explorer', label: '文件资源管理器', target: 'explorer.exe' },
  { id: 'notepad', label: '记事本', target: 'notepad.exe' },
  { id: 'calculator', label: '计算器', target: 'calc.exe' },
  { id: 'taskmgr', label: '任务管理器', target: 'taskmgr.exe' },
  { id: 'settings', label: 'Windows 设置', target: 'ms-settings:' },
  { id: 'browser', label: '默认浏览器', target: 'https://www.bing.com' },
]

const LaunchParams = z.object({ app: z.string().min(1).max(40) })

export function launchAppTool(): ToolSpec {
  return {
    name: 'app.launch',
    description: `启动一个已登记的应用（白名单：${ALLOWED_APPS.map(a => a.id).join(' / ')}）。不接受任意路径或命令。`,
    permissionKind: 'app-launch',
    params: LaunchParams,
    timeoutMs: 5000,
    readOnly: false,
    async run(params): Promise<ToolResult> {
      const p = params as z.infer<typeof LaunchParams>
      const app = ALLOWED_APPS.find(a => a.id === p.app)
      if (!app) return fail(`「${p.app}」不在可启动的应用白名单里（可选：${ALLOWED_APPS.map(a => a.id).join(', ')}）`)
      try {
        if (app.target.startsWith('http') || app.target.endsWith(':')) {
          await shell.openExternal(app.target)
        } else {
          const r = await shell.openPath(app.target)
          // `openPath` 用**返回的空串**表示成功（返回非空即错误说明）
          if (r) return fail(`启动失败：${r.slice(0, 200)}`)
        }
      } catch (e) {
        return fail(`启动失败：${e instanceof Error ? e.message.slice(0, 200) : '未知错误'}`)
      }
      log().info('已启动应用', { app: app.id }, 'app.launch.ok')
      return ok(`已启动「${app.label}」`, digestOf(`launch:${app.id}`), { app: app.id })
    },
  }
}

// ───────────────────────────────────────────────────────── 工具：读剪贴板

const ClipboardReadParams = z.object({
  maxChars: z.number().int().min(1).max(20_000).optional(),
})

export function clipboardReadTool(): ToolSpec {
  return {
    name: 'clipboard.read',
    description: '读取当前剪贴板文本（需确认）。剪贴板可能含密码等敏感内容，请只在确实需要时调用。',
    permissionKind: 'clipboard-read',
    params: ClipboardReadParams,
    timeoutMs: 3000,
    readOnly: true,
    async run(params): Promise<ToolResult> {
      const p = params as z.infer<typeof ClipboardReadParams>
      let text = ''
      /**
       * ⚠ `clipboard.readText()` 在 Electron 44 返回 **Promise<string>**。
       *   早期按同步 API 写（`text = clipboard.readText()`）会被 tsc 拦下 ——
       *   如果没有类型检查，运行期会拿到一个 `[object Promise]` 字符串，
       *   于是"读剪贴板"看起来永远读到一堆无意义内容。异步 API 必须 await。
       */
      try { text = await clipboard.readText() } catch (e) {
        return fail(`读取剪贴板失败：${e instanceof Error ? e.message.slice(0, 200) : '未知错误'}`)
      }
      if (!text) return ok('剪贴板当前没有文本内容', digestOf('empty'), { chars: 0 })
      /**
       * ⚠ 剪贴板**是最容易夹带凭据的地方**（用户刚复制的密码）。
       *   所以：① 需要确认（`clipboard-read` 档位是 confirm）；
       *   ② 默认只给"长度 + 是否像密钥"的判定，**不回正文**；
       *   ③ 若看起来像密钥/令牌，直接**拒绝**并说明理由（而不是"照读不误"）。
       */
      const looksSecret = /(^|\s)(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.)/.test(text)
      if (looksSecret) {
        log().warn('剪贴板内容疑似凭据，已拒绝返回', { chars: text.length }, 'clipboard.looks-secret')
        return fail(`剪贴板内容疑似密钥/令牌（长度 ${text.length}），已拒绝返回。如果确实需要，请手动复制到别处再试。`)
      }
      return ok(
        `已读取剪贴板（${text.length} 字符）；为保护隐私默认只给摘要，未回传正文`,
        digestOf(text),
        { chars: text.length },
      )
    },
  }
}

// ───────────────────────────────────────────────────────── 工具：窗口控制（只读）

const WindowListParams = z.object({})

export function windowListTool(): ToolSpec {
  return {
    name: 'window.list',
    description: '列出本应用自己的窗口（只读）。不会枚举或操作其它程序的窗口。',
    permissionKind: 'window-control',
    params: WindowListParams,
    timeoutMs: 3000,
    readOnly: true,
    async run(): Promise<ToolResult> {
      /**
       * ⚠ **只列本应用自己的窗口**。
       *
       * 为什么不做"列出所有窗口 / 切换任意窗口"：那需要一个跨进程的窗口枚举与操作通路，
       * 而它正是"不可见自动化"的典型形态（用户明确禁止）。
       * 本应用的窗口计数另有硬要求（恒为 1），所以这里给出的其实是一个很有用的**自检读数**。
       */
      const { BrowserWindow } = require('electron') as typeof import('electron')
      const wins = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed())
      const list = wins.map(w => ({
        id: w.id,
        title: w.getTitle().slice(0, 60),
        bounds: { ...w.getBounds() },
        visible: w.isVisible(),
        alwaysOnTop: w.isAlwaysOnTop(),
      }))
      return ok(`本应用有 ${list.length} 个窗口`, digestOf(JSON.stringify(list)), { windows: list })
    },
  }
}

// ───────────────────────────────────────────────────────── 汇总

/** 全部 M3 工具（**注册顺序即清单顺序**；权限判定由注册表统一做） */
export function computerUseTools(): ToolSpec[] {
  return [
    screenCaptureTool(),
    fileReadTool(),
    listDirTool(),
    launchAppTool(),
    clipboardReadTool(),
    windowListTool(),
  ]
}

/** 供设置页显示：屏幕理解的状态摘要（**不含任何画面内容**） */
export function computerUseDiagnostics(): {
  screen: ScreenUiState
  allowedApps: Array<{ id: string, label: string }>
  /** 文件读取的授权目录数量（**只给数量，不给路径**） */
  allowlistedDirs: number
  /** 敏感规则数量 */
  rules: { file: number, dir: number }
} {
  const fileRead = getPermission('file-read')
  return {
    screen: screenStatus(),
    allowedApps: ALLOWED_APPS.map(a => ({ id: a.id, label: a.label })),
    allowlistedDirs: fileRead.pathAllowlist.length,
    rules: (() => {
      const { ruleSummary } = require('./fs-allowlist.js') as typeof import('./fs-allowlist.js')
      const s = ruleSummary()
      return { file: s.fileRules, dir: s.dirRules }
    })(),
  }
}

/** 真实存在的目录才能被授权（供 IPC 校验；避免白名单里塞进不存在的路径） */
export function pathExists(p: string): boolean {
  return existsSync(p)
}

// ───────────────────────────────────────────────────────── 目录白名单管理

/**
 * 给 renderer 看的白名单条目：**只给 id 与末级目录名**。
 *
 * 为什么不做"显示完整路径"：renderer 一旦拿到完整路径，就把
 * "renderer 拿不到任意文件路径"这条设计打开了口子（而界面并不需要它 ——
 * 用户看到末级目录名就知道自己授权了哪个目录）。
 * `id` 是路径的 sha256 前 12 位，稳定且不可反推。
 */
export function allowlistEntriesForUi(): Array<{ id: string, label: string }> {
  const perm = getPermission('file-read')
  return perm.pathAllowlist.map((p) => {
    const id = createHash('sha256').update(p.toLowerCase(), 'utf8').digest('hex').slice(0, 12)
    // 末级目录名（去掉尾分隔符后取最后一段）
    const trimmed = p.replace(/[\\/]+$/, '')
    const parts = trimmed.split(/[\\/]+/).filter(Boolean)
    const label = parts[parts.length - 1] ?? trimmed
    return { id, label: label.slice(0, 120) }
  })
}

/** 由 id 反查路径（内部用；id 不可反推，所以必须遍历比对） */
function pathById(id: string): string | null {
  const perm = getPermission('file-read')
  for (const p of perm.pathAllowlist) {
    if (createHash('sha256').update(p.toLowerCase(), 'utf8').digest('hex').slice(0, 12) === id) return p
  }
  return null
}

export interface AllowlistMutation {
  ok: boolean
  code: string
  detail: string
}

/**
 * 授权一个目录。
 *
 * ⚠ 走 `checkAllowlistCandidate()`：**敏感目录当场被拒**（`.ssh` / `Windows` /
 *   浏览器用户数据目录…）。这一步不能只在界面里做 —— 界面可以被绕过，
 *   IPC 的入参校验与这里才是真正的闸门。
 */
export function addAllowlistedDir(dir: string): AllowlistMutation {
  const verdict = checkAllowlistCandidate(dir)
  if (verdict.access === 'deny') return { ok: false, code: verdict.code.toUpperCase(), detail: verdict.detail }
  const real = verdict.resolved as string
  const perm = getPermission('file-read')
  // 去重（大小写不敏感）：同一个目录重复授权会让界面出现两条一样的条目
  const exists = perm.pathAllowlist.some(p => p.toLowerCase() === real.toLowerCase())
  if (exists) return { ok: true, code: 'OK', detail: '该目录已在白名单内' }
  if (perm.pathAllowlist.length >= 64) return { ok: false, code: 'TOO_MANY', detail: '授权目录数量已达上限（64）' }
  setPermission({ kind: 'file-read', pathAllowlist: [...perm.pathAllowlist, real] })
  log().info('已授权目录', { total: perm.pathAllowlist.length + 1 }, 'fs.allowlist.add')
  return { ok: true, code: 'OK', detail: '已授权' }
}

/** 撤销授权（幂等：不存在返回 false） */
export function revokeAllowlistedDir(id: string): boolean {
  const target = pathById(id)
  if (!target) return false
  const perm = getPermission('file-read')
  const next = perm.pathAllowlist.filter(p => p !== target)
  setPermission({ kind: 'file-read', pathAllowlist: next })
  log().info('已撤销目录授权', { total: next.length }, 'fs.allowlist.revoke')
  return true
}
