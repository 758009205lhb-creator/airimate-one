/**
 * tools/qa/scan-dist-payload.mjs —— 分发包载荷扫描（A17 的**第 5 个扫描面**）
 *
 * 为什么单做这一面：此前的密钥扫描（`secret-audit.mjs`）扫的是**工作区**。
 * 但"工作区干净"**不等于**"分发包干净"，两者差在三处：
 *   ① 工作区里被 `.gitignore` 的开发产物、证据截图、日志**不会**进分发；
 *   ② 分发里的**打包产物是另一个形态**（minify 后的 bundle、sourcemap 里的原始源码），
 *      工作区扫描看的是源码，看不到"打包后是否把某段密钥带进去了"；
 *   ③ 分发还有一份**额外清单**要求：许可声明、不含绝对路径、不含开发调试开关。
 *
 * 本脚本的做法：**只扫 `dist-package/`** —— 那是 `stage-dist.mjs` 按显式清单
 * 组装出来的发布载荷。载荷清单的定义**只有一处**（组装脚本），
 * 这样"扫描范围"与"发布范围"不会各自漂移（各自漂移的扫描等于没扫）。
 *
 * ⚠ 本项目的现实约束（必须写清，否则脚本会给人虚假的安全感）：
 *   由于 Mate Engine 的许可（MateEngine Pro License v2.1）与 DLC 资产无独立许可，
 *   **VRM / VRMA / .anim 不允许随分发一起给出**。因此本项目当前只做**私有自用**构建，
 *   真正的对外分发包尚未产出。本脚本扫描的是"**将要**发布的那批文件"（构建产物 + 文档），
 *   并把"资产不在载荷内"这件事作为一条**显式检查**（资产一旦被误加入就要报错）。
 *
 * 用法：
 *   node tools/qa/scan-dist-payload.mjs
 *   node tools/qa/scan-dist-payload.mjs --json docs\evidence\phase7\A17-dist-payload.json
 * 退出码：0 = 无问题；1 = 有命中或清单异常（**不静默成功**）
 *
 * ★ 关于"完整性/哈希"（2026-10-03 补）：
 *   本脚本扫的是**内容特征**（密钥 / 禁用清单 / 开发开关），它**不能**回答
 *   "这份载荷还是不是当初组装的那份" —— 那是**摘要**的职责，不是扫描的职责。
 *   所以哈希校验**刻意不塞进本文件**，而是由 `tools/qa/verify-dist-integrity.mjs`
 *   单独负责（逐文件 sha256 + 总摘要复算）。
 *   `npm run build:dist` 会把两者**串联**跑：
 *     `stage-dist.mjs` → `scan-dist-payload.mjs`（内容） → `verify-dist-integrity.mjs`（完整性）
 *   单独跑本脚本（不带完整性那关）时请自知：**它不覆盖"文件被换掉/损坏"这一类问题**。
 */
import { readdirSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, extname } from 'node:path'

const ROOT = process.cwd()
const args = process.argv.slice(2)
const jsonIdx = args.indexOf('--json')
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null

/**
 * 载荷清单：**我们要发布的到底是哪些文件**。
 *
 * ⚠ 扫描目标是 `tools/qa/stage-dist.mjs` **组装出来的 `dist-package/`**，
 * 不是工作区里的 `dist/` —— 这是刻意的：工作区里还留着开发构建（带 sourcemap）
 * 与一堆不发布的东西，直接扫工作区会把"开发产物"误当成"发布产物"。
 * 组装脚本显式定义了"加什么、为什么加、绝不加什么"，本脚本只扫它的输出。
 */
const PAYLOAD_ROOT = join(ROOT, 'dist-package')

/** 明确**不得**进入载荷的东西（每一条都对应一次真实风险） */
const FORBIDDEN_IN_PAYLOAD = [
  {
    /**
     * ⚠ 规则必须**精确**：载荷里 `app/node_modules/@airimate/*` 是**刻意**放进去的
     * （主进程要 `require` 这两个内部包），所以不能一看到 `node_modules` 就报错。
     * 这里只拦"工作区里的依赖树被整棵复制进来"这一件事 ——
     * 那种载荷既臃肿，又无法审计（几百个包全在里面）。
     */
    pattern: /^node_modules\//,
    why: '整棵依赖树不得手写进载荷（会臃肿且无法审计）；内部包按需放在 app/node_modules/@airimate/ 下',
  },
  { pattern: /\.vrm$/i, why: 'VRM 角色资产：Mate Engine DLC 无独立许可 ⇒ 不得随分发给出' },
  { pattern: /\.vrma$/i, why: 'VRMA 动作资产：由 Mate 的 .anim 转出，权利人未授予再分发' },
  { pattern: /\.anim$/i, why: 'Mate 原始动捕资产：同上' },
  /**
   * ★ 下列是**适配层允许、但本源构建不允许**的资产格式。
   *
   * 为什么现在就要拦：M5 §3 要求商业版替换为"允许再分发与商用的 VRM、动作、语音与模型资产"。
   * 替换后这些格式会**合法出现**在载荷里 —— 但那是**另一个构建**（不同许可、不同资产清单）。
   * 保留拦截的意义是：**本源构建绝不允许悄悄混入资产文件**，
   * 而合法的商业载荷必须显式改这份清单（改一次 = 一次有意识的许可决策，
   * 而不是"某次构建顺手带进去了"）。判定逻辑在 `companion-kit` 的 `judgeLicense()`。
   */
  { pattern: /\.(glb|gltf)$/i, why: 'GLB/GLTF 角色或动作资产：本源构建不含（商业版需显式替换清单并确认许可）' },
  { pattern: /\.(fbx|bvh)$/i, why: 'FBX/BVH 动作资产：同上' },
  { pattern: /\.(onnx|gguf|safetensors)$/i, why: '模型权重文件：体积大且许可需逐条确认，不得混入' },
  /**
   * ⚠ `.bin` 必须**排除 Electron 运行时自带的 V8 快照**。
   *
   * 实测踩到：规则写成 `\.bin$` 时，`snapshot_blob.bin` 与 `v8_context_snapshot.bin`
   * 被判成"模型权重"，把一次本来正常的组装打成了 FAIL —— 而这两份是**必需的运行时文件**
   * （删了应用直接起不来）。假阳性比漏报更糟：它会让人把这条检查当噪声整体忽略。
   * 所以这里改成"排除已知的合法 .bin，其余一律拦"。
   */
  {
    pattern: /\.bin$/i,
    except: /^(snapshot_blob|v8_context_snapshot)\.bin$/i,
    why: '二进制权重/模型文件：许可需逐条确认，不得混入（Electron 自身的 V8 快照已排除）',
  },
  { pattern: /\.(wav|mp3|ogg|flac)$/i, why: '语音包：许可需逐条确认（当前使用系统 SAPI，不分发语音资产）' },
  { pattern: /^docs\//, why: '验收证据（含截图与机器信息）不进分发' },
  { pattern: /^tools\//, why: 'QA 工具不进分发（部分会暴露调试入口）' },
  { pattern: /\.map$/, why: 'sourcemap 含**原始源码**，会把未压缩实现暴露并可能带入注释里的内部信息' },
  { pattern: /(^|\/)\.env/i, why: '环境文件可能含密钥' },
  { pattern: /\.log$/i, why: '日志文件' },
  { pattern: /\.jsonl$/i, why: '采样/日志数据' },
  { pattern: /(^|\/)secrets?(\/|$)/i, why: '密钥目录' },
  { pattern: /\.pdb$/i, why: '调试符号' },
]

/** 密钥特征（与 secret-audit.mjs 保持同一套判据，避免两处口径不一致） */
const SECRET_PATTERNS = [
  { id: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g, note: 'OpenAI 风格密钥' },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, note: 'Anthropic 密钥' },
  { id: 'deepseek-key', re: /\bsk-[a-f0-9]{32}\b/g, note: 'DeepSeek 风格密钥' },
  { id: 'google-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, note: 'Google API key' },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, note: 'GitHub token' },
  { id: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g, note: 'AWS access key id' },
  { id: 'bearer', re: /\bBearer\s+[A-Za-z0-9._-]{30,}/g, note: 'Bearer 令牌' },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, note: 'JWT' },
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, note: '私钥' },
]
/** 允许列表：命中这些上下文的不算泄漏（自检/测试用的假值） */
const ALLOWLIST = [
  /sk-airimate-[a-z]*probe/i,
  /notarealkey/i,
  /invalid/i,
  /example/i,
  /placeholder/i,
  /xxxx/i,
  /your[-_]?api[-_]?key/i,
]

/**
 * 不该出现在分发产物里的东西。
 *
 * ⚠ 这里刻意**不**把 `--dev-server` 当问题：它只是 CLI 的一个**参数名**
 * （`valueOf('--dev-server')`），载荷里没有硬编码地址、也没有 localhost。
 * 把"参数名里带 dev"当成缺陷是**假阳性**，而假阳性会让这条检查被忽略掉 ——
 * 那比没有检查更糟。真正该查的是下面三条：硬编码地址、开发专用全局、构建机绝对路径。
 */
const DEV_MARKERS = [
  { pattern: /localhost:\d{4,5}/, why: '硬编码的本地端口' },
  { pattern: /127\.0\.0\.1:\d{4,5}/, why: '硬编码的回环地址端口' },
  { pattern: /VITE_DEV|import\.meta\.env\.DEV\b/, why: '开发专用构建期变量被带进产物' },
  {
    /**
     * 构建机绝对路径：会把**开发者的用户名与目录结构**泄露到分发包里。
     * 本机工作区路径含中文与空格（`F:\deepseek harness\AI女友\新工程`），
     * 一旦被打进产物，既是隐私问题也是"在别人机器上必然失效"的隐患。
     */
    pattern: /[A-Za-z]:[\\/](?:Users|deepseek|Projects)[\\/][^\s"']{0,80}/,
    why: '构建机绝对路径（泄露用户名/目录结构，且在他人机器上无效）',
  },
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

/**
 * 载荷 = `dist-package/` 下的**全部文件**（由 stage-dist.mjs 组装）。
 * 这里不再自己展开 glob：载荷清单的定义只应有一处（组装脚本），
 * 否则"扫描范围"与"发布范围"会各自漂移，扫描就失去意义。
 */
function collectPayload() {
  if (!existsSync(PAYLOAD_ROOT)) return null
  return walk(PAYLOAD_ROOT)
}

const collected = collectPayload()
if (collected === null) {
  console.error(`[dist-scan] 载荷目录不存在：${PAYLOAD_ROOT}`)
  console.error('[dist-scan] 请先运行：node tools/qa/stage-dist.mjs --clean')
  console.error('[dist-scan] 注意：本脚本**不**直接扫工作区 —— 工作区里还有开发构建（带 sourcemap）')
  console.error('[dist-scan]       与不发布的东西，直接扫会把"开发产物"误判成"发布产物"。')
  process.exit(1)
}
const payload = collected.sort((a, b) => a.path.localeCompare(b.path))

const hits = []
const forbiddenHits = []
const devMarkerHits = []
let bytes = 0
const scanned = []

for (const f of payload) {
  const rel = relative(PAYLOAD_ROOT, f.path).split('\\').join('/')
  bytes += f.size

  // ① 禁用清单
  for (const rule of FORBIDDEN_IN_PAYLOAD) {
    if (!rule.pattern.test(rel)) continue
    /**
     * `except` 是**精确豁免**（目前只用于 Electron 自带的 V8 快照 .bin）。
     * 豁免必须写成一个具体文件名模式，不能写成"目录级"的宽豁免 ——
     * 那等于把规则作废。
     */
    if (rule.except && rule.except.test(rel.split('/').pop() ?? rel)) continue
    forbiddenHits.push({ path: rel, why: rule.why })
  }

  // ② 只扫文本类文件（二进制跳过，避免把 PNG/EXE 当文本误报）
  const ext = extname(rel).toLowerCase()
  const TEXTY = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.ts', '.css', '.html', '.txt', '.yml', '.yaml'])
  if (!TEXTY.has(ext)) continue
  if (f.size > 8 * 1024 * 1024) continue
  let text
  try { text = readFileSync(f.path, 'utf8') } catch { continue }
  scanned.push(rel)

  /**
   * 把 `//` 与 `/* *\/` 注释、以及 `*.d.ts` 整体排除在"开发开关/硬编码地址"检查之外。
   *
   * 为什么（实测踩到的假阳性）：注释里出现的 `127.0.0.1:5173`、
   * "生产传 null" 这类**说明性文字**会被当成硬编码地址命中。
   * 假阳性比漏报更糟：它会让这条检查被当成噪声而整体忽略。
   * 注意**密钥检查仍然扫全文**（注释里也可能藏真密钥）。
   */
  const isDts = rel.endsWith('.d.ts')
  const codeOnly = isDts ? '' : text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')

  // ③ 密钥
  for (const sp of SECRET_PATTERNS) {
    const re = new RegExp(sp.re.source, sp.re.flags)
    let m
    while ((m = re.exec(text)) !== null) {
      const around = text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60)
      if (ALLOWLIST.some(a => a.test(around)) || ALLOWLIST.some(a => a.test(m[0]))) continue
      hits.push({ path: rel, kind: sp.id, note: sp.note, sample: `${m[0].slice(0, 12)}…（长度 ${m[0].length}）` })
    }
  }

  // ④ 开发开关
  for (const dm of DEV_MARKERS) {
    if (dm.pattern.test(codeOnly)) devMarkerHits.push({ path: rel, why: dm.why })
  }
}

const result = {
  schema: 'airimate/dist-payload-scan/1',
  scannedAt: new Date().toISOString(),
  payloadRoot: relative(ROOT, PAYLOAD_ROOT).split('\\').join('/'),
  payloadFileCount: payload.length,
  payloadBytes: bytes,
  payloadMB: Number((bytes / 1048576).toFixed(2)),
  textFilesScanned: scanned.length,
  /** 明文密钥命中（允许列表之外） */
  secretHits: hits,
  secretHitCount: hits.length,
  /** 不该出现在载荷里的东西 */
  forbiddenHits,
  forbiddenHitCount: forbiddenHits.length,
  devMarkerHits,
  devMarkerHitCount: devMarkerHits.length,
  /** 许可声明必须在载荷里（合规） */
  noticesPresent: payload.some(p => relative(PAYLOAD_ROOT, p.path).split('\\').join('/') === 'THIRD-PARTY-NOTICES.md'),
  /**
   * 资产必须**不在**载荷里（Mate 许可约束 + 适配层的许可判定）。
   * ⚠ 这里的扩展名集合必须与上面 `FORBIDDEN_IN_PAYLOAD` 里的资产类规则**保持一致** ——
   *   两处各写一份就会漂移（"扫描拦了但汇总没算"或反过来）。
   *   因为 `forbiddenHits` 已经过 `except` 豁免，这里只做**汇总**，不再重复豁免逻辑
   *   （重复一处就多一处漂移点）。
   */
  assetFilesInPayload: forbiddenHits
    .filter(h => /\.(vrm|vrma|anim|glb|gltf|fbx|bvh|onnx|gguf|safetensors|bin|wav|mp3|ogg|flac)$/i.test(h.path))
    .map(h => h.path),
  pass: hits.length === 0
    && forbiddenHits.length === 0
    && devMarkerHits.length === 0
    && payload.length > 0
    && payload.some(p => relative(PAYLOAD_ROOT, p.path).split('\\').join('/') === 'THIRD-PARTY-NOTICES.md'),
}

if (jsonOut) {
  writeFileSync(jsonOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
}

console.log(`载荷清单：${payload.length} 个文件，${result.payloadMB} MB；其中文本 ${scanned.length} 个已扫描`)

console.log('')
if (hits.length) {
  console.log(`✗ 明文密钥命中 ${hits.length} 条：`)
  for (const h of hits.slice(0, 20)) console.log(`   ${h.path}  [${h.kind}] ${h.sample}`)
} else console.log('✓ 明文密钥：0 命中')
if (forbiddenHits.length) {
  console.log(`✗ 禁用文件进入载荷 ${forbiddenHits.length} 条：`)
  for (const h of forbiddenHits.slice(0, 20)) console.log(`   ${h.path}  — ${h.why}`)
} else console.log('✓ 禁用清单：0 命中（VRM/VRMA/.anim/证据/工具/sourcemap 均不在载荷内）')
if (devMarkerHits.length) {
  console.log(`✗ 开发开关命中 ${devMarkerHits.length} 条：`)
  for (const h of devMarkerHits.slice(0, 20)) console.log(`   ${h.path}  — ${h.why}`)
} else console.log('✓ 开发开关：0 命中')
console.log(`许可证声明在载荷内：${result.noticesPresent ? '是' : '否（不合规）'}`)
console.log('')
console.log(result.pass ? '[dist-scan] PASS' : '[dist-scan] FAIL')
process.exit(result.pass ? 0 : 1)
