/**
 * tools/qa/negative-claims-test.mjs —— check-claims 的**负向验证**
 *
 * 为什么必须有它：
 *   一条断言"通过"有两种可能 —— ① 被测对象真的合规；② **断言恒真（根本没在检查）**。
 *   A9 的口径拆分把 `no-remote-resources-in-bundle` 的正则改窄了，
 *   而"改窄"这个动作本身就带着"改到什么都不匹配"的风险。
 *   所以必须证明：**注入一个真违规，它一定会红。**
 *
 * 做法（逐条、可恢复）：
 *   把一段**合成的违规**临时追加进一个真实产物的副本位置（改原文件 → 测 → **立刻还原**），
 *   跑一次 check-claims，断言它**确实 FAIL**；无论成败都在 finally 里还原原字节。
 *
 * ⚠ 它**不是**常规回归的一部分（会临时改产物文件）；只在改过 check-claims 之后手工跑：
 *     node tools/qa/negative-claims-test.mjs
 * 退出码：0 = 每条负向用例都被抓住；1 = 有负向用例**没被抓住**（= 断言可能是恒真的）
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const ROOT = process.cwd()
const TARGET = join(ROOT, 'apps/renderer/dist/index.html')

if (!existsSync(TARGET)) {
  console.error(`[neg] 找不到 ${TARGET} —— 请先构建 renderer（npm run build:renderer）`)
  process.exit(2)
}

/**
 * ★ 只改 **CSP 属性里的那一份**，不碰 HTML 注释里的同名文字。
 *
 *   为什么必须这么精确（第一版就栽在这里）：`index.html` 的注释里也写着
 *   "`connect-src` 必须含 `app:`" 这类字样，而 `String.replace(子串, …)`
 *   **只替换第一处** —— 于是"注入"改的是注释、CSP 原封不动，
 *   负向用例表现为"没抓住"，看起来像断言恒真，其实是**测试自己没改到地方**。
 *   （`script-src 'self'` 在文件里出现 2 次，第一处正是注释。）
 */
function mutateCsp(html, from, to) {
  return html.replace(
    /(Content-Security-Policy"[^>]*content=")([^"]+)(")/i,
    (all, pre, csp, post) => (csp.includes(from) ? `${pre}${csp.replace(from, to)}${post}` : all),
  )
}

/**
 * 负向用例：每一段是"如果这段代码真的出现在产物里，对应断言必须 FAIL"。
 * `expectFail` 是**必须变红的那条断言 id**。
 */
const CASES = [
  {
    id: 'remote-script-tag',
    inject: '<script src="https://evil.example.com/tracker.js"></script>',
    expectFail: 'no-remote-resources-in-bundle',
    why: '<script src> 是真正的远程资源加载',
  },
  {
    id: 'remote-link-href',
    inject: '<link rel="stylesheet" href="https://cdn.example.com/x.css">',
    expectFail: 'no-remote-resources-in-bundle',
    why: '远程样式表',
  },
  {
    id: 'css-url-remote-font',
    inject: '<style>@font-face{src:url(https://fonts.example.com/f.woff2)}</style>',
    expectFail: 'no-remote-resources-in-bundle',
    why: 'CSS url() 远程字体',
  },
  {
    id: 'remote-dynamic-import',
    inject: '<script>import("https://cdn.example.com/mod.js")</script>',
    expectFail: 'no-remote-resources-in-bundle',
    why: '动态 import 远程模块',
  },
  {
    id: 'csp-wildcard',
    inject: '',
    mutate: (html) => mutateCsp(html, "connect-src 'self'", 'connect-src *'),
    expectFail: 'renderer-csp-blocks-remote-egress',
    why: 'CSP 放行通配源 ⇒ 库级 fetch 就够得着外域了',
  },
  {
    id: 'csp-unsafe-eval',
    inject: '',
    mutate: (html) => mutateCsp(html, "script-src 'self'", "script-src 'self' 'unsafe-eval'"),
    expectFail: 'renderer-csp-blocks-remote-egress',
    why: "CSP 放行 'unsafe-eval'",
  },
]

/** 跑一次 check-claims，返回 { pass, failed[] } —— 判据读 JSON，不看退出码 */
function runClaims(label) {
  // ⚠ 临时报告放**系统 temp**，不放 `docs/evidence/` ——
  //   放证据目录会在中途失败时留下 `_tmp-claims-*.json` 垃圾（实测发生过：留下 7 个），
  //   而证据目录是交付面的一部分，不该出现测试残渣。
  const out = join(tmpdir(), `airimate-claims-neg-${label}.json`)
  spawnSync(process.execPath, ['tools/qa/check-claims.mjs', '--json', out], {
    cwd: ROOT, encoding: 'utf8', stdio: 'inherit',
  })
  let report = null
  try { report = JSON.parse(readFileSync(out, 'utf8')) } catch { /* ignore */ }
  try { rmSync(out, { force: true }) } catch { /* ignore */ }
  return report ?? { pass: false, failed: ['<报告解析失败>'], checks: [] }
}

// ── ① 基准：未注入时必须全绿（否则负向结论无意义）
const base = runClaims('base')
if (!base.pass) {
  console.error(`[neg] ✗ 基准就不绿（failed=${base.failed.join(',')}）—— 先修好再谈负向验证`)
  process.exit(1)
}
console.log(`[neg] 基准：${base.checks.length} 条断言全绿（${base.checks.length} checks）`)
console.log('')

const original = readFileSync(TARGET, 'utf8')
let caught = 0
const missed = []

try {
  for (const c of CASES) {
    const mutated = c.mutate ? c.mutate(original) : `${original}\n${c.inject}\n`
    if (mutated === original) {
      missed.push(`${c.id}（注入无效：mutate 没改动文件）`)
      continue
    }
    writeFileSync(TARGET, mutated, 'utf8')
    const r = runClaims(c.id)
    const hit = r.failed.includes(c.expectFail)
    if (hit) { caught++; console.log(`[neg] ✓ ${c.id} ⇒ ${c.expectFail} 变红（正确：${c.why}）`) }
    else {
      missed.push(c.id)
      console.log(`[neg] ✗ ${c.id} ⇒ 期望 ${c.expectFail} 变红，实际 failed=[${r.failed.join(',')}]  ← **没抓住**`)
    }
  }
}
finally {
  // ★ 无论成败都必须还原（原字节写回，不做任何"顺手整理"）
  writeFileSync(TARGET, original, 'utf8')
  console.log('')
  console.log(`[neg] 已还原 ${TARGET.replace(ROOT + '\\', '').replace(/\\/g, '/')}`)
}

console.log('')
console.log(`负向验证：${caught}/${CASES.length} 被抓住`)
if (missed.length) {
  console.log(`✗ 没抓住：${missed.join(', ')} —— 这些断言可能是**恒真**的（等于没在检查）`)
  process.exit(1)
}
console.log('[neg] PASS：每条注入的违规都被对应断言抓住')
