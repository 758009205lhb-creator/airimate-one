/** _dbg2.mjs —— 对可疑肌肉逐条打印「轴 / 角度 / 四元数 / 世界位移」 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { Buffer } from 'node:buffer'
import { MUSCLE_TABLE, IDENTITY_QUAT, axisAngle, qmul } from './humanoid-map.mjs'

const MOD = 'F:/deepseek harness/AI女友/build/airi-modules'
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
function stripImages(b) {
  const jsonLen = b.readUInt32LE(12)
  const json = JSON.parse(b.subarray(20, 20 + jsonLen).toString('utf8'))
  delete json.images; delete json.samplers; delete json.textures; delete json.meshes; delete json.skins
  for (const n of json.nodes ?? []) { delete n.mesh; delete n.skin }
  const rest = b.subarray(20 + jsonLen)
  let jb = Buffer.from(JSON.stringify(json), 'utf8')
  if (jb.length % 4) jb = Buffer.concat([jb, Buffer.alloc(4 - (jb.length % 4), 0x20)])
  const head = Buffer.alloc(20); head.write('glTF', 0, 'ascii'); head.writeUInt32LE(2, 4)
  head.writeUInt32LE(12 + 8 + jb.length + rest.length, 8); head.writeUInt32LE(jb.length, 12); head.writeUInt32LE(0x4e4f534a, 16)
  return Buffer.concat([head, jb, rest])
}
const _w = console.warn, _e = console.error
const buf = stripImages(readFileSync('F:/deepseek harness/AI女友/repos/Mate-Engine/Assets/MATE ENGINE - Avatar/DLCs/Lazuli_VRM.vrm'))
console.warn = () => {}; console.error = () => {}
const g = new GLTFLoader(); g.register((p) => new VRMLoaderPlugin(p))
const gltf = await new Promise((res, rej) => g.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej))
const vrm = gltf.userData.vrm
console.warn = _w; console.error = _e
vrm.scene.updateWorldMatrix(true, true)
const ALL = Object.keys(vrm.humanoid.humanBones)
const node = (n) => vrm.humanoid.getNormalizedBoneNode(n)
const wp = (n) => { const nd = node(n); return nd ? nd.getWorldPosition(new THREE.Vector3()) : null }
const restPos = new Map(ALL.map((b) => [b, node(b)?.position.clone() ?? null]))
const reset = () => { for (const b of ALL) { const nd = node(b); if (nd) { nd.quaternion.set(0, 0, 0, 1); const rp = restPos.get(b); if (rp) nd.position.copy(rp) } } vrm.scene.updateWorldMatrix(true, true) }

for (const muscle of ['Spine Left-Right', 'Neck Nod Down-Up', 'Head Nod Down-Up', 'Left Arm Front-Back', 'Left Arm Down-Up', 'Left Lower Leg Stretch', 'Left Upper Leg Front-Back', 'Left Forearm Stretch', 'Left Foot Up-Down']) {
  const row = MUSCLE_TABLE.find((r) => r.axes.some((a) => a && a.muscle === muscle))
  const a = row.axes.find((x) => x && x.muscle === muscle)
  const i = row.axes.indexOf(a)
  const value = 1
  const [negMax, posMax] = a.limit
  const v = Math.max(-1, Math.min(1, value))
  const deg = v >= 0 ? v * posMax : v * Math.abs(negMax)
  const q = axisAngle(a.axis, deg)
  const others = row.axes.map((x, j) => (x && j !== i ? axisAngle(x.axis, 0) : null)).filter(Boolean)
  let acc = { ...IDENTITY_QUAT }
  const seq = [2, 0, 1].filter((k) => row.axes[k]).map((k) => ({ k, q: k === i ? q : axisAngle(row.axes[k].axis, 0) }))
  for (const p of seq) acc = qmul(acc, p.q)

  reset()
  const before = {}
  for (const n of ['spine', 'neck', 'head', 'leftHand', 'leftFoot', 'leftLowerArm', 'leftToes']) { const p = wp(n); before[n] = p ? p.clone() : null }
  const nd = node(row.bone)
  nd.quaternion.set(acc.x, acc.y, acc.z, acc.w)
  vrm.scene.updateWorldMatrix(true, true)
  console.log(`\n[${muscle}]  骨=${row.bone} slot=${i} axis=[${a.axis.join(',')}] limit=[${a.limit.join(',')}] deg=${deg}`)
  console.log(`   q=[${q.x.toFixed(4)},${q.y.toFixed(4)},${q.z.toFixed(4)},${q.w.toFixed(4)}]  acc=[${acc.x.toFixed(4)},${acc.y.toFixed(4)},${acc.z.toFixed(4)},${acc.w.toFixed(4)}]`)
  for (const n of Object.keys(before)) {
    const p = wp(n); if (!p || !before[n]) continue
    const d = p.clone().sub(before[n])
    console.log(`   ${n.padEnd(14)} Δ=[${d.x.toFixed(4)},${d.y.toFixed(4)},${d.z.toFixed(4)}]`)
  }
}
reset()
