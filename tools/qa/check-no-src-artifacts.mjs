/**
 * tools/qa/check-no-src-artifacts.mjs —— 源码目录与配置文件的"静默故障"守卫
 *
 * 这个脚本守两件事，都由**真实踩过的坑**换来：
 *
 * ① **`src/` 下不得有编译产物**
 *    `packages/shared/src/` 曾同时存在手写的 `ipc.ts` 与一份陈旧编译产物 `ipc.js`，
 *    而 `index.ts` 写的是 `export * from './ipc.js'`（TS 的 ESM 习惯写法），
 *    于是 Vite/esbuild 的解析规则（**精确匹配优先**）命中了陈旧的 `ipc.js` 而不是 `ipc.ts`
 *    ⇒ renderer 构建报 `"manifestSemantic" is not exported by ...`。
 *    更早的 agent 没找到根因，而是把两个 helper **内联**进 `stage.ts` 绕过了它。
 *
 * ② **JSON/JSONL 文件不得带 UTF-8 BOM**
 *    PowerShell 5.1 的 `Set-Content -Encoding UTF8` **总是写 BOM**，
 *    而 `JSON.parse` 遇到 BOM 会直接抛 `Unexpected token ''`。
 *    实测两次：一次让 QA 脚本的 `ConvertFrom-Json` 静默失败，
 *    一次让 6 个 `package.json` 全部带上 BOM（`node` 读它们就崩）。
 *    这类问题的表现是"工具莫名其妙报解析错误"，而根因在一个看不见的 3 字节前缀。
 *
 * 用法：`node tools/qa/check-no-src-artifacts.mjs`
 * 退出码：0 = 干净；1 = 有问题（并列出文件与修复办法）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const ROOT = process.cwd()
const SCAN_DIRS = ['packages', 'apps']
/** `src/` 下**允许**存在的、看起来像产物的文件（手写的环境声明） */
const ALLOWED_DTS = new Set([
  'apps/renderer/src/env.d.ts',
  'apps/renderer/src/vue-shims.d.ts',
])

/** 编译产物特征：与同名 .ts 并存的 .js / .js.map / .d.ts / .d.ts.map */
const ARTIFACT_EXT = ['.js', '.js.map', '.d.ts', '.d.ts.map', '.mjs.map', '.cjs.map']

const hits = []
const bomFiles = []

function walk(dir) {
  let entries
  try { entries = readdirSync(dir) } catch { return }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === 'dist-package' || name === '.git') continue
    const full = join(dir, name)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) { walk(full); continue }
    const rel = relative(ROOT, full).split(sep).join('/')

    // ② BOM 检查（覆盖整个仓库的 JSON/JSONL，不只 src/）
    if (/\.(json|jsonl)$/.test(name)) {
      try {
        const fd = readFileSync(full)
        if (fd.length >= 3 && fd[0] === 0xEF && fd[1] === 0xBB && fd[2] === 0xBF) bomFiles.push(rel)
      } catch { /* 读不了就跳过 */ }
    }

    // ① 只对 src/ 检查编译产物
    if (!rel.includes('/src/')) continue
    if (ALLOWED_DTS.has(rel)) continue
    if (ARTIFACT_EXT.some(ext => name.endsWith(ext))) {
      hits.push({ rel, bytes: st.size, mtime: st.mtime.toISOString() })
    }
  }
}

for (const d of SCAN_DIRS) walk(join(ROOT, d))
// BOM 检查要覆盖仓库根与 docs（证据 JSON 也在其中）
for (const d of ['.']) walk(join(ROOT, d))

let failed = false

if (hits.length > 0) {
  failed = true
  console.error(`[guard] 发现 ${hits.length} 个编译产物掉进了 src/ —— 这会让构建解析到**陈旧代码**：`)
  for (const h of hits) console.error(`  - ${h.rel}  (${h.bytes} B, ${h.mtime})`)
  console.error('')
  console.error('为什么必须清掉：`export * from "./x.js"` 在 Vite/esbuild 下是**精确匹配优先**，')
  console.error('陈旧 .js 会盖住同名 .ts，导致"改了源码却没生效"或"某个导出不存在"这类假故障。')
  console.error('')
  console.error('清理（确认这些文件确实是产物后再执行；手写 .d.ts 不在列表中）：')
  console.error('  Get-ChildItem -Recurse packages,apps -Include *.js,*.js.map,*.d.ts,*.d.ts.map -File |')
  console.error('    Where-Object { $_.FullName -like "*\\src\\*" } | Remove-Item -Force')
} else {
  console.log(`[guard] OK：${SCAN_DIRS.join('/')}/*/src 下没有编译产物（只允许手写源码与手写 .d.ts）`)
}

if (bomFiles.length > 0) {
  failed = true
  console.error('')
  console.error(`[guard] 发现 ${bomFiles.length} 个 JSON/JSONL 带 UTF-8 BOM —— \`JSON.parse\` 会直接抛错：`)
  for (const f of bomFiles.slice(0, 30)) console.error(`  - ${f}`)
  if (bomFiles.length > 30) console.error(`  … 另有 ${bomFiles.length - 30} 个`)
  console.error('')
  console.error('根因：PowerShell 5.1 的 `Set-Content -Encoding UTF8` **总是写 BOM**。')
  console.error('写 JSON 请用 node（`fs.writeFileSync(p, JSON.stringify(v,null,2)+"\\n", "utf8")`），')
  console.error('或 PowerShell 的 `[System.IO.File]::WriteAllText($p, $s, (New-Object System.Text.UTF8Encoding($false)))`。')
  console.error('')
  console.error('批量去 BOM（内容不变，只去掉前 3 字节）：')
  console.error('  node -e "const fs=require(\'fs\'),p=require(\'path\');const w=d=>{for(const n of fs.readdirSync(d)){if([\'node_modules\',\'dist\',\'dist-package\',\'.git\'].includes(n))continue;const f=p.join(d,n);if(fs.statSync(f).isDirectory())w(f);else if(/\\.(json|jsonl)$/.test(n)){const r=fs.readFileSync(f,\'utf8\');if(r.charCodeAt(0)===0xFEFF)fs.writeFileSync(f,r.slice(1),\'utf8\')}}};w(\'.\')"')
} else {
  console.log('[guard] OK：仓库内没有带 BOM 的 JSON/JSONL')
}

process.exit(failed ? 1 : 0)
