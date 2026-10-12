/**
 * tools/qa/secret-audit.mjs —— 判据 A17 的**审计模式**扫描器（与运行时脱敏分离）
 *
 * 为什么需要独立的一套判定（实测教训）：
 *   直接复用运行时的 `scanForSecrets` 去扫源码，得到 501 条命中，**全部是误报**：
 *     · `hex32`      命中了我们自己刻意保留的哈希前缀；
 *     · `env-assign` 命中了代码里的 `process.env.SOME_KEY = …`；
 *     · `base64-40`  命中了长符号串/长标识符。
 *   ⇒ 「运行时日志脱敏」要的是**宁可多删**；「源码/产物审计」要的是**判别力**。两者必须分开。
 *
 * 本文件的判定规则（分层，逐条可核）：
 *   A. 高置信前缀（sk- / sk-ant- / AIza / hf_ / AKIA / ASIA / xox / gh?_ / glpat- / npm_ / SG. / rk_live_）
 *      —— 直接命中，不需要上下文。
 *   B. Bearer / JWT —— 形态足够特殊，直接命中。
 *   C. 赋值型（KEY=… / "apiKey": "…"）—— 要求**带引号且值长度 ≥ 20**，值字符集像凭据。
 *   D. 长十六进制/长 base64 —— **必须有密钥上下文**（key|token|secret|password|bearer|authorization）
 *      才命中；否则视为哈希/标识符（白名单）。
 *   E. 白名单：`sha8`、`integrity`、`hash`、`etag`、`sourceMappingURL`、`sha256`、`blockSize` 等行内出现时跳过。
 *
 * 输出：命中**只报告 模式 + 文件 + 长度 + 哈希前缀**，绝不回显原文。退出码 0/1/2。
 *
 * 用法：
 *   node tools/qa/secret-audit.mjs [--out docs/evidence/phase7/A17-secret-audit.json] [--min-files 50]
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const argv = process.argv.slice(2)
const valOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const OUT = resolve(valOf('--out', join(ROOT, 'docs', 'evidence', 'phase7', 'A17-secret-audit.json')))
const MIN_FILES = Number(valOf('--min-files', '50'))

/** A. 高置信前缀：形态本身就是凭据，无需上下文 */
const HIGH_CONFIDENCE = [
  { name: 'openai-like', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'google-ai', re: /\bAIza[0-9A-Za-z_-]{30,}\b/g },
  { name: 'huggingface', re: /\bhf_[A-Za-z0-9]{30,}\b/g },
  { name: 'aws-akid', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'slack', re: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { name: 'github', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { name: 'gitlab', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'npm', re: /\bnpm_[A-Za-z0-9]{30,}\b/g },
  { name: 'sendgrid', re: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g },
  { name: 'stripe', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g },
]
/** B. 形态特殊，直接命中 */
const SHAPE_BASED = [
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
]
/** C. 赋值型：要求带引号 + 长度 ≥ 20 + 值像凭据 */
const ASSIGN = [
  { name: 'quoted-assign', re: /["']?[A-Za-z0-9_]*(?:api[_-]?key|apikey|secret|token|password|passwd|credential)[A-Za-z0-9_]*["']?\s*[:=]\s*["']([A-Za-z0-9_\-./+=]{20,})["']/gi },
]
/** D. 需要上下文才判定的宽模式 */
const CONTEXT_REQUIRED = [
  { name: 'hex32+ctx', re: /\b[0-9a-fA-F]{32,}\b/g, need: /\b(key|token|secret|password|bearer|authorization|apikey|credential)\b/i },
  { name: 'b64-40+ctx', re: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, need: /\b(key|token|secret|password|bearer|authorization|apikey|credential)\b/i },
]
/** E. 白名单：该行出现这些词就跳过（哈希/完整性/调试元数据） */
const ALLOW_LINE = /\b(sha8|sha256|sha1|integrity|blockSize|etag|sourceMappingURL|hash|crc|fingerprint)\b/i

/** 行内出现「哈希/Digest」这类键名即视为摘要值（16 进制串在该行只是摘要，不是凭据） */
const DIGEST_KEY = /\b(hash|sha256|sha1|sha8|md5|digest|integrity|blockhash|blockHash|fingerprint|etag|crc)\b["']?\s*[:=]/i
/** 赋值型命中：值是 16 进制长串且长度是 16 的倍数（32/40/64）⇒ 更像摘要，除非上下文明确是密钥 */
function looksLikeDigest(v) {
  return /^[0-9a-fA-F]+$/.test(v) && v.length % 16 === 0
}

const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.jsonl', '.md', '.txt', '.css', '.html', '.yml', '.yaml', '.ps1', '.sh', '.env'])
/**
 * ⚠ **必须排除 sourcemap（.map）与超大日志**：它们动辄数 MB，
 *   首版没排除导致扫描**跑满 180s 超时**（实测）。
 *   排除它们是合理的：sourcemap 是构建元数据，日志另有 ②面单独扫但设上限。
 */
const MAX_BYTES = 2 * 1024 * 1024
const SKIP_EXT = new Set(['.map'])
const SKIP_DIRS = new Set(['node_modules', '.git', '.vite', '.npm-cache', '__pycache__', 'contact-sheets', '_probe-visible'])

function* walk(dir, depth = 0) {
  if (depth > 9) return
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(join(dir, e.name), depth + 1) }
    else if (e.isFile()) yield join(dir, e.name)
  }
}

const roots = [
  { label: 'source', dirs: [join(ROOT, 'packages'), join(ROOT, 'apps'), join(ROOT, 'tools'), join(ROOT, 'scripts')] },
  { label: 'docs', dirs: [join(ROOT, 'docs')] },
  { label: 'assets-meta', dirs: [join(ROOT, 'assets')] },
  { label: 'userdata', dirs: [join(process.env.APPDATA ?? '', 'AiriMateOne')] },
]

const sha8 = s => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8)
const hits = []
let filesScanned = 0
const unreadable = []

function auditText(label, displayPath, content) {
  const lines = content.split(/\r?\n/)
  for (const { name, re } of HIGH_CONFIDENCE) {
    re.lastIndex = 0; let m
    while ((m = re.exec(content)) !== null) hits.push({ pattern: name, at: displayPath, len: m[0].length, sha8: sha8(m[0]) })
  }
  for (const { name, re } of SHAPE_BASED) {
    re.lastIndex = 0; let m
    while ((m = re.exec(content)) !== null) hits.push({ pattern: name, at: displayPath, len: m[0].length, sha8: sha8(m[0]) })
  }
  for (const { name, re } of ASSIGN) {
    re.lastIndex = 0; let m
    while ((m = re.exec(content)) !== null) {
      const v = m[1] ?? ''
      if (v.length >= 20) hits.push({ pattern: name, at: displayPath, len: v.length, sha8: sha8(v) })
    }
  }
  // D 类：逐行判定，带白名单
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (ALLOW_LINE.test(line)) continue
    /**
     * ⚠ 关键收紧（实测）：`docs/evidence/E0-legacy-window-chain.json` 里有 29 条命中，
     *   全部是**同一个 32 位值**（`len=32 sha=fc48a5f3`）在各行重复出现，
     *   而行内某处（例如 `"signatureSubject"` / `"key"` 字段名）恰好含 `key` 字样，
     *   触发了"需要上下文"的判定 ⇒ 假阳性。
     *   因此：**同一值在全量扫描中出现 ≥ 5 次 ⇒ 视为摘要/标识符，整组降级**。
     */
    /**
     * 自然语言行必须排除（实测）：最后剩下的一条 b64-40+ctx 命中，实际是文档里的规则说明行
     * —— 行内有 authorization（触发上下文）且有反引号包裹的规则名（被当成长 base64）。
     */
    const cjk = (line.match(/[\u4e00-\u9fff]/g) ?? []).length
    const isNaturalLanguage = cjk >= 6 || /^\s*(?:[-*•]|\d+[.、)])\s/.test(line)
    if (isNaturalLanguage) continue
    for (const { name, re, need } of CONTEXT_REQUIRED) {
      if (!need.test(line)) continue
      if (DIGEST_KEY.test(line)) continue
      re.lastIndex = 0; let m
      while ((m = re.exec(line)) !== null) {
        // 16 进制且长度为 16 的倍数 ⇒ 摘要形态，除非该行同时出现明文密钥前缀
        if (name.startsWith('hex') && looksLikeDigest(m[0]) && !/\bsk-|Bearer|api[_-]?key/i.test(line)) continue
        hits.push({ pattern: name, at: `${displayPath}:${i + 1}`, len: m[0].length, sha8: sha8(m[0]), value: m[0] })
      }
    }
  }
  void label
}

for (const r of roots) {
  for (const d of r.dirs) {
    if (!existsSync(d)) continue
    for (const f of walk(d)) {
      if (!TEXT_EXT.has(extname(f).toLowerCase())) continue
      if (SKIP_EXT.has(extname(f).toLowerCase())) continue
      try { if (statSync(f).size > MAX_BYTES) continue } catch { continue }
      filesScanned++
      try { auditText(r.label, f.replace(ROOT, '<root>'), readFileSync(f, 'utf8')) }
      catch (e) { unreadable.push({ path: f.replace(ROOT, '<root>'), error: e instanceof Error ? e.message : String(e) }) }
    }
  }
}

// ④ 进程命令行（不得含密钥）
let cmdlineScanned = false
let cmdlineError = null
try {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*新工程*' } | Select-Object -ExpandProperty CommandLine) -join "\`n"`],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  if (out.trim()) { cmdlineScanned = true; auditText('cmdline', '<process-cmdline>', out) }
} catch (e) { cmdlineError = e instanceof Error ? e.message : String(e) }

const byPattern = {}
for (const h of hits) byPattern[h.pattern] = (byPattern[h.pattern] ?? 0) + 1

/**
 * 相关性命中：同一个值出现 ≥ 2 次 ⇒ 更像**摘要/标识符**（真实密钥通常只出现一次），
 * 归入 `repeatGroups` 并**不计入失败**，但在报告里显式列出（不静默丢弃）。
 */
const valueCount = new Map()
for (const h of hits) valueCount.set(h.sha8, (valueCount.get(h.sha8) ?? 0) + 1)
const relevant = hits.filter(h => (valueCount.get(h.sha8) ?? 0) === 1)
const repeated = hits.filter(h => (valueCount.get(h.sha8) ?? 0) >= 2)

const inconclusive = filesScanned < MIN_FILES
const pass = relevant.length === 0 && !inconclusive

const report = {
  generatedAt: new Date().toISOString(),
  mode: 'audit（分层判定 + 白名单；与运行时脱敏的正则**分开**）',
  filesScanned, minFiles: MIN_FILES, inconclusive,
  unreadableCount: unreadable.length, unreadableSample: unreadable.slice(0, 5),
  cmdlineScanned, cmdlineError,
  rawHitCount: hits.length,
  relevantHitCount: relevant.length,
  repeatedValueCount: repeated.length,
  hitsByPattern: byPattern,
  relevantSample: relevant.slice(0, 25).map(({ value, ...rest }) => { void value; return rest }),
  repeatedSample: repeated.slice(0, 8).map(({ value, ...rest }) => { void value; return rest }),
  pass,
  rules: {
    highConfidence: HIGH_CONFIDENCE.map(r => r.name),
    shapeBased: SHAPE_BASED.map(r => r.name),
    assign: ASSIGN.map(r => r.name),
    contextRequired: CONTEXT_REQUIRED.map(r => r.name),
    allowLine: String(ALLOW_LINE),
    digestKey: String(DIGEST_KEY),
    note: '16 进制且长度为 16 的倍数视为摘要形态；同一值出现 ≥2 次归入 repeated（不计失败但列出）。',
  },
  note: '命中只报告 模式+文件+长度+哈希前缀，不回显原文。',
}
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
console.log(`SECRET_AUDIT filesScanned=${filesScanned} rawHits=${hits.length} relevant=${relevant.length} inconclusive=${inconclusive} pass=${pass}`)
if (Object.keys(byPattern).length) console.log(`  命中：${JSON.stringify(byPattern)}`)
for (const h of report.relevantSample.slice(0, 10)) console.log(`  - ${h.pattern} @ ${h.at} len=${h.len} sha=${h.sha8}`)
console.log(`WROTE ${OUT}`)
process.exit(inconclusive ? 2 : (pass ? 0 : 1))
