/**
 * _calib.mjs —— 一次性标定：逐肌肉施加已知值，量它在真实 VRM 上的世界效果
 * 用来判定「轴名 → 世界轴」的假设是否成立，以及正负号。
 *
 * 参考静止姿态（_probe-rig / _probe-conv 实测）：
 *   hips=[0,0.834,0]、spine 在 +Y、左臂沿 -X、右臂沿 +X、双腿沿 -Y、角色朝 +Z
 *   ⇒ 模型坐标：+X = 角色左手侧、+Y = 上、+Z = 前
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
const { VRMAnimationLoaderPlugin, createVRMAnimationClip } = await load('three-vrm-animation.module.js')

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
const gl = new GLTFLoader(); gl.register((p) => new VRMLoaderPlugin(p))
const gltf = await new Promise((res, rej) => gl.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej))
const vrm = gltf.userData.vrm
console.warn = _w; console.error = _e
vrm.scene.updateWorldMatrix(true, true)

const bones = Object.keys(vrm.humanoid.humanBones)
// 每根骨测定用的"远端骨"（拿它的世界位置定义方向）
const DISTAL = {
  hips: 'spine', spine: 'chest', chest: 'neck', neck: 'head', head: 'head',
  leftShoulder: 'leftUpperArm', leftUpperArm: 'leftLowerArm', leftLowerArm: 'leftHand', leftHand: 'leftMiddleProximal',
  rightShoulder: 'rightUpperArm', rightUpperArm: 'rightLowerArm', rightLowerArm: 'rightHand', rightHand: 'rightMiddleProximal',
  leftUpperLeg: 'leftLowerLeg', leftLowerLeg: 'leftFoot', leftFoot: 'leftToes',
  rightUpperLeg: 'rightLowerLeg', rightLowerLeg: 'rightFoot', rightFoot: 'rightToes',
}
function worldDir(bone) {
  const d = DISTAL[bone]; if (!d) return null
  const n1 = vrm.humanoid.getNormalizedBoneNode(bone), n2 = vrm.humanoid.getNormalizedBoneNode(d)
  if (!n1 || !n2) return null
  const a = n1.getWorldPosition(new THREE.Vector3()), b = n2.getWorldPosition(new THREE.Vector3())
  if (b.lengthSq() === 0 && a.lengthSq() === 0) return null
  const v = b.sub(a); if (v.lengthSq() < 1e-12) return null
  return v.normalize()
}
function setBoneLocal(bone, q) {
  const n = vrm.humanoid.getNormalizedBoneNode(bone); if (!n) return false
  n.quaternion.set(q[0], q[1], q[2], q[3]); n.updateMatrixWorld(true); return true
}
const DEG = Math.PI / 180
const axisQ = (axis, deg) => { const h = deg * DEG / 2, s = Math.sin(h); return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)] }
const reset = () => { for (const b of bones) { const n = vrm.humanoid.getNormalizedBoneNode(b); if (n) n.quaternion.set(0, 0, 0, 1) } vrm.scene.updateWorldMatrix(true, true) }

console.log('=== 逐肌肉标定（施加 +60°，量远端骨世界方向的变化） ===')
console.log('轴名 → 世界轴假设：')
console.log('  Front-Back: +X    Back-Front: -X    Up-Down: +Z    Down-Up: -Z')
console.log('  Left-Right: +X    Right-Left: -X    In-Out: +Y     Twist In-Out: +Y')
console.log('')
console.log('骨名'.padEnd(16) + '轴'.padEnd(14) + '世界轴'.padEnd(10) + '静止方向'.padEnd(28) + '+60° 后'.padEnd(28) + '角位移')
const TESTS = [
  ['spine', 'Front-Back', '+X'], ['spine', 'Left-Right', '+Z'], ['spine', 'Twist', '+Y'],
  ['neck', 'Nod Down-Up', '-Z'], ['neck', 'Tilt Left-Right', '+Z'], ['neck', 'Turn Left-Right', '+Y'],
  ['leftShoulder', 'Down-Up', '-Z'], ['leftShoulder', 'Front-Back', '+X'],
  ['leftUpperArm', 'Down-Up', '-Z'], ['leftUpperArm', 'Front-Back', '+X'], ['leftUpperArm', 'Twist', '+Y'],
  ['leftLowerArm', 'Stretch', '-Z'], ['leftLowerArm', 'Twist', '+Y'],
  ['leftHand', 'Down-Up', '+Z'], ['leftHand', 'In-Out', '+Y'],
  ['leftUpperLeg', 'Front-Back', '+X'], ['leftUpperLeg', 'In-Out', '+Y'], ['leftUpperLeg', 'Twist', '+Y'],
  ['leftLowerLeg', 'Stretch', '-X'], ['leftLowerLeg', 'Twist', '+Y'],
  ['leftFoot', 'Up-Down', '+Z'], ['leftFoot', 'Twist', '+Y'],
  ['rightUpperArm', 'Down-Up', '-Z'], ['rightUpperArm', 'Front-Back', '+X'],
]
const AX = { '+X': [1, 0, 0], '-X': [-1, 0, 0], '+Y': [0, 1, 0], '-Y': [0, -1, 0], '+Z': [0, 0, 1], '-Z': [0, 0, -1] }
for (const [bone, mname, axName] of TESTS) {
  reset()
  const d0 = worldDir(bone)
  if (!d0) { console.log(`${bone.padEnd(16)}${mname.padEnd(14)}${axName.padEnd(10)}<无归一化骨/远端骨>`); continue }
  setBoneLocal(bone, axisQ(AX[axName], 60))
  const d1 = worldDir(bone)
  const ang = Math.acos(Math.max(-1, Math.min(1, d0.dot(d1)))) / DEG
  const f = (v) => `[${v.toArray().map((x) => x.toFixed(3)).join(',')}]`
  console.log(`${bone.padEnd(16)}${mname.padEnd(14)}${axName.padEnd(10)}${f(d0).padEnd(28)}${f(d1).padEnd(28)}${ang.toFixed(1)}°`)
}
reset()

console.log('\n=== 部位参考：把几个"语义应当明确"的旋转画出来 ===')
const show = (label, bone, axis, deg) => {
  reset(); if (!setBoneLocal(bone, axisQ(AX[axis], deg))) { console.log(`  ${label}: 骨缺失`); return }
  const d = worldDir(bone)
  console.log(`  ${label.padEnd(46)} ${bone} ${axis}${deg}° ⇒ 方向 [${d.toArray().map((x) => x.toFixed(3)).join(',')}]`)
}
show('左臂 Down-Up -60°（期望：抬起 / 手向上）', 'leftUpperArm', '-Z', -60)
show('左臂 Down-Up +60°（期望：下压 / 手向下）', 'leftUpperArm', '-Z', 60)
show('左腿 Front-Back +60°（期望：膝盖向前）', 'leftUpperLeg', '+X', 60)
show('左膝 Stretch -60°（期望：脚跟向后）', 'leftLowerLeg', '-X', -60)
show('脊柱 Front-Back +30°（期望：躯干前倾）', 'spine', '+X', 30)
show('脊柱 Front-Back -30°（期望：躯干后仰）', 'spine', '+X', -30)
reset()
