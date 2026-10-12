/**
 * tools/qa/stage-dist.mjs —— 组装分发包载荷目录（`dist-package/`）
 *
 * 为什么需要"组装"这一步而不是让打包工具直接扫工作区：
 *   "我们认为会发布什么"必须是一份**可见、可复核的清单**，而不是散落在某个
 *   打包配置里的隐式行为。本脚本把它显式化：**加什么、为什么加、绝不加什么**，
 *   全部写在这一个文件里；随后 `scan-dist-payload.mjs` 只扫这个目录。
 *
 * 关键约束（来自本项目的许可现实）：
 *   · Mate Engine 是 MateEngine Pro License v2.1，DLC 资产**无独立许可**
 *     ⇒ **VRM / VRMA / .anim 一律不得进入载荷**（`FORBIDDEN` 会机械拦截）；
 *   · 载荷**不含完整的** `node_modules`：只显式携带内部 workspace 包与
 *     运行时第三方依赖，手写整棵依赖树既臃肿又难以审计；
 *   · 载荷**必须含** `THIRD-PARTY-NOTICES.md`（合规）。
 *
 * 用法：
 *   node tools/qa/stage-dist.mjs            # 组装并打印清单
 *   node tools/qa/stage-dist.mjs --clean    # 先清空 dist-package/
 * 退出码：0 = 成功；1 = 缺关键文件或命中禁用清单
 */
import { readdirSync, readFileSync, existsSync, statSync, mkdirSync, rmSync, copyFileSync, writeFileSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { createHash } from 'node:crypto'

const ROOT = process.cwd()
const OUT = join(ROOT, 'dist-package')
const clean = process.argv.includes('--clean')
/**
 * `--with-runtime`：把 Electron 运行时一并打进载荷，使载荷**可独立运行**。
 *
 * 为什么做成可选而不是默认：运行时约 367 MB，而绝大多数迭代只需要验证
 * "我们的产物对不对"。默认只装程序本体（1.8 MB），按需加运行时。
 *
 * ⚠ 但"完整安装包"**必须**带运行时 —— `install.ps1` 目前是从开发树复制
 * `electron.exe`，那只够演练，不是可交付的安装包。
 *
 * 许可：Electron 的 `LICENSE`（MIT）与 `LICENSES.chromium.html`（约 19.5 MB，
 * Chromium 及其它组件的许可汇编）**必须**随运行时一起分发 —— 它们本来就在
 * `node_modules/electron/dist/` 里，包含运行时即自动包含它们。
 */
const withRuntime = process.argv.includes('--with-runtime')

/** 载荷内容：源路径 → 在载荷里的相对路径 */
const INCLUDE = [
  { from: 'apps/desktop/dist/main', to: 'app/main', why: '主进程编译产物（入口）' },
  { from: 'apps/desktop/dist/preload', to: 'app/preload', why: 'preload（IPC 白名单唯一出口）' },
  { from: 'apps/renderer/dist', to: 'app/renderer', why: 'renderer 打包产物' },
  { from: 'packages/shared/dist', to: 'app/node_modules/@airimate/shared/dist', why: '共享契约（主进程 require）' },
  { from: 'packages/security/dist', to: 'app/node_modules/@airimate/security/dist', why: '安全工具（主进程 require）' },
  {
    from: 'node_modules/zod',
    to: 'app/node_modules/zod',
    why: '共享契约运行时依赖（@airimate/shared 直接 import）',
    filter: (rel) => {
      const normalized = rel.split('\\').join('/')
      if (normalized === 'package.json' || normalized === 'LICENSE') return true
      if (normalized === 'index.cjs' || normalized === 'index.js') return true
      return /^v3\/.+\.(?:cjs|js)$/.test(normalized)
    },
  },
  /**
   * ⚠ 适配层框架也必须在载荷里：它是 `@airimate/desktop` 的**直接依赖**
   * （`capabilities/index.ts` 里 import 了它）。
   * 漏掉它的后果是**装机后直接起不来**（`Cannot find module '@airimate/companion-kit'`）——
   * 而开发树里因为 npm workspaces 的软链，永远发现不了这个缺失。
   * 这类"开发能跑、装了就跑不起来"的缺口，只能靠载荷清单逐条对齐依赖。
   */
  { from: 'packages/companion-kit/dist', to: 'app/node_modules/@airimate/companion-kit/dist', why: '适配层框架（主进程 require）' },
  { from: 'package.json', to: 'app/package.json', why: '包元数据' },
  { from: 'THIRD-PARTY-NOTICES.md', to: 'THIRD-PARTY-NOTICES.md', why: '第三方许可声明（合规必需）' },
  { from: 'README.md', to: 'README.md', why: '使用说明' },
]

/**
 * 运行时（仅 `--with-runtime`）：Electron 本体 + 它自己的许可文件。
 * 一并带上 `assets/`：角色的绝对路径在 `catalog.json` 里，而 `app://model/` 的授权根
 * 由它推出 —— 少了 assets 目录，应用起来后找不到模型。
 */
const RUNTIME_INCLUDE = [
  { from: 'node_modules/electron/dist/electron.exe', to: 'AiriMateOne.exe', why: '可执行文件（安装时改名为 AiriMateOne.exe）' },
  { from: 'node_modules/electron/dist/LICENSE', to: 'LICENSE', why: 'Electron 自身许可（MIT）—— 分发必需' },
  { from: 'node_modules/electron/dist/LICENSES.chromium.html', to: 'LICENSES.chromium.html', why: 'Chromium 及组件许可汇编 —— 分发必需' },
  { from: 'node_modules/electron/dist/icudtl.dat', to: 'icudtl.dat', why: 'ICU 数据（文本/编码）' },
  { from: 'node_modules/electron/dist/resources.pak', to: 'resources.pak', why: 'Chromium 资源包' },
  { from: 'node_modules/electron/dist/chrome_100_percent.pak', to: 'chrome_100_percent.pak', why: '界面资源（100%）' },
  { from: 'node_modules/electron/dist/chrome_200_percent.pak', to: 'chrome_200_percent.pak', why: '界面资源（200%，高分屏）' },
  { from: 'node_modules/electron/dist/snapshot_blob.bin', to: 'snapshot_blob.bin', why: 'V8 快照' },
  { from: 'node_modules/electron/dist/v8_context_snapshot.bin', to: 'v8_context_snapshot.bin', why: 'V8 上下文快照' },
  { from: 'node_modules/electron/dist/ffmpeg.dll', to: 'ffmpeg.dll', why: '媒体解码' },
  { from: 'node_modules/electron/dist/vulkan-1.dll', to: 'vulkan-1.dll', why: '图形后端' },
  { from: 'node_modules/electron/dist/vk_swiftshader.dll', to: 'vk_swiftshader.dll', why: '软件 Vulkan 回退' },
  { from: 'node_modules/electron/dist/vk_swiftshader_icd.json', to: 'vk_swiftshader_icd.json', why: '软件 Vulkan 配置' },
  { from: 'node_modules/electron/dist/d3dcompiler_47.dll', to: 'd3dcompiler_47.dll', why: 'D3D 着色器编译' },
  { from: 'node_modules/electron/dist/dxcompiler.dll', to: 'dxcompiler.dll', why: 'DirectX 着色器编译' },
  { from: 'node_modules/electron/dist/dxil.dll', to: 'dxil.dll', why: 'DirectX 中间语言' },
  { from: 'node_modules/electron/dist/locales', to: 'locales', why: '界面语言包（zh-CN 等）' },
  { from: 'node_modules/electron/dist/resources', to: 'resources', why: 'Electron 默认资源（default_app.asar 等）' },
  { from: 'node_modules/electron/dist/version', to: 'version', why: '运行时版本标识' },
  {
    from: 'assets',
    to: 'workspace/assets',
    why: '动作清单与模型路径引用（**刻意排除 .vrma/.anim/.vrm —— 那是 Mate 的资产，许可不允许再分发**）',
    /**
     * ⚠ 必须过滤：`assets/motion/` 下有 16 个 `.vrma`（由 Mate 的 .anim 转出），
     * 另有一批 `.bak`。整目录复制会把它们带进载荷 —— `FORBIDDEN` 会拦截，
     * 但失败原因看起来像"禁用清单命中"，容易误判成"规则太严"。
     * 真正需要的只有 **sidecar 清单**（描述每个动作的元数据）与 `catalog.json`
     * （模型的**路径引用**，不是模型本身）。
     */
    filter: (rel) => {
      const lower = rel.toLowerCase()
      if (lower.endsWith('.vrma') || lower.endsWith('.anim') || lower.endsWith('.vrm')) return false
      if (lower.endsWith('.bak')) return false
      return true
    },
  },
]

/**
 * 禁用清单：**任何**匹配项一旦出现在载荷里就报错。
 * 每一条都对应一次真实风险，而不是"顺手加上的规则"。
 */
const FORBIDDEN = [
  { re: /\.vrm$/i, why: 'VRM 角色资产：Mate DLC 无独立许可，不得再分发' },
  { re: /\.vrma$/i, why: 'VRMA 动作资产：由 Mate 的 .anim 转出，权利人未授予再分发' },
  { re: /\.anim$/i, why: 'Mate 原始动捕资产：同上' },
  { re: /\.map$/i, why: 'sourcemap 含未压缩原始源码，会暴露实现细节' },
  { re: /(^|\/)docs(\/|$)/i, why: '文档与证据（含机器信息/截图）不进载荷' },
  { re: /(^|\/)tools(\/|$)/i, why: 'QA 工具不进载荷（部分会暴露调试入口）' },
  { re: /\.env/i, why: '环境文件可能含密钥' },
  { re: /\.log$/i, why: '日志' },
  { re: /\.jsonl$/i, why: '采样数据' },
  { re: /(^|\/)secrets?(\/|$)/i, why: '密钥目录' },
  { re: /\.pdb$/i, why: '调试符号' },
  { re: /\.tsbuildinfo$/i, why: '构建缓存' },
]

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir) } catch { return out }
  for (const name of entries) {
    const full = join(dir, name)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) walk(full, out)
    else out.push({ path: full, size: st.size })
  }
  return out
}

if (clean && existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const copied = []
const missing = []

const ACTIVE_INCLUDE = withRuntime ? [...INCLUDE, ...RUNTIME_INCLUDE] : INCLUDE
for (const item of ACTIVE_INCLUDE) {
  const src = join(ROOT, item.from)
  if (!existsSync(src)) { missing.push({ ...item, reason: '源路径不存在（先跑 npm run build）' }); continue }
  const st = statSync(src)
  if (st.isDirectory()) {
    for (const f of walk(src)) {
      const rel = relative(src, f.path)
      // 逐项过滤（见 RUNTIME_INCLUDE 里 assets 那条的注释：必须排除 Mate 的资产）
      if (typeof item.filter === 'function' && !item.filter(rel.split('\\').join('/'))) continue
      const dest = join(OUT, item.to, rel)
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(f.path, dest)
      copied.push({ rel: relative(OUT, dest).split('\\').join('/'), size: f.size, why: item.why })
    }
  } else {
    const dest = join(OUT, item.to)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(src, dest)
    copied.push({ rel: relative(OUT, dest).split('\\').join('/'), size: st.size, why: item.why })
  }
}

const violations = []
for (const c of copied) {
  for (const rule of FORBIDDEN) {
    if (rule.re.test(c.rel)) violations.push({ rel: c.rel, why: rule.why })
  }
}

/**
 * 改写 `app/package.json`，让载荷**真的能启动**。
 *
 * 为什么必须这一步（实测暴露）：源 `package.json` 的 `main` 写的是
 * `dist/main/index.js`，而载荷内主进程在 `app/main/index.js` ——
 * 直接照搬会得到一个"装好了但起不来"的包，而且报错信息（找不到入口）
 * 与应用自身的日志无关，排查时要绕一圈。发布物应当在**组装阶段**就自洽。
 *
 * 同时顺手做三件事：
 *   · 去掉 `scripts` 与 `devDependencies`：载荷里没有构建工具，留着 `postinstall`
 *     会让"装完 npm 顺手装一遍依赖"这类操作在无网环境下失败；
 *   · 去掉 `workspaces`：载荷不是 monorepo，留着会让人以为要 `npm install`；
 *   · 保留 `name` / `version` / `description` / `private` / `main` / `dependencies`，
 *     它们是运行期真正用到的（`app.getName()`、Electron 的入口解析）。
 */
const appPkgPath = join(OUT, 'app', 'package.json')
let appPkgRewrite = null
if (existsSync(appPkgPath)) {
  try {
    const src = JSON.parse(readFileSync(appPkgPath, 'utf8'))
    const stripped = []
    for (const k of ['scripts', 'devDependencies', 'workspaces', 'files', 'engines']) {
      if (k in src) { delete src[k]; stripped.push(k) }
    }
    const before = src.main
    src.main = 'main/index.js'
    appPkgRewrite = { mainBefore: before, mainAfter: src.main, strippedKeys: stripped }
    writeFileSync(appPkgPath, `${JSON.stringify(src, null, 2)}\n`, 'utf8')
    // 改写后大小会变，同步 MANIFEST 里的记录
    const rec = copied.find(c => c.rel === 'app/package.json')
    if (rec) rec.size = statSync(appPkgPath).size
  } catch (e) {
    appPkgRewrite = { error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 自洽性检查：载荷必须**自己能启动**。
 *
 * 为什么要把这件事机械化（实测暴露）：源 `package.json` 的 `main` 写的是
 * `dist/main/index.js`，而载荷内主进程在 `app/main/index.js` ——
 * 照搬会得到一个"装好了但起不来"的包。这类问题的报错（找不到入口）
 * 与应用自身的日志完全无关，排查时要绕一圈才会想到"是路径没改写"。
 *
 * 检查四件事，都是"启动必需、且在组装阶段就能判定"的：
 *   ① `main` 指向真实存在的文件；
 *   ② 该文件能被解析为合法 JS（catch 语法/编码类问题）；
 *   ③ preload 在位（`contextBridge` 白名单是 renderer 的唯一出口）；
 *   ④ renderer 产物在位。
 */
const selfCheck = {
  main: null,
  mainExists: false,
  mainParses: false,
  preloadExists: false,
  rendererExists: false,
  runtimeDependency: null,
  runtimeDependencyResolvable: false,
  problems: [],
}
try {
  const pkgPath = join(OUT, 'app', 'package.json')
  if (!existsSync(pkgPath)) { selfCheck.problems.push('缺少 app/package.json') }
  else {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    selfCheck.main = pkg.main ?? null
    if (!pkg.main) { selfCheck.problems.push('package.json 没有 main 字段') }
    else {
      const entry = join(OUT, 'app', pkg.main)
      selfCheck.mainExists = existsSync(entry)
      if (!selfCheck.mainExists) { selfCheck.problems.push(`main 指向的文件不存在：app/${pkg.main}`) }
      else {
        try {
          // 只做语法解析、不执行（执行需要 electron 运行时）
          const vm = await import('node:vm')
          new vm.Script(readFileSync(entry, 'utf8'), { filename: entry })
          selfCheck.mainParses = true
        } catch (e) {
          selfCheck.problems.push(`入口无法解析：${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
  }
  selfCheck.preloadExists = existsSync(join(OUT, 'app', 'preload', 'index.js'))
  selfCheck.rendererExists = existsSync(join(OUT, 'app', 'renderer', 'index.html'))
  if (!selfCheck.preloadExists) selfCheck.problems.push('缺少 app/preload/index.js')
  if (!selfCheck.rendererExists) selfCheck.problems.push('缺少 app/renderer/index.html')

  const zodPackagePath = join(OUT, 'app', 'node_modules', 'zod', 'package.json')
  if (!existsSync(zodPackagePath)) {
    selfCheck.problems.push('缺少运行期依赖：app/node_modules/zod/package.json')
  } else {
    try {
      const zodPackage = JSON.parse(readFileSync(zodPackagePath, 'utf8'))
      const { createRequire } = await import('node:module')
      const requireFromApp = createRequire(join(OUT, 'app', 'package.json'))
      requireFromApp.resolve('zod')
      selfCheck.runtimeDependency = { id: 'zod', version: zodPackage.version, resolvable: true }
      selfCheck.runtimeDependencyResolvable = true
    } catch (e) {
      selfCheck.runtimeDependency = {
        id: 'zod',
        version: null,
        resolvable: false,
        error: e instanceof Error ? e.message : String(e),
      }
      selfCheck.problems.push(`运行期依赖无法解析：zod（${e instanceof Error ? e.message : String(e)}）`)
    }
  }
} catch (e) {
  selfCheck.problems.push(e instanceof Error ? e.message : String(e))
}

const totalBytes = copied.reduce((a, c) => a + c.size, 0)

/**
 * ★ 完整性校验（本轮新增）：给**每个**载荷文件记 sha256，并合成一个总摘要。
 *
 * 为什么要在这里做（而不是"以后加签名"）：
 *   外部复核实测 `MANIFEST.json` **一个 `sha*` / `checksum` / `hash` / `digest` 字段都没有**，
 *   只有 `{rel, size}` —— 于是"传输中损坏"与"被塞进一个同大小的文件"这两件事
 *   **都发现不了**；`scan-dist-payload.mjs` 只能扫内容特征，不能证明"这份载荷就是那份载荷"。
 *
 * 三条纪律：
 *   ① 在**所有改写完成之后**才算哈希 —— `app/package.json` 会被本脚本改写过
 *      （`main` 字段重写），先算就等于给一个不存在的版本签名；
 *   ② 用**正斜杠相对路径**作为 key，与 MANIFEST 里其它位置同一口径（Windows 反斜杠会破坏可比性）；
 *   ③ 总摘要由"排序后的 `rel\0sha256` 列表"哈希而成 ⇒ **可复现**：
 *      同一份载荷无论用什么顺序遍历，digest 都相同（`readdirSync` 顺序不保证稳定）。
 */
const sha256Of = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

const fileHashes = copied.map(c => ({ rel: c.rel, sha256: sha256Of(join(OUT, c.rel)) }))
const digestInput = [...fileHashes]
  .sort((a, b) => a.rel.localeCompare(b.rel))
  .map(h => `${h.rel}\0${h.sha256}`)
  .join('\n')
const payloadDigest = createHash('sha256').update(digestInput, 'utf8').digest('hex')

const manifest = {
  schema: 'airimate/dist-package-manifest/2',
  stagedAt: new Date().toISOString(),
  outDir: relative(ROOT, OUT).split('\\').join('/'),
  fileCount: copied.length,
  totalMB: Number((totalBytes / 1048576).toFixed(2)),
  missingSources: missing,
  forbiddenViolations: violations,
  withRuntime,
  includeRules: ACTIVE_INCLUDE.map(i => ({ from: i.from, to: i.to, why: i.why })),
  appPackageRewrite: appPkgRewrite,
  selfCheck,
  /**
   * 载荷总摘要（**判据**）：`sha256(排序后的 "rel\0sha256" 列表)`。
   * 复算方式见 `tools/qa/verify-dist-integrity.mjs`（它同时复算每文件哈希）。
   */
  payloadDigest,
  digestAlgorithm: 'sha256',
  files: copied.map(c => {
    const h = fileHashes.find(x => x.rel === c.rel)
    return { rel: c.rel, size: c.size, sha256: h ? h.sha256 : null }
  }),
}
writeFileSync(join(OUT, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

console.log(`[stage] 载荷目录：${manifest.outDir}  文件 ${manifest.fileCount} 个，${manifest.totalMB} MB`)
console.log(`[stage] 完整性：已记录 ${fileHashes.length} 个 sha256；payloadDigest=${payloadDigest.slice(0, 16)}…（复算：node tools/qa/verify-dist-integrity.mjs）`)
for (const i of INCLUDE) console.log(`  ${i.from}  ->  ${i.to}   — ${i.why}`)
console.log(`[stage] 自洽性：main=${selfCheck.main} 存在=${selfCheck.mainExists} 可解析=${selfCheck.mainParses} preload=${selfCheck.preloadExists} renderer=${selfCheck.rendererExists}`)
console.log(`[stage] 运行期依赖：zod=${selfCheck.runtimeDependencyResolvable ? `resolvable (${selfCheck.runtimeDependency?.version})` : 'unresolved'}`)
if (missing.length) {
  console.log('')
  console.log(`✗ 缺少 ${missing.length} 个源路径：`)
  for (const m of missing) console.log(`   ${m.from}  — ${m.reason}`)
}
if (violations.length) {
  console.log('')
  console.log(`✗ 禁用清单命中 ${violations.length} 条：`)
  for (const v of violations.slice(0, 20)) console.log(`   ${v.rel}  — ${v.why}`)
}
if (selfCheck.problems.length) {
  console.log('')
  console.log(`✗ 载荷不自洽（装了也起不来）${selfCheck.problems.length} 条：`)
  for (const p of selfCheck.problems) console.log(`   ${p}`)
}
const pass = missing.length === 0 && violations.length === 0 && copied.length > 0 && selfCheck.problems.length === 0
console.log('')
console.log(pass ? '[stage] PASS' : '[stage] FAIL')
process.exit(pass ? 0 : 1)
