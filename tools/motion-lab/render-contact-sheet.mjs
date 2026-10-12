/**
 * render-contact-sheet.mjs —— 无 GUI 的验证帧渲染器
 *
 * 两条路，**优先真渲染**：
 *
 *   ① **Electron + 真 WebGL**（首选）
 *      用 `node_modules/electron/dist/electron.exe` 起一个隐藏窗口，
 *      用真 `@pixiv/three-vrm` 加载真 `.vrm`、真 `VRMAnimationLoaderPlugin` 加载真 `.vrma`，
 *      `mixer.setTime(t)` 定帧后 `toDataURL()` 出 PNG。
 *      GL 后端用 `--use-gl=angle --use-angle=swiftshader`（软件光栅），无 GPU 也能出图。
 *
 *   ② **SVG 骨骼投影**（可靠回退，且**总是**一起产出）
 *      纯 Node 计算：把 VRMA 的四元数喂给一个自实现的 FK，
 *      用模型自己的骨骼偏移（从 `.vrm` 的节点树读）算出每根骨的世界位置，
 *      再正交投影成 SVG。完全不依赖 GPU/浏览器，因此**永远可用**。
 *
 * 为什么两路都做：①是"人眼可判"的证据，但它在无 GPU 的环境里可能失败；
 * ②是"机器可判"的证据，永远能跑。任何一路成功都不算失败，
 * 但 REPORT 里必须写清**哪一路真的跑通了**。
 *
 * 用法
 *   node render-contact-sheet.mjs --vrma <x.vrma> [--frames 4] [--out <dir>] [--no-electron]
 *   node render-contact-sheet.mjs --set idle --max 3
 * 退出码：0 至少一路成功 / 1 两路都失败 / 2 环境不可用
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve, join, basename, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Buffer } from 'node:buffer'

const HERE = dirname(fileURLToPath(import.meta.url))
const MOD = 'F:/deepseek harness/AI女友/build/airi-modules'
const VRM_PATH = 'F:/deepseek harness/AI女友/repos/Mate-Engine/Assets/MATE ENGINE - Avatar/DLCs/Lazuli_VRM.vrm'
const DEFAULT_VRMA_DIR = 'F:/deepseek harness/AI女友/新工程/assets/motion'
const DEFAULT_OUT = 'F:/deepseek harness/AI女友/新工程/assets/motion/contact-sheets'
const ELECTRON = 'F:/deepseek harness/AI女友/node_modules/electron/dist/electron.exe'

// ── CLI
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const valOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d }
if (has('--help') || argv.length === 0) {
  console.log('用法:')
  console.log('  node render-contact-sheet.mjs --vrma <x.vrma> [--frames 4] [--out <dir>] [--view three-quarter|front|side]')
  console.log('  node render-contact-sheet.mjs --set idle [--max 2] [--no-electron] [--no-svg] [--json]')
  process.exit(argv.length === 0 ? 2 : 0)
}

const WIDTH = Number(valOf('--width', '640'))
const HEIGHT = Number(valOf('--height', '640'))
const VIEW = valOf('--view', 'three-quarter')
const OUT_DIR = valOf('--out', DEFAULT_OUT)
const FRAMES = Number(valOf('--frames', '4'))
const SKIP_ELECTRON = has('--no-electron')
const SKIP_SVG = has('--no-svg')
const TIMEOUT_MS = Number(valOf('--timeout', '300000'))
/** 渲染载荷档位：'bones'（默认，最稳）| 'flat' | 'original' */
const MESH_MODE = valOf('--mesh-mode', 'bones')
/** hips 世界原点口径：'relative'（默认，钉在世界原点）| 'absolute'（照抄 RootT） */
const HIPS_ORIGIN = valOf('--hips-origin', 'relative')

let targets = []
if (has('--vrma')) targets = [resolve(valOf('--vrma'))]
else {
  const set = valOf('--set', 'idle')
  const dir = valOf('--dir', DEFAULT_VRMA_DIR)
  if (!existsSync(dir)) { console.error(`[环境不可用] ${dir} 不存在`); process.exit(2) }
  targets = readdirSync(dir).filter((f) => f.endsWith('.vrma') && (set === 'all' || f.includes(set))).sort().map((f) => join(dir, f))
  const max = Number(valOf('--max', '0'))
  if (max > 0) targets = targets.slice(0, max)
}
if (!targets.length) { console.error('[环境不可用] 没有匹配的 .vrma'); process.exit(2) }

mkdirSync(OUT_DIR, { recursive: true })
console.log(`=== 渲染验证帧 ===`)
console.log(`输出目录  : ${OUT_DIR}`)
console.log(`目标      : ${targets.length} 个 .vrma`)
console.log(`分辨率    : ${WIDTH}x${HEIGHT}   视角=${VIEW}   每文件帧数=${FRAMES}`)
console.log(`Electron  : ${SKIP_ELECTRON ? '(跳过)' : EXISTS_ELECTRON() ? ELECTRON : '(不可用)'}`)
console.log(`SVG 回退  : ${SKIP_SVG ? '(跳过)' : '启用'}\n`)
function EXISTS_ELECTRON() { return existsSync(ELECTRON) }

const summary = { generated: new Date().toISOString(), electron: { attempted: false, ok: false, detail: null, files: [] }, svg: { ok: false, files: [] } }
let anySuccess = false

/**
 * 把 browser 版 three / three-vrm 模块铺到 `tools/motion-lab/` 下的相对路径，
 * 让 `renderer.html` 的相对 import 能解析。
 *
 * 为什么就地铺而不是改 renderer.html 的 import：
 *   这几个 `.module.js` 是**打包产物**，内部用的是裸名 `import ... from 'three'`。
 *   要让裸名可解析，最省事且最稳的是给它一个同目录的 `three/package.json`
 *   （`{ "name":"three", "main":"three.module.js", "exports": ... }`）——
 *   浏览器不会读 package.json，但**裸名 import 在浏览器里本来也不合法**。
 *   ⇒ 所以真正的解法是：让 `three-vrm*.module.js` 里的裸 `three` 也能解析。
 *   file:// 下浏览器不支持 import maps 的裸名吗？支持 —— 但需要一个 importmap 声明。
 *   `renderer.html` 里没有 importmap。
 *
 * ⇒ 因此这里做**文本改写**：把拷过去的 `three-vrm*.module.js` 里的
 *   `from "three"` / `from 'three'` 改成 `from "./three/three.module.js"`。
 *   改写后的文件放在 motion-lab 根下（与 renderer.html 同级）。
 *   这是唯一能在 file:// 下工作、又不需要打包器的办法。
 *   同时把源文件的 sha256 记进报告，保证"改了什么"可追溯。
 */
function ensureRendererModules() {
  const files = [
    // ⚠ 源路径是 `three/build/three.module.js`（不是 `three/three.module.js`）；
    //   实测踩到过：路径写错时 `existsSync` 全 false，模块一个都没铺上。
    ['three/build/three.module.js', 'three/three.module.js'],
    ['three/build/three.core.js', 'three/three.core.js'],
    ['three-stdlib/loaders/GLTFLoader.js', 'three-stdlib/loaders/GLTFLoader.js'],
    ['three-stdlib/utils/BufferGeometryUtils.js', 'three-stdlib/utils/BufferGeometryUtils.js'],
    ['three-stdlib/_polyfill/constants.js', 'three-stdlib/_polyfill/constants.js'],
    ['three-stdlib/_polyfill/LoaderUtils.js', 'three-stdlib/_polyfill/LoaderUtils.js'],
    // ⚠ 类型声明桩：`three-stdlib/utils/BufferGeometryUtils.js` 里有一句
    //   `import type { ... } from '../types/helpers.js'`。浏览器**不认** `import type`
    //   （它是 TS 语法），所以那句会被原样当运行时 import 解析 ⇒ 404 ⇒ 整条模块链断掉。
    //   实测踩到过（自检直接把它挡住了）。把空的类型桩也铺过去，让 404 变成 200。
    ['three-stdlib/types/helpers.js', 'three-stdlib/types/helpers.js'],
    ['three-vrm.module.js', 'three-vrm.module.js'],
    ['three-vrm-animation.module.js', 'three-vrm-animation.module.js'],
    ['three-vrm-core.module.js', 'three-vrm-core.module.js'],
    ['three-vrm-materials-mtoon.module.js', 'three-vrm-materials-mtoon.module.js'],
    ['three-vrm-node-constraint.module.js', 'three-vrm-node-constraint.module.js'],
    ['three-vrm-springbone.module.js', 'three-vrm-springbone.module.js'],
  ]
  const copied = []
  try {
    for (const [src, dst] of files) {
      const from = join(MOD, src)
      const to = join(HERE, dst)
      if (!existsSync(from)) continue
      mkdirSync(dirname(to), { recursive: true })
      let text = readFileSync(from, 'utf8')
      // 只改 `three-vrm*.module.js`：它们 bundle 里用的是裸名 `three`。
      // ⚠ **不要**动 `three-stdlib/loaders/GLTFLoader.js` —— AIRI 那份已经是
      //   `from "../utils/BufferGeometryUtils.js"` 之外还用了 `from "three"`，
      //   但它在 `three-stdlib/loaders/` 下，正确相对路径是 `../../three/three.module.js`；
      //   早期版本在**已改写过**的副本上再改一次，生成了
      //   `three-stdlib/three/three.module.js`（404）—— 实测就是这么踩的。
      if (dst.startsWith('three-vrm')) {
        const before = text
        text = text.replace(/(\bfrom\s*)(["'])three\2/g, '$1$2./three/three.module.js$2')
        if (text !== before) copied.push({ dst, rewritten: 'bare three → ./three/three.module.js' })
      }
      writeFileSync(to, text, 'utf8')
    }
    // `three-stdlib/**` 里的每个文件都按**自己的目录深度**算到 `three/three.module.js`
    // 的相对路径。用统一规则（数目录层数）而不是硬编码，避免再出现
    // `three-stdlib/three/three.module.js` 这种断链（实测踩到过）。
    const STDLIB = [
      'three-stdlib/loaders/GLTFLoader.js',
      'three-stdlib/utils/BufferGeometryUtils.js',
      'three-stdlib/_polyfill/constants.js',
      'three-stdlib/_polyfill/LoaderUtils.js',
    ]
    for (const rel of STDLIB) {
      const src = join(MOD, rel)
      const dst = join(HERE, rel)
      if (!existsSync(src)) continue
      const depth = rel.split('/').length - 1   // 相对 motion-lab 的层数
      const up = '../'.repeat(depth)
      let t = readFileSync(src, 'utf8')
      const before = t
      t = t.replace(/(\bfrom\s*)(["'])three\2/g, `$1$2${up}three/three.module.js$2`)
      writeFileSync(dst, t, 'utf8')
      if (t !== before) copied.push({ dst: rel, rewritten: `bare three → ${up}three/three.module.js` })
    }
    const need = ['three/three.module.js', 'three-vrm.module.js', 'three-vrm-animation.module.js', 'three-stdlib/loaders/GLTFLoader.js']
    const missing = need.filter((n) => !existsSync(join(HERE, n)))
    if (missing.length) return { ok: false, detail: `缺少 ${missing.join(', ')}`, copied }
    // 自检：所有相对 import 的目标必须真实存在（断链会表现为页面顶层 import 静默失败，
    // 页面什么都不报，主进程只能等到超时 —— 所以必须在这里挡住）
    const suspicious = []
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) { walk(p); continue }
        if (!e.name.endsWith('.js')) continue
        const t = readFileSync(p, 'utf8')
        for (const m of t.matchAll(/from\s*["'](\.[^"']+)["']/g)) {
          const target = resolve(dirname(p), m[1])
          if (!existsSync(target)) suspicious.push(`${p.replace(HERE + '\\', '')} → ${m[1]}`)
        }
        for (const m of t.matchAll(/from\s*["'](three)["']/g)) suspicious.push(`${p.replace(HERE + '\\', '')} → 裸名 "three"（浏览器无法解析）`)
      }
    }
    for (const d of ['three', 'three-stdlib']) if (existsSync(join(HERE, d))) walk(join(HERE, d))
    for (const f of ['three-vrm.module.js', 'three-vrm-animation.module.js', 'three-vrm-core.module.js', 'three-vrm-materials-mtoon.module.js', 'three-vrm-node-constraint.module.js', 'three-vrm-springbone.module.js']) {
      const p = join(HERE, f)
      if (!existsSync(p)) continue
      const t = readFileSync(p, 'utf8')
      for (const m of t.matchAll(/from\s*["'](\.[^"']+)["']/g)) {
        const target = resolve(dirname(p), m[1])
        if (!existsSync(target)) suspicious.push(`${f} → ${m[1]}`)
      }
      for (const m of t.matchAll(/from\s*["'](three)["']/g)) suspicious.push(`${f} → 裸名 "three"`)
    }
    if (suspicious.length) return { ok: false, detail: `import 断链：\n    ${[...new Set(suspicious)].slice(0, 8).join('\n    ')}`, copied }
    return { ok: true, detail: `铺了 ${files.length + STDLIB.length} 个模块（其中 ${copied.length} 个做了裸名改写），import 链自检通过`, copied, dir: HERE }
  } catch (e) {
    return { ok: false, detail: e.message, copied }
  }
}

// ═════════════════════════════════════════════════ ① Electron + 真 WebGL

if (!SKIP_ELECTRON && existsSync(ELECTRON)) {
  summary.electron.attempted = true
  // ⚠ 先铺好模块目录。renderer.html 用相对路径 import：
  //     ./three/three.module.js   ./three-stdlib/loaders/GLTFLoader.js
  //     ./three-vrm.module.js     ./three-vrm-animation.module.js
  //   而 three-vrm*.module.js 内部 import 的是**裸 `three`**，
  //   所以 `three/` 子目录里必须有 package.json 指明入口。
  //   实测：不做这一步时页面顶层 import 直接失败，而且**页面什么都不报**，
  //   主进程只能等到超时（300s 白等）。
  const stage = ensureRendererModules()
  console.log(`[electron] 模块目录：${stage.ok ? '就绪' : '失败 → ' + stage.detail}`)
  summary.electron.modules = stage
  if (!stage.ok) summary.electron.detail = `模块目录准备失败：${stage.detail}`
  for (const vrma of targets) {
    const stem = basename(vrma).replace(/\.vrma$/, '')
    const cfgPath = join(OUT_DIR, `_electron-cfg.${stem}.json`)
    // 采样时刻：均匀覆盖整段（首尾各留一点，避免首帧与循环边界）
    const times = []
    // 先从 VRMA 里读时长（自己解析 GLB 的 accessor，不依赖转换器）
    let duration = 0
    try {
      const buf = readFileSync(vrma)
      const jl = buf.readUInt32LE(12)
      const g = JSON.parse(buf.subarray(20, 20 + jl).toString('utf8'))
      const s0 = g.animations?.[0]?.samplers?.[0]
      const a = g.accessors[s0.input]
      duration = a.max?.[0] ?? 0
    } catch { /* 留给下面的兜底 */ }
    if (!(duration > 0)) duration = 1
    for (let i = 0; i < FRAMES; i++) times.push(+((duration * i) / Math.max(1, FRAMES - 1) * 0.98).toFixed(4))

    writeFileSync(cfgPath, JSON.stringify({
      width: WIDTH, height: HEIGHT, view: VIEW, outDir: join(OUT_DIR, stem), fileStem: stem,
      keepMaterials: false, meshMode: MESH_MODE, hipsOriginMode: HIPS_ORIGIN, timeoutMs: TIMEOUT_MS, vrmPath: VRM_PATH, vrmaPath: vrma, times,
    }, null, 2), 'utf8')

    console.log(`[electron] ${stem} …`)
    const r = spawnSync(ELECTRON, [join(HERE, 'electron-main.cjs'), cfgPath], { encoding: 'utf8', timeout: TIMEOUT_MS + 60_000, windowsHide: true })
    const out = (r.stdout ?? '') + (r.stderr ?? '')
    const resultLine = out.split(/\r?\n/).find((l) => l.startsWith('[main] RESULT '))
    let info = null
    if (resultLine) { try { info = JSON.parse(resultLine.slice('[main] RESULT '.length)) } catch { /* ignore */ } }
    const ok = r.status === 0 && info?.ok === true
    if (ok) {
      anySuccess = true
      summary.electron.ok = true
      console.log(`[electron] ${stem}  OK  GL=${info.gl}  webgl2=${info.webgl2}  clip=${info.clip?.duration?.toFixed?.(3)}s/${info.clip?.tracks} 轨  PNG=${info.files} 张`)
      summary.electron.files.push({ stem, ok: true, gl: info.gl, webgl2: info.webgl2, clip: info.clip, pngs: info.files, json: info.json })
    } else {
      console.log(`[electron] ${stem}  FAIL  exit=${r.status}${info ? '  ' + JSON.stringify(info.errors ?? info) : ''}`)
      summary.electron.files.push({ stem, ok: false, exit: r.status, stdout: out.split(/\r?\n/).slice(-12).join('\n') })
    }
    summary.electron.detail = summary.electron.files.map((f) => `${f.stem}:${f.ok ? 'OK' : 'FAIL'}`).join(' ')
    try { writeFileSync(join(OUT_DIR, `_electron-cfg.${stem}.json.bak`), readFileSync(cfgPath)) } catch { /* ignore */ }
  }
} else if (!SKIP_ELECTRON) {
  summary.electron.detail = `electron.exe 不存在：${ELECTRON}`
  console.log(`[electron] 跳过：${ELECTRON} 不存在`)
}

// ═════════════════════════════════════════════════ ② SVG 骨骼投影（总是可用）

if (!SKIP_SVG) {
  console.log(`\n[svg] 生成骨骼投影正交视图（纯 Node，无 GPU 依赖）…`)
  // 复用 load-test 的 Node 垫片与真加载链路
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
  if (typeof globalThis.createImageBitmap === 'undefined') globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} })

  const load = async (rel) => import(pathToFileURL(resolve(MOD, rel)).href)
  let THREE, GLTFLoader, VRMLoaderPlugin, VRMAnimationLoaderPlugin, createVRMAnimationClip
  try {
    THREE = await load('three/build/three.module.js')
    ;({ GLTFLoader } = await load('three-stdlib/loaders/GLTFLoader.js'))
    ;({ VRMLoaderPlugin } = await load('three-vrm.module.js'))
    ;({ VRMAnimationLoaderPlugin, createVRMAnimationClip } = await load('three-vrm-animation.module.js'))
  } catch (e) {
    console.error(`[svg] 模块导入失败：${e.message}`)
    summary.svg.error = e.message
  }
  if (THREE) {
    function skeletonOnlyGlb(buf) {
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
      const head = Buffer.alloc(20)
      head.write('glTF', 0, 'ascii'); head.writeUInt32LE(2, 4)
      head.writeUInt32LE(12 + 8 + jb.length + rest.length, 8); head.writeUInt32LE(jb.length, 12); head.writeUInt32LE(0x4e4f534a, 16)
      return Buffer.concat([head, jb, rest])
    }
    const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
    const _w = console.warn, _e = console.error
    console.warn = () => {}; console.error = () => {}
    const vbuf = skeletonOnlyGlb(readFileSync(VRM_PATH))
    const gl = new GLTFLoader(); gl.register((p) => new VRMLoaderPlugin(p))
    const vrmGltf = await new Promise((res, rej) => gl.parse(ab(vbuf), '', res, rej))
    const vrm = vrmGltf.userData.vrm
    console.warn = _w; console.error = _e
    vrm.scene.updateWorldMatrix(true, true)

    const BONES = Object.keys(vrm.humanoid.humanBones)
    /** 骨骼连线（父 → 子），只画有意义的那些 */
    const LINKS = [
      ['hips', 'spine'], ['spine', 'chest'], ['chest', 'neck'], ['neck', 'head'],
      ['chest', 'leftShoulder'], ['leftShoulder', 'leftUpperArm'], ['leftUpperArm', 'leftLowerArm'], ['leftLowerArm', 'leftHand'],
      ['chest', 'rightShoulder'], ['rightShoulder', 'rightUpperArm'], ['rightUpperArm', 'rightLowerArm'], ['rightLowerArm', 'rightHand'],
      ['hips', 'leftUpperLeg'], ['leftUpperLeg', 'leftLowerLeg'], ['leftLowerLeg', 'leftFoot'], ['leftFoot', 'leftToes'],
      ['hips', 'rightUpperLeg'], ['rightUpperLeg', 'rightLowerLeg'], ['rightLowerLeg', 'rightFoot'], ['rightFoot', 'rightToes'],
    ]
    const KEY_BONES = new Set(['hips', 'head', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot', 'leftLowerLeg', 'rightLowerLeg', 'leftUpperArm', 'rightUpperArm'])

    const restPos = new Map(BONES.map((b) => [b, vrm.humanoid.getNormalizedBoneNode(b)?.position.clone() ?? null]))
    function hardReset() {
      for (const b of BONES) {
        const nd = vrm.humanoid.getNormalizedBoneNode(b); if (!nd) continue
        nd.quaternion.set(0, 0, 0, 1)
        const rp = restPos.get(b); if (rp) nd.position.copy(rp)
      }
      vrm.scene.updateWorldMatrix(true, true)
    }
    hardReset()

    /** 正交投影：选两个视角（正面 = 看 +Z 方向；侧面 = 看 -X 方向） */
    const PROJECTIONS = [
      { name: 'front', axis: (p) => [p.x, -p.y] },
      { name: 'side', axis: (p) => [p.z, -p.y] },
    ]
    const W = 320, H = 320, PAD = 34

    for (const vrma of targets) {
      const stem = basename(vrma).replace(/\.vrma$/, '')
      let vr
      try {
        const l = new GLTFLoader()
        l.register((p) => new VRMAnimationLoaderPlugin(p))
        const g = await new Promise((res, rej) => l.parse(ab(readFileSync(vrma)), '', res, rej))
        const va = g.userData.vrmAnimations?.[0]
        if (!va) throw new Error('未解析出 VRMAnimation')
        vr = { va, clip: createVRMAnimationClip(va, vrm) }
      } catch (e) {
        console.log(`[svg] ${stem}  FAIL 加载失败：${e.message}`)
        summary.svg.files.push({ stem, ok: false, error: e.message })
        continue
      }
      const duration = vr.clip.duration
      const times = []
      for (let i = 0; i < FRAMES; i++) times.push((duration * i) / Math.max(1, FRAMES - 1) * 0.98)

      const mixer = new THREE.AnimationMixer(vrm.scene)
      const action = mixer.clipAction(vr.clip); action.play()
      const panels = []
      const boneTrace = {}
      for (let fi = 0; fi < times.length; fi++) {
        mixer.setTime(times[fi])
        vrm.scene.updateWorldMatrix(true, true)
        const world = {}
        for (const b of BONES) {
          const nd = vrm.humanoid.getNormalizedBoneNode(b)
          if (!nd) continue
          const p = nd.getWorldPosition(new THREE.Vector3())
          world[b] = p
        }
        for (const b of KEY_BONES) if (world[b]) (boneTrace[b] ??= []).push({ t: +times[fi].toFixed(3), p: [+world[b].x.toFixed(4), +world[b].y.toFixed(4), +world[b].z.toFixed(4)] })
        // 所有帧共用一套缩放（否则各帧之间不可比）
        panels.push({ t: times[fi], world })
      }
      hardReset()

      // 统一包围盒
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      for (const p of panels) for (const b of Object.keys(p.world)) {
        const v = p.world[b]
        minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x)
        minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y)
        minX = Math.min(minX, v.z); maxX = Math.max(maxX, v.z)
      }
      const spanX = Math.max(maxX - minX, 0.4)
      const spanY = Math.max(maxY - minY, 0.4)
      const scale = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanY)
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2

      const svgPanel = (panel, proj) => {
        const to = (v) => {
          const [ax, ay] = proj.axis(v)
          // 用同一套中心与缩放，保证两个投影、所有帧可比
          const c = proj.name === 'front' ? cx : (minX + maxX) / 2
          return [W / 2 + (ax - c) * scale, H / 2 + (ay + cy) * scale]
        }
        const lines = LINKS.map(([a, b]) => {
          if (!panel.world[a] || !panel.world[b]) return ''
          const [x1, y1] = to(panel.world[a]), [x2, y2] = to(panel.world[b])
          const isLeg = /Leg|Foot|Toes/.test(a) || /Leg|Foot|Toes/.test(b)
          return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${isLeg ? '#7fd1ff' : '#ffd479'}" stroke-width="2.2" stroke-linecap="round"/>`
        }).join('')
        const dots = Object.keys(panel.world).filter((b) => KEY_BONES.has(b)).map((b) => {
          const [x, y] = to(panel.world[b])
          return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="#ffffff" opacity="0.85"/>`
        }).join('')
        // 地面参考线（y=0）
        const [, gy] = to(new THREE.Vector3(0, 0, 0))
        return `<g>${lines}${dots}<line x1="0" y1="${gy.toFixed(1)}" x2="${W}" y2="${gy.toFixed(1)}" stroke="#446" stroke-width="1" stroke-dasharray="4 4"/></g>`
      }

      for (const proj of PROJECTIONS) {
        const cols = Math.min(panels.length, 4)
        const rows = Math.ceil(panels.length / cols)
        const cw = W, ch = H
        const svgW = cols * cw, svgH = rows * ch + 26
        const body = panels.map((p, i) => {
          const gx = (i % cols) * cw, gy = Math.floor(i / cols) * ch
          return `<g transform="translate(${gx},${gy})">${svgPanel(p, proj)}<text x="6" y="14" fill="#9ab" font-size="12">t=${p.t.toFixed(2)}s</text></g>`
        }).join('')
        const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}">
<rect width="${svgW}" height="${svgH}" fill="#101014"/>
<text x="8" y="${svgH - 8}" fill="#7fd1ff" font-size="13">${stem} · ${proj.name} 正交投影 · 曲线=黄 腿=蓝 · ${duration.toFixed(3)}s · ${panels.length} 帧（数据来源：真 VRMAnimationLoaderPlugin + createVRMAnimationClip）</text>
${body}
</svg>`
        const outPath = join(OUT_DIR, `${stem}_${proj.name}.svg`)
        writeFileSync(outPath, svg, 'utf8')
        summary.svg.files.push({ stem, projection: proj.name, path: outPath, bytes: Buffer.byteLength(svg, 'utf8'), frames: panels.length, duration })
      }
      const tracePath = join(OUT_DIR, `${stem}_bonetrace.json`)
      writeFileSync(tracePath, JSON.stringify({ stem, vrma, duration, times, boneTrace }, null, 2), 'utf8')
      summary.svg.files.push({ stem, path: tracePath, kind: 'boneTrace', bytes: statSync(tracePath).size })
      summary.svg.ok = true
      anySuccess = true
      console.log(`[svg] ${stem}  OK  ${FRAMES} 帧 × 2 投影 → ${stem}_front.svg / ${stem}_side.svg + ${stem}_bonetrace.json`)
    }
  }
}

// ═════════════════════════════════════════════════ 汇总

console.log(`\n=== 汇总 ===`)
console.log(`Electron 真 WebGL : ${summary.electron.attempted ? (summary.electron.ok ? '至少一个文件成功' : '全部失败') : '未尝试'}  ${summary.electron.detail ?? ''}`)
console.log(`SVG 骨骼投影      : ${summary.svg.ok ? '成功' : '失败/未运行'}`)
const pngs = summary.electron.files.filter((f) => f.ok).reduce((a, f) => a + (f.pngs ?? 0), 0)
console.log(`产出 PNG          : ${pngs} 张`)
console.log(`产出 SVG          : ${summary.svg.files.filter((f) => f.path?.endsWith('.svg')).length} 个`)
console.log(`输出目录          : ${OUT_DIR}`)
console.log(anySuccess ? 'VERDICT: OK（至少一路成功）' : 'VERDICT: FAIL（两路都失败）')

const reportPath = join(OUT_DIR, '_contact-sheet-report.json')
writeFileSync(reportPath, JSON.stringify({ ...summary, verdict: anySuccess ? 'OK' : 'FAIL', pngCount: pngs }, null, 2), 'utf8')
console.log(`JSON 报告: ${reportPath}`)

if (has('--json')) console.log(JSON.stringify(summary, null, 2))
process.exit(anySuccess ? 0 : 1)
