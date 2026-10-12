/**
 * tools/qa/probe-visible-window.mjs
 *
 * 对照实验：把 motion-lab 里**已证明能出图**的那条渲染链，放进一个**可见窗口**里跑，
 * 并对页面内的 WebGL 画布做"拷到 2D canvas 再取像素"的呈现探针。
 *
 * 为什么要做这个（本轮取证）：
 *   应用（AiriMate One）里已经证明：
 *     · `drawCalls=24`、`triangles=130235`（绘制提交了）；
 *     · `canvasNonBgRatio = 1`（**WebGL 帧缓冲回读**整片非背景色 ⇒ 角色画进缓冲了）；
 *     · 屏幕像素探针在同一块区域只看到**一整片均匀清屏色**。
 *   ⇒ 问题在"画布内容 → 屏幕"的呈现层。这个脚本用一条**独立的、已出图的**链
 *     在同样的可见窗口条件下复现，从而把差异面缩到"窗口/会话配置"或"页面配置"二者之一。
 *
 * 用法：
 *   node tools/qa/probe-visible-window.mjs [--mesh-mode bones|flat|original] [--frames 2]
 * 产物：
 *   assets/motion/contact-sheets/_probe-visible/<stem>_visible-copy.png
 *   assets/motion/contact-sheets/_probe-visible/<stem>_render.json
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const LAB = join(ROOT, 'tools', 'motion-lab')
const ELECTRON = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const OUT_DIR = join(ROOT, 'assets', 'motion', 'contact-sheets', '_probe-visible')
const VRM_PATH = 'F:\\deepseek harness\\AI女友\\repos\\Mate-Engine\\Assets\\MATE ENGINE - Avatar\\DLCs\\Lazuli_VRM.vrm'

const argv = process.argv.slice(2)
const valOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const MESH_MODE = valOf('--mesh-mode', 'bones')
const FRAMES = Number(valOf('--frames', '2'))
const VRMA = resolve(valOf('--vrma', join(ROOT, 'assets', 'motion', 'idle_pet_idle.vrma')))

function fail(msg, code = 2) {
  console.error(`[probe] ${msg}`)
  process.exit(code)
}

if (!existsSync(ELECTRON)) fail(`找不到 Electron：${ELECTRON}`)
if (!existsSync(VRM_PATH)) fail(`找不到角色模型：${VRM_PATH}`)
if (!existsSync(VRMA)) fail(`找不到动作：${VRMA}`)
mkdirSync(OUT_DIR, { recursive: true })

// renderer.html 用相对路径 import，模块目录必须铺好（否则页面顶层 import 直接失败且不报错）
const modules = ['three', 'three-stdlib', 'three-vrm.module.js', 'three-vrm-animation.module.js',
  'three-vrm-core.module.js', 'three-vrm-materials-mtoon.module.js', 'three-vrm-springbone.module.js',
  'three-vrm-node-constraint.module.js']
const missing = modules.filter(m => !existsSync(join(LAB, m)))
if (missing.length) fail(`motion-lab 模块目录不完整，缺：${missing.join(', ')}（先跑一次 render-contact-sheet.mjs 让它自动铺好）`)

const stem = basename(VRMA).replace(/\.vrma$/, '')
const cfgPath = join(OUT_DIR, `_probe-cfg.${stem}.json`)

// 从 VRMA 自己读时长（不依赖转换器）
let duration = 1
try {
  const buf = readFileSync(VRMA)
  const jl = buf.readUInt32LE(12)
  const g = JSON.parse(buf.subarray(20, 20 + jl).toString('utf8'))
  const s0 = g.animations?.[0]?.samplers?.[0]
  const a = g.accessors?.[s0?.input ?? 0]
  duration = a?.max?.[0] ?? 1
} catch { /* 用兜底 */ }
const times = []
for (let i = 0; i < Math.max(1, FRAMES); i++) times.push(+((duration * i) / Math.max(1, FRAMES - 1) * 0.98).toFixed(4))

writeFileSync(cfgPath, JSON.stringify({
  width: 641, height: 641, view: 'three-quarter',
  outDir: OUT_DIR, fileStem: `${stem}.visible`,
  keepMaterials: false, meshMode: MESH_MODE, hipsOriginMode: 'relative',
  timeoutMs: 120000, vrmPath: VRM_PATH, vrmaPath: VRMA, times,
  // ── 本探针的两个关键开关
  showWindow: true,
  probeVisible: true,
}, null, 2), 'utf8')

console.log(`[probe] 起可见窗口跑已验证的渲染链：meshMode=${MESH_MODE} vrma=${stem} cfg=${cfgPath}`)
const r = spawnSync(ELECTRON, [join(LAB, 'electron-main.cjs'), cfgPath], {
  encoding: 'utf8', timeout: 180_000, windowsHide: true,
})
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
for (const line of out.split(/\r?\n/)) {
  if (line.includes('[probe') || line.includes('[main] RESULT') || line.includes('呈现探针') || line.includes('RESULT')) console.log(line)
}
const resultLine = out.split(/\r?\n/).find(l => l.startsWith('[main] RESULT '))
if (!resultLine) {
  console.error('[probe] 未拿到 RESULT 行；原始输出尾部：')
  console.error(out.split(/\r?\n/).slice(-15).join('\n'))
  process.exit(3)
}
let info = null
try { info = JSON.parse(resultLine.slice('[main] RESULT '.length)) } catch { /* ignore */ }
console.log(`[probe] VERDICT ok=${info?.ok} gl=${info?.gl} clipTracks=${info?.clip?.tracks} probe=${JSON.stringify(info?.probe ?? null)}`)
process.exit(info?.ok ? 0 : 4)
