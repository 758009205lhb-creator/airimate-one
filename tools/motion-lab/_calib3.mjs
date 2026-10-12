/**
 * _calib3.mjs —— 尾端骨（脚趾 / 手指 / 手掌）的方向与各轴效果
 * 脚趾与关节重合，必须用「脚趾骨自身的世界四元数」而不是位置差。
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const MOD = resolve('F:/deepseek harness/AI女友/build/airi-modules')
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis
if (typeof globalThis.self === 'undefined') globalThis.self = globalThis
if (typeof globalThis.navigator === 'undefined') globalThis.navigator = { userAgent: 'node' }
if (typeof globalThis.document === 'undefined') globalThis.document = { createElementNS: () => ({ style: {}, getContext: () => null, addEventListener() {}, removeEventListener() {} }), createElement: () => ({ style: {}, getContext: () => null, addEventListener() {}, removeEventListener() {} }) }
if (typeof globalThis.URL.createObjectURL === 'undefined') globalThis.URL.createObjectURL = () => 'blob:stub'
if (typeof globalThis.createImageBitmap === 'undefined') globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} })

const load = async (rel) => import(pathToFileURL(resolve(MOD, rel)).href)
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

const allBones = Object.keys(vrm.humanoid.humanBones)
const reset = () => { for (const b of allBones) { const nd = vrm.humanoid.getNormalizedBoneNode(b); if (nd) nd.quaternion.set(0, 0, 0, 1) } vrm.scene.updateWorldMatrix(true, true) }
const DEG = Math.PI / 180
const AX = { '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1] }
const setRot = (bone, ax, deg) => { const nd = vrm.humanoid.getNormalizedBoneNode(bone); if (!nd) return false; const a = AX[ax], h = deg * DEG / 2, s = Math.sin(h); nd.quaternion.set(a[0] * s, a[1] * s, a[2] * s, Math.cos(h)); vrm.scene.updateWorldMatrix(true, true); return true }
const v3 = (v) => `[${v.toArray().map((x) => (Math.abs(x) < 5e-4 ? 0 : x).toFixed(3)).join(',')}]`

// 「骨自身的局部轴在世界里的方向」：用世界四元数旋转单位轴
const localAxesWorld = (bone) => {
  const nd = vrm.humanoid.getNormalizedBoneNode(bone); if (!nd) return null
  const q = nd.getWorldQuaternion(new THREE.Quaternion())
  return {
    X: new THREE.Vector3(1, 0, 0).applyQuaternion(q),
    Y: new THREE.Vector3(0, 1, 0).applyQuaternion(q),
    Z: new THREE.Vector3(0, 0, 1).applyQuaternion(q),
    q: q.clone(),
  }
}

console.log('=== 尾端骨：静止时「骨自身 local 轴」在世界里的指向 ===')
reset()
for (const b of ['leftToes', 'rightToes', 'leftHand', 'rightHand', 'leftThumbMetacarpal', 'leftIndexProximal', 'leftMiddleProximal', 'leftFoot', 'head', 'leftEye', 'hips']) {
  const la = localAxesWorld(b)
  if (!la) { console.log(`  ${b.padEnd(22)} 归一化骨不存在`); continue }
  console.log(`  ${b.padEnd(22)} localX→${v3(la.X)}  localY→${v3(la.Y)}  localZ→${v3(la.Z)}`)
}

console.log('\n=== 尾端骨：绕 ±X/±Y/±Z 转 +45° 后，骨自身 localY(世界) 的变化 ===')
for (const b of ['leftToes', 'rightToes', 'leftMiddleProximal', 'leftThumbProximal']) {
  reset()
  const la0 = localAxesWorld(b); if (!la0) { console.log(`  ${b}: 缺失`); continue }
  const parts = [`  ${b.padEnd(22)} 静止localY=${v3(la0.Y)}`]
  for (const ax of ['+X', '-X', '+Y', '-Y', '+Z', '-Z']) {
    reset(); setRot(b, ax, 45)
    const la = localAxesWorld(b)
    const ang = (Math.acos(Math.max(-1, Math.min(1, la0.Y.dot(la.Y)))) * 180) / Math.PI
    if (ang > 5) parts.push(`${ax}:${v3(la.Y)}(${ang.toFixed(0)}°)`)
  }
  console.log(parts.join('  '))
}

console.log('\n=== 手指骨静止方向（从掌骨指向指尖的位置差） ===')
reset()
for (const [a, b] of [['leftIndexProximal', 'leftIndexIntermediate'], ['leftIndexIntermediate', 'leftIndexDistal'], ['leftThumbMetacarpal', 'leftThumbProximal'], ['leftHand', 'leftMiddleProximal']]) {
  const p = vrm.humanoid.getNormalizedBoneNode(a)?.getWorldPosition(new THREE.Vector3())
  const q = vrm.humanoid.getNormalizedBoneNode(b)?.getWorldPosition(new THREE.Vector3())
  if (!p || !q) { console.log(`  ${a}->${b} n/a`); continue }
  const d = q.clone().sub(p)
  console.log(`  ${a.padEnd(24)} → ${b.padEnd(24)} ${d.lengthSq() > 1e-12 ? v3(d.normalize()) : '(重合)'}  |d|=${q.distanceTo(p).toFixed(4)}`)
}
reset()
