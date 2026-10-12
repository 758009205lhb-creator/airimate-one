/**
 * @airimate/motion-director/manifest —— manifest 的**运行期校验**
 *
 * 为什么需要运行期校验（而不是只靠 TS 类型）
 * ------------------------------------------
 *   manifest 是 `import manifest from './motion.manifest.json'` 进来的**外部数据**：
 *   TS 只能保证"调用点以为它是什么"，保证不了"文件里真的写对了"。
 *   实测过的坑：`durationSec` 写成字符串 `"2.45"`、`boneActivityDeg` 的键写成 Unity 的
 *   PascalCase（`LeftUpperLeg`）—— 类型断言全过，运行到 `AnimationMixer` 才静默失效。
 *   ⇒ 这里做**结构 + 取值域**双重校验，并在失败时给出**可定位到字段**的错误路径。
 *
 * 与 `tools/motion-lab/convert-anim.mjs` 产出的 `motion-clip-manifest/1` 的映射
 * --------------------------------------------------------------------------
 *   转换器 sidecar（`assets/motion/manifests/<slug>.json`）        本契约字段
 *   ─────────────────────────────────────────────────────────────  ─────────────────────
 *   `name`                                                          `name`
 *   `slug`                                                          （仅文件名用，不入契约）
 *   `vrma.file`                                                     `file`
 *   `vrma.bytes`                                                    `bytes`
 *   `duration`                                                      `durationSec`
 *   `loopable`                                                      `loopable`
 *   `rootDisplacement.range` (数组 [x,y,z])                          `rootDisplacementRange`
 *   `perBoneActivityDeg` (VRM 归一化骨名)                            `boneActivityDeg`
 *   `legActivity.total`                                             `legActivityDeg`
 *   `allowedOverlayLayers`                                          `allowedOverlayLayers`
 *   `set`                                                           `semantic`（映射见 SET_TO_SEMANTIC）
 *   （转换器不产出）                                                  `layer` / `priorityHint`
 *
 *   `layer` 的规则：`semantic === 'idle' | 'walk' | 'sit' | 'sleep' | 'drag' | 'pose'`
 *   ⇒ `'base'`；`semantic === 'oneShot'` ⇒ `'base'`（一次性动作也是基础动作，
 *   只是优先级更高、播完回退）；其余 ⇒ `'overlay'`。
 *   `priorityHint` 由 `semantic` 推出：drag → Drag，oneShot → OneShot，
 *   walk/sit/sleep → State，idle/pose → Idle。
 */

import type { MotionClipManifest, MotionLayerKind, MotionPriority, MotionSemantic } from './types.js'
import { MotionPriority as P } from './types.js'

/** 转换器的 `set` 字段 → 本契约的 `semantic` */
export const SET_TO_SEMANTIC: Readonly<Record<string, MotionSemantic>> = Object.freeze({
  idle: 'idle',
  walk: 'walk',
  sit: 'sit',
  sleep: 'sleep',
  drag: 'drag',
  pose: 'pose',
  oneshot: 'oneShot',
})

/** 语义 → 默认优先级 */
export const SEMANTIC_TO_PRIORITY: Readonly<Record<MotionSemantic, MotionPriority>> = Object.freeze({
  idle: P.Idle,
  pose: P.Idle,
  walk: P.State,
  sit: P.State,
  sleep: P.State,
  drag: P.Drag,
  oneShot: P.OneShot,
  other: P.State,
})

/** 语义 → 图层 */
export const SEMANTIC_TO_LAYER: Readonly<Record<MotionSemantic, MotionLayerKind>> = Object.freeze({
  idle: 'base', pose: 'base', walk: 'base', sit: 'base', sleep: 'base', drag: 'base', oneShot: 'base', other: 'base',
})

const VALID_SEMANTICS = new Set<string>(Object.keys(SEMANTIC_TO_PRIORITY))
const VALID_LAYERS = new Set<string>(['base', 'overlay'])

/** 一条校验错误 */
export interface ManifestIssue {
  /** 出错字段的 JSON 路径，例如 `clips[3].durationSec` */
  readonly path: string
  readonly message: string
  /** 实际读到的值（便于贴日志） */
  readonly got?: unknown
}

export interface ManifestValidationResult {
  readonly ok: boolean
  readonly issues: readonly ManifestIssue[]
  /** 校验通过的 clip 数 */
  readonly clipCount: number
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/**
 * 校验一个 clip 对象。**不改动输入**（返回问题列表，由调用方决定怎么办）。
 * @param raw 待校验对象
 * @param path 该对象在整体里的路径前缀，例如 `clips[2]`
 */
export function validateClip(raw: unknown, path = 'clip'): ManifestIssue[] {
  const issues: ManifestIssue[] = []
  const bad = (p: string, message: string, got?: unknown) => issues.push({ path: `${path}.${p}`, message, got })
  if (!isPlainObject(raw)) {
    issues.push({ path, message: '不是对象', got: typeof raw })
    return issues
  }

  if (!isNonEmptyString(raw.name)) bad('name', '必须是非空字符串', raw.name)
  else if (!/^[a-zA-Z0-9_.-]+$/.test(raw.name)) bad('name', '只允许字母/数字/下划线/点/连字符（会用作文件名与轨道名前缀）', raw.name)

  if (!isNonEmptyString(raw.layer) || !VALID_LAYERS.has(raw.layer)) bad('layer', `必须是 'base' | 'overlay'`, raw.layer)

  if (!isNonEmptyString(raw.semantic) || !VALID_SEMANTICS.has(raw.semantic)) {
    bad('semantic', `必须是 ${[...VALID_SEMANTICS].join(' | ')} 之一`, raw.semantic)
  }

  if (!isNonEmptyString(raw.source)) bad('source', '必须是非空字符串（源 .anim 路径）', raw.source)
  if (!isNonEmptyString(raw.file)) bad('file', '必须是非空字符串（.vrma 路径）', raw.file)
  else if (!raw.file.toLowerCase().endsWith('.vrma')) bad('file', '必须指向 .vrma 文件', raw.file)

  if (!isFiniteNumber(raw.bytes) || raw.bytes <= 0) bad('bytes', '必须是 > 0 的有限数', raw.bytes)
  if (!isFiniteNumber(raw.durationSec) || raw.durationSec <= 0) bad('durationSec', '必须是 > 0 的有限数（秒）', raw.durationSec)
  else if (raw.durationSec > 600) bad('durationSec', '超过 600s 不合理（多半单位写成毫秒了）', raw.durationSec)

  if (typeof raw.loopable !== 'boolean') bad('loopable', '必须是 boolean', raw.loopable)

  const rd = raw.rootDisplacementRange
  if (!Array.isArray(rd) || rd.length !== 3 || !rd.every(isFiniteNumber)) bad('rootDisplacementRange', '必须是 3 个有限数的数组 [x,y,z]', rd)
  else if (rd.some((v) => (v as number) < 0)) bad('rootDisplacementRange', '位移范围不应为负（用绝对值幅度）', rd)

  const ba = raw.boneActivityDeg
  if (!isPlainObject(ba)) bad('boneActivityDeg', '必须是对象（VRM 归一化骨名 → 度）', ba)
  else {
    const entries = Object.entries(ba)
    if (entries.length === 0) bad('boneActivityDeg', '不能为空（至少要有一根骨的活动量）', 0)
    for (const [k, v] of entries) {
      // ⚠ 实测过的坑：转换器/手工 manifest 里出现过 Unity 的 PascalCase 骨名，
      //   规范要求 camelCase（`leftUpperLeg`）。这里显式挡掉。
      if (/^[A-Z]/.test(k)) bad(`boneActivityDeg.${k}`, '骨名必须是 VRM 归一化名（camelCase，首字母小写）', k)
      if (!isFiniteNumber(v) || v < 0) bad(`boneActivityDeg.${k}`, '活动量必须是 >= 0 的有限数（度）', v)
    }
  }

  if (!isFiniteNumber(raw.legActivityDeg) || raw.legActivityDeg < 0) bad('legActivityDeg', '必须是 >= 0 的有限数（度）', raw.legActivityDeg)

  if (!Array.isArray(raw.allowedOverlayLayers) || !raw.allowedOverlayLayers.every(isNonEmptyString)) {
    bad('allowedOverlayLayers', '必须是字符串数组', raw.allowedOverlayLayers)
  }

  if (raw.priorityHint !== undefined) {
    const vals: number[] = [P.Idle, P.State, P.OneShot, P.Drag]
    if (!isFiniteNumber(raw.priorityHint) || !vals.includes(raw.priorityHint)) bad('priorityHint', `必须是 ${vals.join(' | ')} 之一`, raw.priorityHint)
  }
  return issues
}

/**
 * 校验整个 manifest（`{ clips: [...] }`）。**只读**，不改输入。
 *
 * 额外做集合级检查（单看一条看不出来的问题）：
 *   · `name` 不能重复
 *   · 至少要有一个 `layer === 'base'` 且 `semantic === 'idle'` 的 clip
 *     （否则 director 一启动就没有基础动作 ⇒ 必然 T-pose）
 */
export function validateManifest(raw: unknown): ManifestValidationResult {
  const issues: ManifestIssue[] = []
  if (!isPlainObject(raw)) {
    return { ok: false, issues: [{ path: '(root)', message: '不是对象', got: typeof raw }], clipCount: 0 }
  }
  const clips = raw.clips
  if (!Array.isArray(clips)) {
    return { ok: false, issues: [{ path: 'clips', message: '必须是数组', got: typeof clips }], clipCount: 0 }
  }
  if (clips.length === 0) issues.push({ path: 'clips', message: '不能为空', got: 0 })

  const seen = new Map<string, number>()
  clips.forEach((c, i) => {
    issues.push(...validateClip(c, `clips[${i}]`))
    if (isPlainObject(c) && isNonEmptyString(c.name)) {
      if (seen.has(c.name)) issues.push({ path: `clips[${i}].name`, message: `与 clips[${seen.get(c.name)}] 重名`, got: c.name })
      else seen.set(c.name, i)
    }
  })

  const idleBases = clips.filter((c) => isPlainObject(c) && c.layer === 'base' && c.semantic === 'idle')
  if (clips.length > 0 && idleBases.length === 0) {
    issues.push({ path: 'clips', message: "至少要有一个 layer='base' 且 semantic='idle' 的 clip（否则启动即无基础动作 = T-pose 窗口）", got: idleBases.length })
  }

  return { ok: issues.length === 0, issues, clipCount: clips.length }
}

/** 校验失败时抛这个（带上全部问题，便于一次性修完） */
export class ManifestValidationError extends Error {
  readonly issues: readonly ManifestIssue[]
  constructor(issues: readonly ManifestIssue[]) {
    super(`manifest 校验失败（${issues.length} 项）：\n` + issues.slice(0, 20).map((i) => `  · ${i.path}: ${i.message}${i.got !== undefined ? `  (got: ${JSON.stringify(i.got)})` : ''}`).join('\n'))
    this.name = 'ManifestValidationError'
    this.issues = issues
  }
}

/** 校验并在失败时抛错；成功则返回**原对象**（已 narrowed 类型） */
export function assertManifest(raw: unknown): { clips: MotionClipManifest[] } {
  const r = validateManifest(raw)
  if (!r.ok) throw new ManifestValidationError(r.issues)
  return raw as { clips: MotionClipManifest[] }
}

/**
 * 把 `tools/motion-lab/convert-anim.mjs` 产出的 sidecar JSON（`motion-clip-manifest/1`）
 * 转成本契约的 `MotionClipManifest`。**纯函数**，不读文件。
 *
 * ⚠ 这是唯一被允许的"外部格式 → 契约"的入口。不要在别处再写一遍映射。
 */
export function fromConverterSidecar(raw: unknown): MotionClipManifest {
  if (!isPlainObject(raw)) throw new ManifestValidationError([{ path: '(root)', message: 'sidecar 不是对象' }])
  const issues: ManifestIssue[] = []
  const need = (p: string, v: unknown, test: (x: unknown) => boolean, msg: string) => {
    if (!test(v)) issues.push({ path: p, message: msg, got: v })
    return v
  }
  need('name', raw.name, isNonEmptyString, '缺少 name')
  need('vrma.file', isPlainObject(raw.vrma) ? (raw.vrma as Record<string, unknown>).file : undefined, isNonEmptyString, '缺少 vrma.file')
  need('vrma.bytes', isPlainObject(raw.vrma) ? (raw.vrma as Record<string, unknown>).bytes : undefined, isFiniteNumber, '缺少 vrma.bytes')
  need('duration', raw.duration, isFiniteNumber, '缺少 duration')
  if (issues.length) throw new ManifestValidationError(issues)

  const vrma = raw.vrma as Record<string, unknown>
  const setRaw = typeof raw.set === 'string' ? raw.set.toLowerCase() : ''
  const semantic: MotionSemantic = SET_TO_SEMANTIC[setRaw] ?? 'other'
  const rd = isPlainObject(raw.rootDisplacement) && Array.isArray((raw.rootDisplacement as Record<string, unknown>).range)
    ? (raw.rootDisplacement as { range: number[] }).range
    : [0, 0, 0]

  const clip: MotionClipManifest = {
    name: raw.name as string,
    layer: SEMANTIC_TO_LAYER[semantic],
    semantic,
    source: typeof raw.source === 'string' ? raw.source : String(raw.sourceRelative ?? ''),
    file: vrma.file as string,
    bytes: vrma.bytes as number,
    durationSec: raw.duration as number,
    loopable: raw.loopable === true,
    rootDisplacementRange: [Math.abs(rd[0] ?? 0), Math.abs(rd[1] ?? 0), Math.abs(rd[2] ?? 0)],
    boneActivityDeg: (isPlainObject(raw.perBoneActivityDeg) ? raw.perBoneActivityDeg : {}) as Record<string, number>,
    legActivityDeg: isPlainObject(raw.legActivity) && isFiniteNumber((raw.legActivity as Record<string, unknown>).total)
      ? ((raw.legActivity as { total: number }).total)
      : 0,
    allowedOverlayLayers: Array.isArray(raw.allowedOverlayLayers) ? (raw.allowedOverlayLayers as string[]) : [],
    priorityHint: SEMANTIC_TO_PRIORITY[semantic],
  }
  // 走一遍正式校验，保证 fromConverterSidecar 的产物一定合法
  const v = validateClip(clip, 'clip')
  if (v.length) throw new ManifestValidationError(v)
  return clip
}
