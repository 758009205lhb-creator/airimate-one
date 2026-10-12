#!/usr/bin/env node
/**
 * tools/qa/clean-dist-maps.mjs —— 生产构建前清掉 dist 里的历史 sourcemap。
 *
 * 为什么需要（本轮实测踩到）：
 *   tsc -p tsconfig.json（dev 构建）会产出 .js.map，而
 *   tsc -p tsconfig.prod.json（生产构建）**只影响本次是否生成**，
 *   **不会删除上一次留下的文件**（tsc 不做 outDir 清理）。
 *   于是一旦先跑过 npm run build:dev 再跑 npm run build，
 *   分发目录里就会带着未压缩源码的映射 —— 静态断言 no-sourcemap-in-dist 会（正确地）失败。
 *
 * ⚠ 本文件的注释里**不要出现反引号**：模板字符串语法会让整个模块解析失败
 *   （本轮又踩了一次；tools/qa 下已经有过同样的教训）。
 *
 * 本脚本只删 packages/*\/dist 与 apps/*\/dist 下的 .map，不碰 node_modules，不做别的清理。
 * 退出码恒为 0（"没有可删的"不是错误）。
 */
import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const roots = ['packages', 'apps']
let removed = 0

function walk(dir) {
  let entries
  try { entries = readdirSync(dir) } catch { return }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git') continue
    const p = join(dir, name)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) { walk(p); continue }
    if (!name.endsWith('.map')) continue
    try { rmSync(p); removed++; console.log(`[clean-dist-maps] 删除 ${p}`) } catch { /* ignore */ }
  }
}

for (const r of roots) walk(r)
console.log(`[clean-dist-maps] 完成：删除 ${removed} 个 sourcemap 文件`)
