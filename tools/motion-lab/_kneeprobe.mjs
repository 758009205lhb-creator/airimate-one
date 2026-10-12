/**
 * _kneeprobe.mjs —— 精确定位：膝屈曲到底是谁贡献的？
 * 逐步施加单一肌肉，观察 leftLowerLeg 的**世界自转角**。
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
const vbuf = strip(readFileSync('F:/deepseek harness/AI女友/repos/Mate-Engine/Assets/MATE ENGINE - Avatar/DLCs/Lazuli_VRM.vrm'))
const g = await new Promise((res, rej) => gl.parse(vbuf.buffer.slice(vbuf.byteOffset, vbuf.byteOffset + vbuf.byteLength), '', res, rej))
const vrm = g.userData.vrm
console.warn = _w; console.error = _e
vrm.scene.updateWorldMatrix(true, true)
const ALL = Object.keys(vrm.humanoid.humanBones)
const node = (n) => vrm.humanoid.getNormalizedBoneNode(n)
const wp = (n) => { const nd = node(n); return nd ? nd.getWorldPosition(new THREE.Vector3()) : null }
const restPos = new Map(ALL.map((b) => [b, node(b)?.position.clone() ?? null]))
const reset = () => { for (const b of ALL) { const nd = node(b); if (nd) { nd.quaternion.set(0, 0, 0, 1); const rp = restPos.get(b); if (rp) nd.position.copy(rp) } } vrm.scene.updateWorldMatrix(true, true) }
const DEG = 180 / Math.PI
const rotDeg = (b) => { const nd = node(b); if (!nd) return null; const q = nd.getWorldQuaternion(new THREE.Quaternion()); return 2 * Math.acos(Math.min(1, Math.abs(q.w))) * DEG }

reset()
console.log('静止（全单位阵）:')
console.log('  leftLowerLeg 世界自转角 =', rotDeg('leftLowerLeg')?.toFixed(6), '°')
console.log('  leftUpperLeg 世界自转角 =', rotDeg('leftUpperLeg')?.toFixed(6), '°')
console.log('  leftLowerLeg local quat =', node('leftLowerLeg').quaternion.toArray().map((v) => v.toFixed(6)).join(','))
console.log('  hips position =', node('hips').position.toArray().map((v) => v.toFixed(4)).join(','))

// 逐肌肉单独施加（取值 = 该肌肉在 PET_IDLE_2 的 t=0 值）
const p2 = parseAnim(ANIM + 'PET_IDLE_2.anim')
const { map: m2 } = indexCurves(authoritativeCurves(p2))
const p1 = parseAnim(ANIM + 'PET_IDLE.anim')
const { map: m1 } = indexCurves(authoritativeCurves(p1))

console.log('\n各肌肉在 PET_IDLE.anim / PET_IDLE_2.anim t=0 的值，以及单独施加后 leftLowerLeg 的世界自转角：')
for (const row of MUSCLE_TABLE) {
  for (const a of row.axes) {
    if (!a) continue
    if (!/Leg|Foot|Toes/.test(row.bone)) continue
    const v1 = m1.get(a.muscle) ? sampleCurve(m1.get(a.muscle).keys, 0) : undefined
    const v2 = m2.get(a.muscle) ? sampleCurve(m2.get(a.muscle).keys, 0) : undefined
    // 单独施加 v1
    const test = (v) => {
      reset()
      if (v === undefined) return null
      const [negMax, posMax] = a.limit
      const vv = Math.max(-1, Math.min(1, v))
      const deg = vv >= 0 ? vv * posMax : vv * Math.abs(negMax)
      const q = axisAngle(a.axis, deg)
      const nd = node(row.bone); if (!nd) return null
      nd.quaternion.set(q.x, q.y, q.z, q.w)
      vrm.scene.updateWorldMatrix(true, true)
      return rotDeg('leftLowerLeg')
    }
    const k = /left/i.test(row.bone) ? test(v1) : null
    console.log(`  ${row.bone.padEnd(15)} ${a.muscle.padEnd(32)} axis=[${a.axis.join(',')}] limit=[${a.limit.join(',')}]  v(PET_IDLE)=${v1 === undefined ? 'n/a' : v1.toFixed(4)} v(_2)=${v2 === undefined ? 'n/a' : v2.toFixed(4)}  单独施加(PET_IDLE 值)→左膝自转=${k == null ? 'n/a' : k.toFixed(2) + '°'}`)
  }
}
reset()
