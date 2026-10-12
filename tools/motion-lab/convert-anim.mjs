/**
 * convert-anim.mjs —— Unity Humanoid `.anim` → `.vrma`（glTF 2.0 + VRMC_vrm_animation 1.0）
 *
 * 管线
 * ----
 *   .anim (Unity YAML)
 *     │ parse-anim.mjs            按 m_FloatCurves / m_EditorCurves **分段**解析曲线
 *     │ humanoid-map.mjs          肌肉 → 局部增量四元数（轴/符号已逐轴标定）
 *     └─ 本文件                   固定时间网格采样 → GLB 二进制 + sidecar manifest
 *
 * ★ 四元数约定（实测结论，改它前先看 humanoid-map.mjs 的长注释）
 *   · 归一化骨架的静止 local 旋转是**单位四元数**（52/52 实测），
 *     所以 VRMA 里写的增量 = Unity 肌肉增量本身，**不要再乘 rest**。
 *   · 模型 `metaVersion="0"` 时 three-vrm 加载器会把 x/z 分量取反。
 *     实测「不自己取反」得到正确世界朝向；「自己先取反」得到镜像姿态。
 *     ⇒ `VRMA_QUATERNION_CONVENTION.negateXZForVrm0 = false`，本转换器照此写。
 *   · 唯一有歧义的是「欧拉序」：Unity 对末端骨（手/脚/脚趾）用不同序。
 *     本实现按 Z→X→Y（末端骨 Z→Y→X）逐次右乘，`--euler-order` 可切换。
 *
 * CLI
 * ---
 *   node convert-anim.mjs --in <anim> --out <vrma> [--hz 30] [--dry-run]
 *   node convert-anim.mjs --set idle [--hz 30]
 *   node convert-anim.mjs --batch <manifest.json>
 *   node convert-anim.mjs --list
 *
 * 退出码：0 全部成功 / 1 有失败 / 2 用法或环境错误
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs'
import { dirname, join, basename, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Buffer } from 'node:buffer'
import { parseAnim, authoritativeCurves, indexCurves, sampleCurve, classifyAttribute } from './parse-anim.mjs'
import {
  MUSCLE_TABLE, VRM_TO_UNITY, IDENTITY_QUAT, REST_MODE, VRMA_QUATERNION_CONVENTION,
  allFingerMuscleNames, fingerMuscleInfo, muscleToDegrees, musclesToQuaternion, isTerminal,
  qmul, axisAngle,
} from './humanoid-map.mjs'

// ───────────────────────────────────────────────────────── 路径常量

/** Mate Engine 的动画资产（只读源） */
const MATE_ROOT = 'F:/deepseek harness/AI女友/repos/Mate-Engine'
const ANIM_DIR = join(MATE_ROOT, 'Assets', 'MATE ENGINE - Animations')

/** 产出目录（任务书指定） */
const OUT_DIR = 'F:/deepseek harness/AI女友/新工程/assets/motion'
const MANIFEST_DIR = join(OUT_DIR, 'manifests')

// ───────────────────────────────────────────────────────── 命名集合

/**
 * `--set idle` 的成员。任务书优先 `PET_IDLE.anim`、`PET_IDLE_2..10.anim`，
 * 缺名时退回 `PET_IDLE/ME_02/*`。`--list` 会先跑一遍存在性检查。
 */
export const SETS = {
  idle: [
    ['PET_IDLE', 'PET_IDLE.anim'],
    ['PET_IDLE', 'PET_IDLE_2.anim'],
    ['PET_IDLE', 'PET_IDLE_3.anim'],
    ['PET_IDLE', 'PET_IDLE_4.anim'],
    ['PET_IDLE', 'PET_IDLE_5.anim'],
    ['PET_IDLE', 'PET_IDLE_6.anim'],
    ['PET_IDLE', 'PET_IDLE_7.anim'],
    ['PET_IDLE', 'PET_IDLE_8.anim'],
    ['PET_IDLE', 'PET_IDLE_9.anim'],
    ['PET_IDLE', 'PET_IDLE_10.anim'],
    ['PET_IDLE', 'ME_02', 'PET_IDLE_16.anim'],
    ['PET_IDLE', 'ME_02', 'PET_IDLE_17.anim'],
    ['PET_IDLE', 'ME_02', 'PET_IDLE_19.anim'],
    ['PET_IDLE', 'ME_02', 'PET_IDLE_20.anim'],
    ['PET_IDLE', 'ME_02', 'PET_IDLE_21.anim'],
    ['PET_IDLE', 'ME_02', 'PET_IDLE_22.anim'],
  ],
  drag: [['PET_MISC', 'PET_DRAGGING.anim']],
  walk: [['PET_LOCOMOTION', 'PET_WALK_LEFT.anim'], ['PET_LOCOMOTION', 'PET_WALK_RIGHT.anim']],
  sit: [['PET_SITTING', 'ME_02', 'PET_SIT_01.anim'], ['PET_SITTING', 'ME_02', 'PET_SIT_02.anim']],
  sleep: [['PET_SLEEPING', 'PET_SLEEPING.anim']],
  pose: [['PET_POSE', 'PET_POSE_1.anim'], ['PET_POSE', 'PET_POSE_2.anim'], ['PET_POSE', 'PET_POSE_3.anim'], ['PET_POSE', 'PET_POSE_4.anim']],
}

const TARGET_SETS = ['idle', 'drag', 'walk', 'sit', 'sleep']

/** 输出文件名：`mate_<slug>.vrma` */
export function slugOf(relParts) {
  const base = relParts[relParts.length - 1].replace(/\.anim$/i, '')
  const folder = relParts[0].toLowerCase().replace(/^pet_/, '')
  return `${folder}_${base}`.toLowerCase().replace(/[^a-z0-9_]+/g, '_')
}

// ───────────────────────────────────────────────────────── 采样

/**
 * 一根骨的实际活动量（度）：对各轴角度求和的时间积分上限的粗略替代 ——
 * 这里用「逐帧角度变化绝对值之和」，即**总角行程**（total angular travel）。
 * 单位：度。这样静止不动的骨得 0，来回摆动的骨得到与摆幅×次数成正比的数。
 */
function angularTravel(quats) {
  let sum = 0
  for (let i = 1; i < quats.length; i++) {
    const a = quats[i - 1], b = quats[i]
    const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w)
    const ang = (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI
    sum += ang
  }
  return sum
}

/**
 * 在固定时间网格上采样整段 clip。
 * @returns {{
 *   duration:number, hz:number, frames:number, times:Float64Array,
 *   bones:string[], quats:Record<string, Array<{x,y,z,w}>>,
 *   hipsT:Float32Array|null, hipsRest:[number,number,number],
 *   muscleNames:string[], warnings:string[], outOfRange:Array<{muscle:string,min:number,max:number}>,
 *   rootTorRange:[number,number,number,number,number,number]|null
 * }}
 */
export function buildSamples(parsed, hz, opts = {}) {
  const includeFingers = opts.includeFingers !== false
  const curves = authoritativeCurves(parsed)
  const { map, dupes } = indexCurves(curves)
  const warnings = []
  if (dupes.length) warnings.push(`同名曲线内容冲突 ${dupes.length} 条（已取第一条）：${dupes.slice(0, 5).join(', ')}`)

  let duration = parsed.duration
  if (!(duration > 0)) {
    for (const c of map.values()) duration = Math.max(duration, c.keys[c.keys.length - 1][0])
  }
  if (!(duration > 0)) { duration = 1 / hz; warnings.push('时长探测为 0，退化为 1 帧') }

  const n = Math.max(2, Math.round(duration * hz))
  const dt = duration / n
  const times = new Float64Array(n + 1)
  for (let i = 0; i <= n; i++) times[i] = i * dt
  times[n] = duration

  // 肌肉活动范围检查（Unity 会在运行时夹取；这里报告原始越界值）
  const outOfRange = []
  for (const [attr, c] of map) {
    if (classifyAttribute(attr) !== 'muscle' && classifyAttribute(attr) !== 'fingerMuscle') continue
    let mn = Infinity, mx = -Infinity
    for (const k of c.keys) { if (k[1] < mn) mn = k[1]; if (k[1] > mx) mx = k[1] }
    if (mn < -1.0001 || mx > 1.0001) outOfRange.push({ muscle: attr, min: mn, max: mx })
  }
  if (outOfRange.length) warnings.push(`${outOfRange.length} 条肌肉曲线超出 Unity 的 [-1,1] 归一化范围（运行时会被夹取）：${outOfRange.slice(0, 4).map((o) => o.muscle).join(', ')}`)

  // 参与转换的骨集合
  const bones = []
  const perFrameMuscles = []
  for (let i = 0; i <= n; i++) {
    const t = times[i]
    const mv = {}
    for (const row of MUSCLE_TABLE) {
      for (const a of row.axes) {
        if (!a) continue
        const c = map.get(a.muscle)
        if (c) mv[a.muscle] = sampleCurve(c.keys, t)
      }
    }
    perFrameMuscles.push(mv)
  }

  const quats = {}
  for (const row of MUSCLE_TABLE) {
    const hasAny = row.axes.some((a) => a && map.has(a.muscle))
    if (!hasAny) continue
    bones.push(row.bone)
    quats[row.bone] = perFrameMuscles.map((mv) => musclesToQuaternion(row.bone, mv, { terminal: opts.terminalEuler ? isTerminal(row.bone) : undefined }))
    if (!quats[row.bone]) delete quats[row.bone]
  }

  // 手指
  if (includeFingers) {
    for (const name of allFingerMuscleNames()) {
      const c = map.get(name)
      if (!c) continue
      const info = fingerMuscleInfo(name)
      if (!info) continue
      const arr = new Array(n + 1)
      for (let i = 0; i <= n; i++) arr[i] = axisAngle(info.axis, muscleToDegrees(name, sampleCurve(c.keys, times[i]), info))
      if (quats[info.bone]) quats[info.bone] = quats[info.bone].map((q, i) => qmul(q, arr[i]))
      else { quats[info.bone] = arr; if (!bones.includes(info.bone)) bones.push(info.bone) }
    }
  }

  // RootT → hips 位移
  let hipsT = null
  let hipsRest = [0, 0, 0]
  const rtx = map.get('RootT.x'), rty = map.get('RootT.y'), rtz = map.get('RootT.z')
  if (rtx || rty || rtz) {
    hipsT = new Float32Array((n + 1) * 3)
    for (let i = 0; i <= n; i++) {
      hipsT[i * 3] = rtx ? sampleCurve(rtx.keys, times[i]) : 0
      hipsT[i * 3 + 1] = rty ? sampleCurve(rty.keys, times[i]) : 0
      hipsT[i * 3 + 2] = rtz ? sampleCurve(rtz.keys, times[i]) : 0
    }
    hipsRest = [hipsT[0], hipsT[1], hipsT[2]]
  }

  // RootQ → hips 旋转。**默认丢弃**（`opts.rootQMode === 'apply'` 才写）。
  //
  // 为什么默认丢弃（实测证据，不是偏好）：
  //   1) 实测源数据 `RootQ` 在所有采样 clip 里都是**接近 180° 的旋转**：
  //        PET_IDLE.anim      RootQ t=0 = [ 0.18552, 0.00981,  0.97299, -0.07132]  |q|=0.993  角=171.8°  轴≈+Z
  //        PET_IDLE_2.anim    RootQ t=0 = [-0.00001, 0.00000,  0.99951, -0.09876]  角=168.7°  轴≈+Z
  //        PET_POSE_1.anim    RootQ t=0 = [ 0.07609, 0.00325, -0.99694, -0.12340]  角=165.8°  轴≈-Z
  //        PET_WALK_LEFT.anim RootQ t=0 = [ 0.00882, -0.02572, 0.99961,  0.01725]  角=178.0°  轴≈+Z
  //   2) 把它写进 VRMA 的 hips rotation，再用真模型加载，骨架会**整体上下颠倒**
  //      （实测：hips 在 0.834，spine/head 掉到 0.79/0.45，腿翘到 1.49 —— 头在髋下面）。
  //      把 hips rotation 换成单位四元数后立刻恢复正常：
  //        hips 0.834 → spine 0.879 → chest 0.990 → neck 1.160 → head 1.225
  //        leftUpperLeg 0.776 → leftLowerLeg 0.459 → leftFoot 0.146
  //      （证据脚本：`_rootq.mjs` + `_rigdump.mjs`，见 REPORT.md）
  //   3) 解释：Unity 的 `RootQ` 是 **Avatar 根节点的朝向**（这些资产是在"根被转 180°"
  //      的绑定下制作的），不是"角色相对 T-pose 的增量"。而 VRM 的归一化骨架**自带**
  //      正确的站立朝向（rest 旋转 = 单位阵，实测 52/52）。再叠一次 180° 必然颠倒。
  //   ⇒ 需要原始根旋转的场合请显式传 `--rootq apply`，那时由调用方自己负责抵消。
  const rq = opts.rootQMode === 'apply' ? ['x', 'y', 'z', 'w'].map((a) => map.get(`RootQ.${a}`)) : [null, null, null, null]
  if (rq.some(Boolean)) {
    const arr = new Array(n + 1)
    for (let i = 0; i <= n; i++) {
      const q = {
        x: rq[0] ? sampleCurve(rq[0].keys, times[i]) : 0,
        y: rq[1] ? sampleCurve(rq[1].keys, times[i]) : 0,
        z: rq[2] ? sampleCurve(rq[2].keys, times[i]) : 0,
        w: rq[3] ? sampleCurve(rq[3].keys, times[i]) : 1,
      }
      const len = Math.hypot(q.x, q.y, q.z, q.w) || 1
      arr[i] = { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len }
    }
    if (quats.hips) quats.hips = quats.hips.map((h, i) => qmul(arr[i], h))
    else { quats.hips = arr; if (!bones.includes('hips')) bones.push('hips') }
  } else if (hipsT) {
    // hips 没有旋转曲线也要存在（VRMA 规范要求；且加载器要用它算 rest 姿势）
    quats.hips = new Array(n + 1).fill(IDENTITY_QUAT)
    if (!bones.includes('hips')) bones.push('hips')
  }

  // RootT 位移范围（用于 manifest 的 root displacement range）
  let rootTorRange = null
  if (hipsT) {
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i <= n; i++) for (let c = 0; c < 3; c++) {
      const v = hipsT[i * 3 + c]
      if (v < mn[c]) mn[c] = v
      if (v > mx[c]) mx[c] = v
    }
    rootTorRange = [mn[0], mx[0], mn[1], mx[1], mn[2], mx[2]]
  }

  bones.sort((a, b) => a.localeCompare(b))
  return { duration, hz, frames: n + 1, times, bones, quats, hipsT, hipsRest, warnings, outOfRange, rootTorRange, dupes }
}

// ───────────────────────────────────────────────────────── GLB 写出

const GLB_MAGIC = 0x46546c67
const CHUNK_JSON = 0x4e4f534a
const CHUNK_BIN = 0x004e4942
const IDENTITY4 = [0, 0, 0, 1]

/**
 * 组装 GLB。结构要点（每条都有实测理由，见 loader-test.mjs 的历史坑）：
 *  · `hips` 必须在 `humanBones` 里 —— 加载器要读它的世界位置当 rest。
 *  · 每个 node **必须**有 translation/rotation（否则解析器 decompose 时 undefined 崩）。
 *  · `channels[i].sampler` 必须指向存在的 sampler。
 *  · 只有 hips 允许有 translation 轨道（规范硬性要求，别的会被忽略并 warn）。
 */
export function buildVrma(name, s) {
  const bones = s.bones.slice()
  if (!bones.includes('hips')) bones.unshift('hips')

  /** 节点：每个骨一个；hips 额外带 rest 位移 */
  const nodes = bones.map((b) => ({ name: b, translation: [0, 0, 0], rotation: IDENTITY4.slice() }))
  const hipsIdx = bones.indexOf('hips')
  nodes[hipsIdx].translation = [s.hipsRest[0], s.hipsRest[1], s.hipsRest[2]]

  const bufferViews = []
  const accessors = []
  const blobs = []
  let offset = 0
  const pushView = (buf, target) => {
    const pad = (4 - (buf.length % 4)) % 4
    const padded = pad ? Buffer.concat([buf, Buffer.alloc(pad)]) : buf
    const bv = { buffer: 0, byteOffset: offset, byteLength: buf.length }
    if (target) bv.target = target
    bufferViews.push(bv)
    blobs.push(padded)
    offset += padded.length
    return bufferViews.length - 1
  }
  const pushAcc = (view, count, type, min, max) => {
    const a = { bufferView: view, componentType: 5126, count, type }
    if (min) a.min = min
    if (max) a.max = max
    accessors.push(a)
    return accessors.length - 1
  }

  // 时间 accessor（所有 sampler 共用同一个）
  const tBuf = Buffer.alloc(s.times.length * 4)
  for (let i = 0; i < s.times.length; i++) tBuf.writeFloatLE(s.times[i], i * 4)
  const tAcc = pushAcc(pushView(tBuf), s.times.length, 'SCALAR', [s.times[0]], [s.times[s.times.length - 1]])

  const channels = []
  const samplers = []
  const humanBones = {}
  for (let i = 0; i < bones.length; i++) humanBones[bones[i]] = { node: i }

  for (const b of bones) {
    const seq = s.quats[b]
    if (!seq) continue
    const qb = Buffer.alloc(seq.length * 16)
    for (let i = 0; i < seq.length; i++) {
      qb.writeFloatLE(seq[i].x, i * 16)
      qb.writeFloatLE(seq[i].y, i * 16 + 4)
      qb.writeFloatLE(seq[i].z, i * 16 + 8)
      qb.writeFloatLE(seq[i].w, i * 16 + 12)
    }
    const acc = pushAcc(pushView(qb), seq.length, 'VEC4')
    samplers.push({ input: tAcc, output: acc, interpolation: 'LINEAR' })
    channels.push({ sampler: samplers.length - 1, target: { node: bones.indexOf(b), path: 'rotation' } })
  }
  if (s.hipsT) {
    const tb = Buffer.alloc(s.hipsT.length * 4)
    for (let i = 0; i < s.hipsT.length; i++) tb.writeFloatLE(s.hipsT[i], i * 4)
    const acc = pushAcc(pushView(tb), s.hipsT.length / 3, 'VEC3')
    samplers.push({ input: tAcc, output: acc, interpolation: 'LINEAR' })
    channels.push({ sampler: samplers.length - 1, target: { node: hipsIdx, path: 'translation' } })
  }

  const bin = Buffer.concat(blobs)
  const gltf = {
    asset: { version: '2.0', generator: 'motion-lab/convert-anim.mjs' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    animations: [{ name, channels, samplers }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length }],
    extensionsUsed: ['VRMC_vrm_animation'],
    extensions: {
      VRMC_vrm_animation: {
        specVersion: '1.0',
        humanoid: { humanBones },
      },
    },
  }

  let jb = Buffer.from(JSON.stringify(gltf), 'utf8')
  if (jb.length % 4) jb = Buffer.concat([jb, Buffer.alloc(4 - (jb.length % 4), 0x20)])
  const binPad = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)])
  const chunk = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b }
  const total = 12 + 8 + jb.length + 8 + binPad.length
  const header = Buffer.alloc(12)
  header.writeUInt32LE(GLB_MAGIC, 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(total, 8)
  const glb = Buffer.concat([header, chunk(jb.length, CHUNK_JSON), jb, chunk(binPad.length, CHUNK_BIN), binPad])
  return { glb, stats: { nodes: nodes.length, bones: Object.keys(humanBones).length, frames: s.times.length, duration: s.duration, bytes: glb.length } }
}

// ───────────────────────────────────────────────────────── manifest

/**
 * 逐骨总角行程（度）。用于 manifest 的 per-bone activity 与 leg activity metric。
 */
export function boneActivity(s) {
  const out = {}
  for (const b of s.bones) {
    const seq = s.quats[b]
    out[b] = seq ? +angularTravel(seq).toFixed(3) : 0
  }
  return out
}

const LEG_BONES = ['leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes']

/**
 * 自动判定是否可循环：
 *   ① 首末帧姿态距离（所有骨四元数夹角的最大值）要小
 *   ② RootT 漂移要小
 *   ③ Unity 的 m_LoopTime 标记为 1（辅助信息）
 */
export function loopability(s, parsed) {
  const poseDists = {}
  let maxPose = 0
  for (const b of s.bones) {
    const seq = s.quats[b]
    if (!seq || seq.length < 2) continue
    const a = seq[0], z = seq[seq.length - 1]
    const dot = Math.abs(a.x * z.x + a.y * z.y + a.z * z.z + a.w * z.w)
    const ang = (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI
    poseDists[b] = +ang.toFixed(3)
    if (ang > maxPose) maxPose = ang
  }
  let rootDrift = 0
  if (s.hipsT) {
    const n = s.hipsT.length / 3
    rootDrift = Math.hypot(s.hipsT[0] - s.hipsT[(n - 1) * 3], s.hipsT[1] - s.hipsT[(n - 1) * 3 + 1], s.hipsT[2] - s.hipsT[(n - 1) * 3 + 2])
  }
  const unityLoop = parsed?.settings?.m_LoopTime === 1
  const POSE_TOL = 3.0     // 度
  const DRIFT_TOL = 0.02   // 米
  const loopable = maxPose <= POSE_TOL && rootDrift <= DRIFT_TOL
  return {
    loopable,
    unityLoopTime: unityLoop,
    maxFirstLastPoseDistanceDeg: +maxPose.toFixed(3),
    rootDriftMeters: +rootDrift.toFixed(5),
    perBoneFirstLastDeg: poseDists,
    thresholds: { poseTolDeg: POSE_TOL, driftTolMeters: DRIFT_TOL },
  }
}

/** 允许叠加的层：依据活动量给建议 */
export function allowedOverlays(activity, legActivity) {
  const layers = ['emotion-face']
  const spine = (activity.spine ?? 0) + (activity.chest ?? 0) + (activity.upperChest ?? 0)
  const head = (activity.head ?? 0) + (activity.neck ?? 0)
  const arms = ['leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand']
    .reduce((a, b) => a + (activity[b] ?? 0), 0)
  if (spine < 40) layers.push('breathing')
  else layers.push('breathing-reduced')
  if (head < 60) layers.push('look-at')
  if (arms < 120) layers.push('prop-hand')
  if (legActivity < 40) layers.push('idle-sway')
  return layers
}

export function buildManifest(parsed, s, meta) {
  const activity = boneActivity(s)
  const legs = Object.fromEntries(LEG_BONES.map((b) => [b, activity[b] ?? 0]))
  const legActivity = +Object.values(legs).reduce((a, b) => a + b, 0).toFixed(3)
  const loop = loopability(s, parsed)
  return {
    schema: 'motion-clip-manifest/1',
    name: meta.name,
    slug: meta.slug,
    set: meta.set,
    source: meta.source,
    sourceRelative: meta.sourceRelative,
    sourceBytes: meta.sourceBytes,
    clip: {
      unityName: parsed.name,
      unitySampleRate: parsed.sampleRate,
      unityWrapMode: parsed.wrapMode,
      unityLoopTime: parsed.settings.m_LoopTime === 1,
      unityCompressed: !!parsed.compressed,
      serializedVersion: parsed.serializedVersion,
    },
    vrma: {
      file: meta.outFile,
      bytes: meta.bytes,
      hz: s.hz,
      frames: s.frames,
      bones: s.bones.length,
      boneNames: s.bones,
      specVersion: '1.0',
      generator: 'motion-lab/convert-anim.mjs',
      restMode: REST_MODE,
      quaternionConvention: VRMA_QUATERNION_CONVENTION,
    },
    duration: +s.duration.toFixed(6),
    loopable: loop.loopable,
    loop,
    rootDisplacement: s.rootTorRange
      ? {
        hasTranslation: true,
        rest: s.hipsRest.map((v) => +v.toFixed(5)),
        min: [s.rootTorRange[0], s.rootTorRange[2], s.rootTorRange[4]].map((v) => +v.toFixed(5)),
        max: [s.rootTorRange[1], s.rootTorRange[3], s.rootTorRange[5]].map((v) => +v.toFixed(5)),
        range: [s.rootTorRange[1] - s.rootTorRange[0], s.rootTorRange[3] - s.rootTorRange[2], s.rootTorRange[5] - s.rootTorRange[4]].map((v) => +v.toFixed(5)),
      }
      : { hasTranslation: false, rest: [0, 0, 0], min: [0, 0, 0], max: [0, 0, 0], range: [0, 0, 0] },
    perBoneActivityDeg: activity,
    legActivity: { total: legActivity, perBone: legs, metric: '总角行程（逐帧四元数夹角之和，度）' },
    allowedOverlayLayers: allowedOverlays(activity, legActivity),
    curveStats: {
      totalCurves: parsed.curves.length,
      fromFloatCurves: parsed.bySection.m_FloatCurves,
      fromEditorCurves: parsed.bySection.m_EditorCurves,
      counts: parsed.counts,
    },
    warnings: s.warnings,
    outOfRangeMuscles: s.outOfRange,
    unverified: [
      ...(allFingerMuscleNames().length ? ['手指肌肉的轴向/符号未逐轴实测（活动量 < 1°）'] : []),
      '左右 In-Out / Twist 的**命名方向**（哪个叫"内"）未与 Unity 文档逐条比对；轴与符号已实测',
      '脚趾 Up-Down 的符号未独立实测（脚趾与脚踝世界位置重合，位置探测无法区分）',
      '欧拉序（ZXY vs ZYX）未在本工程的样本上被独立区分',
    ],
  }
}

// ───────────────────────────────────────────────────────── CLI

function resolveSetMembers(setName) {
  const cands = SETS[setName]
  if (!cands) throw new Error(`未知 set "${setName}"；可用：${Object.keys(SETS).join(', ')}`)
  const out = []
  for (const parts of cands) {
    const p = join(ANIM_DIR, ...parts)
    if (existsSync(p)) out.push({ parts, path: p })
  }
  return out
}

/** 把 `--set` 展开成任务列表；缺名时按任务书规则回退 */
function expandSet(setName, hz) {
  const jobs = []
  if (setName === 'idle') {
    // 任务书：优先 PET_IDLE.anim、PET_IDLE_2..10.anim，缺名退回 ME_02/*
    const direct = []
    const me02 = []
    for (let i = 1; i <= 10; i++) {
      const fn = i === 1 ? 'PET_IDLE.anim' : `PET_IDLE_${i}.anim`
      direct.push(['PET_IDLE', fn])
    }
    for (const n of ['PET_IDLE_16.anim', 'PET_IDLE_17.anim', 'PET_IDLE_19.anim', 'PET_IDLE_20.anim', 'PET_IDLE_21.anim', 'PET_IDLE_22.anim']) me02.push(['PET_IDLE', 'ME_02', n])
    const picked = []
    for (const parts of direct) {
      if (picked.length >= 10) break
      const p = join(ANIM_DIR, ...parts)
      if (existsSync(p)) picked.push(parts)
    }
    let k = 0
    while (picked.length < 10 && k < me02.length) {
      const parts = me02[k++]
      const p = join(ANIM_DIR, ...parts)
      if (existsSync(p)) picked.push(parts)
    }
    for (const parts of picked) jobs.push({ set: 'idle', parts })
    return jobs
  }
  if (setName === 'walk') {
    for (const parts of SETS.walk) {
      const p = join(ANIM_DIR, ...parts)
      if (existsSync(p)) { jobs.push({ set: 'walk', parts }); break }
    }
    return jobs
  }
  for (const parts of SETS[setName] ?? []) {
    const p = join(ANIM_DIR, ...parts)
    if (existsSync(p)) jobs.push({ set: setName, parts })
  }
  return jobs
}

function doOne(job, hz, opts) {
  const srcPath = job.abs ?? join(ANIM_DIR, ...job.parts)
  if (!existsSync(srcPath)) return { ok: false, name: job.parts?.join('/') ?? srcPath, error: `源文件不存在：${srcPath}` }
  const outPath = opts.out ?? join(OUT_DIR, `${slugOf(job.parts)}.vrma`)
  // slug：显式 --out 时以输出文件名反推（保证 manifest 名与 .vrma 名一致），否则由路径生成
  const slug = opts.name ?? basename(outPath).replace(/\.vrma$/i, '')
  const outFile = basename(outPath)
  const srcBytes = statSync(srcPath).size

  try {
    const parsed = parseAnim(srcPath)
    if (parsed.compressed || parsed.compressedRotationCurves) {
      return { ok: false, name: slug, error: `m_Compressed=1（m_CompressedRotationCurves=${parsed.compressedRotationCurves}）：本转换器不支持压缩载荷，已显式拒绝（不产出垃圾数据）` }
    }
    const s = buildSamples(parsed, hz, opts)
    if (s.bones.length === 0) return { ok: false, name: slug, error: '没有任何肌肉曲线命中肌肉表 —— 该 clip 可能不是 Humanoid 动画' }
    const { glb, stats } = buildVrma(slug, s)
    const manifest = buildManifest(parsed, s, {
      name: slug, slug, set: job.set, source: srcPath, sourceRelative: relative(ANIM_DIR, srcPath).replace(/\\/g, '/'),
      sourceBytes: srcBytes, outFile, bytes: glb.length,
    })
    if (opts.dryRun) {
      return { ok: true, name: slug, dryRun: true, stats, manifest }
    }
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, glb)
    mkdirSync(MANIFEST_DIR, { recursive: true })
    const mPath = join(MANIFEST_DIR, `${slug}.json`)
    writeFileSync(mPath, JSON.stringify(manifest, null, 2), 'utf8')
    return { ok: true, name: slug, outPath, manifestPath: mPath, stats, manifest }
  } catch (e) {
    return { ok: false, name: slug, error: `${e?.message ?? e}` }
  }
}

const isDirectRun = (() => {
  try {
    const entry = process.argv[1] ? resolve(process.argv[1]) : ''
    return !!entry && resolve(fileURLToPath(import.meta.url)) === entry
  } catch { return false }
})()

if (isDirectRun) {
  const argv = process.argv.slice(2)
  const has = (f) => argv.includes(f)
  const valOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d }

  if (has('--list') || argv.length === 0) {
    console.log(`动画源目录：${ANIM_DIR}  (${existsSync(ANIM_DIR) ? '存在' : '不存在'})`)
    for (const set of TARGET_SETS) {
      const jobs = expandSet(set, 30)
      console.log(`\n[${set}]  ${jobs.length} 个：`)
      for (const j of jobs) console.log(`  ${join(...j.parts)}`)
      if (!jobs.length) console.log('  (无可用文件)')
    }
    process.exit(argv.length === 0 ? 2 : 0)
  }

  const HZ = Number(valOf('--hz', '30'))
  const DRY = has('--dry-run')
  if (!(HZ > 0 && HZ <= 240)) { console.error(`--hz 非法：${valOf('--hz', '30')}`); process.exit(2) }

  let jobs = []
  if (has('--in')) {
    const inp = valOf('--in')
    const abs = existsSync(inp) ? inp : join(ANIM_DIR, inp)
    jobs.push({ set: valOf('--set-name', 'single'), parts: null, abs, explicitOut: valOf('--out', null) })
  } else if (has('--set')) {
    const setName = valOf('--set')
    jobs = expandSet(setName, HZ)
    if (!jobs.length) { console.error(`[环境不可用] set "${setName}" 里一个文件都不存在`); process.exit(2) }
  } else if (has('--batch')) {
    const bf = valOf('--batch')
    if (!existsSync(bf)) { console.error(`[环境不可用] batch 文件不存在：${bf}`); process.exit(2) }
    const spec = JSON.parse(readFileSync(bf, 'utf8'))
    const list = Array.isArray(spec) ? spec : spec.clips
    if (!Array.isArray(list)) { console.error('batch 文件必须是数组或 { clips: [...] }'); process.exit(2) }
    for (const it of list) {
      const rel = it.source ?? it.in
      const abs = existsSync(rel) ? rel : join(ANIM_DIR, rel)
      jobs.push({ set: it.set ?? 'batch', parts: null, abs, explicitOut: it.out ?? null, name: it.name ?? null })
    }
  } else {
    console.error('用法: --in <anim> --out <vrma> | --set <idle|drag|walk|sit|sleep> | --batch <json> | --list')
    process.exit(2)
  }

  let fail = 0, ok = 0
  const results = []
  for (const job of jobs) {
    const j = job.parts
      ? job
      : { ...job, parts: [relative(ANIM_DIR, job.abs)] }
    const opts = {
      dryRun: DRY, name: job.name ?? null, out: job.explicitOut ?? null,
      includeFingers: !has('--no-fingers'),
      rootQMode: has('--rootq') ? valOf('--rootq', 'drop') : 'drop',
    }
    const r = doOne(j, HZ, opts)
    results.push(r)
    if (r.ok) {
      ok++
      const m = r.manifest
      const legs = m.legActivity.total
      console.log(`[OK]   ${r.name.padEnd(24)} 骨=${String(m.vrma.bones).padStart(3)} 帧=${String(m.vrma.frames).padStart(4)} 时长=${m.duration.toFixed(3)}s 字节=${String(m.vrma.bytes).padStart(8)} 腿行程=${legs.toFixed(1)}° 可循环=${m.loopable ? 'Y' : 'N'}${DRY ? '  (dry-run)' : ''}`)
      if (r.stats && !DRY) console.log(`       → ${r.outPath}`)
    } else {
      fail++
      console.log(`[FAIL] ${r.name}: ${r.error}`)
    }
  }
  console.log(`\n合计 ${jobs.length} 个；成功 ${ok}，失败 ${fail}`)
  if (!DRY && ok) console.log(`VRMA 目录    : ${OUT_DIR}\nmanifest 目录: ${MANIFEST_DIR}`)
  process.exit(fail ? 1 : 0)
}
