/**
 * tools/qa/verify-dist-integrity.mjs —— 分发包完整性复算（B4 的**判据**）
 *
 * 为什么必须有这一条（外部复核实测出来的缺口）：
 *   `MANIFEST.json` 原来只有 `{rel, size}` —— **一个 `sha*` / `checksum` / `hash` / `digest`
 *   字段都没有**。于是下面两件事都发现不了：
 *     ① 传输/拷贝过程中文件被截断或损坏（`locales/*.pak` 这种几十 MB 的二进制最容易中招）；
 *     ② 载荷里被塞进一个**同名同大小**但内容不同的文件。
 *   `scan-dist-payload.mjs` 扫的是"内容特征"（密钥 / 禁用清单 / 开发开关），
 *   它**不能**回答"这份载荷还是不是当初组装的那份" —— 那是摘要的职责，不是扫描的职责。
 *
 * 本脚本只做一件事：**把 `stage-dist.mjs` 记下的哈希重算一遍，逐条比对**。
 * 它不修任何东西、不猜任何东西；对不上就 FAIL，并把对不上的文件点名出来。
 *
 * 用法：
 *   node tools/qa/verify-dist-integrity.mjs
 *   node tools/qa/verify-dist-integrity.mjs --json docs/evidence/phase14/B4-dist-integrity.json
 *   node tools/qa/verify-dist-integrity.mjs --quiet      # 只出结论行
 * 退出码：0 = 全部一致；1 = 有任何不一致或清单异常（**不静默成功**）
 */
import { readdirSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createHash } from 'node:crypto'

const ROOT = process.cwd()
const OUT = join(ROOT, 'dist-package')
const args = process.argv.slice(2)
const jsonIdx = args.indexOf('--json')
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null
const quiet = args.includes('--quiet')

/**
 * `README.md` 是给人看的；`MANIFEST.json` **不能**把自己也记进去
 * （记进去就变成"摘要描述了包含它自己的载荷"，永远无法自洽）。
 */
const MANIFEST = join(OUT, 'MANIFEST.json')

/** 递归列出载荷内全部文件（相对路径一律**正斜杠**，与 MANIFEST 同口径） */
function walk(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.isFile()) out.push(p)
  }
  return out
}

const problems = []
const check = (ok, code, detail) => { if (!ok) problems.push({ code, detail }) }

if (!existsSync(OUT)) {
  console.error(`[integrity] 载荷目录不存在：${OUT}`)
  console.error('[integrity] 请先运行：node tools/qa/stage-dist.mjs --clean --with-runtime')
  process.exit(1)
}
if (!existsSync(MANIFEST)) {
  console.error(`[integrity] 缺少清单：${MANIFEST}`)
  console.error('[integrity] 没有清单就无法复算 —— 这正是本脚本存在的理由（不要跳过组装步骤）')
  process.exit(1)
}

let manifest
try {
  manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
} catch (e) {
  console.error(`[integrity] 清单不是合法 JSON：${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}

/** ① 清单自身必须可信 */
check(manifest.schema === 'airimate/dist-package-manifest/2', 'manifest-schema',
  `schema=${String(manifest.schema)}（期望 airimate/dist-package-manifest/2，即带 sha256 的那一版）`)
check(Array.isArray(manifest.files) && manifest.files.length > 0, 'manifest-files', 'files 数组缺失或为空')
check(typeof manifest.payloadDigest === 'string' && /^[0-9a-f]{64}$/.test(manifest.payloadDigest), 'payload-digest',
  `payloadDigest 不是 64 位十六进制：${String(manifest.payloadDigest).slice(0, 24)}`)
check(manifest.digestAlgorithm === 'sha256', 'digest-algorithm', `digestAlgorithm=${String(manifest.digestAlgorithm)}`)

const recorded = Array.isArray(manifest.files) ? manifest.files : []

/** ② 每条记录都必须有哈希（"少记一个"就整条判据失效，不能只统计数量） */
const missingHash = recorded.filter(f => typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256))
check(missingHash.length === 0, 'missing-hash',
  `${missingHash.length} 条记录没有合法 sha256：${missingHash.slice(0, 5).map(f => f.rel).join(', ')}`)

/** ③ 路径安全：不得有绝对路径 / 上跳 / 反斜杠（否则"清单说的文件"和"落盘文件"可能不是一回事） */
const unsafe = recorded.filter(f => typeof f.rel !== 'string'
  || f.rel.length === 0
  || f.rel.startsWith('/')
  || /^[a-zA-Z]:/.test(f.rel)
  || f.rel.split('/').includes('..')
  || f.rel.includes('\\'))
check(unsafe.length === 0, 'unsafe-path',
  `${unsafe.length} 条路径不合规（绝对路径 / 上跳 / 反斜杠）：${unsafe.slice(0, 5).map(f => String(f.rel)).join(', ')}`)

/** ④ 不得重复登记同一个路径（重复会让"文件数"这个口径失去意义） */
const seen = new Set()
const dupes = []
for (const f of recorded) {
  if (seen.has(f.rel)) dupes.push(f.rel)
  seen.add(f.rel)
}
check(dupes.length === 0, 'duplicate-rel', `重复登记的路径 ${dupes.length} 个：${dupes.slice(0, 5).join(', ')}`)

/** ⑤ 盘上真实文件集合（`MANIFEST.json` 自己不算载荷内容） */
const onDisk = walk(OUT)
  .map(p => relative(OUT, p).split('\\').join('/'))
  .filter(rel => rel !== 'MANIFEST.json')
  .sort()
const recordedRels = recorded.map(f => f.rel).sort()

const missingOnDisk = recordedRels.filter(rel => !onDisk.includes(rel))
const extraOnDisk = onDisk.filter(rel => !recordedRels.includes(rel))
check(missingOnDisk.length === 0, 'file-missing', `清单里有、盘上没有的文件 ${missingOnDisk.length} 个：${missingOnDisk.slice(0, 5).join(', ')}`)
check(extraOnDisk.length === 0, 'file-extra', `盘上有、清单里没有的文件 ${extraOnDisk.length} 个：${extraOnDisk.slice(0, 5).join(', ')}`)
check(manifest.fileCount === recorded.length, 'file-count', `fileCount=${String(manifest.fileCount)} 与 files 数组长度 ${recorded.length} 不一致`)

/** ⑥ 逐文件复算哈希 + 大小（**这是本脚本的核心**） */
const rows = []
const mismatched = []
const sizeMismatched = []
let bytes = 0
for (const f of recorded) {
  if (unsafe.some(u => u === f)) continue
  const abs = join(OUT, f.rel)
  if (!existsSync(abs)) continue
  const st = statSync(abs)
  const sha = createHash('sha256').update(readFileSync(abs)).digest('hex')
  bytes += st.size
  const okHash = typeof f.sha256 === 'string' && sha === f.sha256
  const okSize = Number.isFinite(f.size) && f.size === st.size
  if (!okHash) mismatched.push({ rel: f.rel, recorded: String(f.sha256).slice(0, 16), actual: sha.slice(0, 16), size: st.size })
  if (!okSize) sizeMismatched.push({ rel: f.rel, recorded: f.size, actual: st.size })
  rows.push({ rel: f.rel, size: st.size, sha256: sha, hashMatch: okHash, sizeMatch: okSize })
}
check(mismatched.length === 0, 'hash-mismatch',
  `${mismatched.length} 个文件内容与清单不符（截断/损坏/被替换）：${mismatched.slice(0, 5).map(m => `${m.rel}(${m.recorded}…≠${m.actual}…)`).join(', ')}`)
check(sizeMismatched.length === 0, 'size-mismatch',
  `${sizeMismatched.length} 个文件大小与清单不符：${sizeMismatched.slice(0, 5).map(m => `${m.rel}(${m.recorded}≠${m.actual})`).join(', ')}`)

/** ⑦ 总摘要复算：与组装时**同一算法**（排序后的 `rel\0sha256` 列表再哈希） */
const recomputedDigest = createHash('sha256')
  .update([...rows].sort((a, b) => a.rel.localeCompare(b.rel)).map(r => `${r.rel}\0${r.sha256}`).join('\n'), 'utf8')
  .digest('hex')
check(recomputedDigest === manifest.payloadDigest, 'payload-digest-mismatch',
  `总摘要不符：清单 ${String(manifest.payloadDigest).slice(0, 16)}… vs 复算 ${recomputedDigest.slice(0, 16)}…`)

const result = {
  schema: 'airimate/dist-integrity/1',
  verifiedAt: new Date().toISOString(),
  payloadRoot: relative(ROOT, OUT).split('\\').join('/'),
  stagedAt: manifest.stagedAt ?? null,
  algorithm: 'sha256',
  manifestFiles: recorded.length,
  hashedFiles: rows.length,
  payloadBytes: bytes,
  payloadMB: Number((bytes / 1048576).toFixed(2)),
  payloadDigest: manifest.payloadDigest ?? null,
  recomputedDigest,
  digestMatch: recomputedDigest === manifest.payloadDigest,
  hashMismatches: mismatched,
  sizeMismatches: sizeMismatched,
  missingOnDisk,
  extraOnDisk,
  problems,
  pass: problems.length === 0,
}

if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8')

if (!quiet) {
  console.log(`载荷：${result.payloadRoot}  清单记录 ${recorded.length} 个 / 实际复算 ${rows.length} 个，${result.payloadMB} MB`)
  console.log(`总摘要：清单 ${String(result.payloadDigest).slice(0, 24)}…`)
  console.log(`        复算 ${recomputedDigest.slice(0, 24)}…  ${result.digestMatch ? '一致' : '不一致'}`)
  console.log('')
}
if (problems.length) {
  console.log(`✗ 完整性复算发现 ${problems.length} 类问题：`)
  for (const p of problems) console.log(`   [${p.code}] ${p.detail}`)
} else {
  console.log(`✓ 完整性：${rows.length} 个文件的 sha256 全部一致，总摘要一致（${result.payloadDigest.slice(0, 16)}…）`)
}
console.log('')
console.log(result.pass ? '[integrity] PASS' : '[integrity] FAIL')
process.exit(result.pass ? 0 : 1)
