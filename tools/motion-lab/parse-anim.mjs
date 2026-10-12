/**
 * parse-anim.mjs —— Unity Humanoid `.anim`（YAML 文本）解析器
 *
 * 适配对象：Mate Engine 的 162 个 `.anim`（`serializedVersion: 7`，`m_Compressed: 0`）。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 为什么要重写（旧原型 `tools/vrma/parse-anim.mjs` 的两个真实 bug）
 * ─────────────────────────────────────────────────────────────────────────────
 *  ① **重复曲线**：旧版用「全文扫 `attribute:`」切段，而 Unity 的 `AnimationClip`
 *     在同一个文件里有两份曲线数组：
 *       `m_FloatCurves`（**权威**：归一化肌肉值） 与 `m_EditorCurves`（编辑器展开）
 *     ⇒ 每条曲线被读两遍。旧版靠"同名只留第一条"掩盖了它，但一旦两份内容不同
 *       就会静默读错。本版**按段落归属**（`SECTION:` 标记）解析，显式分开。
 *
 *  ② **`m_EditorCurves` 往往是空的**（实测 `PET_POSE_1.anim`：
 *     `m_EditorCurves: []`、`m_EulerEditorCurves: []`，而 `m_FloatCurves` 有 260 条）。
 *     所以不能依赖 editor 曲线，必须正确解析 `m_FloatCurves`。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 已实测确认的 YAML 形态（PET_IDLE.anim，17095 行）
 * ─────────────────────────────────────────────────────────────────────────────
 *   m_FloatCurves:
 *   - serializedVersion: 2
 *     curve:
 *       serializedVersion: 2
 *       m_Curve:
 *       - serializedVersion: 3
 *         time: 0
 *         value: -0.3906005
 *         inSlope: 0.13740711        ← ⚠ 含子串 "Slope"，绝不能当成 value
 *         ...
 *       m_PreInfinity: 2
 *       m_PostInfinity: 2
 *       m_RotationOrder: 4
 *     attribute: RootT.x             ← 4 空格缩进
 *     path:                          ← 人形曲线 path 为空
 *     classID: 95
 *     script: {fileID: 0}
 *     flags: 16
 *
 *   曲线类别（实测 PET_IDLE.anim，m_FloatCurves 段）：
 *     RootT 3 + RootQ 4 + LeftHandT/Q 4+4? ... 见 README 的统计输出
 *
 * 用法
 *   node parse-anim.mjs <anim 路径> [--json] [--top N] [--curves]
 *   node parse-anim.mjs --scan <目录>          # 批量体检 162 个文件
 *   node parse-anim.mjs --list <目录>
 *
 * 退出码：0 成功 / 1 解析失败 / 2 用法或环境错误
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, resolve, basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ───────────────────────────────────────────────────────── 分类

/** 曲线类别枚举（任务书要求：rootT / rootQ / muscle / fingerMuscle / ikT / ikQ / other） */
export const CURVE_KINDS = ['rootT', 'rootQ', 'muscle', 'fingerMuscle', 'ikT', 'ikQ', 'other']

/**
 * 手指肌肉名。
 *
 * ⚠ 实测踩到的坑：Unity 手指肌肉名的"节号 + 后缀"**不是**固定搭配 ——
 *   同一个文件里同时存在
 *     `LeftHand.Index.1 Stretched`   （节号在前、后缀在后）
 *     `LeftHand.Index.Spread`        （只有后缀、没有节号）
 *   早期版本只认 `.<节号> <后缀>`，于是 40 条手指肌肉里 20 条（全部 Spread）
 *   落到 `other` 桶，统计看起来"少了 20 条"、`other` 虚高到 20。
 *   ⇒ 用**两分支**正则显式覆盖两种形态。
 */
const RE_FINGER = /^(?:LeftHand|RightHand)\.[A-Za-z]+\.(?:[123]\s+(?:Stretched|Spread)|Spread)$/
/** IK 目标位移：`LeftFootT.x` / `LeftHandT.y` */
const RE_IK_T = /^(LeftFootT|RightFootT|LeftHandT|RightHandT)\.[xyz]$/
/** IK 目标旋转：`LeftFootQ.w` / `LeftHandQ.z` */
const RE_IK_Q = /^(LeftFootQ|RightFootQ|LeftHandQ|RightHandQ)\.[xyzw]$/

/**
 * 分类一条曲线。
 * @param {string} attribute
 * @returns {'rootT'|'rootQ'|'muscle'|'fingerMuscle'|'ikT'|'ikQ'|'other'}
 */
export function classifyAttribute(attribute) {
  const a = String(attribute ?? '').trim()
  if (a.startsWith('RootT.')) return 'rootT'
  if (a.startsWith('RootQ.')) return 'rootQ'
  if (RE_IK_T.test(a)) return 'ikT'
  if (RE_IK_Q.test(a)) return 'ikQ'
  if (RE_FINGER.test(a)) return 'fingerMuscle'
  // 身体肌肉：`Spine Front-Back` / `Left Arm Down-Up` / `Left Toes Up-Down`
  // 特征 = 含空格、且不是上面几类。用「首词是已知骨前缀」再收紧一层。
  if (/^[A-Za-z]+( [A-Za-z]+)* [A-Za-z-]+$/.test(a) && a.includes(' ')) return 'muscle'
  return 'other'
}

// ───────────────────────────────────────────────────────── 解析

const RE_HEADER_NAME = /^  m_Name: ?(.*)$/
const RE_SECTION = /^  (m_FloatCurves|m_EditorCurves|m_EulerEditorCurves|m_RotationCurves|m_CompressedRotationCurves|m_EulerCurves|m_PositionCurves|m_ScaleCurves|m_PPtrCurves|m_ClipBindingConstant|m_AnimationClipSettings|m_Events|m_Bounds):/
const RE_ATTR = /^    attribute: ?(.*)$/
const RE_PATH = /^    path: ?(.*)$/
const RE_CLASSID = /^    classID: ?(.*)$/
const RE_KEY_TIME = /^ {8}time: ?(-?[0-9.eE+-]+)$/
const RE_KEY_VALUE = /^ {8}value: ?(-?[0-9.eE+-]+)$/

/** `m_AnimationType` 枚举（Unity AnimationClip.AnimationType） */
const ANIMATION_TYPE = { 0: 'Legacy', 1: 'Generic', 2: 'Humanoid', 3: 'None' }

/**
 * 解析一个 Unity `.anim` 文件。
 *
 * 实现选择（都有理由，别随手改）：
 *  · **一行行扫，不 split 成数组**：`PET_DANCING.anim` 有 21 MB，split 会产生
 *    上百万个小字符串，GC 压力大。用带 `g` 标志的正则 + `lastIndex` 推进，
 *    只对每个 section 内部的 `      - serializedVersion` 做一次 `exec` 循环。
 *  · **按 section 归属**：只有 `m_FloatCurves` 当作权威运行时曲线；
 *    `m_EditorCurves` 单独存一份（可能为空）；其余 section 只报数量。
 *  · **不猜缩进**：属性/路径行用「4 空格 + 关键字」锚定；关键帧的 time/value
 *    用「8 空格 + 关键字 + 行尾」锚定 —— 这样 `inSlope`/`outSlope` 不可能误命中。
 *
 * @param {string} file
 * @returns {{
 *   file:string, name:string, serializedVersion:number, legacy:boolean, compressed:boolean,
 *   sampleRate:number, wrapMode:number, animationType:string|null,
 *   settings:Record<string,number|boolean>, duration:number,
 *   curves:Array<{section:string, attribute:string, path:string, classID:number|null,
 *                 kind:string, keys:Array<[number,number]>}>,
 *   counts:Record<string,number>, bySection:Record<string,number>,
 *   warnings:string[], unsupported:string[]
 * }}
 */
export function parseAnim(file) {
  const text = readFileSync(file, 'utf8')
  return parseAnimText(text, file)
}

/**
 * 同上，但接受已经读进来的文本（便于测试与流式复用）。
 * @param {string} text
 * @param {string} [file]
 */
export function parseAnimText(text, file = '<memory>') {
  const lines = text.split(/\r?\n/)
  const n = lines.length

  const out = {
    file,
    name: '',
    serializedVersion: 0,
    legacy: false,
    compressed: false,
    compressedRotationCurves: 0,
    sampleRate: 0,
    wrapMode: 0,
    animationType: undefined,
    animationTypeName: undefined,
    settings: {},
    duration: 0,
    curves: [],
    counts: Object.fromEntries(CURVE_KINDS.map((k) => [k, 0])),
    bySection: { m_FloatCurves: 0, m_EditorCurves: 0, m_EulerEditorCurves: 0, m_RotationCurves: 0, m_EulerCurves: 0, m_PositionCurves: 0, m_ScaleCurves: 0 },
    warnings: [],
    unsupported: [],
  }

  // ── ① 头部 + 设置字段：用**不依赖缩进**的扁平正则。
  //     踩过的坑：`m_SampleRate` / `m_AnimationClipSettings` 里的字段在
  //     `m_ClipBindingConstant` **之后**（PET_IDLE.anim 第 17087、18265 行），
  //     只扫头部会全部漏掉；而它们的缩进层级在不同文件里并不统一。
  //     这些键名在 AnimationClip 里唯一，扁平匹配是安全且最稳的。
  const flat = (re, cast = (v) => v) => { const m = re.exec(text); return m ? cast(m[1].trim()) : undefined }
  const num = (v) => (/^-?[\d.]+(?:[eE][+-]?\d+)?$/.test(v) ? Number(v) : undefined)

  out.name = flat(/^  m_Name: ?(.*)$/m, (v) => v) ?? ''
  out.serializedVersion = flat(/^  serializedVersion: ?(\d+)$/m, Number) ?? 0
  out.legacy = flat(/^  m_Legacy: ?(\d+)$/m, Number) === 1
  out.compressed = flat(/^  m_Compressed: ?(\d+)$/m, Number) === 1
  out.sampleRate = flat(/^  m_SampleRate: ?(-?[\d.]+)$/m, Number) ?? 0
  out.wrapMode = flat(/^  m_WrapMode: ?(\d+)$/m, Number) ?? 0
  out.animationType = flat(/^  m_AnimationType: ?(-?\d+)$/m, Number)
  out.animationTypeName = flat(/^  m_AnimationType: ?(-?\d+)$/m, (v) => ANIMATION_TYPE[Number(v)] ?? `unknown(${v})`)

  for (const key of ['m_StartTime', 'm_StopTime', 'm_AdditiveReferencePoseTime', 'm_LoopTime', 'm_LoopBlend',
    'm_LoopBlendOrientation', 'm_LoopBlendPositionY', 'm_LoopBlendPositionXZ', 'm_KeepOriginalOrientation',
    'm_KeepOriginalPositionY', 'm_KeepOriginalPositionXZ', 'm_HasAdditiveReferencePose', 'm_Level',
    'm_CycleOffset', 'm_Mirror', 'm_OrientationOffsetY', 'm_HeightFromFeet']) {
    const v = flat(new RegExp(`^\\s+${key}: ?([^\\s]+)$`, 'm'))
    if (v !== undefined) out.settings[key] = num(v) ?? v
  }

  // 压缩载荷检测（显式拒绝，不产出垃圾）
  if (/^  m_CompressedRotationCurves:$/m.test(text)) out.compressedRotationCurves = 1

  let section = null
  let i = 0
  for (; i < n; i++) {
    if (RE_SECTION.test(lines[i])) { section = RE_SECTION.exec(lines[i])[1]; i++; break }
  }

  if (out.compressed) {
    out.unsupported.push(
      'm_Compressed: 1 —— 该 clip 的曲线被 Unity 的量化压缩格式编码，本解析器**不解析压缩载荷**。' +
      '已显式拒绝（而不是输出垃圾数值）。库里 162 个 .anim 实测 m_Compressed 全为 0。'
    )
  }

  // ── ② 段落扫描
  // 逐行推进；进入 m_FloatCurves / m_EditorCurves 时按 `attribute:` 切曲线。
  let cur = null
  let pendingTime = null
  let lastTime = -Infinity
  const flush = () => {
    if (!cur) return
    if (cur.keys.length === 0) { cur = null; return }
    // 时间必须严格递增；不递增就丢掉这一条并记警告（Unity 不应产生这种数据）
    let ok = true
    for (let k = 1; k < cur.keys.length; k++) if (!(cur.keys[k][0] > cur.keys[k - 1][0])) { ok = false; break }
    if (!ok) out.warnings.push(`${cur.section}:${cur.attribute} 关键帧时间不是严格递增，已丢弃该曲线`)
    else {
      out.curves.push(cur)
      out.bySection[cur.section] = (out.bySection[cur.section] ?? 0) + 1
      out.counts[cur.kind]++
      const t = cur.keys[cur.keys.length - 1][0]
      if (t > out.duration) out.duration = t
    }
    cur = null
  }

  for (; i < n; i++) {
    const L = lines[i]
    if (L.length === 0) continue

    // 段落切换 / 设置字段：2 空格缩进的顶层键
    if (L.charCodeAt(0) === 32 && L.charCodeAt(1) === 32 && L.charCodeAt(2) !== 32) {
      const m = RE_SECTION.exec(L)
      if (m) { flush(); section = m[1]; continue }
    }

    const inCurveSection = section === 'm_FloatCurves' || section === 'm_EditorCurves'
    if (!inCurveSection) continue

    // 4 空格缩进 = 曲线对象的字段
    if (L.charCodeAt(0) === 32 && L.charCodeAt(1) === 32 && L.charCodeAt(2) === 32 && L.charCodeAt(3) === 32 && L.charCodeAt(4) !== 32) {
      let m
      if ((m = RE_ATTR.exec(L))) {
        flush()
        const attribute = m[1].trim()
        cur = { section, attribute, path: '', classID: null, kind: classifyAttribute(attribute), keys: [] }
        pendingTime = null
        continue
      }
      if (cur && (m = RE_PATH.exec(L))) { cur.path = m[1].trim(); continue }
      if (cur && (m = RE_CLASSID.exec(L))) { cur.classID = Number(m[1]) || null; continue }
      continue
    }

    if (!cur) continue
    let m
    if ((m = RE_KEY_TIME.exec(L))) { pendingTime = Number(m[1]); continue }
    if (pendingTime != null && (m = RE_KEY_VALUE.exec(L))) {
      cur.keys.push([pendingTime, Number(m[1])])
      pendingTime = null
      continue
    }
  }
  flush()

  // ── ③ duration 兜底：优先用 m_AnimationClipSettings.m_StopTime（Unity 的真实时长）
  const stop = out.settings.m_StopTime
  if (typeof stop === 'number' && stop > 0) out.duration = stop

  out.curveCount = out.curves.length
  out.duplicateAcrossSections = out.bySection.m_FloatCurves > 0 && out.bySection.m_EditorCurves > 0

  if (out.compressed) {
    out.warnings.push('压缩 clip：curves 数组可能不完整，不要据此做转换')
  }
  if (out.bySection.m_FloatCurves === 0 && out.bySection.m_EditorCurves === 0) {
    out.warnings.push('既没有 m_FloatCurves 也没有 m_EditorCurves —— 该文件可能不是 AnimationClip')
  }
  return out
}

/** 取权威曲线（m_FloatCurves 优先；没有则退回 m_EditorCurves） */
export function authoritativeCurves(parsed) {
  const f = parsed.curves.filter((c) => c.section === 'm_FloatCurves')
  if (f.length) return f
  return parsed.curves.filter((c) => c.section === 'm_EditorCurves')
}

// ───────────────────────────────────────────────────────── 采样

/**
 * 在关键帧上线性插值。Unity 默认是三次贝塞尔（Auto/ClampedAuto），
 * 但我们按**固定时间网格**重采样后输出 LINEAR，误差在 1/2 帧以内可接受；
 * 采样率由 `--hz` 控制（默认 30）。
 *
 * 用二分查找 ⇒ O(log k) / 采样点，PET_DANCING 那种几十万关键帧的也不会卡。
 */
export function sampleCurve(keys, t) {
  if (!keys || keys.length === 0) return 0
  if (keys.length === 1) return keys[0][1]
  if (t <= keys[0][0]) return keys[0][1]
  const last = keys[keys.length - 1]
  if (t >= last[0]) return last[1]
  let lo = 0, hi = keys.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (keys[mid][0] <= t) lo = mid; else hi = mid
  }
  const [t0, v0] = keys[lo], [t1, v1] = keys[hi]
  return t1 === t0 ? v0 : v0 + (v1 - v0) * ((t - t0) / (t1 - t0))
}

/** 把一组曲线整理成 attribute → keys 的索引（同名只保留第一条，并报告冲突） */
export function indexCurves(curves) {
  const map = new Map()
  const dupes = []
  for (const c of curves) {
    if (!c.attribute || !c.keys.length) continue
    const prev = map.get(c.attribute)
    if (prev) {
      // 同名且内容不同 ⇒ 必须报出来（旧原型在这里静默丢数据）
      const same = prev.keys.length === c.keys.length &&
        prev.keys.every((k, i) => k[0] === c.keys[i][0] && k[1] === c.keys[i][1])
      if (!same) dupes.push(c.attribute)
      continue
    }
    map.set(c.attribute, c)
  }
  return { map, dupes }
}

// ───────────────────────────────────────────────────────── CLI

const isDirectRun = (() => {
  try {
    const entry = process.argv[1] ? resolve(process.argv[1]) : ''
    return entry && resolve(fileURLToPath(import.meta.url)) === entry
  } catch { return false }
})()

if (isDirectRun) {
  const argv = process.argv.slice(2)
  const has = (f) => argv.includes(f)
  const valOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }

  if (has('--help') || argv.length === 0) {
    console.log('用法:')
    console.log('  node parse-anim.mjs <anim 路径> [--json] [--top N] [--curves]')
    console.log('  node parse-anim.mjs --scan <目录>     # 批量体检所有 .anim')
    console.log('  node parse-anim.mjs --list <目录>')
    process.exit(argv.length === 0 ? 2 : 0)
  }

  const listDir = valOf('--scan', valOf('--list', null))
  if (listDir) {
    if (!existsSync(listDir)) { console.error(`[环境不可用] 目录不存在：${listDir}`); process.exit(2) }
    const files = []
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (extname(e.name).toLowerCase() === '.anim') files.push(p)
      }
    }
    walk(listDir)
    files.sort()
    if (has('--list')) { for (const f of files) console.log(f); console.log(`共 ${files.length} 个 .anim`); process.exit(0) }

    console.log(`扫描 ${files.length} 个 .anim（目录 ${listDir}）\n`)
    console.log('文件'.padEnd(40) + '曲线'.padStart(5) + 'rootT'.padStart(6) + 'rootQ'.padStart(6) + '肌肉'.padStart(6) + '手指'.padStart(6) + 'ikT'.padStart(5) + 'ikQ'.padStart(5) + '其它'.padStart(5) + '时长s'.padStart(9) + '压缩'.padStart(6))
    let compressed = 0, failed = 0
    const rows = []
    for (const f of files) {
      try {
        const p = parseAnim(f)
        if (p.compressed || p.compressedRotationCurves) compressed++
        rows.push(p)
        console.log(
          basename(f).slice(0, 39).padEnd(40) +
          String(p.curves.length).padStart(5) +
          String(p.counts.rootT).padStart(6) + String(p.counts.rootQ).padStart(6) +
          String(p.counts.muscle).padStart(6) + String(p.counts.fingerMuscle).padStart(6) +
          String(p.counts.ikT).padStart(5) + String(p.counts.ikQ).padStart(5) +
          String(p.counts.other).padStart(5) +
          p.duration.toFixed(3).padStart(9) +
          (p.compressed || p.compressedRotationCurves ? 'YES' : '-').padStart(6)
        )
      } catch (e) {
        failed++
        console.log(`${basename(f).slice(0, 39).padEnd(40)}  [解析失败] ${e.message}`)
      }
    }
    console.log(`\n合计 ${files.length} 个；压缩 clip ${compressed} 个；解析失败 ${failed} 个`)
    const anyWarn = rows.flatMap((r) => r.warnings.map((w) => `${basename(r.file)}: ${w}`))
    if (anyWarn.length) { console.log('\n警告：'); for (const w of anyWarn.slice(0, 40)) console.log('  ' + w); if (anyWarn.length > 40) console.log(`  ...共 ${anyWarn.length} 条`) }
    process.exit(failed ? 1 : 0)
  }

  const file = argv.find((a) => !a.startsWith('--'))
  if (!file) { console.error('用法: node parse-anim.mjs <anim 路径> [--json] [--top N] [--curves]'); process.exit(2) }
  if (!existsSync(file)) { console.error(`[环境不可用] 找不到：${file}`); process.exit(2) }

  const p = parseAnim(file)
  const top = Number(valOf('--top', '12'))

  if (has('--json')) {
    console.log(JSON.stringify({
      file: p.file, name: p.name, serializedVersion: p.serializedVersion,
      m_Compressed: p.compressed, legacy: p.legacy, sampleRate: p.sampleRate, wrapMode: p.wrapMode,
      animationType: p.animationType, duration: p.duration, settings: p.settings,
      counts: p.counts, bySection: p.bySection, curveCount: p.curves.length,
      warnings: p.warnings, unsupported: p.unsupported,
      curves: has('--curves') ? p.curves.map((c) => ({ section: c.section, attribute: c.attribute, path: c.path, classID: c.classID, kind: c.kind, keys: c.keys.length })) : undefined,
    }, null, 2))
    process.exit(0)
  }

  console.log(`文件        : ${p.file}`)
  console.log(`名称        : ${p.name}`)
  console.log(`serializedV : ${p.serializedVersion}   m_Legacy=${p.legacy ? 1 : 0}   m_Compressed=${p.compressed ? 1 : 0}`)
  console.log(`SampleRate  : ${p.sampleRate}   WrapMode=${p.wrapMode}   AnimationType=${p.animationTypeName ?? '(未写)'}`)
  console.log(`时长        : ${p.duration.toFixed(6)} s   (m_StartTime=${p.settings.m_StartTime ?? '-'} m_StopTime=${p.settings.m_StopTime ?? '-'} m_LoopTime=${p.settings.m_LoopTime ?? '-'})`)
  console.log(`曲线总数    : ${p.curves.length}   [m_FloatCurves=${p.bySection.m_FloatCurves} m_EditorCurves=${p.bySection.m_EditorCurves} m_RotationCurves=${p.bySection.m_RotationCurves} m_EulerCurves=${p.bySection.m_EulerCurves}]`)
  for (const k of CURVE_KINDS) console.log(`  ${k.padEnd(13)}: ${p.counts[k]}`)
  if (p.compressed || p.compressedRotationCurves) console.log(`  ⚠ 压缩：m_Compressed=${p.compressed} m_CompressedRotationCurves=${p.compressedRotationCurves}`)
  if (p.warnings.length) { console.log('警告:'); for (const w of p.warnings) console.log('  - ' + w) }
  if (p.unsupported.length) { console.log('不支持:'); for (const w of p.unsupported) console.log('  - ' + w) }

  const interesting = [...p.curves].sort((a, b) => {
    const ra = rangeOf(a), rb = rangeOf(b)
    return rb - ra
  }).slice(0, top)
  console.log(`\n变化幅度最大的 ${interesting.length} 条曲线：`)
  console.log('  ' + 'attribute'.padEnd(32) + 'kind'.padEnd(14) + 'keys'.padStart(7) + '   [min, max]')
  for (const c of interesting) {
    let mn = Infinity, mx = -Infinity
    for (const k of c.keys) { if (k[1] < mn) mn = k[1]; if (k[1] > mx) mx = k[1] }
    console.log('  ' + c.attribute.padEnd(32) + c.kind.padEnd(14) + String(c.keys.length).padStart(7) + `   [${mn.toFixed(5)}, ${mx.toFixed(5)}]`)
  }
  const { dupes } = indexCurves(authoritativeCurves(p))
  if (dupes.length) console.log(`\n⚠ 同名但内容不同的曲线 ${dupes.length} 条：${dupes.slice(0, 10).join(', ')}`)
  process.exit(0)
}

function rangeOf(c) {
  let mn = Infinity, mx = -Infinity
  for (const k of c.keys) { if (k[1] < mn) mn = k[1]; if (k[1] > mx) mx = k[1] }
  return mx - mn
}

export { rangeOf }
