/**
 * test/no-three-import.test.mjs
 *
 * 一条**结构性**断言：`src/` 与 `dist/` 里都不得出现渲染库的 import。
 *
 * 为什么值得单独写一个测试文件
 * ----------------------------
 *   "core 不依赖 three" 这条纪律一旦被破坏是**静默**的：
 *   代码照样能跑，只是从"可以在 Node 里单测的纯逻辑"退化成"必须拖进一个
 *   WebGL 上下文才能跑"。等发现时已经很难拆回来。
 *   所以把它做成测试，CI 一跑就红。
 *
 * 允许的 import：相对路径（`./x.js`）。其余一律禁止。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 禁止出现在包内任何源码里的模块名（子串匹配） */
const FORBIDDEN = ['three', '@pixiv', 'three-vrm', 'three-stdlib', 'electron', 'react', 'vue', 'svelte']

function collect(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...collect(p))
    else if (/\.(ts|js|mjs|cts|mts)$/.test(e.name)) out.push(p)
  }
  return out
}

/** 抽出所有 `from '<spec>'` / `import('<spec>')` / `require('<spec>')` 的 spec */
function importsOf(text) {
  const specs = []
  for (const re of [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
  ]) {
    let m
    while ((m = re.exec(text)) !== null) specs.push(m[1])
  }
  return specs
}

describe('core 不依赖渲染库', () => {
  for (const sub of ['src', 'dist']) {
    test(`${sub}/ 里所有 import 都是相对路径，且不含 three / @pixiv / DOM 框架`, () => {
      const files = collect(join(PKG, sub))
      if (sub === 'dist' && files.length === 0) {
        // dist 需要先 build；没有就跳过（但要在 src 那一轮覆盖到）
        console.log('[skip] dist/ 为空（尚未 build）')
        return
      }
      assert.ok(files.length > 0, `${sub}/ 里应有源码文件`)
      const bad = []
      for (const f of files) {
        const text = readFileSync(f, 'utf8')
        for (const spec of importsOf(text)) {
          if (spec.startsWith('.')) continue
          if (spec.startsWith('node:')) continue     // 允许 node 内建（本包实际一个都没用）
          bad.push(`${f.replace(PKG, '<pkg>')} → "${spec}"`)
        }
        for (const word of FORBIDDEN) {
          // 只查 import 语句，不查注释/文档里提到 three
          for (const spec of importsOf(text)) if (spec.includes(word)) bad.push(`${f.replace(PKG, '<pkg>')} → "${spec}"（命中禁用词 ${word}）`)
        }
      }
      assert.deepEqual(bad, [], `core 必须保持纯净，发现非相对 import：\n  ${bad.join('\n  ')}`)
    })
  }

  test('package.json 里 runtime dependencies 为空', () => {
    const pkg = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'))
    const deps = Object.keys(pkg.dependencies ?? {})
    assert.deepEqual(deps, [], `runtime 依赖必须为空，实际：${deps.join(', ')}`)
  })
})
