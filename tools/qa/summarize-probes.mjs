/**
 * tools/qa/summarize-probes.mjs —— 把一堆探针 JSON 汇总成"人看得懂、机器可复核"的一张表
 *
 * 为什么需要它（本轮实测踩到）：
 *   各探针的**判定字段命名并不统一** —— `pass` / `allPass` / `passA10` / `passA11a` /
 *   `passHitRegionMatchesVisual` / `passWheelInWindow` / `checks{...}` 都有。
 *   于是"用 `pass` 字段数数"会得到 `checks=0/0` 这种**假空结果**（本轮第一次汇总就撞上了），
 *   而**假空结果与真失败无法区分** —— 这正是本项目反复强调要避免的那类错误。
 *
 * 本脚本改成：**递归收集一切 `pass*` / `allPass` 布尔字段**，外加 `checks{...}` 的 true/false 计数，
 * 并把 `fail*` / `errors` 之类的反向字段一并列出。任何**一个** false 或非空 errors ⇒ 该探针判 FAIL。
 *
 * 用法：
 *   node tools/qa/summarize-probes.mjs <目录> [--json <输出.json>]
 * 退出码：0 = 全部探针通过；1 = 有任一探针失败或无 JSON（**不静默成功**）
 */
import { readdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const args = process.argv.slice(2)
const dir = args[0] ? join(ROOT, args[0]) : null
const jsonIdx = args.indexOf('--json')
const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : null

if (!dir || !existsSync(dir)) {
  console.error('[probes] 用法：node tools/qa/summarize-probes.mjs <目录> [--json <输出.json>]')
  console.error(`[probes] 目录不存在：${String(dir)}`)
  process.exit(1)
}

/** 递归收集布尔字段：key 命中 /^pass/i ⇒ 正向；/^fail/i ⇒ 反向；/^errors?$/i ⇒ 数组内容 */
function scan(node, path, acc, depth = 0) {
  if (depth > 8 || node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    /** ⚠ 末尾的 `[0]` 下标会破坏 `/^errors?$/` —— 先剥掉下标再判键名（实测踩到） */
    const leaf = (path.split('.').pop() ?? '').replace(/\[\d+\]$/, '')
    if (/^errors?$/i.test(leaf) && node.length > 0) {
      /**
       * ⚠ `errors: [0]` 是**零错误**的另一种写法（真实踩到：`a10` 探针用 `errors:[0]` 表示"0 个错误"）。
       *   把所有非零元素才算错误，否则会把"没问题"读成"有问题"（假结论比漏报更坏）。
       */
      const real = node.filter(x => {
        if (x === null || x === undefined || x === false || x === 0 || x === '') return false
        if (typeof x === 'object' && Object.keys(x).length === 0) return false
        return true
      })
      if (real.length > 0) acc.errors.push(...real.map(x => `${path}=${JSON.stringify(x).slice(0, 60)}`))
    }
    for (let i = 0; i < node.length; i++) scan(node[i], `${path}[${i}]`, acc, depth + 1)
    return
  }
  for (const [k, v] of Object.entries(node)) {
    const p = path ? `${path}.${k}` : k
    if (typeof v === 'boolean') {
      /**
       * ⚠ **不把 `ok` 当作判定字段**（本轮实测踩到）：本项目大量使用"**拒绝即正确**"的语义 ——
       *   `listenWhenDisabled.ok=false`、`callStartDenied.ok=false`、`fsAddSensitive.ok=false`、
       *   `badUrlReject.ok=false` 全都是**门禁正确工作**的读数，把它们算成失败会得到
       *   完全相反的结论。判定只认 `pass*` / `allPass` / `fail*`。
       */
      if (/^pass/i.test(k) || /^allPass$/i.test(k)) acc.pass.push({ key: p, value: v })
      else if (/^fail/i.test(k)) acc.fail.push({ key: p, value: v })
      continue
    }
    if (Array.isArray(v)) {
      if (/^fail/i.test(k) && v.length > 0) acc.fail.push({ key: p, value: `${v.length} 条` })
      /**
       * ⚠ 与数组分支**同一口径**：`errors: [0]` / `errors: []` 都表示"零错误"。
       *   两条路径必须一起过滤 —— 只修一处会留下"同一份数据两种结论"的漂移
       *   （本轮实测踩到：先修了数组分支，属性分支仍在报 `errors=[0]` 为失败）。
       */
      if (/^errors?$/i.test(k) && v.length > 0) {
        const real = v.filter(x => {
          if (x === null || x === undefined || x === false || x === 0 || x === '') return false
          if (typeof x === 'object' && Object.keys(x).length === 0) return false
          return true
        })
        if (real.length > 0) acc.errors.push(`${p}=${JSON.stringify(real).slice(0, 60)}`)
      }
      scan(v, p, acc, depth + 1)
      continue
    }
    scan(v, p, acc, depth + 1)
  }
}

/**
 * ⚠ 排除本脚本自己的产物（`_summary.json`）与任何以下划线开头的辅助文件：
 *   否则第二次运行时会把上一次的汇总当成一个探针来判，得到"自己判自己失败"的荒谬结果
 *   （实测踩到：`_summary.json` 里 `pass:false` 被计成一条失败探针）。
 *
 * ⚠ 还要排除**不是探针**的同目录产物：`desktop-state-*.json`（桌面/窗口清点快照）与
 *   `MANIFEST.json` 之类。它们没有 `pass*` 字段，硬判就会得到"JSON 解析失败/无判定字段"的
 *   **假失败**（实测踩到）。判据：既无 `pass*` 字段、也无 `checks{}` 的，**跳过并如实计数**。
 */
const SKIP_PATTERNS = [/^_/, /^desktop-state-/, /^MANIFEST\.json$/i]
const allFiles = readdirSync(dir).filter(f => f.toLowerCase().endsWith('.json')).sort()
const skipped = allFiles.filter(f => SKIP_PATTERNS.some(re => re.test(f)))
const files = allFiles.filter(f => !SKIP_PATTERNS.some(re => re.test(f)))
if (files.length === 0) {
  console.error(`[probes] 目录里没有 JSON：${dir}`)
  process.exit(1)
}

const rows = []
let allPass = true
for (const f of files) {
  const full = join(dir, f)
  let data
  try { data = JSON.parse(readFileSync(full, 'utf8')) } catch (e) {
    rows.push({ file: f, pass: false, reason: `JSON 解析失败：${e instanceof Error ? e.message.slice(0, 80) : '未知'}` })
    allPass = false
    continue
  }
  const acc = { pass: [], fail: [], errors: [] }
  scan(data, '', acc)
  const passTrue = acc.pass.filter(x => x.value === true).length
  const passFalse = acc.pass.filter(x => x.value === false).map(x => x.key)
  const failHits = acc.fail.filter(x => x.value === true || typeof x.value === 'string').map(x => x.key)
  // `checks{...}` 单独统计（很多探针把 20~50 条断言放这里）
  const checks = (data && typeof data.checks === 'object' && data.checks !== null) ? data.checks : null
  const checkTotal = checks ? Object.keys(checks).length : 0
  const checkTrue = checks ? Object.values(checks).filter(v => v === true).length : 0
  const ok = passFalse.length === 0 && failHits.length === 0 && acc.errors.length === 0 && passTrue + checkTrue > 0
  if (!ok) allPass = false
  rows.push({
    file: f,
    pass: ok,
    passFieldsTrue: passTrue,
    passFieldsFalse: passFalse,
    failFields: failHits,
    errors: acc.errors,
    checksTotal: checkTotal,
    checksTrue: checkTrue,
  })
}

const result = {
  schema: 'airimate/probe-summary/1',
  summarizedAt: new Date().toISOString(),
  dir: relative(ROOT, dir).split('\\').join('/'),
  probeCount: rows.length,
  passed: rows.filter(r => r.pass).length,
  failed: rows.filter(r => !r.pass).length,
  /** 被跳过的非探针文件（如实列出，避免"少算了却不知道"） */
  skippedNonProbes: skipped,
  rows,
  pass: allPass,
}
if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(result, null, 2)}\n`, 'utf8')

console.log(`探针汇总：${result.dir}  共 ${result.probeCount} 个，通过 ${result.passed}，失败 ${result.failed}`)
if (skipped.length) console.log(`（另有 ${skipped.length} 个非探针 JSON 已跳过：${skipped.join(', ')}）`)
console.log('')
console.log('探针'.padEnd(14) + '判定'.padEnd(8) + 'pass* 真'.padEnd(10) + 'checks')
console.log('-'.repeat(56))
for (const r of rows) {
  const verdict = r.pass ? 'PASS' : 'FAIL'
  const checkStr = r.checksTotal ? `${r.checksTrue}/${r.checksTotal}` : '—'
  console.log(String(r.file).padEnd(14) + verdict.padEnd(8) + String(r.passFieldsTrue).padEnd(10) + checkStr)
  if (!r.pass) {
    if (r.reason) console.log(`   ! ${r.reason}`)
    if (r.passFieldsFalse?.length) console.log(`   ! 为 false 的判定字段：${r.passFieldsFalse.join(', ')}`)
    if (r.failFields?.length) console.log(`   ! 命中 fail* 字段：${r.failFields.join(', ')}`)
    if (r.errors?.length) console.log(`   ! errors 非空：${r.errors.slice(0, 3).join(' | ')}`)
  }
}
console.log('')
console.log(result.pass ? '[probes] PASS' : '[probes] FAIL')
process.exit(result.pass ? 0 : 1)
