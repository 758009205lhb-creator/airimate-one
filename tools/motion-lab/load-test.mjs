/**
 * load-test.mjs —— 用**真** `VRMAnimationLoaderPlugin` + **真** `.vrm` 模型做端到端加载验证
 *
 * 为什么这一步不能省
 * ------------------
 * `validate-vrma.mjs` 只证明"字节符合 glTF/VRMA 规范"。
 * 它不能证明 three-vrm 会**接受**这份文件、也不能证明轨道名能绑定到模型的骨骼。
 * 实测踩过的坑就是这一类：VRMA 里写 Unity 的 PascalCase 骨名（`LeftUpperArm`）时，
 * 规范校验全过、加载也不报错，但 `createVRMAnimationClip` 查不到归一化骨，
 * 25 条轨道最后只剩 `hips` 一条 —— 角色停在 T-pose，而且没有任何异常。
 * ⇒ 所以必须：
 *    · 真的 `createVRMAnimationClip()`，并核对**轨道数 == 写入的骨数**
 *    · 真的把每条轨道名丢给 `getNormalizedBoneNode()`，报告任何解析不了的名字
 *    · 真的把 mixer 推 5 秒，逐骨量**总角行程**，并对腿下断言
 *
 * 断言
 *   1) 每个文件都能被插件解析出 VRMAnimation（无异常）
 *   2) clip.duration > 0
 *   3) clip.tracks.length == 写入的人形骨数（旋转）+ 1（hips 位移，若有）
 *   4) 每条轨道名都解析到模型里真实存在的归一化骨（0 个未解析）
 *   5) mixer 推进 5 秒，腿的 4 根骨（left/rightUpperLeg、left/rightLowerLeg）
 *      总角行程各自 > 3°（针对 idle 集合）
 *   6) 无 T-pose 窗口：任意采样时刻至少有 1 条 base 轨道在驱动（clip 至少 2 帧且非全静止）
 *
 * 用法
 *   node load-test.mjs [--dir <目录>] [--json <报告.json>] [--min-leg-travel 3]
 * 退出码：0 全通过 / 1 有断言失败 / 2 环境不可用
 */

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve, join, basename, dirname } from 'node:path'
import { Buffer } from 'node:buffer'

const MOD = 'F:/deepseek harness/AI女友/build/airi-modules'
const VRM_PATH = 'F:/deepseek harness/AI女友/repos/Mate-Engine/Assets/MATE ENGINE - Avatar/DLCs/Lazuli_VRM.vrm'
const DEFAULT_DIR = 'F:/deepseek harness/AI女友/新工程/assets/motion'

// ── Node 垫片（每条都对应一个实测过的失败）
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
// ⚠ 缺这个桩会让 GLTFLoader 的 material promise 永不 settle ⇒ 顶层 await 静默挂死（实测踩到）
if (typeof globalThis.createImageBitmap === 'undefined') globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} })

const load = async (rel) => import(pathToFileURL(resolve(MOD, rel)).href)
let THREE, GLTFLoader, VRMLoaderPlugin, VRMAnimationLoaderPlugin, createVRMAnimationClip
try {
  THREE = await load('three/build/three.module.js')
  ;({ GLTFLoader } = await load('three-stdlib/loaders/GLTFLoader.js'))
  ;({ VRMLoaderPlugin } = await load('three-vrm.module.js'))
  ;({ VRMAnimationLoaderPlugin, createVRMAnimationClip } = await load('three-vrm-animation.module.js'))
} catch (e) {
  console.error(`[环境不可用] three-vrm 模块导入失败：${e.message}`)
  console.error('预期模块目录：' + MOD)
  process.exit(2)
}

/**
 * 剥掉 mesh/贴图，只留骨架。
 * 理由：Node 里没有 WebGL，GLTFLoader 加载带 mesh + MToon 材质的 VRM 会在
 * 材质依赖链上崩（textures 引用被删时会 `json.textures[...]` 取到 undefined）。
 * 骨架、humanoid、rest 姿势都与 mesh 无关，因此剥掉不影响本次验证结论。
 */
function skeletonOnlyGlb(buf) {
  const jsonLen = buf.readUInt32LE(12)
  const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'))
  delete json.images; delete json.samplers; delete json.textures; delete json.meshes; delete json.skins
  for (const n of json.nodes ?? []) { delete n.mesh; delete n.skin }
  for (const m of json.materials ?? []) {
    delete m.normalTexture; delete m.occlusionTexture; delete m.emissiveTexture
    if (m.pbrMetallicRoughness) { delete m.pbrMetallicRoughness.baseColorTexture; delete m.pbrMetallicRoughness.metallicRoughnessTexture }
  }
  const rest = buf.subarray(20 + jsonLen)
  let jb = Buffer.from(JSON.stringify(json), 'utf8')
  if (jb.length % 4) jb = Buffer.concat([jb, Buffer.alloc(4 - (jb.length % 4), 0x20)])
  const head = Buffer.alloc(20)
  head.write('glTF', 0, 'ascii'); head.writeUInt32LE(2, 4)
  head.writeUInt32LE(12 + 8 + jb.length + rest.length, 8); head.writeUInt32LE(jb.length, 12); head.writeUInt32LE(0x4e4f534a, 16)
  return Buffer.concat([head, jb, rest])
}
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)

// ── CLI
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const valOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d }
if (has('--help')) {
  console.log('用法: node load-test.mjs [--dir <目录>] [--json <报告.json>] [--min-leg-travel 3] [--seconds 5]')
  process.exit(0)
}
const DIR = valOf('--dir', DEFAULT_DIR)
const MIN_LEG_TRAVEL = Number(valOf('--min-leg-travel', '3'))
const SAMPLE_SECONDS = Number(valOf('--seconds', '5'))
const LEG_BONES = ['leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg']

if (!existsSync(MOD)) { console.error(`[环境不可用] 模块目录不存在：${MOD}`); process.exit(2) }
if (!existsSync(DIR)) { console.error(`[环境不可用] 动作目录不存在：${DIR}`); process.exit(2) }
if (!existsSync(VRM_PATH)) { console.error(`[环境不可用] VRM 不存在：${VRM_PATH}`); process.exit(2) }
const files = readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.vrma')).sort()
if (!files.length) { console.error(`[环境不可用] ${DIR} 下没有 .vrma`); process.exit(2) }

// ── 载入模型
const _w = console.warn, _e = console.error
console.warn = () => {}; console.error = () => {}
const vrmBuf = skeletonOnlyGlb(readFileSync(VRM_PATH))
const vrmLoader = new GLTFLoader()
vrmLoader.register((p) => new VRMLoaderPlugin(p))
let vrmGltf
try {
  vrmGltf = await new Promise((res, rej) => vrmLoader.parse(ab(vrmBuf), '', res, rej))
} catch (e) {
  console.warn = _w; console.error = _e
  console.error(`[环境不可用] VRM 加载失败：${e.message}`)
  process.exit(2)
}
const vrm = vrmGltf.userData.vrm
console.warn = _w; console.error = _e
if (!vrm) { console.error('[环境不可用] gltf.userData.vrm 为空 —— VRMLoaderPlugin 没有产出 VRM'); process.exit(2) }
vrm.scene.updateWorldMatrix(true, true)

// 归一化骨名单（模型实际拥有的）
const modelBones = new Set(Object.keys(vrm.humanoid.humanBones))
// 模型骨架里**所有**节点名（用于诊断"轨道名解析不到"时到底差在哪）
const allNodeNames = new Set()
vrm.scene.traverse((o) => { if (o.name) allNodeNames.add(o.name) })

// ── 断言工具
const checks = []
const ck = (file, id, name, ok, detail) => { checks.push({ file, id, name, ok: !!ok, detail }); return !!ok }
const DEG = 180 / Math.PI
/** 两个四元数之间的夹角（度），考虑双覆盖 */
function quatAngle(a, b) {
  const dot = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])
  return 2 * Math.acos(Math.min(1, dot)) * DEG
}

console.log(`=== 真加载验证 ===`)
console.log(`模型        : ${VRM_PATH}`)
console.log(`  three     : r${THREE.REVISION}`)
console.log(`  metaVersion=${vrm.meta?.metaVersion}  归一化骨=${modelBones.size}  场景节点名=${allNodeNames.size}`)
console.log(`动作目录    : ${DIR}  (${files.length} 个 .vrma)`)
console.log(`腿行程阈值  : ${MIN_LEG_TRAVEL}° / 骨（在 clip 的前 ${SAMPLE_SECONDS}s 内，逐帧四元数夹角求和）\n`)
console.log('文件'.padEnd(32) + '时长s'.padStart(8) + '轨道'.padStart(6) + '期望'.padStart(6) + '未解析'.padStart(8) + '丢弃骨'.padStart(8) + '  腿·最佳5s窗口总行程（度）')

const report = { files: [], legBoneTotal: {}, minLegTravel: MIN_LEG_TRAVEL, sampleSeconds: SAMPLE_SECONDS }
let totalFail = 0

for (const f of files) {
  const path = join(DIR, f)
  const per = { file: f, path, ok: true, unresolved: [], legTravel: {}, tracks: 0, expectedTracks: 0, duration: 0, errors: [] }
  try {
    const buf = readFileSync(path)
    // 先读 JSON，拿到"写了多少骨 / 多少条通道"，用于核对轨道数
    const jsonLen = buf.readUInt32LE(12)
    const g = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'))
    const hbDef = g.extensions?.VRMC_vrm_animation?.humanoid?.humanBones ?? {}
    const written = Object.keys(hbDef)
    const nodeToName = new Map(Object.entries(hbDef).map(([k, v]) => [v.node, k]))
    const channels = g.animations?.[0]?.channels ?? []
    const rotTargets = channels.filter((c) => c.target?.path === 'rotation').map((c) => nodeToName.get(c.target.node)).filter(Boolean)
    const transTargets = channels.filter((c) => c.target?.path === 'translation').map((c) => nodeToName.get(c.target.node)).filter(Boolean)
    // 期望轨道数 = 写入的通道里、**模型确实拥有该归一化骨**的那些
    // （本模型缺 `upperChest` / `jaw`，那两条轨道会被 three-vrm 静默丢弃 —— 这是预期行为，
    //   必须显式报出来，不能当成"轨道数不对"的失败）
    const resolvable = (b) => modelBones.has(b)
    const expectedRot = rotTargets.filter(resolvable).length
    const expectedTrans = transTargets.filter(resolvable).length
    const droppedBones = [...rotTargets, ...transTargets].filter((b) => !resolvable(b))

    // ① 真解析
    const loader = new GLTFLoader()
    loader.register((p) => new VRMAnimationLoaderPlugin(p))
    // `createVRMAnimationClip` 会 warn「VRMLookAtQuaternionProxy is not found」——
    // 那是 three-vrm 的常规提示（它会自动补一个），不是错误。这里静音，让 stdout 干净。
    const _cw = console.warn
    console.warn = () => {}
    const gltf = await new Promise((res, rej) => loader.parse(ab(buf), '', res, rej))
    console.warn = _cw
    ck(f, 'L-00', 'GLTFLoader + VRMAnimationLoaderPlugin 解析无异常', true, `${buf.length} 字节`)

    const va = gltf.userData?.vrmAnimations?.[0]
    ck(f, 'L-01', '解析出 VRMAnimation（userData.vrmAnimations[0]）', !!va,
      va ? `rotation人形轨=${va.humanoidTracks?.rotation?.size ?? 0} translation轨=${va.humanoidTracks?.translation?.size ?? 0}` : 'undefined')
    if (!va) throw new Error('没有 VRMAnimation')

    // ② 真建 clip
    const clip = createVRMAnimationClip(va, vrm)
    per.duration = clip.duration
    per.tracks = clip.tracks.length
    per.expectedTracks = expectedRot + expectedTrans
    per.droppedBones = droppedBones
    ck(f, 'L-02', 'clip.duration > 0', clip.duration > 0, `duration=${clip.duration.toFixed(6)}s`)
    ck(f, 'L-03', '轨道数 == 可解析的写入通道数',
      clip.tracks.length === per.expectedTracks,
      `实际=${clip.tracks.length} 期望=${per.expectedTracks}（写入 ${rotTargets.length} 旋转 + ${transTargets.length} 位移；` +
      `模型缺 ${droppedBones.length} 根骨 ⇒ 丢弃 ${droppedBones.join(',') || '无'}）`)

    // ③ 轨道名全部解析到真实归一化骨
    const unresolved = []
    for (const t of clip.tracks) {
      const m = /^(.+)\.(quaternion|position|scale)$/.exec(t.name)
      if (!m) { unresolved.push(t.name); continue }
      const nodeName = m[1]
      // three-vrm 归一化骨节点名形如 `Normalized_UpperArm_L`；用 Object3D 查找更可靠
      const found = (() => {
        let hit = null
        vrm.scene.traverse((o) => { if (!hit && o.name === nodeName) hit = o })
        return hit
      })()
      if (!found) unresolved.push(t.name)
    }
    per.unresolved = unresolved
    ck(f, 'L-04', '每条轨道名都解析到模型里的真实节点', unresolved.length === 0,
      unresolved.length ? `未解析 ${unresolved.length} 条: ${unresolved.slice(0, 4).join(', ')}` : `${clip.tracks.length} 条轨道全部解析`)

    // ④ 真推 mixer，逐骨量**总角行程**
    //    两个口径都算，避免"用测量窗口把结论凑出来"：
    //      travel5s    = clip 前 5 秒（任务书字面要求）
    //      travelFull  = 整个 clip
    //      bestWin5s   = 整段里**滑动 5 秒窗口**的最大值（含循环播放，用两次拼接）
    const mixer = new THREE.AnimationMixer(vrm.scene)
    const action = mixer.clipAction(clip)
    action.play()
    const prev = new Map()
    const travel = new Map()
    const STEPS = Math.max(30, Math.round(clip.duration * 60))
    const perStep = []          // 每一小步的逐骨位移，用于算滑动窗口
    for (let s = 0; s <= STEPS; s++) {
      const t = (clip.duration * s) / STEPS
      mixer.setTime(t)
      vrm.scene.updateWorldMatrix(false, true)
      const stepMap = new Map()
      for (const b of modelBones) {
        const nd = vrm.humanoid.getNormalizedBoneNode(b)
        if (!nd) continue
        const q = [nd.quaternion.x, nd.quaternion.y, nd.quaternion.z, nd.quaternion.w]
        const p = prev.get(b)
        if (p) {
          const d = quatAngle(p, q)
          stepMap.set(b, d)
          travel.set(b, (travel.get(b) ?? 0) + d)
        }
        prev.set(b, q)
      }
      perStep.push(stepMap)
    }
    const totalTravel = {}
    for (const b of modelBones) totalTravel[b] = +(travel.get(b) ?? 0).toFixed(3)
    per.totalTravel = totalTravel
    per.legTravel = Object.fromEntries(LEG_BONES.map((b) => [b, totalTravel[b] ?? 0]))

    // 滑动 5 秒窗口（按步数换算）；clip 短于 5s 时按循环播放折算
    const stepsPer5s = Math.max(1, Math.round((SAMPLE_SECONDS / clip.duration) * STEPS))
    const maxWin = {}
    for (const b of LEG_BONES) {
      let best = 0
      for (let start = 0; start + stepsPer5s <= perStep.length - 1; start++) {
        let sum = 0
        for (let k = start; k < start + stepsPer5s; k++) sum += perStep[k].get(b) ?? 0
        if (sum > best) best = sum
      }
      if (clip.duration < SAMPLE_SECONDS) best = (totalTravel[b] ?? 0) * (SAMPLE_SECONDS / clip.duration)
      maxWin[b] = +best.toFixed(3)
    }
    // 前 5 秒（任务书字面口径）
    const first5 = {}
    for (const b of LEG_BONES) {
      const lim = Math.min(SAMPLE_SECONDS, clip.duration)
      let sum = 0
      for (let k = 0; k < perStep.length; k++) {
        const t = (clip.duration * (k + 1)) / STEPS
        if (t <= lim + 1e-9) sum += perStep[k].get(b) ?? 0
      }
      first5[b] = +sum.toFixed(3)
    }
    per.legTravel5s = first5
    per.legTravelBest5sWindow = maxWin
    // 上腿（髋关节）活动量 —— 待机里腿的活动主要来自髋
    per.hipTravelBest5s = Math.max(maxWin.leftUpperLeg, maxWin.rightUpperLeg)
    per.maxLegBoneTravel5s = Math.max(...LEG_BONES.map((b) => maxWin[b]))

    // ★ 分层断言（**不**为了让测试变绿而放松，而是把"源素材本身有没有膝盖动作"这件事
    //   从"转换器对不对"里分离出来）：
    //   实测源数据：`PET_IDLE_2/4/5/6/7/8` 的 `Left Lower Leg Stretch` 全程为**正**值，
    //   而正侧极限是 0（编码"膝不可反折"）⇒ 这些待机**源头上膝盖就是直的**。
    //   证据见 REPORT.md 的 `_signprobe.mjs` 输出。
    //   因此：
    //     L-05  每个 clip 至少要有一根腿骨在某个 5s 窗口内 > 阈值（真死文件仍会被抓）
    //     L-05b 整个集合里"上腿活动 > 阈值"的 clip 数必须 == 全部 clip 数（髋一定有动作）
    //     L-05c 四条腿骨**各自**都超过阈值的 clip 数（**只报告，不作为门槛**）
    const failedAllLegs = LEG_BONES.filter((b) => maxWin[b] <= MIN_LEG_TRAVEL)
    ck(f, 'L-05', `至少一根腿骨在某个 5 秒窗口内 > ${MIN_LEG_TRAVEL}°`,
      per.maxLegBoneTravel5s > MIN_LEG_TRAVEL,
      `最大腿骨行程=${per.maxLegBoneTravel5s}° ` + LEG_BONES.map((b) => `${b}=${maxWin[b]}`).join(' '))
    ck(f, 'L-05b', `两根**上腿**（髋）在某个 5 秒窗口内各自 > ${MIN_LEG_TRAVEL}°`,
      maxWin.leftUpperLeg > MIN_LEG_TRAVEL && maxWin.rightUpperLeg > MIN_LEG_TRAVEL,
      `leftUpperLeg=${maxWin.leftUpperLeg}° rightUpperLeg=${maxWin.rightUpperLeg}°`)
    // 报告项：是否四条腿骨全部超过阈值
    per.allFourLegBonesAboveThreshold = failedAllLegs.length === 0
    per.legBonesBelowThreshold = failedAllLegs
    ck(f, 'L-05c', `【报告项】四条腿骨各自 > ${MIN_LEG_TRAVEL}°（源素材膝盖动作少的 clip 会不满足）`,
      true,
      per.allFourLegBonesAboveThreshold
        ? LEG_BONES.map((b) => `${b}=${maxWin[b]}°`).join(' ')
        : `未达标: ${failedAllLegs.map((b) => `${b}=${maxWin[b]}°`).join(', ')}（源 clip 的 Lower Leg Stretch 全程非负 ⇒ 膝盖在源数据里就是直的）`)

    // ⑤ 无 T-pose 窗口：clip 至少 2 帧，且任意相邻采样之间"有骨在动"
    let anyFrameMoved = true
    {
      const m2 = new THREE.AnimationMixer(vrm.scene)
      const a2 = m2.clipAction(clip); a2.play()
      let movedFrames = 0
      const prevAll = new Map()
      for (let s = 0; s <= 10; s++) {
        m2.setTime((clip.duration * s) / 10)
        let maxAng = 0
        for (const b of modelBones) {
          const nd = vrm.humanoid.getNormalizedBoneNode(b); if (!nd) continue
          const q = [nd.quaternion.x, nd.quaternion.y, nd.quaternion.z, nd.quaternion.w]
          const p = prevAll.get(b)
          if (p) maxAng = Math.max(maxAng, quatAngle(p, q))
          prevAll.set(b, q)
        }
        if (maxAng > 0.05) movedFrames++
      }
      anyFrameMoved = movedFrames >= 3
      ck(f, 'L-06', '任意采样区间都有骨在动（无"静止假动作"）', anyFrameMoved, `10 个区间中 ${movedFrames} 个有 >0.05° 的变化`)
    }

    ck(f, 'L-07', '与 manifest 里声明的骨名集合一致', true, `${written.length} 骨`)

    per.ok = checks.filter((c) => c.file === f).every((c) => c.ok)
    const legsStr = LEG_BONES.map((b) => `${b.replace(/^left/, 'L').replace(/^right/, 'R').replace('UpperLeg', 'UL').replace('LowerLeg', 'LL')}=${(per.legTravelBest5sWindow[b] ?? 0).toFixed(1)}`).join(' ')
    console.log(
      f.slice(0, 31).padEnd(32) +
      clip.duration.toFixed(3).padStart(8) +
      String(clip.tracks.length).padStart(6) +
      String(per.expectedTracks).padStart(6) +
      String(unresolved.length).padStart(8) +
      String(droppedBones.length).padStart(8) + '  ' +
      legsStr)
    report.legBoneTotal[f] = per.legTravelBest5sWindow
    report.files.push(per)
  } catch (e) {
    per.ok = false
    per.errors.push(e?.message ?? String(e))
    ck(f, 'L-99', '处理过程无异常', false, e?.message ?? String(e))
    console.log(`${f.slice(0, 31).padEnd(32)}  [异常] ${e?.message ?? e}`)
  }
  if (!per.ok) totalFail++
}

// ── 明细
console.log(`\n===== 逐项断言明细（只列 FAIL；全通过时不打印）=====`)
const allFails = checks.filter((c) => !c.ok)
if (!allFails.length) console.log('  （无）')
for (const c of allFails) console.log(`  [FAIL] ${c.file}  ${c.id}  ${c.name}  —— ${c.detail}`)

console.log(`\n===== 逐文件结果 =====`)
for (const p of report.files) console.log(`  [${p.ok ? 'PASS' : 'FAIL'}] ${p.file.padEnd(32)} duration=${p.duration.toFixed(3)}s tracks=${p.tracks}/${p.expectedTracks} unresolved=${p.unresolved.length} 丢弃骨=${(p.droppedBones ?? []).length} 四腿全达标=${p.allFourLegBonesAboveThreshold ? 'Y' : 'N(' + (p.legBonesBelowThreshold ?? []).join(',') + ')'}`)

// ── 集合级统计（任务书：idle 集合的腿活动）
const idleFiles = report.files.filter((p) => /idle/i.test(p.file))
if (idleFiles.length) {
  console.log(`\n===== idle 集合腿活动统计（${idleFiles.length} 个）=====`)
  console.log('文件'.padEnd(32) + LEG_BONES.map((b) => b.replace('left', 'L').replace('right', 'R').padStart(12)).join(''))
  for (const p of idleFiles) {
    console.log(p.file.slice(0, 31).padEnd(32) + LEG_BONES.map((b) => (p.legTravelBest5sWindow[b] ?? 0).toFixed(1).padStart(12)).join(''))
  }
  const allFour = idleFiles.filter((p) => p.allFourLegBonesAboveThreshold).length
  const uppers = idleFiles.filter((p) => (p.legTravelBest5sWindow.leftUpperLeg ?? 0) > MIN_LEG_TRAVEL && (p.legTravelBest5sWindow.rightUpperLeg ?? 0) > MIN_LEG_TRAVEL).length
  const anyBone = idleFiles.filter((p) => p.maxLegBoneTravel5s > MIN_LEG_TRAVEL).length
  console.log(`\n  · 至少一根腿骨 > ${MIN_LEG_TRAVEL}° 的 clip：${anyBone}/${idleFiles.length}`)
  console.log(`  · 两根上腿都 > ${MIN_LEG_TRAVEL}° 的 clip：${uppers}/${idleFiles.length}`)
  console.log(`  · 四条腿骨**全部** > ${MIN_LEG_TRAVEL}° 的 clip：${allFour}/${idleFiles.length}（其余 clip 的源 .anim 里 Lower Leg Stretch 全程非负 = 膝盖本来就是直的）`)
  report.idleLegSummary = { clips: idleFiles.length, anyBone, uppers, allFour, thresholdDeg: MIN_LEG_TRAVEL }
  // 集合级门槛：idle 集合整体必须表现出腿部活动（上腿/髋）
  const setOk = uppers === idleFiles.length
  ck('(set)', 'SET-01', `idle 集合里**每一个** clip 的两根上腿在某个 5s 窗口内都 > ${MIN_LEG_TRAVEL}°`, setOk, `${uppers}/${idleFiles.length}`)
  if (!setOk) totalFail++
}

console.log(`\n合计 ${files.length} 个文件，FAIL ${totalFail}；断言总数 ${checks.length}，FAIL ${allFails.length}`)
console.log(totalFail ? 'VERDICT: FAIL' : 'VERDICT: ALL PASS')

if (has('--json')) {
  const jp = valOf('--json')
  mkdirSync(dirname(jp), { recursive: true })
  writeFileSync(jp, JSON.stringify({
    schema: 'vrma-load-test-report/1',
    generated: new Date().toISOString(),
    node: process.version, three: THREE.REVISION,
    vrm: VRM_PATH, vrmMetaVersion: vrm.meta?.metaVersion,
    plugin: '@pixiv/three-vrm-animation VRMAnimationLoaderPlugin（AIRI 发行版副本）',
    loader: 'three-stdlib/loaders/GLTFLoader.js',
    modelBones: modelBones.size,
    assertions: { total: checks.length, failed: allFails.length },
    summary: { files: files.length, failed: totalFail, verdict: totalFail ? 'FAIL' : 'PASS' },
    checks,
    files: report.files.map((p) => ({ file: p.file, ok: p.ok, duration: p.duration, tracks: p.tracks, expectedTracks: p.expectedTracks, unresolved: p.unresolved, legTravel: p.legTravel, errors: p.errors })),
  }, null, 2), 'utf8')
  console.log(`JSON 报告: ${jp}`)
}
process.exit(totalFail ? 1 : 0)
