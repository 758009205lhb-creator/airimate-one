/**
 * tools/qa/scan-secrets.mjs —— 判据 A17：日志、源码、构建产物、诊断包、命令行中的云密钥命中数必须为 0
 *
 * 用 `@airimate/security` 的 `scanForSecrets`（与运行时日志脱敏**同一套**正则）
 * 扫描以下五个面：
 *   ① docs/ 与源码（packages/ apps/ tools/）
 *   ② 构建产物（apps 与 packages 下的 dist）
 *   ③ 用户数据目录（%APPDATA%\AiriMateOne\logs、crashDumps、settings/secrets 元数据）
 *   ④ 本应用进程的**命令行**（密钥不得出现在进程命令行里）
 *   ⑤ 证据目录（docs/evidence）—— 前几轮取证可能把令牌写进过报告
 *
 * 防"假通过"：必须报告 `filesScanned`；少于下限则判 INCONCLUSIVE（退出码 2）。
 *
 * 用法：
 *   node tools/qa/scan-secrets.mjs [--out docs/evidence/phase7/A17-secret-scan.json] [--min-files 50]
 * 退出码：0 = 通过；1 = 命中（失败）；2 = INCONCLUSIVE（环境/样本不足）
 */
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { scanForSecrets } from '../../packages/security/dist/index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

const argv = process.argv.slice(2)
const valOf = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d }
const OUT = resolve(valOf('--out', join(ROOT, 'docs', 'evidence', 'phase7', 'A17-secret-scan.json')))
const MIN_FILES = Number(valOf('--min-files', '50'))

const TEXT_EXT = new Set([
  '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.jsonl', '.md', '.txt', '.css', '.html',
  '.yml', '.yaml', '.ps1', '.sh', '.env', '.log', '.map',
])
const MAX_BYTES = 4 * 1024 * 1024
const SKIP_DIRS = new Set(['node_modules', '.git', '.vite', '.npm-cache', '__pycache__'])

function* walk(dir, depth = 0) {
  if (depth > 8) return
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      yield* walk(join(dir, e.name), depth + 1)
    } else if (e.isFile()) {
      yield join(dir, e.name)
    }
  }
}

const roots = [
  { label: 'source', dirs: [join(ROOT, 'packages'), join(ROOT, 'apps'), join(ROOT, 'tools'), join(ROOT, 'scripts')] },
  { label: 'docs+evidence', dirs: [join(ROOT, 'docs')] },
  { label: 'userdata', dirs: [join(process.env.APPDATA ?? '', 'AiriMateOne')] },
]

const files = []
for (const r of roots) {
  for (const d of r.dirs) {
    if (!existsSync(d)) continue
    for (const f of walk(d)) {
      const ext = extname(f).toLowerCase()
      if (!TEXT_EXT.has(ext)) continue
      try { if (statSync(f).size > MAX_BYTES) continue } catch { continue }
      files.push({ path: f, label: r.label })
    }
  }
}

// 读文件（读不动的跳过并记录）
const payloads = []
const unreadable = []
for (const f of files) {
  try {
    payloads.push({ path: f.path, content: readFileSync(f.path, 'utf8'), label: f.label })
  } catch (e) {
    unreadable.push({ path: f.path, error: e instanceof Error ? e.message : String(e) })
  }
}

// ④ 进程命令行（不得含密钥）
let cmdline = ''
let cmdlineError = null
try {
  const ps = 'powershell.exe'
  cmdline = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*新工程*' } | Select-Object -ExpandProperty CommandLine) -join "\`n"`],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
} catch (e) {
  cmdlineError = e instanceof Error ? e.message : String(e)
}

const hits = scanForSecrets(payloads.map(p => ({ path: p.path.replace(ROOT, '<root>'), content: p.content })))
if (cmdline.trim()) {
  hits.push(...scanForSecrets([{ path: '<process-cmdline>', content: cmdline }]))
}

const byPattern = {}
for (const h of hits) byPattern[h.pattern] = (byPattern[h.pattern] ?? 0) + 1

const filesScanned = payloads.length
const inconclusive = filesScanned < MIN_FILES
const pass = hits.length === 0 && !inconclusive

const report = {
  generatedAt: new Date().toISOString(),
  command: `node tools/qa/scan-secrets.mjs --out ${OUT.replace(ROOT, '<root>')}`,
  minFiles: MIN_FILES,
  filesScanned,
  unreadableCount: unreadable.length,
  unreadableSample: unreadable.slice(0, 5),
  cmdlineScanned: cmdline.trim().length > 0,
  cmdlineError,
  hitCount: hits.length,
  hitsByPattern: byPattern,
  hitsSample: hits.slice(0, 20).map(h => ({ pattern: h.pattern, at: h.path, len: h.length, sha8: h.sha8 })),
  pass,
  inconclusive,
  note: '命中只报告"模式名 + 文件 + 长度 + 哈希前缀"，**不回显原文**；扫描与运行时日志脱敏共用同一套正则。',
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.log(`SCAN_SECRETS filesScanned=${filesScanned} minFiles=${MIN_FILES} hits=${hits.length} inconclusive=${inconclusive} pass=${pass}`)
if (Object.keys(byPattern).length) console.log(`  命中模式：${JSON.stringify(byPattern)}`)
for (const h of report.hitsSample.slice(0, 8)) console.log(`  - ${h.pattern} @ ${h.at} len=${h.len} sha=${h.sha8}`)
console.log(`WROTE ${OUT}`)
process.exit(inconclusive ? 2 : (pass ? 0 : 1))
