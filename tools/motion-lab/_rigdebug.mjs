/**
 * _rigdebug.mjs —— 一次性诊断：VRMA 定帧后骨架为什么是"倒的"
 * 打印静止 vs 动画 t=0 的逐骨世界位置与自转角。
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { Buffer } from 'node:buffer'

const MOD = 'F:/deepseek harness/AI女友/build/airi-modules'
const VRM = 'F:/deepseek harness/AI女友/repos/Mate-Engine/Assets/MATE ENGINE - Avatar/DLCs/Lazuli_VRM.vrm'
const VRMA = process.argv[2] ?? 'F:/deepseek harness/AI女友/新工程/assets/motion/idle_pet_idle.vrma'
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
const { VRMAnimationLoaderPlugin, createVRMAnimationClip } = await load('three-vrm-animation.module.js')

function skeletonOnly(buf) {
  const jl = buf.readUInt32LE(12)
  const json = JSON.parse(buf.subarray(20, 20 + jl).toString('utf8'))
  delete json.images; delete json.samplers; delete json.textures; delete json.meshes; delete json.skins
  for (const n of json.nodes ?? []) { delete n.mesh; delete n.skin }
  for (const m of json.materials ?? []) {
    delete m.normalTexture; delete m.occlusionTexture; delete m.emissiveTexture
    if (m.pbrMetallicRoughness) { delete m.pbrMetallicRoughness.baseColorTexture; delete m.pbrMetallicRoughness.metallicRoughnessTexture }
  }
  const rest = buf.subarray(20 + jl)
  let jb = Buffer.from(JSON.stringify(json), 'utf8')
  if (jb.length % 4) jb = Buffer.concat([jb, Buffer.alloc(4 - (jb.length % 4), 0x20)])
  const head = Buffer.alloc(20); head.write('glTF', 0, 'ascii'); head.writeUInt32LE(2, 4)
  head.writeUInt32LE(12 + 8 + jb.length + rest.length, 8); head.writeUInt32LE(jb.length, 12); head.writeUInt32LE(0x4e4f534a, 16)
  return Buffer.concat([head, jb, rest])
}
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
const _w = console.warn, _e = console.error
console.warn = () => {}; console.error = () => {}
const gl = new GLTFLoader(); gl.register((p) => new VRMLoaderPlugin(p))
const vb = skeletonOnly(readFileSync(VRM))
const g = await new Promise((res, rej) => gl.parse(ab(vb), '', res, rej))
const vrm = g.userData.vrm
const al = new GLTFLoader(); al.register((p) => new VRMAnimationLoaderPlugin(p))
const ag = await new Promise((res, rej) => al.parse(ab(readFileSync(VRMA)), '', res, rej))
const clip = createVRMAnimationClip(ag.userData.vrmAnimations[0], vrm)
console.warn = _w; console.error = _e

const SHOW = ['hips', 'spine', 'chest', 'neck', 'head', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes']
const p = (n) => { const nd = vrm.humanoid.getNormalizedBoneNode(n); const v = nd?.getWorldPosition(new THREE.Vector3()); return v ? `[${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}]` : 'n/a' }
const q = (n) => { const nd = vrm.humanoid.getNormalizedBoneNode(n); return nd ? `[${nd.quaternion.x.toFixed(3)},${nd.quaternion.y.toFixed(3)},${nd.quaternion.z.toFixed(3)},${nd.quaternion.w.toFixed(3)}]` : 'n/a' }

vrm.scene.updateWorldMatrix(true, true)
console.log('=== 静止（单位阵）===')
for (const b of SHOW) console.log(`  ${b.padEnd(15)} world=${p(b).padEnd(26)} localQ=${q(b)}`)

const mixer = new THREE.AnimationMixer(vrm.scene)
const action = mixer.clipAction(clip); action.play()
mixer.setTime(0)
vrm.scene.updateWorldMatrix(true, true)
console.log('\n=== 动画 t=0（未做任何位移修正）===')
for (const b of SHOW) console.log(`  ${b.padEnd(15)} world=${p(b).padEnd(26)} localQ=${q(b)}`)

console.log('\n=== 各轨道名字（前 12 条）===')
for (const t of clip.tracks.slice(0, 12)) console.log(`  ${t.name}  values=${t.values.length}  first=${t.values[0].toFixed(5)}`)

console.log('\n=== 逐骨自转角（相对父骨，度）—— 找 180° 那种翻转 ===')
const DEG = 180 / Math.PI
for (const b of SHOW) {
  const nd = vrm.humanoid.getNormalizedBoneNode(b)
  const par = vrm.humanoid.getNormalizedBoneNode({ hips: null, spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck', leftUpperArm: 'chest', leftLowerArm: 'leftUpperArm', leftHand: 'leftLowerArm', leftUpperLeg: 'hips', leftLowerLeg: 'leftUpperLeg', leftFoot: 'leftLowerLeg', leftToes: 'leftFoot' }[b] ?? 'hips')
  if (!nd) continue
  const qc = nd.getWorldQuaternion(new THREE.Quaternion())
  const qr = par ? par.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(qc) : qc
  console.log(`  ${b.padEnd(15)} ${(2 * Math.acos(Math.min(1, Math.abs(qr.w))) * DEG).toFixed(2)}°`)
}
