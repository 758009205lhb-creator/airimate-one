/**
 * tools/qa/gen-third-party-licenses.mjs —— 生成第三方许可清单（THIRD-PARTY-NOTICES.md）
 *
 * 为什么必须有：本项目依赖 Electron / three.js / three-vrm / Vue / zod 等大量第三方代码，
 * 而**分发包里一份许可文件都没有**（实测：全仓 `LICENSE` / `NOTICE` / `THIRD*` 命中 0）。
 * 这不是"以后再补"的小事 —— 多数 MIT/BSD 许可都要求"再分发时保留版权声明与许可文本"，
 * 缺了就是**违反许可条款**，而不是风格问题。
 *
 * 数据来源（**离线、不猜**）：
 *   · 依赖图：直接读 `node_modules`，不联网解析（本机 GitHub/npm 的主站均不可达，
 *     只有镜像可用，因此**绝不**依赖网络）；
 *   · 许可类型：读每个包的 `package.json` 的 `license` / `licenses` 字段；
 *   · 许可正文：优先读包内自带的 `LICENSE*` / `COPYING*` / `NOTICE*` 文件。
 *     读不到就**如实标注"包内未附许可文本"**，而不是编一段。
 *
 * 用法：
 *   node tools/qa/gen-third-party-licenses.mjs            # 打印摘要
 *   node tools/qa/gen-third-party-licenses.mjs --write     # 写出 THIRD-PARTY-NOTICES.md
 *   node tools/qa/gen-third-party-licenses.mjs --json out.json
 */
import { readdirSync, readFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'

const ROOT = process.cwd()
const NM = join(ROOT, 'node_modules')

const args = process.argv.slice(2)
const doWrite = args.includes('--write')
const jsonIdx = args.indexOf('--json')
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null

/** 许可正文的候选文件名（大小写不敏感匹配前缀） */
const LICENSE_PREFIXES = ['license', 'licence', 'copying', 'notice', 'unlicense']

function findLicenseText(dir) {
  let entries
  try { entries = readdirSync(dir) } catch { return null }
  for (const name of entries) {
    const lower = name.toLowerCase()
    if (!LICENSE_PREFIXES.some(p => lower.startsWith(p))) continue
    const full = join(dir, name)
    try {
      if (!statSync(full).isFile()) continue
      const text = readFileSync(full, 'utf8')
      // 许可正文一般都不长；超长文件（例如误匹配到源码）跳过
      if (text.length > 200_000) continue
      return { file: name, text: text.trim() }
    } catch { /* 下一个 */ }
  }
  return null
}

function normalizeLicense(pkg) {
  if (typeof pkg.license === 'string' && pkg.license.trim()) return pkg.license.trim()
  if (pkg.license && typeof pkg.license === 'object' && pkg.license.type) return String(pkg.license.type)
  if (Array.isArray(pkg.licenses) && pkg.licenses.length) {
    return pkg.licenses.map(l => (typeof l === 'string' ? l : l?.type)).filter(Boolean).join(' OR ')
  }
  if (typeof pkg.private === 'boolean' && pkg.private) return '(private)'
  return '(未声明)'
}

/** 收集 node_modules 下的全部包（含 scoped 与嵌套） */
function collectPackages() {
  const out = new Map() // name@version -> record
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      if (name.startsWith('.')) continue
      const full = join(dir, name)
      let st
      try { st = statSync(full) } catch { continue }
      if (!st.isDirectory()) continue
      if (name.startsWith('@')) { walk(full); continue }
      const pj = join(full, 'package.json')
      if (existsSync(pj)) {
        try {
          const pkg = JSON.parse(readFileSync(pj, 'utf8'))
          const key = `${pkg.name ?? name}@${pkg.version ?? '?'}`
          if (!out.has(key)) {
            const lic = findLicenseText(full)
            out.set(key, {
              name: pkg.name ?? name,
              version: pkg.version ?? '?',
              license: normalizeLicense(pkg),
              homepage: typeof pkg.homepage === 'string' ? pkg.homepage : null,
              repository: typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? null),
              licenseText: lic ? lic.text : null,
              licenseFile: lic ? lic.file : null,
              dir: full.slice(ROOT.length + 1),
            })
          }
        } catch { /* 坏 package.json 跳过 */ }
      }
      // 继续下探嵌套 node_modules（pnpm 风格布局下会大量出现）
      const nested = join(full, 'node_modules')
      if (existsSync(nested)) walk(nested)
    }
  }
  walk(NM)
  return out
}

const pkgs = [...collectPackages().values()].sort((a, b) => a.name.localeCompare(b.name, 'en'))

/** 按许可类型汇总 */
const byLicense = new Map()
for (const p of pkgs) {
  const list = byLicense.get(p.license) ?? []
  list.push(p)
  byLicense.set(p.license, list)
}

const missingText = pkgs.filter(p => !p.licenseText)
const undeclared = pkgs.filter(p => p.license === '(未声明)')
/** 需要**特别审查**的许可：copyleft 类会传染，闭源/私有分发要格外小心 */
const COPYLEFT = /(GPL|AGPL|LGPL|MPL|EPL|CDDL|SSPL)/i

const copyleft = pkgs.filter(p => COPYLEFT.test(p.license))

const textHash = createHash('sha256')
  .update(pkgs.map(p => `${p.name}@${p.version}:${p.license}`).join('\n'), 'utf8')
  .digest('hex').slice(0, 16)

const summary = {
  schema: 'airimate/third-party-licenses/1',
  generatedAt: new Date().toISOString(),
  packageCount: pkgs.length,
  /** 依赖集合指纹：依赖变了这个值就变，便于判断清单是否过期 */
  dependencySetHash: textHash,
  licenseCounts: Object.fromEntries([...byLicense.entries()].map(([k, v]) => [k, v.length]).sort((a, b) => b[1] - a[1])),
  missingLicenseText: missingText.map(p => `${p.name}@${p.version}`),
  undeclaredLicense: undeclared.map(p => `${p.name}@${p.version}`),
  copyleftPackages: copyleft.map(p => ({ name: p.name, version: p.version, license: p.license })),
}

if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify({ ...summary, packages: pkgs }, null, 2)}\n`, 'utf8')

if (doWrite) {
  const lines = []
  lines.push('# 第三方许可声明（THIRD-PARTY NOTICES）')
  lines.push('')
  lines.push('> **本文件由 `tools/qa/gen-third-party-licenses.mjs` 自动生成，请勿手工编辑。**')
  lines.push('>')
  lines.push(`> 生成时间：${summary.generatedAt}`)
  lines.push(`> 依赖集合指纹：\`${textHash}\`（依赖变化后此值会变，可据此判断清单是否过期）`)
  lines.push(`> 收录包数：**${pkgs.length}**`)
  lines.push('')
  lines.push('## 许可类型分布')
  lines.push('')
  lines.push('| 许可 | 包数 |')
  lines.push('|---|---|')
  for (const [lic, count] of Object.entries(summary.licenseCounts)) lines.push(`| ${lic} | ${count} |`)
  lines.push('')
  if (copyleft.length) {
    lines.push('## ⚠ 需要审查的 copyleft 类依赖')
    lines.push('')
    lines.push('以下依赖带 copyleft 类许可。**私有自用**场景下通常只需保留声明；')
    lines.push('但若要**对外分发**，必须逐一确认其义务（源码提供、同类许可传染等）。')
    lines.push('')
    lines.push('| 包 | 版本 | 许可 |')
    lines.push('|---|---|---|')
    for (const p of copyleft) lines.push(`| ${p.name} | ${p.version} | ${p.license} |`)
    lines.push('')
  }
  if (undeclared.length) {
    lines.push('## ⚠ 未声明许可的依赖')
    lines.push('')
    lines.push('这些包既没有 `license` 字段也没有许可文件。**在对外分发前必须查清**：')
    lines.push('未声明许可默认等于"保留全部权利"，不等于可以自由再分发。')
    lines.push('')
    for (const p of undeclared) lines.push(`- \`${p.name}@${p.version}\``)
    lines.push('')
  }
  if (missingText.length) {
    lines.push('## ℹ 包内未附许可正文的依赖')
    lines.push('')
    lines.push('`package.json` 声明了许可类型，但包内没有 `LICENSE` 文件。')
    lines.push('大多数许可要求再分发时附上许可正文 ⇒ **分发前需从上游补齐**。')
    lines.push('')
    for (const p of missingText) lines.push(`- \`${p.name}@${p.version}\`（声明：${p.license}）`)
    lines.push('')
  }
  lines.push('## 各依赖的版权声明与许可正文')
  lines.push('')
  for (const p of pkgs) {
    lines.push(`### ${p.name}@${p.version}`)
    lines.push('')
    lines.push(`- 许可：**${p.license}**`)
    if (p.homepage) lines.push(`- 主页：${p.homepage}`)
    if (p.repository) lines.push(`- 仓库：${p.repository}`)
    lines.push('')
    if (p.licenseText) {
      lines.push(`<details><summary>许可正文（来自包内 <code>${p.licenseFile}</code>）</summary>`)
      lines.push('')
      lines.push('```text')
      lines.push(p.licenseText)
      lines.push('```')
      lines.push('')
      lines.push('</details>')
    } else {
      lines.push('_包内未附许可正文 —— 分发前需从上游补齐。_')
    }
    lines.push('')
  }
  writeFileSync(join(ROOT, 'THIRD-PARTY-NOTICES.md'), `${lines.join('\n')}\n`, 'utf8')
}

console.log(JSON.stringify(summary, null, 2))
console.log('')
console.log(`[licenses] 共 ${pkgs.length} 个包；许可类型 ${Object.keys(summary.licenseCounts).length} 种`)
if (undeclared.length) console.log(`[licenses] ⚠ 未声明许可：${undeclared.length} 个（对外分发前必须查清）`)
if (copyleft.length) console.log(`[licenses] ⚠ copyleft 类：${copyleft.length} 个`)
if (missingText.length) console.log(`[licenses] ℹ 包内无许可正文：${missingText.length} 个（分发前需补齐）`)
if (doWrite) console.log('[licenses] 已写出 THIRD-PARTY-NOTICES.md')
