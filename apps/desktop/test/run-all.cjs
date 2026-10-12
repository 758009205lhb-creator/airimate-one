/**
 * apps/desktop/test/run-all.cjs —— 跑全部单测（`node --test <目录>` 在本机 Node 上不可靠）
 *
 * 为什么需要这个入口：直接把目录交给 `node --test` 时，本机 Node 会把它当成
 * **一个模块路径**去 require，报 `Cannot find module '...\test'`，一个用例都不跑
 * （实测）。这里显式列出文件，保证"跑全量"这件事有确定行为。
 *
 * 用法：`node apps/desktop/test/run-all.cjs`
 */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const dir = __dirname
const files = fs.readdirSync(dir)
  .filter(f => f.endsWith('.test.cjs'))
  .sort()
  .map(f => path.join(dir, f))

if (files.length === 0) {
  console.error('没有找到任何 *.test.cjs —— 不要把它当成"测试通过"')
  process.exit(1)
}
console.log(`[test] 共 ${files.length} 个测试文件：`)
for (const f of files) console.log(`  - ${path.basename(f)}`)

const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })
process.exit(r.status === null ? 1 : r.status)
