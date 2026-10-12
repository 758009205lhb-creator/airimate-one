/** _dbg.mjs —— 定位 self-check 里 S 段失败的根因 */
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
  const head = Buffer.alloc(20)
  head.write('glTF', 0, 'ascii'); head.writeUInt32LE(2, 4)
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
reset()

const show = (label) => {
  const f = (n) => { const p = wp(n); return p ? `[${p.toArray().map((v) => v.toFixed(4)).join(',')}]` : 'n/a' }
  console.log(`${label}: leftUpperArm=${f('leftUpperArm')} leftLowerArm=${f('leftLowerArm')} leftHand=${f('leftHand')} spine=${f('spine')} neck=${f('neck')} head=${f('head')}`)
}
show('rest')

// 直接绕世界 Y 转 leftUpperArm 81°
{
  const nd = node('leftUpperArm')
  const h = 81 * Math.PI / 180 / 2, s = Math.sin(h)
  nd.quaternion.set(0, s, 0, Math.cos(h))
  vrm.scene.updateWorldMatrix(true, true)
  show('leftUpperArm 绕 +Y 81°  → 期望 leftHand.z 变大')
  console.log('   parent(leftShoulder) world quat =', node('leftShoulder').getWorldQuaternion(new THREE.Quaternion()).toArray().map((v) => v.toFixed(4)).join(','))
  console.log('   leftUpperArm local quat =', nd.quaternion.toArray().map((v) => v.toFixed(4)).join(','))
  console.log('   leftUpperArm world quat =', nd.getWorldQuaternion(new THREE.Quaternion()).toArray().map((v) => v.toFixed(4)).join(','))
}
reset()

// 脊柱：绕 -X 转 20°
{
  const nd = node('spine')
  const h = -20 * Math.PI / 180 / 2, s = Math.sin(h)
  nd.quaternion.set(s * -1, 0, 0, Math.cos(h))
  vrm.scene.updateWorldMatrix(true, true)
  show('spine 绕 -X 20° → 期望 neck.z 变大')
}
reset()

// 检查 poseForOneMuscle 的产物
function poseForOneMuscle(muscle, value) {
  const out = new Map()
  for (const row of MUSCLE_TABLE) {
    const parts = []
    let any = false
    row.axes.forEach((a, i) => {
      if (!a) return
      let deg = 0
      if (a.muscle === muscle) {
        any = true
        const [negMax, posMax] = a.limit
        const v = Math.max(-1, Math.min(1, value))
        deg = v >= 0 ? v * posMax : v * Math.abs(negMax)
      }
      parts.push({ i, axis: a.axis, deg })
    })
    if (!any) continue
    parts.sort((x, y) => [2, 0, 1].indexOf(x.i) - [2, 0, 1].indexOf(y.i))
    let acc = { ...IDENTITY_QUAT }
    for (const p of parts) acc = qmul(acc, axisAngle(p.axis, p.deg))
    out.set(row.bone, acc)
  }
  return out
}
console.log('\nposeForOneMuscle("Left Arm Front-Back", 0.9) 内容：')
for (const [b, q] of poseForOneMuscle('Left Arm Front-Back', 0.9)) console.log(`  ${b.padEnd(18)} [${q.x.toFixed(4)},${q.y.toFixed(4)},${q.z.toFixed(4)},${q.w.toFixed(4)}]`)
console.log('poseForOneMuscle("Spine Front-Back", 1) 内容：')
for (const [b, q] of poseForOneMuscle('Spine Front-Back', 1)) console.log(`  ${b.padEnd(18)} [${q.x.toFixed(4)},${q.y.toFixed(4)},${q.z.toFixed(4)},${q.w.toFixed(4)}]`)

function applyPose(map) { reset(); for (const [b, q] of map) { const nd = node(b); if (nd) nd.quaternion.set(q.x, q.y, q.z, q.w) } vrm.scene.updateWorldMatrix(true, true) }
applyPose(poseForOneMuscle('Left Arm Front-Back', 0.9)); show('\napply(Left Arm Front-Back 0.9)')
applyPose(poseForOneMuscle('Spine Front-Back', 1)); show('apply(Spine Front-Back 1)')
applyPose(poseForOneMuscle('Left Lower Leg Stretch', -1)); show('apply(Left Lower Leg Stretch -1)')
reset()
