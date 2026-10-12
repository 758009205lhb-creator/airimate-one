/**
 * _probe-conv.mjs —— 一次性探针 #2：确定「VRMA 里该写什么四元数」
 *
 * 要回答的三个问题
 * ----------------
 *  Q1  `VRMAnimationLoaderPlugin` 对 **metaVersion=0** 的模型会把四元数的 x/z 取反
 *      （源码 createVRMAnimationHumanoidTracks: `metaVersion === "0" && i % 2 === 0 ? -v : v`
 *       对 quaternion 是下标 0/2 = x/z 取反）。那到底该写"已取反"的还是"未取反"的？
 *  Q2  归一化骨架的静止 local 旋转是单位阵（探针 #1 已证），那 VRMA 里的旋转是不是
 *      就直接等于「相对 T-pose 的增量」本身？
 *  Q3  原始 VRM 节点（raw）有没有被做坐标翻转？归一化骨是不是和 raw 同向？
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

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
if (typeof globalThis.createImageBitmap === 'undefined') {
  globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} })
}

const load = async (rel) => import(pathToFileURL(resolve(MOD, rel)).href)
const THREE = await load('three/build/three.module.js')
const { GLTFLoader } = await load('three-stdlib/loaders/GLTFLoader.js')
const { VRMLoaderPlugin } = await load('three-vrm.module.js')
const { VRMAnimationLoaderPlugin, createVRMAnimationClip } = await load('three-vrm-animation.module.js')

const VRM_PATH = 'F:/deepseek harness/AI女友/repos/Mate-Engine/Assets/MATE ENGINE - Avatar/DLCs/Lazuli_VRM.vrm'

function stripImages(buf) {
  const jsonLen = buf.readUInt32LE(12)
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'))
  delete json.images; delete json.samplers; delete json.textures; delete json.meshes; delete json.skins
  for (const n of json.nodes ?? []) { delete n.mesh; delete n.skin }
  const rest = buf.subarray(20 + jsonLen)
  let jb = Buffer.from(JSON.stringify(json), 'utf8')
  if (jb.length % 4) jb = Buffer.concat([jb, Buffer.alloc(4 - (jb.length % 4), 0x20)])
  const head = Buffer.alloc(20)
  head.write('glTF', 0, 'ascii'); head.writeUInt32LE(2, 4)
  head.writeUInt32LE(12 + 8 + jb.length + rest.length, 8)
  head.writeUInt32LE(jb.length, 12); head.writeUInt32LE(0x4e4f534a, 16)
  return { glb: Buffer.concat([head, jb, rest]), json }
}

const _warn = console.warn, _err = console.error
const strip = stripImages(readFileSync(VRM_PATH))
const rawJson = strip.json
console.warn = () => {}; console.error = () => {}
const buf = strip.glb
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
const loader = new GLTFLoader()
loader.register((p) => new VRMLoaderPlugin(p))
const gltf = await new Promise((res, rej) => loader.parse(ab, '', res, rej))
const vrm = gltf.userData.vrm
console.warn = _warn; console.error = _err

// ── Q3: raw 节点原始 TRS vs three 里的 raw 节点 vs 归一化节点
let ext = rawJson.extensions.VRMC_vrm, extName = 'VRMC_vrm'
if (!ext) { ext = rawJson.extensions.VRM; extName = 'VRM' }
console.log('extensionsUsed =', JSON.stringify(rawJson.extensionsUsed))
console.log('VRM 扩展名 =', extName, ' specVersion =', ext?.specVersion ?? '(VRM0 无此字段)', ' metaVersion =', vrm.meta.metaVersion)
const hb = ext.humanoid.humanBones
console.log('humanBones 前 8 项 =', JSON.stringify(Object.entries(hb).slice(0, 8)))
const rawDefNode = (name) => {
  const v = hb[name]
  if (v == null) return null
  return typeof v === 'number' ? v : v.node
}
console.log('\n=== Q3: raw JSON 节点 TRS vs three.js 节点 ===')
for (const n of ['hips', 'leftUpperArm', 'leftUpperLeg', 'head']) {
  const idx = rawDefNode(n)
  const def = idx != null ? rawJson.nodes[idx] : null
  const rn = vrm.humanoid.getRawBoneNode(n)
  const nn = vrm.humanoid.getNormalizedBoneNode(n)
  const f = (arr) => (arr ? `[${arr.map((v) => (+v).toFixed(4)).join(',')}]` : 'n/a')
  console.log(`  ${n.padEnd(13)} jsonIdx=${idx}`)
  console.log(`      json.translation=${f(def?.translation)}  json.rotation=${f(def?.rotation)}`)
  console.log(`      three.raw  localPos=${f(rn?.position.toArray())}  localQuat=${f(rn?.quaternion.toArray())}`)
  console.log(`      three.norm localPos=${f(nn?.position.toArray())}  localQuat=${f(nn?.quaternion.toArray())}`)
}

// ── Q1/Q2: 写一个"已知朝向"的 VRMA，看它落到哪
/**
 * 造一个单骨 VRMA：给 `bone` 写 `q`（不取反、也不预乘任何东西），其余骨写单位阵。
 */
function makeVrma(bone, q, { negateXZ = false } = {}) {
  const qq = negateXZ ? [-q[0], q[1], -q[2], q[3]] : q
  const bones = ['hips', bone]
  const nodes = bones.map((b) => ({ name: b, rotation: [0, 0, 0, 1], translation: [0, 0, 0] }))
  nodes[0].translation = [0, 0.834, 0]
  const times = new Float32Array([0, 1])
  const vals = new Float32Array(8)
  vals.set([0, 0, 0, 1], 0); vals.set(qq, 4)
  const bin = Buffer.concat([Buffer.from(times.buffer), Buffer.from(vals.buffer)])
  const json = {
    asset: { version: '2.0', generator: 'probe' }, scene: 0, scenes: [{ nodes: [0, 1] }], nodes,
    animations: [{
      name: 'probe',
      samplers: [{ input: 0, output: 1, interpolation: 'LINEAR' }],
      channels: [{ sampler: 0, target: { node: 1, path: 'rotation' } }],
    }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 1, componentType: 5126, count: 2, type: 'VEC4' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 8 },
      { buffer: 0, byteOffset: 8, byteLength: 32 },
    ],
    buffers: [{ byteLength: bin.length }],
    extensionsUsed: ['VRMC_vrm_animation'],
    extensions: { VRMC_vrm_animation: { specVersion: '1.0', humanoid: { humanBones: { hips: { node: 0 }, [bone]: { node: 1 } } } } },
  }
  let jb = Buffer.from(JSON.stringify(json), 'utf8')
  if (jb.length % 4) jb = Buffer.concat([jb, Buffer.alloc(4 - (jb.length % 4), 0x20)])
  const bb = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)])
  const head = Buffer.alloc(12)
  head.write('glTF', 0, 'ascii'); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + jb.length + 8 + bb.length, 8)
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b }
  return Buffer.concat([head, ch(jb.length, 0x4e4f534a), jb, ch(bb.length, 0x004e4942), bb])
}

const dirOf = (bone, child) => {
  const a = vrm.humanoid.getNormalizedBoneNode(bone).getWorldPosition(new THREE.Vector3())
  const b = vrm.humanoid.getNormalizedBoneNode(child).getWorldPosition(new THREE.Vector3())
  return b.sub(a).normalize()
}
const resetPose = () => { vrm.humanoid.resetNormalizedPose(); vrm.scene.updateWorldMatrix(true, true) }

async function applyVrma(bytes) {
  const l = new GLTFLoader()
  l.register((p) => new VRMAnimationLoaderPlugin(p))
  const a2 = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const g = await new Promise((res, rej) => l.parse(a2, '', res, rej))
  const va = g.userData.vrmAnimations[0]
  const clip = createVRMAnimationClip(va, vrm)
  const mixer = new THREE.AnimationMixer(vrm.scene)
  const action = mixer.clipAction(clip)
  action.play()
  mixer.setTime(0.5)
  vrm.scene.updateWorldMatrix(true, true)
  return { va, clip }
}

console.log('\n=== Q1/Q2: 写进 VRMA 的四元数 → 归一化骨世界朝向 ===')
// 参照：静止
resetPose()
const restArm = dirOf('leftUpperArm', 'leftLowerArm').toArray().map((v) => +v.toFixed(4))
console.log(`  rest leftUpperArm->leftLowerArm 世界方向 = [${restArm.join(',')}]`)

// 目标：让左臂沿世界 -Y（垂在身侧）。绕 Z 转 -90°：(-1,0,0) --Rz(-90)--> (0,-1,0)
const H = Math.PI / 180
const qDown = [0, 0, Math.sin(-45 * H), Math.cos(-45 * H)]   // 绕 +Z 转 -90°
for (const negateXZ of [false, true]) {
  resetPose()
  const bytes = makeVrma('leftUpperArm', qDown, { negateXZ })
  const { va } = await applyVrma(bytes)
  const written = [...va.humanoidTracks.rotation.get('leftUpperArm')?.values.slice(0, 4) ?? []].map((v) => +v.toFixed(4))
  // loader 解析后的值（对 metaVersion=0 会 x/z 取反）
  resetPose()
  await applyVrma(bytes)
  const d = dirOf('leftUpperArm', 'leftLowerArm').toArray().map((v) => +v.toFixed(4))
  console.log(`  negateXZ=${String(negateXZ).padEnd(5)} 写=[${qDown.map((v) => +v.toFixed(4)).join(',')}] (裸) → loader 后=[${written.join(',')}]  ⇒ 左臂方向=[${d.join(',')}]`)
}

// 另一组：绕 +Y 转 +45°（应当把左臂从 -X 转向 ...）
const qY = [0, Math.sin(22.5 * H), 0, Math.cos(22.5 * H)]
for (const negateXZ of [false, true]) {
  resetPose()
  const bytes = makeVrma('leftUpperArm', qY, { negateXZ })
  await applyVrma(bytes)
  const d = dirOf('leftUpperArm', 'leftLowerArm').toArray().map((v) => +v.toFixed(4))
  console.log(`  +Y45° negateXZ=${String(negateXZ).padEnd(5)} ⇒ 左臂方向=[${d.join(',')}]`)
}

// 腿：绕 +X 转 ? 让左腿从 (0,-1,0) 抬到前方
const qX = [Math.sin(22.5 * H), 0, 0, Math.cos(22.5 * H)]
for (const negateXZ of [false, true]) {
  resetPose()
  const bytes = makeVrma('leftUpperLeg', qX, { negateXZ })
  await applyVrma(bytes)
  const d = dirOf('leftUpperLeg', 'leftLowerLeg').toArray().map((v) => +v.toFixed(4))
  console.log(`  +X45° negateXZ=${String(negateXZ).padEnd(5)} ⇒ 左腿方向=[${d.join(',')}]`)
}
resetPose()
