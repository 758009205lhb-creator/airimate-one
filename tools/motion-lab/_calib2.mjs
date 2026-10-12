/**
 * _calib2.mjs —— 决定性标定：对每根骨枚举「绕 ±X / ±Y / ±Z 转 +60°」，
 * 报告**末端骨世界方向**，并与语义期望对照。
 *
 * 世界方向约定（_probe-rig 实测）：+X = 角色左、+Y = 上、+Z = 前。
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
const WP = (n) => vrm.humanoid.getNormalizedBoneNode(n)?.getWorldPosition(new THREE.Vector3()) ?? null
const reset = () => { for (const b of allBones) { const nd = vrm.humanoid.getNormalizedBoneNode(b); if (nd) nd.quaternion.set(0, 0, 0, 1) } vrm.scene.updateWorldMatrix(true, true) }
const DEG = Math.PI / 180
const AX = { '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1] }
function setRot(bone, ax, deg) {
  const nd = vrm.humanoid.getNormalizedBoneNode(bone); if (!nd) return false
  const a = AX[ax], h = deg * DEG / 2, s = Math.sin(h)
  nd.quaternion.set(a[0] * s, a[1] * s, a[2] * s, Math.cos(h))
  vrm.scene.updateWorldMatrix(true, true)
  return true
}
const v3 = (v) => `[${v.toArray().map((x) => (Math.abs(x) < 5e-4 ? 0 : x).toFixed(3)).join(',')}]`

// 每个关节：探测方向 = (关节世界位置 → 探测点世界位置)。探测点取一个**偏离旋转中心**的点。
const PROBE = {
  spine: 'neck', chest: 'neck', upperChest: 'neck', neck: 'head', head: 'head',
  leftShoulder: 'leftUpperArm', leftUpperArm: 'leftHand', leftLowerArm: 'leftHand', leftHand: 'leftMiddleProximal',
  rightShoulder: 'rightUpperArm', rightUpperArm: 'rightHand', rightLowerArm: 'rightHand', rightHand: 'rightMiddleProximal',
  leftUpperLeg: 'leftFoot', leftLowerLeg: 'leftFoot', leftFoot: 'leftToes', leftToes: 'leftToes',
  rightUpperLeg: 'rightFoot', rightLowerLeg: 'rightFoot', rightFoot: 'rightToes', rightToes: 'rightToes',
}
const BONES = Object.keys(PROBE)
console.log('静止（T-pose）方向：')
reset()
const rest = {}
for (const b of BONES) {
  const p = WP(b), q = WP(PROBE[b])
  if (!p || !q) { console.log(`  ${b.padEnd(15)} n/a`); continue }
  const d = q.clone().sub(p)
  if (d.lengthSq() < 1e-10) { console.log(`  ${b.padEnd(15)} 探测点与关节重合（无法定方向）`); continue }
  rest[b] = d.normalize()
  console.log(`  ${b.padEnd(15)} → ${PROBE[b].padEnd(20)} ${v3(rest[b])}`)
}

console.log('\n绕 ±X/±Y/±Z 转 +60° 的末端方向（只列位移 > 5° 的轴）：')
for (const b of BONES) {
  if (!rest[b]) continue
  const rows = []
  for (const ax of ['+X', '-X', '+Y', '-Y', '+Z', '-Z']) {
    reset()
    if (!setRot(b, ax, 60)) continue
    const p = WP(b), q = WP(PROBE[b])
    const d = q.clone().sub(p)
    if (d.lengthSq() < 1e-12) continue
    d.normalize()
    const ang = (Math.acos(Math.max(-1, Math.min(1, rest[b].dot(d)))) * 180) / Math.PI
    if (ang > 5) rows.push(`${ax}=${v3(d)}(${ang.toFixed(0)}°)`)
  }
  reset()
  console.log(`  ${b.padEnd(15)} 静止${v3(rest[b])}  ${rows.join('  ') || '(全部轴位移 < 5°，纯扭转)'}`)
}
reset()
