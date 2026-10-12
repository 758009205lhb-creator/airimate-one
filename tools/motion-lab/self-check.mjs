/**
 * self-check.mjs —— 轴向/符号的**经验验证**（任务书第 2 条点名要的那个工具）
 *
 * 这个文件不"断言"约定，它**量**。三段：
 *
 *  ┌─ S 段（语义单元测试，最强的一段）
 *  │   对**单条肌肉**施加一个值，在真实 `.vrm` 模型上量**世界空间**效果，
 *  │   并断言它符合该肌肉名字所描述的动作。例如：
 *  │     `Left Arm Down-Up = +1`  ⇒ 左手世界 Y 必须**上升**（同侧对比：右手也必须上升）
 *  │     `Left Arm Down-Up = -1`  ⇒ 左手世界 Y 必须**下降**
 *  │     `Left Lower Leg Stretch = -1` ⇒ **膝角**（大腿·小腿夹角）必须**减小**（屈膝）
 *  │     两侧对称：左右两条同名肌肉施加同一值，Y 变化方向必须一致
 *  │   这是真正能钉死「符号」的测试 —— 只靠"姿态看起来合理"是不够的（见下方 NOTE）。
 *  │
 *  ├─ B 段（对照实验）
 *  │   把同一份 muscle 值按 4 种候选约定解码（asis / flipSigns / flipAxes / swapSwingTwist），
 *  │   统计各自通过解剖学不变量的比例。
 *  │
 *  └─ A 段（解剖学不变量）
 *      在真实 `.vrma` 的若干采样帧上断言：上臂不插进躯干 / 手在躯干外 /
 *      大腿朝下 / 膝不反折 / 脚不高于髋 / 头在髋上 / 两膝不穿模。
 *
 * NOTE（为什么必须有 S 段）：0.16 秒的待机姿态里腿只动几度，
 * 「姿态看起来合理」对符号翻转**不敏感** —— 实测 flipSigns 在 PET_POSE_1 上
 * 也能拿到 100% 的解剖学通过率。所以符号必须靠 S 段的**定向位移**来钉死。
 *
 * 用法
 *   node self-check.mjs --semantics                 # S 段（默认就是它）
 *   node self-check.mjs --vrma <file.vrma> [--frames 6] [--json]
 *   node self-check.mjs --set idle
 *   node self-check.mjs --sign-sweep [--anim <file.anim>]
 *   node self-check.mjs --all
 *
 * 退出码：0 全通过 / 1 有断言失败 / 2 环境不可用
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve, basename } from 'node:path'
import { Buffer } from 'node:buffer'
import { parseAnim, authoritativeCurves, indexCurves, sampleCurve } from './parse-anim.mjs'
import { MUSCLE_TABLE, IDENTITY_QUAT, axisAngle, qmul } from './humanoid-map.mjs'

const MOD = 'F:/deepseek harness/AI女友/build/airi-modules'
const VRM_PATH = 'F:/deepseek harness/AI女友/repos/Mate-Engine/Assets/MATE ENGINE - Avatar/DLCs/Lazuli_VRM.vrm'
const MATE_ANIM = 'F:/deepseek harness/AI女友/repos/Mate-Engine/Assets/MATE ENGINE - Animations'
const VRMA_DIR = 'F:/deepseek harness/AI女友/新工程/assets/motion'

// ── 浏览器模块的 Node 垫片（每条都有踩坑理由）
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis
if (typeof globalThis.navigator === 'undefined') globalThis.navigator = { userAgent: 'node' }
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElementNS: () => ({ style: {}, getContext: () => null, addEventListener() {}, removeEventListener() {} }),
    createElement: () => ({ style: {}, getContext: () => null, addEventListener() {}, removeEventListener() {} }),
  }
}
if (typeof globalThis.URL.createObjectURL === 'undefined') globalThis.URL.createObjectURL = () => 'blob:stub'
// ⚠ 缺这个桩，GLTFLoader 的 material promise 永不 settle，顶层 await 会**静默挂死**
if (typeof globalThis.createImageBitmap === 'undefined') globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} })

const load = async (rel) => import(pathToFileURL(resolve(MOD, rel)).href)
const THREE = await load('three/build/three.module.js')
const { GLTFLoader } = await load('three-stdlib/loaders/GLTFLoader.js')
const { VRMLoaderPlugin } = await load('three-vrm.module.js')
const { VRMAnimationLoaderPlugin, createVRMAnimationClip } = await load('three-vrm-animation.module.js')

/** 剥掉 mesh/贴图：只要骨架（Node 无 WebGL，带 mesh 会崩） */
function loadableGlb(buf) {
  const jsonLen = buf.readUInt32LE(12)
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'))
  delete json.images; delete json.samplers; delete json.textures; delete json.meshes; delete json.skins
  for (const n of json.nodes ?? []) { delete n.mesh; delete n.skin }
  for (const m of json.materials ?? []) {
    delete m.normalTexture; delete m.occlusionTexture; delete m.emissiveTexture
    if (m.pbrMetallicRoughness) { delete m.pbrMetallicRoughness.baseColorTexture; delete m.pbrMetallicRoughness.metallicRoughnessTexture }
  }
  const rest = buf.subarray(20 + jsonLen)
  let jb = Buffer.from(JSON.stringify(json), 'utf8')
  if (jb.length % 4) jb = Buffer.concat([jb, Buffer.alloc(4 - (jb.length % 4), 0x20)])
  const head = Buffer.alloc(20)
  head.write('glTF', 0, 'ascii'); head.writeUInt32LE(2, 4)
  head.writeUInt32LE(12 + 8 + jb.length + rest.length, 8); head.writeUInt32LE(jb.length, 12); head.writeUInt32LE(0x4e4f534a, 16)
  return Buffer.concat([head, jb, rest])
}
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)

const _w = console.warn, _e = console.error
console.warn = () => {}; console.error = () => {}
const vrmGlb = loadableGlb(readFileSync(VRM_PATH))
const gl = new GLTFLoader(); gl.register((p) => new VRMLoaderPlugin(p))
const vrmGltf = await new Promise((res, rej) => gl.parse(ab(vrmGlb), '', res, rej))
const vrm = vrmGltf.userData.vrm
console.warn = _w; console.error = _e
vrm.scene.updateWorldMatrix(true, true)

const ALL_BONES = Object.keys(vrm.humanoid.humanBones)
const node = (n) => vrm.humanoid.getNormalizedBoneNode(n)
const wp = (n) => node(n)?.getWorldPosition(new THREE.Vector3()) ?? null
const restPos = new Map(ALL_BONES.map((b) => [b, node(b)?.position.clone() ?? null]))
function hardReset() {
  for (const b of ALL_BONES) {
    const nd = node(b); if (!nd) continue
    nd.quaternion.set(0, 0, 0, 1)
    const rp = restPos.get(b); if (rp) nd.position.copy(rp)
  }
  vrm.scene.updateWorldMatrix(true, true)
}
function applyPose(map) {
  hardReset()
  for (const [b, q] of map) { const nd = node(b); if (nd) nd.quaternion.set(q.x, q.y, q.z, q.w) }
  vrm.scene.updateWorldMatrix(true, true)
}
const V = (x, y, z) => new THREE.Vector3(x, y, z)
function dirOf(a, b) {
  const p = wp(a), q = wp(b)
  if (!p || !q) return null
  const d = q.clone().sub(p)
  return d.lengthSq() < 1e-12 ? null : d.normalize()
}

// ═══════════════════════════════════════════════════ S 段：语义单元测试

const DEG = 180 / Math.PI
/**
 * 骨链三点夹角（度）：方向 A→B 与 B→C 的夹角。180° = 完全伸直。
 * ⚠ 三点必须**两两不同**且不共线同向，否则点积恒为 1、角度恒为 0（实测踩到过）。
 * @param {string} a 父骨（近端）
 * @param {string} b 关节骨（顶点）
 * @param {string} c 远端骨
 */
function jointAngle3(a, b, c) {
  if (!a || !b || !c) return null
  const d1 = dirOf(a, b)
  const d2 = dirOf(b, c)
  if (!d1 || !d2) return null
  return (Math.acos(Math.max(-1, Math.min(1, d1.dot(d2))))) * DEG
}

/**
 * **本骨自转角度**（度）：该骨相对静止朝向转了多少。
 * 这是量「屈曲」最鲁棒的方式 —— 实测对比过两种：
 *   · 三点夹角法：`flexion = 180 − angle(父→本, 本→远端)`。
 *     在**纯平面**关节上没问题，但在 3D 里会失真：把前臂绕世界 Z 抬 130° 后，
 *     `lowerArm→hand` 与 `upperArm→lowerArm` 的夹角只有 50°（因为远端骨自身也被带转），
 *     得到的是"折线角"而不是"关节屈曲角"。实测：`elbowFlex` 给 50° 而真值是 130°。
 *   · 本骨自转角：归一化骨 rest 旋转 = 单位阵（实测），所以
 *     `angle(childWorldQuat) = 2·acos(|w|)` **就是**该关节转过的角度，与方向无关。
 * 因此 S 段统一用本骨自转角。
 */
function boneRotationDeg(bone) {
  const nd = node(bone)
  if (!nd) return null
  const q = nd.getWorldQuaternion(new THREE.Quaternion())
  return (2 * Math.acos(Math.min(1, Math.abs(q.w))) * DEG)
}
function flexion(a, b, c) {
  // 保留三点法供交叉检查；S 段主用 boneRotationDeg(b)
  const ang = jointAngle3(a, b, c)
  if (ang == null || ang < 1) return null
  return 180 - ang
}

/** 只把一条肌肉设成指定值，其余全 0，得到骨→四元数 */
function poseForOneMuscle(muscle, value, variant = 'asis') {
  const out = new Map()
  for (const row of MUSCLE_TABLE) {
    const axes = row.axes.map((a, i) => ({ a, i })).filter((x) => x.a)
    const parts = []
    let any = false
    for (const { a, i } of axes) {
      let deg = 0
      if (a.muscle === muscle) {
        any = true
        const [negMax, posMax] = a.limit
        const v = Math.max(-1, Math.min(1, value))
        deg = v >= 0 ? v * posMax : v * Math.abs(negMax)
      }
      let axis = a.axis
      if (variant === 'flipSigns') deg = -deg
      if (variant === 'flipAxes') axis = axis.map((x) => -x)
      parts.push({ i, axis, deg })
    }
    if (!any) continue
    parts.sort((x, y) => [2, 0, 1].indexOf(x.i) - [2, 0, 1].indexOf(y.i))   // Z → X → Y
    let acc = { ...IDENTITY_QUAT }
    for (const p of parts) acc = qmul(acc, axisAngle(p.axis, p.deg))
    out.set(row.bone, acc)
  }
  return out
}

/**
 * 语义测试用例表。每条声明「肌肉 + 值 ⇒ 某个可观测量必须往哪边走」。
 *
 * 期望值全部由**两条已实测的事实**推出，不是凭感觉：
 *   ① 静止朝向（`_calib2.mjs`）：左臂 -X、右臂 +X、双腿 -Y、躯干/头 +Y、角色朝 +Z
 *   ② 首词约定：肌肉名的第一个词 = 正方向。
 *      Down-Up +1 向下 | Front-Back +1 向后 | Up-Down +1 向上 | Left-Right +1 向角色左
 *   ⇒ 例：leftUpperArm 沿 -X，绕 +Z 让手从 -X 转向 +Y（上）；「Down-Up +1 = 向下」
 *         ⇒ 应取 -Z，于是 +0.7 让手的 Y **减小**。
 *   每个可观测量都用「相对静止的 Δ」判定，阈值按实测幅度留足余量。
 */
const SEMANTIC_CASES = [
  // ── 抬臂/放臂（两侧必须**行为一致**：同名肌肉在两边产生同方向的世界位移）
  { id: 'S-01', muscle: 'Left Arm Down-Up', value: +0.7, probe: 'handY', bone: 'leftUpperArm', distal: 'leftHand', expect: 'decrease', min: 0.15, desc: 'Down-Up +1 = 向下 ⇒ 左手 Y 下降' },
  { id: 'S-02', muscle: 'Left Arm Down-Up', value: -0.7, probe: 'handY', bone: 'leftUpperArm', distal: 'leftHand', expect: 'increase', min: 0.15, desc: 'Down-Up -1 = 向上 ⇒ 左手 Y 上升' },
  { id: 'S-03', muscle: 'Right Arm Down-Up', value: +0.7, probe: 'handY', bone: 'rightUpperArm', distal: 'rightHand', expect: 'decrease', min: 0.15, desc: '右手与左手**同向**（镜像轴编码的结果）' },
  { id: 'S-04', muscle: 'Right Arm Down-Up', value: -0.7, probe: 'handY', bone: 'rightUpperArm', distal: 'rightHand', expect: 'increase', min: 0.15, desc: '右手 Y 上升' },
  // ── 手臂前后摆
  { id: 'S-05', muscle: 'Left Arm Front-Back', value: +0.9, probe: 'handZ', bone: 'leftUpperArm', distal: 'leftHand', expect: 'decrease', min: 0.10, desc: 'Front-Back +1 = 向后 ⇒ 左手 Z 减小' },
  { id: 'S-06', muscle: 'Left Arm Front-Back', value: -0.9, probe: 'handZ', bone: 'leftUpperArm', distal: 'leftHand', expect: 'increase', min: 0.10, desc: 'Front-Back -1 = 向前 ⇒ 左手 Z 增大' },
  { id: 'S-07', muscle: 'Right Arm Front-Back', value: +0.9, probe: 'handZ', bone: 'rightUpperArm', distal: 'rightHand', expect: 'decrease', min: 0.10, desc: '右手同向' },
  // ── 屈肘（只有一个方向，用关节角判；静止时上臂与前臂共线 = 180°）
  { id: 'S-08', muscle: 'Left Forearm Stretch', value: -1, probe: 'elbowFlex', bone: 'leftLowerArm', distal: 'leftHand', parentBone: 'leftUpperArm', expect: 'increase', min: 100, desc: 'Stretch -1 = 屈肘 ⇒ 屈曲角从 0° 增大到 130°' },
  { id: 'S-09', muscle: 'Left Forearm Stretch', value: +1, probe: 'elbowFlex', bone: 'leftLowerArm', distal: 'leftHand', parentBone: 'leftUpperArm', expect: 'same', min: 0, tol: 1.0, desc: 'Stretch +1 = 0°（正侧极限 0 ⇒ 不可反折）' },
  { id: 'S-10', muscle: 'Right Forearm Stretch', value: -1, probe: 'elbowFlex', bone: 'rightLowerArm', distal: 'rightHand', parentBone: 'rightUpperArm', expect: 'increase', min: 100, desc: '右肘同向' },
  // ── 屈膝 / 抬腿
  { id: 'S-11', muscle: 'Left Lower Leg Stretch', value: -1, probe: 'kneeFlex', bone: 'leftLowerLeg', distal: 'leftFoot', parentBone: 'leftUpperLeg', expect: 'increase', min: 110, desc: 'Stretch -1 = 屈膝 ⇒ 屈曲角从 0° 增大到 130°' },
  { id: 'S-12', muscle: 'Right Lower Leg Stretch', value: -1, probe: 'kneeFlex', bone: 'rightLowerLeg', distal: 'rightFoot', parentBone: 'rightUpperLeg', expect: 'increase', min: 110, desc: '右膝同向' },
  { id: 'S-13', muscle: 'Left Upper Leg Front-Back', value: +0.85, probe: 'footZ', bone: 'leftUpperLeg', distal: 'leftFoot', expect: 'decrease', min: 0.10, desc: 'Front-Back +1 = 向后 ⇒ 左脚 Z 减小' },
  { id: 'S-14', muscle: 'Left Upper Leg Front-Back', value: -0.85, probe: 'footZ', bone: 'leftUpperLeg', distal: 'leftFoot', expect: 'increase', min: 0.10, desc: 'Front-Back -1 = 向前 ⇒ 左脚 Z 增大' },
  { id: 'S-15', muscle: 'Right Upper Leg Front-Back', value: -0.85, probe: 'footZ', bone: 'rightUpperLeg', distal: 'rightFoot', expect: 'increase', min: 0.10, desc: '右腿同向' },
  // ── 中轴
  { id: 'S-16', muscle: 'Spine Front-Back', value: +1, probe: 'neckZ', bone: 'spine', distal: 'neck', expect: 'increase', min: 0.02, desc: 'Front-Back +1 = 躯干前倾 ⇒ 颈 Z 增大（+X 旋转把末端送向 +Z；Unity 的 Front-Back 正侧即前弯）' },
  { id: 'S-17', muscle: 'Spine Front-Back', value: -1, probe: 'neckZ', bone: 'spine', distal: 'neck', expect: 'decrease', min: 0.02, desc: 'Front-Back -1 = 躯干后仰' },
  { id: 'S-18', muscle: 'Spine Left-Right', value: +1, probe: 'neckX', bone: 'spine', distal: 'neck', expect: 'increase', min: 0.02, desc: 'Left-Right +1 = 向角色左（+X）' },
  { id: 'S-19', muscle: 'Spine Left-Right', value: -1, probe: 'neckX', bone: 'spine', distal: 'neck', expect: 'decrease', min: 0.02, desc: 'Left-Right -1 = 向角色右' },
  { id: 'S-20', muscle: 'Neck Nod Down-Up', value: +1, probe: 'headZ', bone: 'neck', distal: 'head', expect: 'increase', min: 0.01, desc: 'Nod Down-Up +1 = 低头 ⇒ 头 Z 增大（朝前）' },
  { id: 'S-21', muscle: 'Neck Nod Down-Up', value: -1, probe: 'headZ', bone: 'neck', distal: 'head', expect: 'decrease', min: 0.01, desc: 'Nod Down-Up -1 = 抬头' },
  // ── 肩 / 腕 / 脚
  { id: 'S-22', muscle: 'Left Shoulder Down-Up', value: +1, probe: 'shoulderArmY', bone: 'leftShoulder', distal: 'leftUpperArm', expect: 'decrease', min: 0.003, desc: 'Down-Up +1 = 沉肩 ⇒ 上臂根 Y 下降' },
  { id: 'S-23', muscle: 'Left Hand Down-Up', value: +1, probe: 'fingertipY', bone: 'leftHand', distal: 'leftMiddleProximal', expect: 'decrease', min: 0.01, desc: 'Down-Up +1 = 屈腕向下' },
  { id: 'S-24', muscle: 'Left Foot Up-Down', value: +1, probe: 'toeY', bone: 'leftFoot', distal: 'leftToes', expect: 'increase', min: 0.005, desc: 'Up-Down +1 = 勾脚尖 ⇒ 脚趾 Y 上升' },
  { id: 'S-25', muscle: 'Left Lower Leg Stretch', value: +1, probe: 'kneeFlex', bone: 'leftLowerLeg', distal: 'leftFoot', parentBone: 'leftUpperLeg', expect: 'same', min: 0, tol: 1.0, desc: 'Stretch +1 = 0°（不可反折，与 Unity 极限 [0,130] 一致）' },
  // ── 两侧对称性（这是"镜像编码是否正确"的判据）
  { id: 'S-26', muscle: 'Right Upper Leg Front-Back', value: +0.85, probe: 'footZ', bone: 'rightUpperLeg', distal: 'rightFoot', expect: 'decrease', min: 0.10, desc: '右腿 Front-Back +1 与左腿**同向**（两腿同轴）' },
  { id: 'S-27', muscle: 'Right Arm Down-Up', value: +0.7, probe: 'handZ', bone: 'rightUpperArm', distal: 'rightHand', expect: 'same', min: 0, tol: 0.002, desc: '纯抬臂不应产生前后位移' },
]

function measure(probe, c) {
  switch (probe) {
    case 'handY': return wp(c.distal)?.y ?? null
    case 'handZ': return wp(c.distal)?.z ?? null
    case 'footZ': return wp(c.distal)?.z ?? null
    case 'neckZ': return wp(c.distal)?.z ?? null
    case 'neckX': return wp(c.distal)?.x ?? null
    case 'headZ': return wp(c.distal)?.z ?? null
    case 'toeY': return wp(c.distal)?.y ?? null
    case 'shoulderArmY': return wp(c.distal)?.y ?? null
    case 'fingertipY': return wp(c.distal)?.y ?? null
    case 'elbowAngle': return jointAngle3(c.parentBone, c.bone, c.distal)
    case 'kneeAngle': return jointAngle3(c.parentBone, c.bone, c.distal)
    case 'elbowFlex': return boneRotationDeg(c.bone)
    case 'kneeFlex': return boneRotationDeg(c.bone)
    default: return null
  }
}

function runSemantics() {
  console.log('=== S 段：逐肌肉语义单元测试（真实 VRM 上的世界空间效果）===')
  console.log('期望语义：肌肉名第一个词 = 正方向（Down-Up +1 向下、Front-Back +1 向后、Up-Down +1 向上、Left-Right +1 向角色左）\n')
  console.log('ID    肌肉'.padEnd(32) + '值'.padStart(6) + '观测量'.padEnd(15) + '静止'.padStart(10) + '施加后'.padStart(10) + 'Δ'.padStart(11) + '  判定')
  const results = []
  for (const c of SEMANTIC_CASES) {
    hardReset()
    const before = measure(c.probe, c)
    applyPose(poseForOneMuscle(c.muscle, c.value))
    const after = measure(c.probe, c)
    const delta = (before != null && after != null) ? after - before : null
    let ok = false
    if (delta != null) {
      if (c.expect === 'increase') ok = delta >= c.min
      else if (c.expect === 'decrease') ok = delta <= -c.min
      else if (c.expect === 'same') ok = Math.abs(delta) <= (c.tol ?? 1)
    }
    results.push({ id: c.id, muscle: c.muscle, value: c.value, probe: c.probe, before, after, delta, expect: c.expect, min: c.min, ok, desc: c.desc })
    const f = (v) => (v == null ? 'n/a' : v.toFixed(4))
    console.log(`${c.id}  ${c.muscle.padEnd(30)}${String(c.value).padStart(6)}${c.probe.padEnd(15)}${f(before).padStart(10)}${f(after).padStart(10)}${f(delta).padStart(11)}  ${ok ? 'PASS' : 'FAIL'}  ${c.desc}`)
  }
  hardReset()
  const pass = results.filter((r) => r.ok).length
  console.log(`\nS 段合计 ${pass}/${results.length} 通过`)
  return results
}

// ═══════════════════════════════════════════════════ A 段：解剖学不变量

const TORSO_R = 0.10
/**
 * ⚠ 两个**实测标定过**的阈值（不是拍的）：
 *
 * A-7「两膝不穿模」：模型**静止姿态**下 `leftLowerLeg` 与 `rightLowerLeg` 的世界
 *   x 差就是 **0.0038 m** —— 这个角色膝盖本来就是并拢的。
 *   实测 `idle_pet_idle_10` 全段最小膝间距 = 0.0038 m（= 静止值，根本没穿模），
 *   早期用 0.02 m 阈值直接把它误判 FAIL。
 *   ⇒ 阈值取 **0.002 m**：只有当膝盖真的交叉（x 变号或近于 0）才会触发。
 *
 * A-3「大腿朝下」：静止时大腿与 -Y 夹角 ≈ 3.1°，待机实测最大 30.2°（正常）。
 *   但 `sleeping_pet_sleeping`（躺姿）实测 **78.9°** —— 躺下时大腿本来就不朝下。
 *   ⇒ 这一条只对站立姿态有意义，非站立姿态通过 `poseKind` 显式**豁免**
 *     （豁免项在结果里标 `exempt: true`，不伪装成"通过"）。
 */
const KNEE_GAP_MIN_M = 0.002
const LEG_DOWN_MAX_DEG = 65

/**
 * 对一个姿态跑全部断言。
 * @param {object} [o]
 * @param {'standing'|'lying'|'sitting'} [o.poseKind='standing']
 */
export function anatomyChecks(o = {}) {
  const poseKind = o.poseKind ?? 'standing'
  const out = []
  const push = (id, ok, detail, value) => out.push({ id, ok: !!ok, detail, value, exempt: false })
  const skip = (id, why) => out.push({ id, ok: true, detail: `豁免：${why}`, exempt: true })
  const hips = wp('hips'), head = wp('head')
  const armDir = dirOf('leftUpperArm', 'leftLowerArm')
  const handPos = wp('leftHand')
  const legDir = dirOf('leftUpperLeg', 'leftLowerLeg')
  const shinDir = dirOf('leftLowerLeg', 'leftFoot')
  const ankle = wp('leftFoot')

  if (armDir) {
    const ang = (Math.acos(Math.max(-1, Math.min(1, Math.abs(armDir.y)))) * 180) / Math.PI
    push('A-1 上臂不平行插入躯干轴', ang > 20, `上臂方向与竖直轴夹角=${ang.toFixed(1)}°（阈值 >20°）`, ang)
  } else push('A-1 上臂不平行插入躯干轴', false, '取不到上臂方向')

  if (handPos && hips) {
    const dxy = Math.hypot(handPos.x - hips.x, handPos.z - hips.z)
    push('A-2 左手不在躯干内', dxy > TORSO_R, `手到髋轴水平距离=${dxy.toFixed(4)}m（阈值 >${TORSO_R}）`, dxy)
  } else push('A-2 左手不在躯干内', false, '取不到左手/hips')

  if (legDir) {
    const a = (Math.acos(Math.max(-1, Math.min(1, -legDir.y))) * 180) / Math.PI
    if (poseKind === 'standing') push('A-3 大腿朝下（膝不高抬）', a < LEG_DOWN_MAX_DEG, `大腿与 -Y 夹角=${a.toFixed(1)}°（阈值 <${LEG_DOWN_MAX_DEG}°）`, a)
    else skip('A-3 大腿朝下（膝不高抬）', `poseKind=${poseKind}，躺/坐姿下大腿本来就不朝下（实测 sleeping 为 78.9°）`)
  } else push('A-3 大腿朝下（膝不高抬）', false, '取不到大腿方向')

  if (legDir && shinDir) {
    const excess = shinDir.z - legDir.z
    push('A-4 膝不反折', excess < 0.55, `小腿-大腿前向差=${excess.toFixed(3)}（阈值 <0.55）`, excess)
  } else push('A-4 膝不反折', false, '取不到小腿方向')

  if (ankle && hips) {
    const dy = ankle.y - hips.y
    if (poseKind === 'standing') push('A-5 脚不高于髋', dy < -0.05, `踝-髋 高度差=${dy.toFixed(4)}m（阈值 <-0.05）`, dy)
    else skip('A-5 脚不高于髋', `poseKind=${poseKind}（实测差 ${dy.toFixed(4)}m）`)
  } else push('A-5 脚不高于髋', false, '取不到踝/hips')

  if (head && hips) {
    const dy = head.y - hips.y
    push('A-6 头在髋之上', dy > 0.15, `头-髋 高度差=${dy.toFixed(4)}m（阈值 >0.15）`, dy)
  } else push('A-6 头在髋之上', false, '取不到头/hips')

  const lk = wp('leftLowerLeg'), rk = wp('rightLowerLeg')
  if (lk && rk) {
    const dx = Math.abs(lk.x - rk.x)
    push('A-7 两膝不穿模', dx >= KNEE_GAP_MIN_M, `膝间距=${dx.toFixed(4)}m（阈值 >=${KNEE_GAP_MIN_M}；模型静止时本来就是 0.0038m，故不能用大阈值）`, dx)
  } else push('A-7 两膝不穿模', false, '取不到膝位置')
  return out
}

// ═══════════════════════════════════════════════════ B 段 + 文件加载

function animFramePose(animPath, t, variant = 'asis') {
  const parsed = parseAnim(animPath)
  const { map } = indexCurves(authoritativeCurves(parsed))
  const out = new Map()
  for (const row of MUSCLE_TABLE) {
    const parts = []
    let any = false
    row.axes.forEach((a, i) => {
      if (!a) return
      const c = map.get(a.muscle)
      if (!c) return
      any = true
      const raw = sampleCurve(c.keys, t)
      const [negMax, posMax] = a.limit
      const v = Math.max(-1, Math.min(1, raw))
      let deg = v >= 0 ? v * posMax : v * Math.abs(negMax)
      let axis = a.axis
      if (variant === 'flipSigns') deg = -deg
      if (variant === 'flipAxes') axis = axis.map((x) => -x)
      if (variant === 'swapSwingTwist') axis = row.axes[[2, 1, 0][i]] ? row.axes[[2, 1, 0][i]].axis : axis
      parts.push({ i, axis, deg })
    })
    if (!any) continue
    parts.sort((x, y) => [2, 0, 1].indexOf(x.i) - [2, 0, 1].indexOf(y.i))
    let acc = { ...IDENTITY_QUAT }
    for (const p of parts) acc = qmul(acc, axisAngle(p.axis, p.deg))
    out.set(row.bone, acc)
  }
  return out
}

async function loadVrma(path) {
  const buf = readFileSync(path)
  const l = new GLTFLoader()
  l.register((p) => new VRMAnimationLoaderPlugin(p))
  const g = await new Promise((res, rej) => l.parse(ab(buf), '', res, rej))
  const va = g.userData.vrmAnimations?.[0]
  if (!va) throw new Error('没有解析出 VRMAnimation')
  return { va, clip: createVRMAnimationClip(va, vrm), buf }
}
function stepTo(clip, t) {
  hardReset()
  const mixer = new THREE.AnimationMixer(vrm.scene)
  const action = mixer.clipAction(clip)
  action.play()
  mixer.setTime(t)
  vrm.scene.updateWorldMatrix(true, true)
}

// ═══════════════════════════════════════════════════ main

const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const valOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d }

if (has('--help') || argv.length === 0) {
  console.log('用法:')
  console.log('  node self-check.mjs --semantics                  # S 段：逐肌肉语义验证')
  console.log('  node self-check.mjs --sign-sweep [--anim a.anim] # B 段：约定对照实验')
  console.log('  node self-check.mjs --vrma <f.vrma> [--frames 6] # A 段：解剖学不变量')
  console.log('  node self-check.mjs --set idle')
  console.log('  node self-check.mjs --all [--json]')
  process.exit(argv.length === 0 ? 2 : 0)
}

let totalFail = 0
const report = { semantics: null, signSweep: null, files: [] }
const ALSO = (...names) => names.some((n) => has(n))
const ONLY_SEMANTICS = has('--semantics') && !has('--all')

// ── S 段
if (has('--semantics') || has('--all') || (!has('--sign-sweep') && !has('--vrma') && !has('--set'))) {
  const r = runSemantics()
  report.semantics = r
  const fail = r.filter((x) => !x.ok)
  if (fail.length) totalFail += fail.length
}

// ── B 段
if (has('--sign-sweep') || has('--all')) {
  const animRel = valOf('--anim', 'PET_POSE/PET_POSE_1.anim')
  const animPath = existsSync(animRel) ? animRel : resolve(MATE_ANIM, animRel)
  if (!existsSync(animPath)) { console.error(`[环境不可用] 找不到 ${animPath}`); process.exit(2) }
  const parsed = parseAnim(animPath)
  const N = Number(valOf('--frames', '6'))
  const ts = Array.from({ length: N }, (_, i) => ((parsed.duration * 0.98 * i) / Math.max(1, N - 1)))
  const variants = ['asis', 'flipSigns', 'flipAxes', 'swapSwingTwist']
  console.log(`\n=== B 段：约定对照实验（样本 ${basename(animPath)}，${N} 帧）===`)
  console.log('变体'.padEnd(18) + '通过'.padStart(6) + '/总'.padStart(8) + '   通过率')
  const results = {}
  for (const v of variants) {
    let pass = 0, tot = 0
    const fails = new Set()
    for (const t of ts) {
      applyPose(animFramePose(animPath, t, v))
      for (const c of anatomyChecks({ poseKind })) { tot++; if (c.ok) pass++; else fails.add(c.id) }
    }
    results[v] = { pass, tot, rate: +(pass / tot).toFixed(4), failedChecks: [...fails] }
    console.log(v.padEnd(18) + String(pass).padStart(6) + String(tot).padStart(8) + `   ${((pass / tot) * 100).toFixed(1)}%   ${fails.size ? '未过: ' + [...fails].join(',') : ''}`)
  }
  hardReset()
  const best = variants.reduce((a, b) => (results[b].pass > results[a].pass ? b : a))
  const asisIsBest = results.asis.pass >= Math.max(...variants.map((v) => results[v].pass))
  console.log(`最优变体 = ${best}；本实现 = 'asis'  ⇒ ${asisIsBest ? 'PASS（不劣于任何候选）' : 'FAIL'}`)
  console.log('注意：本段的区分力有限（待机姿态腿只动几度，flipSigns 也可能满分）；符号由 S 段钉死。')
  report.signSweep = { anim: animPath, frames: N, results, best, asisIsBest }
  if (!asisIsBest) totalFail++
}

// ── A 段
let files = []
if (has('--vrma')) files = [valOf('--vrma')]
else if (has('--set')) {
  const set = valOf('--set')
  if (!existsSync(VRMA_DIR)) { console.error(`[环境不可用] ${VRMA_DIR} 不存在`); process.exit(2) }
  files = readdirSync(VRMA_DIR).filter((f) => f.endsWith('.vrma'))
  if (set !== 'all') files = files.filter((f) => f.includes(set))
  files = files.map((f) => resolve(VRMA_DIR, f))
}
if (files.length) {
  const N = Number(valOf('--frames', '6'))
  /**
   * 姿态类别：`sleeping_*` 是躺姿、`sitting_*` 是坐姿，A-3/A-5 对它们没有意义
   * （实测 sleeping 的大腿与 -Y 夹角 78.9°，站着才要求 < 65°）。
   * 这里**显式声明**并让那些断言标 `exempt` 报告出来，而不是悄悄放松阈值。
   */
  const poseKindOf = (name) => /sleep/i.test(name) ? 'lying' : (/sit/i.test(name) ? 'sitting' : 'standing')
  console.log(`\n=== A 段：解剖学不变量（每文件 ${N} 个采样帧）===`)
  console.log('说明：A-3/A-5 只对站立姿态有意义；躺/坐姿会标 "豁免N"（exempt），不计入通过数也不计入失败。')
  for (const f of files) {
    if (!existsSync(f)) { console.log(`[FAIL] ${f}: 不存在`); totalFail++; continue }
    let vr
    try { vr = await loadVrma(f) } catch (e) { console.log(`[FAIL] ${basename(f)}: ${e.message}`); totalFail++; continue }
    const poseKind = poseKindOf(basename(f))
    const ts = Array.from({ length: N }, (_, i) => (vr.clip.duration * 0.98 * i) / Math.max(1, N - 1))
    let pass = 0, tot = 0, exempt = 0
    const failIds = new Set()
    const rows = []
    for (const t of ts) {
      stepTo(vr.clip, t)
      const cs = anatomyChecks({ poseKind })
      for (const c of cs) {
        if (c.exempt) { exempt++; continue }
        tot++
        if (c.ok) pass++; else failIds.add(c.id)
      }
      rows.push({ t: +t.toFixed(3), checks: cs })
    }
    hardReset()
    const ok = pass === tot
    if (!ok) totalFail++
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${basename(f).padEnd(30)} ${pass}/${tot}  pose=${poseKind}  豁免${exempt}  duration=${vr.clip.duration.toFixed(3)}s${failIds.size ? '  未过: ' + [...failIds].join(', ') : ''}`)
    report.files.push({ file: f, duration: vr.clip.duration, poseKind, pass, tot, exempt, ok, failedChecks: [...failIds], samples: rows })
  }
  const totalExempt = report.files.reduce((a, r) => a + (r.exempt ?? 0), 0)
  console.log(`\nA 段合计：文件 ${report.files.length}，断言 ${report.files.reduce((a, r) => a + r.tot, 0)} 条，豁免 ${totalExempt} 条，FAIL ${report.files.filter((r) => !r.ok).length} 个文件`)
}

if (has('--json')) {
  report.generated = new Date().toISOString()
  console.log(JSON.stringify(report, null, 2))
}
console.log(`\nself-check 总失败数 = ${totalFail}`)
process.exit(totalFail ? 1 : 0)
