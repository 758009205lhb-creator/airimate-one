/**
 * _probe-rig.mjs —— 一次性探针：确认「归一化骨架」的静止姿态取向
 *
 * 为什么必须先做这一步
 * --------------------
 * 任务书第 2 条的核心工程风险是：
 *   Unity 肌肉值是**相对 T-pose 的归一化增量**，所以 VRM 的 local 旋转应当
 *   `local = rest * delta`，而不是 `local = delta`。
 * 但 VRMA 规范（VRMC_vrm_animation 1.0）里存的**不是** local 旋转，而是
 * 「该骨在父骨静止朝向下的相对朝向」（three-vrm-animation 的
 * `_parseAnimation()`：`q_world_anim = q_parentWorld_REST * q_vrma`，
 * 再 `q_local_normalized = q_parentWorld_REST * q_vrma * inverse(q_world_REST)`）。
 *
 * 所以「rest」到底是不是单位阵，只能**实测**。本探针就是量它。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'

const MOD = resolve('F:/deepseek harness/AI女友/build/airi-modules')
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
// ⚠ 必要的桩：GLTFLoader 走 ImageBitmapLoader 时会调 createImageBitmap，
//   Node 里没有 ⇒ Promise 永远不 settle ⇒ 顶层 await 静默挂死（实测踩到）。
//   返回一个"像 ImageBitmap"的对象即可让 material promise 链走完。
if (typeof globalThis.createImageBitmap === 'undefined') {
  globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} })
}

const load = async (rel) => import(pathToFileURL(resolve(MOD, rel)).href)
const THREE = await load('three/build/three.module.js')
const { GLTFLoader } = await load('three-stdlib/loaders/GLTFLoader.js')
const { VRMLoaderPlugin, VRMUtils } = await load('three-vrm.module.js')

// 关掉模型自带的 console 噪声（morph bind 警告，因为剥了 mesh），日志只留我们自己的
const _warn = console.warn, _err = console.error
console.warn = () => {}; console.error = () => {}

const VRM_PATH = 'F:/deepseek harness/AI女友/repos/Mate-Engine/Assets/MATE ENGINE - Avatar/DLCs/Lazuli_VRM.vrm'

/**
 * GLB 改写：把 JSON 块里所有 `images` 剥掉。
 * 我们只要骨架，纹理在 Node 里既加载不了也没意义。
 */
function stripImages(buf) {
  const jsonLen = buf.readUInt32LE(12)
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'))
  const removed = json.images?.length ?? 0
  delete json.images
  delete json.samplers
  delete json.textures
  // 只要骨架：mesh / skin 也一并剥掉（否则 material 会去查已删除的 textures ⇒ 崩）
  delete json.meshes
  delete json.skins
  for (const n of json.nodes ?? []) { delete n.mesh; delete n.skin }
  for (const m of json.materials ?? []) {
    for (const k of ['normalTexture', 'occlusionTexture', 'emissiveTexture']) delete m[k]
    if (m.pbrMetallicRoughness) {
      delete m.pbrMetallicRoughness.baseColorTexture
      delete m.pbrMetallicRoughness.metallicRoughnessTexture
    }
    if (m.extensions?.VRMC_materials_mtoon) {
      const t = m.extensions.VRMC_materials_mtoon
      for (const k of ['shadeMultiplyTexture', 'shadingShiftTexture', 'outlineWidthMultiplyTexture', 'matcapTexture', 'rimMultiplyTexture', 'uvAnimationMaskTexture']) delete t[k]
    }
  }
  const rest = buf.subarray(20 + jsonLen)
  let jb = Buffer.from(JSON.stringify(json), 'utf8')
  if (jb.length % 4) jb = Buffer.concat([jb, Buffer.alloc(4 - (jb.length % 4), 0x20)])
  const head = Buffer.alloc(20)
  head.write('glTF', 0, 'ascii')
  head.writeUInt32LE(2, 4)
  head.writeUInt32LE(12 + 8 + jb.length + rest.length, 8)
  head.writeUInt32LE(jb.length, 12)
  head.writeUInt32LE(0x4e4f534a, 16)
  return { glb: Buffer.concat([head, jb, rest]), removed }
}

const buf = stripImages(readFileSync(VRM_PATH)).glb
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)

const loader = new GLTFLoader()
loader.register((parser) => new VRMLoaderPlugin(parser))
const gltf = await new Promise((res, rej) => loader.parse(ab, '', res, rej))
const vrm = gltf.userData.vrm
console.warn = _warn; console.error = _err
console.log(`VRM 加载成功：${VRM_PATH}`)
console.log(`  metaVersion = ${vrm.meta?.metaVersion}  meta.name = ${vrm.meta?.name}`)
console.log(`  three REVISION = ${THREE.REVISION}`)

const names = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftEye', 'rightEye', 'jaw',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
  'leftThumbMetacarpal', 'leftThumbProximal', 'leftThumbDistal',
  'leftIndexProximal', 'leftIndexIntermediate', 'leftIndexDistal',
  'leftMiddleProximal', 'leftMiddleIntermediate', 'leftMiddleDistal',
  'leftRingProximal', 'leftRingIntermediate', 'leftRingDistal',
  'leftLittleProximal', 'leftLittleIntermediate', 'leftLittleDistal',
  'rightThumbMetacarpal', 'rightThumbProximal', 'rightThumbDistal',
  'rightIndexProximal', 'rightIndexIntermediate', 'rightIndexDistal',
  'rightMiddleProximal', 'rightMiddleIntermediate', 'rightMiddleDistal',
  'rightRingProximal', 'rightRingIntermediate', 'rightRingDistal',
  'rightLittleProximal', 'rightLittleIntermediate', 'rightLittleDistal',
]

vrm.scene.updateWorldMatrix(true, true)
console.log('\n=== 归一化骨骼：静止 local 旋转是否为单位阵？ ===')
let nonIdentity = 0
for (const n of names) {
  const node = vrm.humanoid.getNormalizedBoneNode(n)
  if (!node) { console.log(`  ${n.padEnd(26)} MISSING`); continue }
  const r = node.quaternion
  const isId = (Math.abs(r.x) + Math.abs(r.y) + Math.abs(r.z) + Math.abs(Math.abs(r.w) - 1)) < 1e-6
  if (!isId) nonIdentity++
  console.log(`  ${n.padEnd(26)} node.name=${String(node.name).padEnd(34)} restQ=[${[r.x, r.y, r.z, r.w].map((v) => v.toFixed(6)).join(', ')}]  ${isId ? 'identity' : 'NON-IDENTITY'}`)
}
console.log(`  ⇒ 非单位阵的骨骼数 = ${nonIdentity}`)

// 静止世界朝向：用「指向子骨的方向」定义"骨骼轴"，这才是可测的方向
console.log('\n=== 静止世界朝向（rest world quaternion + 指向子骨的世界方向） ===')
const posOf = (n) => {
  const nd = vrm.humanoid.getNormalizedBoneNode(n)
  if (!nd) return null
  return nd.getWorldPosition(new THREE.Vector3())
}
const qOf = (n) => {
  const nd = vrm.humanoid.getNormalizedBoneNode(n)
  if (!nd) return null
  return nd.getWorldQuaternion(new THREE.Quaternion())
}
const fwdOf = (n) => { const q = qOf(n); return q ? new THREE.Vector3(0, 0, 1).applyQuaternion(q) : null }
const upOf = (n) => { const q = qOf(n); return q ? new THREE.Vector3(0, 1, 0).applyQuaternion(q) : null }

const chain = [
  ['hips', 'spine'], ['spine', 'chest'], ['chest', 'upperChest'], ['upperChest', 'neck'], ['neck', 'head'],
  ['leftShoulder', 'leftUpperArm'], ['leftUpperArm', 'leftLowerArm'], ['leftLowerArm', 'leftHand'],
  ['rightShoulder', 'rightUpperArm'], ['rightUpperArm', 'rightLowerArm'], ['rightLowerArm', 'rightHand'],
  ['leftUpperLeg', 'leftLowerLeg'], ['leftLowerLeg', 'leftFoot'],
  ['rightUpperLeg', 'rightLowerLeg'], ['rightLowerLeg', 'rightFoot'],
]
for (const [a, b] of chain) {
  const pa = posOf(a), pb = posOf(b)
  if (!pa || !pb) { console.log(`  ${a}->${b}: n/a`); continue }
  const dir = pb.clone().sub(pa).normalize()
  const u = upOf(a), f = fwdOf(a)
  console.log(`  ${a.padEnd(14)} -> ${b.padEnd(14)} dirWorld=[${dir.x.toFixed(4)},${dir.y.toFixed(4)},${dir.z.toFixed(4)}]  localY(world)=[${u.x.toFixed(3)},${u.y.toFixed(3)},${u.z.toFixed(3)}]  localZ(world)=[${f.x.toFixed(3)},${f.y.toFixed(3)},${f.z.toFixed(3)}]`)
}

const hipsPos = posOf('hips')
console.log(`\nhips 世界位置 = [${hipsPos.x.toFixed(4)}, ${hipsPos.y.toFixed(4)}, ${hipsPos.z.toFixed(4)}]`)
console.log(`head 世界位置 = [${posOf('head').toArray().map((v) => v.toFixed(4)).join(', ')}]`)
console.log(`leftUpperArm 世界位置 = [${posOf('leftUpperArm').toArray().map((v) => v.toFixed(4)).join(', ')}]`)
console.log(`leftLowerArm 世界位置 = [${posOf('leftLowerArm').toArray().map((v) => v.toFixed(4)).join(', ')}]`)
console.log(`leftHand 世界位置 = [${posOf('leftHand').toArray().map((v) => v.toFixed(4)).join(', ')}]`)

// 原始骨 vs 归一化骨：位置是否一致（判断归一化骨有没有被重排）
console.log('\n=== raw vs normalized 静止世界位置对照（抽样） ===')
for (const n of ['hips', 'leftUpperArm', 'leftUpperLeg', 'leftFoot']) {
  const raw = vrm.humanoid.getRawBoneNode(n)
  const nrm = vrm.humanoid.getNormalizedBoneNode(n)
  const rp = raw?.getWorldPosition(new THREE.Vector3())
  const np = nrm?.getWorldPosition(new THREE.Vector3())
  console.log(`  ${n.padEnd(14)} raw=[${rp ? rp.toArray().map((v) => v.toFixed(3)).join(',') : 'n/a'}]  normalized=[${np ? np.toArray().map((v) => v.toFixed(3)).join(',') : 'n/a'}]`)
}

// 关节骨名（手指）是否存在
console.log('\n=== 手指归一化骨可用性 ===')
let fingerOk = 0
for (const n of names) {
  if (!/Thumb|Index|Middle|Ring|Little/.test(n)) continue
  if (vrm.humanoid.getNormalizedBoneNode(n)) fingerOk++
}
console.log(`  ${fingerOk} / 30 手指归一化骨存在`)
