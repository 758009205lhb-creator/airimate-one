/**
 * _signprobe.mjs —— 用**真实动作数据**反推符号约定
 *
 * 动机（本次会话的关键发现）
 * --------------------------
 * 实测源数据：
 *   `PET_IDLE.anim`   的 `Left Lower Leg Stretch` ∈ [-0.147, -0.048]（**负**）
 *   `PET_IDLE_2.anim` 的 `Left Lower Leg Stretch` ∈ [+0.095, +0.270]（**正**）
 * 两条都是站姿待机，膝盖不可能一条"屈"一条"反折"。
 * ⇒ **至少有一个符号口径是错的**，而 A 段（解剖学不变量）对 ±0.2 的待机姿态不敏感，
 *   所以必须用「符号敏感的判据」把它钉死。
 *
 * 判据（符号敏感、且与解剖学硬约束绑定）
 *   J-1 屈膝方向：人膝**只能向后弯**（踝相对膝向 -Z 走）。
 *       正屈膝 ⇒ 踝 z 变小（后移）；反折 ⇒ 踝 z 变大（前移，解剖学不可能）。
 *   J-2 屈肘方向：肘同理（手相对肘向 +Z 走）。
 *   J-3 待机时膝盖**微屈**是常态（重心下沉），完全伸直 0° 少见；
 *       两套待机给出相反的符号，只有一套能让两者都落在 [0°, 45°] 的合理屈曲区间。
 *
 * 输出：对每个待机 clip，在若干采样帧上，用两套符号分别解码后测量
 *   · 膝屈曲角（本骨自转角，度）
 *   · 踝相对膝的 Z 位移（正 = 前 = 反折，负 = 后 = 正常屈膝）
 *   · 手相对肩的 Y/Z、脚相对髋的 Y
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { Buffer } from 'node:buffer'
import { parseAnim, authoritativeCurves, indexCurves, sampleCurve } from './parse-anim.mjs'
import { MUSCLE_TABLE, IDENTITY_QUAT, axisAngle, qmul } from './humanoid-map.mjs'

const MOD = 'F:/deepseek harness/AI女友/build/airi-modules'
const ANIM = 'F:/deepseek harness/AI女友/repos/Mate-Engine/Assets/MATE ENGINE - Animations/PET_IDLE/'
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis
if (typeof globalThis.navigator === 'undefined') globalThis.navigator = { userAgent: 'node' }
if (typeof globalThis.document === 'undefined') globalThis.document = { createElementNS: () => ({ style: {}, getContext: () => null, addEventListener() {}, removeEventListener() {} }), createElement: () => ({ style: {}, getContext: () => null, addEventListener() {}, removeEventListener() {} }) }
if (typeof globalThis.URL.createObjectURL === 'undefined') globalThis.URL.createObjectURL = () => 'blob:stub'
if (typeof globalThis.createImageBitmap === 'undefined') globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} })
const load = async (r) => import(pathToFileURL(resolve(MOD, r)).href)
const THREE = await load('three/build/three.module.js')
const { GLTFLoader } = await load('three-stdlib/loaders/GLTFLoader.js')
const { VRMLoaderPlugin } = await load('three-vrm.module.js')
function strip(b) {
  const L = b.readUInt32LE(12)
  const j = JSON.parse(b.subarray(20, 20 + L).toString('utf8'))
  delete j.images; delete j.samplers; delete j.textures; delete j.meshes; delete j.skins
  for (const n of j.nodes ?? []) { delete n.mesh; delete n.skin }
  const r = b.subarray(20 + L)
  let jb = Buffer.from(JSON.stringify(j), 'utf8')
  if (jb.length % 4) jb = Buffer.concat([jb, Buffer.alloc(4 - (jb.length % 4), 0x20)])
  const h = Buffer.alloc(20); h.write('glTF', 0, 'ascii'); h.writeUInt32LE(2, 4)
  h.writeUInt32LE(12 + 8 + jb.length + r.length, 8); h.writeUInt32LE(jb.length, 12); h.writeUInt32LE(0x4e4f534a, 16)
  return Buffer.concat([h, jb, r])
}
const _w = console.warn, _e = console.error
console.warn = () => {}; console.error = () => {}
const gl = new GLTFLoader(); gl.register((p) => new VRMLoaderPlugin(p))
const g = await new Promise((res, rej) => gl.parse(strip(readFileSync('F:/deepseek harness/AI女友/repos/Mate-Engine/Assets/MATE ENGINE - Avatar/DLCs/Lazuli_VRM.vrm')).buffer.slice(0), '', res, rej))
const vrm = g.userData.vrm
console.warn = _w; console.error = _e
vrm.scene.updateWorldMatrix(true, true)
const ALL = Object.keys(vrm.humanoid.humanBones)
const node = (n) => vrm.humanoid.getNormalizedBoneNode(n)
const wp = (n) => { const nd = node(n); return nd ? nd.getWorldPosition(new THREE.Vector3()) : null }
const restPos = new Map(ALL.map((b) => [b, node(b)?.position.clone() ?? null]))
const reset = () => { for (const b of ALL) { const nd = node(b); if (nd) { nd.quaternion.set(0, 0, 0, 1); const rp = restPos.get(b); if (rp) nd.position.copy(rp) } } vrm.scene.updateWorldMatrix(true, true) }
const DEG = 180 / Math.PI
/**
 * ⚠ 关键修正（本次会话踩到的第二个测量陷阱）：
 *   `2·acos(|q_world|)` 量到的是**该骨在世界上总共转了多少**，包含**父骨带给它的**转动。
 *   实测：只把 `leftUpperLeg` 转 45°，`leftLowerLeg` 的 `q_world` 也会变成 45°，
 *   于是"膝屈曲"被虚报成 45°（真值 0°）。
 *   ⇒ 关节角必须用 **相对父骨的局部旋转**：q_local = inverse(q_parentWorld) · q_world。
 */
function relRotDeg(child, parent) {
  const nc = node(child), np = parent ? node(parent) : null
  if (!nc) return null
  const qc = nc.getWorldQuaternion(new THREE.Quaternion())
  if (!np) return 2 * Math.acos(Math.min(1, Math.abs(qc.w))) * DEG
  const qp = np.getWorldQuaternion(new THREE.Quaternion())
  const qr = qp.invert().multiply(qc)
  return 2 * Math.acos(Math.min(1, Math.abs(qr.w))) * DEG
}
const kneeDeg = () => relRotDeg('leftLowerLeg', 'leftUpperLeg')
const kneeDegR = () => relRotDeg('rightLowerLeg', 'rightUpperLeg')

/**
 * 用给定的符号策略把一个 clip 在时刻 t 解码并施加。
 * policy.flip = Set(muscleName) —— 这些肌肉的角度取反（等价于把该肌肉的极限 [n,p] 换成 [-p,-n]）
 */
function applyClip(animPath, t, flip) {
  const parsed = parseAnim(animPath)
  const { map } = indexCurves(authoritativeCurves(parsed))
  reset()
  for (const row of MUSCLE_TABLE) {
    const parts = []
    let any = false
    row.axes.forEach((a, i) => {
      if (!a) return
      const c = map.get(a.muscle)
      if (!c) return
      any = true
      const raw = Math.max(-1, Math.min(1, sampleCurve(c.keys, t)))
      const [negMax, posMax] = a.limit
      let deg = raw >= 0 ? raw * posMax : raw * Math.abs(negMax)
      if (flip.has(a.muscle)) deg = -deg
      parts.push({ i, axis: a.axis, deg })
    })
    if (!any) continue
    parts.sort((x, y) => [2, 0, 1].indexOf(x.i) - [2, 0, 1].indexOf(y.i))
    let acc = { ...IDENTITY_QUAT }
    for (const p of parts) acc = qmul(acc, axisAngle(p.axis, p.deg))
    const nd = node(row.bone)
    if (nd) nd.quaternion.set(acc.x, acc.y, acc.z, acc.w)
  }
  vrm.scene.updateWorldMatrix(true, true)
}

const CLIPS = ['PET_IDLE.anim', 'PET_IDLE_2.anim', 'PET_IDLE_3.anim', 'PET_IDLE_4.anim',
  'PET_IDLE_5.anim', 'PET_IDLE_6.anim', 'PET_IDLE_7.anim', 'PET_IDLE_8.anim',
  'PET_IDLE_9.anim', 'PET_IDLE_10.anim']

const A = { name: 'A=当前实现（Stretch 正值=0°）', flip: new Set() }
const B = { name: 'B=Stretch 反号（正值=屈膝）', flip: new Set(['Left Lower Leg Stretch', 'Right Lower Leg Stretch']) }
const C = { name: 'C=B + 肘同反号', flip: new Set(['Left Lower Leg Stretch', 'Right Lower Leg Stretch', 'Left Forearm Stretch', 'Right Forearm Stretch']) }

for (const pol of [A, B, C]) {
  console.log(`\n########## ${pol.name} ##########`)
  console.log('clip'.padEnd(17) + 't'.padStart(6) + 'L膝屈曲°'.padStart(10) + 'R膝屈曲°'.padStart(10) +
    '踝-膝ΔZ(正=反折)'.padStart(18) + '手-肩ΔY'.padStart(10) + '脚-髋ΔY'.padStart(10) + '  判定')
  for (const f of CLIPS) {
    const p = parseAnim(ANIM + f)
    let rowSum = { knee: 0, z: 0, n: 0, bad: 0 }
    const ts = [0, p.duration * 0.25, p.duration * 0.5, p.duration * 0.75, p.duration * 0.98]
    for (const t of ts) {
      applyClip(ANIM + f, t, pol.flip)
      const lk = kneeDeg(), rk = kneeDegR()
      const knee = wp('leftLowerLeg'), ankle = wp('leftFoot'), hip = wp('hips')
      const dz = (ankle && knee) ? ankle.z - knee.z : null
      const hand = wp('leftHand'), sh = wp('leftShoulder')
      const dy = (hand && sh) ? hand.y - sh.y : null
      const footY = (ankle && hip) ? ankle.y - hip.y : null
      // 反折判据：踝在膝前方（+Z）且膝有屈曲 ⇒ 反折
      const bad = (lk != null && dz != null && lk > 3 && dz > 0.01)
      rowSum.knee += (lk ?? 0); rowSum.z += (dz ?? 0); rowSum.n++; if (bad) rowSum.bad++
      if (t === ts[0]) console.log(
        f.padEnd(17) + t.toFixed(2).padStart(6) +
        (lk ?? 0).toFixed(1).padStart(10) + (rk ?? 0).toFixed(1).padStart(10) +
        (dz ?? 0).toFixed(4).padStart(18) + (dy ?? 0).toFixed(3).padStart(10) + (footY ?? 0).toFixed(3).padStart(10) +
        (bad ? '   反折!' : ''))
    }
    const kAvg = rowSum.knee / rowSum.n, zAvg = rowSum.z / rowSum.n
    console.log(`${''.padEnd(17)}     ⇒ 平均: 膝屈曲=${kAvg.toFixed(1)}°  踝-膝ΔZ=${zAvg.toFixed(4)}  反折帧=${rowSum.bad}/${rowSum.n}`)
  }
}
reset()
