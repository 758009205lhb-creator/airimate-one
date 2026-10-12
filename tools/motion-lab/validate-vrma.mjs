/**
 * validate-vrma.mjs —— **独立** VRMA 校验器
 *
 * 「独立」是硬要求：本文件**不 import** `convert-anim.mjs` / `humanoid-map.mjs` /
 * `parse-anim.mjs` 的任何东西。它自己：
 *   · 按字节解析 GLB（header / chunk 布局 / 对齐）
 *   · 自己走 accessor → bufferView → buffer 的越界检查
 *   · 自己读浮点、自己判四元数归一化、自己判时间严格递增
 *   · 自己按 `VRMC_vrm_animation` 规范核对轨道语义
 * 这样它才能抓出"生成器自己也搞错了"的情况。
 *
 * 检查项
 *   G-01 GLB magic == 'glTF' / version == 2 / header.length == 文件实际长度
 *   G-02 chunk 布局：JSON 块第一、BIN 块第二、每块长度 4 字节对齐、无越界
 *   G-03 asset.version == "2.0"
 *   G-04 extensionsUsed 含 VRMC_vrm_animation，且有 extensions.VRMC_vrm_animation
 *   G-05 specVersion ∈ {1.0, 1.0-draft}
 *   A-01 每个 accessor 不越出它的 bufferView；byteStride 合法
 *   A-02 每个 sampler 的 input 是 SCALAR float、output 是 VEC4(float)/VEC3(float)
 *   A-03 时间严格递增、首帧 >= 0、与其它 sampler 的 input 一致（可共享）
 *   Q-01 所有旋转四元数 |q| − 1| < 1e-3
 *   Q-02 四元数无 NaN/Inf
 *   H-01 humanoid.humanBones 存在且每项有数字 node
 *   H-02 全部 humanBones 的 node 索引在 nodes 范围内、且不重复
 *   H-03 hips 必须存在（加载器要用它算 rest 姿势）
 *   H-04 任务书要求的 22 根核心骨必须齐全
 *   T-01 只有 hips 允许有 translation 轨道
 *   T-02 每条 rotation 轨道对应的 node 必须在 humanBones 里（否则是死轨道）
 *   M-01 非静态：至少一条旋转轨道的分量幅度 > 1e-3；或时长 > 0
 *   M-02 时长 > 0，且 ≤ 60s（防呆）
 *
 * 用法
 *   node validate-vrma.mjs --dir <目录> [--json <报告路径>]
 *   node validate-vrma.mjs --in <file.vrma> [--json ...]
 * 退出码：0 全部通过 / 1 有 FAIL / 2 环境不可用
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { join, resolve, basename, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }
const TYPE_COMPS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }

/** 任务书要求的 22 根核心人形骨（VRMA 规范名） */
const CORE_BONES = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
]

// ═════════════════════════════════════════════ GLB 字节级解析

function parseGlb(buf) {
  const r = { errors: [], json: null, bin: null, chunks: [] }
  if (buf.length < 12) { r.errors.push('长度 < 12，不是 GLB'); return r }
  const magic = buf.readUInt32LE(0)
  const version = buf.readUInt32LE(4)
  const declared = buf.readUInt32LE(8)
  if (magic !== 0x46546c67) r.errors.push(`magic 不是 'glTF'（读到 0x${magic.toString(16)}）`)
  if (version !== 2) r.errors.push(`version 不是 2（读到 ${version}）`)
  if (declared !== buf.length) r.errors.push(`header.length=${declared} ≠ 实际文件长度 ${buf.length}`)
  let off = 12, idx = 0
  while (off + 8 <= buf.length) {
    const clen = buf.readUInt32LE(off)
    const ctype = buf.readUInt32LE(off + 4)
    const cstart = off + 8
    const c = { index: idx++, offset: off, length: clen, type: ctype, typeName: ctype === 0x4e4f534a ? 'JSON' : ctype === 0x004e4942 ? 'BIN' : `0x${ctype.toString(16)}` }
    if (cstart + clen > buf.length) { r.errors.push(`chunk#${c.index}(${c.typeName}) 越界：offset=${cstart} len=${clen} 文件长=${buf.length}`); break }
    if (clen % 4 !== 0) r.errors.push(`chunk#${c.index}(${c.typeName}) 长度 ${clen} 不是 4 的倍数（glTF 规范要求对齐）`)
    const data = buf.subarray(cstart, cstart + clen)
    if (ctype === 0x4e4f534a) { if (r.json) r.errors.push('出现第二个 JSON chunk'); else { try { r.json = JSON.parse(data.toString('utf8')) } catch (e) { r.errors.push(`JSON chunk 解析失败：${e.message}`) } } }
    else if (ctype === 0x004e4942) { if (r.bin) r.errors.push('出现第二个 BIN chunk'); else r.bin = data }
    r.chunks.push(c)
    off = cstart + clen
  }
  if (off !== buf.length) r.errors.push(`chunk 累计长度 ${off} ≠ 文件长度 ${buf.length}（尾部有 ${buf.length - off} 字节残留）`)
  if (!r.json) r.errors.push('没有 JSON chunk')
  if (r.chunks[0] && r.chunks[0].type !== 0x4e4f534a) r.errors.push('第一个 chunk 不是 JSON（glTF 规范要求 JSON 在前）')
  return r
}

/** 读 accessor 的第 i 个元素的第 c 个分量（float32 专用） */
function readFloat(glb, accessorIndex, i, c = 0) {
  const g = glb.json
  const a = g.accessors[accessorIndex]
  const bv = g.bufferViews[a.bufferView]
  const comps = TYPE_COMPS[a.type]
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0)
  const stride = bv.byteStride ?? comps * COMPONENT_BYTES[a.componentType]
  return glb.bin.readFloatLE(base + i * stride + c * 4)
}

/** accessor 需要的字节数 / 可用字节数 */
function accessorBounds(glb, accessorIndex) {
  const g = glb.json
  const a = g.accessors[accessorIndex]
  if (!a) return { ok: false, reason: `accessor[${accessorIndex}] 不存在` }
  if (a.bufferView == null) return { ok: true, need: 0, avail: 0, reason: '无 bufferView（稀疏/空）' }
  const bv = g.bufferViews[a.bufferView]
  if (!bv) return { ok: false, reason: `accessor[${accessorIndex}].bufferView=${a.bufferView} 不存在` }
  const comps = TYPE_COMPS[a.type]
  const cb = COMPONENT_BYTES[a.componentType]
  if (!comps || !cb) return { ok: false, reason: `accessor[${accessorIndex}] 的 type/componentType 非法（${a.type}/${a.componentType}）` }
  const elemBytes = comps * cb
  const stride = bv.byteStride ?? elemBytes
  const need = a.count === 0 ? 0 : (a.count - 1) * stride + elemBytes
  const avail = bv.byteLength - (a.byteOffset ?? 0)
  return { ok: need <= avail, need, avail, elemBytes, stride, comps, cb, type: a.type, componentType: a.componentType, count: a.count, bufferView: a.bufferView }
}

// ═════════════════════════════════════════════ 单文件校验

function validateFile(path) {
  const checks = []
  const ck = (id, name, ok, detail) => { checks.push({ id, name, ok: !!ok, detail }); return !!ok }
  const buf = readFileSync(path)
  const glb = parseGlb(buf)

  ck('G-01', 'GLB 头部（magic/version/length）', glb.errors.filter((e) => /magic|version|header/.test(e)).length === 0,
    glb.errors.filter((e) => /magic|version|header/.test(e)).join('; ') || `bytes=${buf.length}`)
  ck('G-02', 'chunk 布局与 4 字节对齐、无越界', glb.errors.filter((e) => /chunk|残留/.test(e)).length === 0,
    glb.errors.filter((e) => /chunk|残留/.test(e)).join('; ') || glb.chunks.map((c) => `${c.typeName}:${c.length}`).join(' + '))
  ck('G-03', 'JSON chunk 可解析', !!glb.json, glb.json ? `${Object.keys(glb.json).length} 个顶层键` : glb.errors.join('; '))
  if (!glb.json) return { path, checks, pass: 0, fail: checks.length, ok: false }

  const g = glb.json
  const ext = g.extensions?.VRMC_vrm_animation

  ck('G-03b', 'asset.version == "2.0"', g.asset?.version === '2.0', `asset=${JSON.stringify(g.asset)}`)
  ck('G-04', 'extensionsUsed 含 VRMC_vrm_animation 且 extensions 里有它',
    Array.isArray(g.extensionsUsed) && g.extensionsUsed.includes('VRMC_vrm_animation') && !!ext,
    `extensionsUsed=${JSON.stringify(g.extensionsUsed)}`)
  ck('G-05', 'specVersion ∈ {1.0, 1.0-draft}', ext?.specVersion === '1.0' || ext?.specVersion === '1.0-draft', `specVersion=${ext?.specVersion}`)

  // ── accessor 边界
  const boundErrs = []
  let bvStrideBad = 0
  for (let i = 0; i < (g.accessors?.length ?? 0); i++) {
    const b = accessorBounds(glb, i)
    if (!b.ok) boundErrs.push(b.reason ?? `accessor[${i}] 越界 need=${b.need} avail=${b.avail}`)
  }
  for (const [i, bv] of (g.bufferViews ?? []).entries()) {
    if (bv.byteStride != null && bv.byteStride % 4 !== 0) { bvStrideBad++; }
    if ((bv.byteOffset ?? 0) + bv.byteLength > (glb.bin?.length ?? 0)) boundErrs.push(`bufferView[${i}] 越出 BIN（off=${bv.byteOffset ?? 0} len=${bv.byteLength} BIN=${glb.bin?.length ?? 0}）`)
  }
  ck('A-01', '全部 accessor / bufferView 不越界、byteStride 合法', boundErrs.length === 0 && bvStrideBad === 0,
    boundErrs.slice(0, 4).join('; ') || `${g.accessors?.length ?? 0} accessor / ${g.bufferViews?.length ?? 0} bufferView`)

  // ── humanBones
  const hb = ext?.humanoid?.humanBones
  const hbEntries = Object.entries(hb ?? {})
  ck('H-01', 'humanoid.humanBones 存在且每项 node 为数字',
    hbEntries.length > 0 && hbEntries.every(([, v]) => typeof v?.node === 'number'),
    `${hbEntries.length} 根`)
  const nodeCount = g.nodes?.length ?? 0
  const badNode = hbEntries.filter(([, v]) => !(v.node >= 0 && v.node < nodeCount)).map(([k]) => k)
  ck('H-02', 'humanBones 的 node 索引在 nodes 范围内', badNode.length === 0, badNode.length ? `越界: ${badNode.join(',')}` : `nodes=${nodeCount}`)
  const nodeVals = hbEntries.map(([, v]) => v.node)
  ck('H-02b', 'humanBones 的 node 不重复', new Set(nodeVals).size === nodeVals.length,
    new Set(nodeVals).size === nodeVals.length ? 'ok' : `有重复：${nodeVals.filter((v, i) => nodeVals.indexOf(v) !== i).join(',')}`)
  ck('H-03', 'hips 存在（加载器要用它算 rest 姿势）', !!hb?.hips && typeof hb.hips.node === 'number', hb?.hips ? `node=${hb.hips.node}` : 'missing')
  const missingCore = CORE_BONES.filter((b) => !hb?.[b] || typeof hb[b].node !== 'number')
  ck('H-04', `任务书要求的 ${CORE_BONES.length} 根核心骨齐全`, missingCore.length === 0, missingCore.length ? `缺: ${missingCore.join(',')}` : `${CORE_BONES.length}/${CORE_BONES.length}`)

  // ── 动画
  const anims = g.animations ?? []
  ck('N-01', '恰有 1 条 animation', anims.length === 1, `anims=${anims.length}`)
  const anim = anims[0]
  if (!anim) return finish(path, checks)

  const nodeToBone = new Map(hbEntries.map(([k, v]) => [v.node, k]))
  const samplerErrs = []
  const timeErrs = []
  let duration = 0
  const inputsSeen = new Map()
  for (const [si, s] of (anim.samplers ?? []).entries()) {
    const bi = accessorBounds(glb, s.input), bo = accessorBounds(glb, s.output)
    if (!bi.ok || bi.type !== 'SCALAR' || bi.componentType !== 5126) samplerErrs.push(`sampler[${si}].input 非 SCALAR/float32 或越界`)
    if (!bo.ok || bo.componentType !== 5126 || (bo.type !== 'VEC4' && bo.type !== 'VEC3')) samplerErrs.push(`sampler[${si}].output 非 VEC4/VEC3 float32 或越界`)
    if (bi.ok && bo.ok && bi.count !== bo.count) samplerErrs.push(`sampler[${si}] input.count=${bi.count} ≠ output.count=${bo.count}`)
    if (s.interpolation != null && s.interpolation !== 'LINEAR') samplerErrs.push(`sampler[${si}].interpolation=${s.interpolation}（本工程只产出 LINEAR）`)
    if (bi.ok) {
      let prev = -Infinity
      for (let i = 0; i < bi.count; i++) {
        const t = readFloat(glb, s.input, i)
        if (!(t > prev)) timeErrs.push(`sampler[${si}] t[${i}]=${t} 不是严格递增（前一个 ${prev}）`)
        if (t < 0) timeErrs.push(`sampler[${si}] t[${i}]=${t} < 0`)
        prev = t
      }
      const first = bi.count ? readFloat(glb, s.input, 0) : 0
      const last = bi.count ? readFloat(glb, s.input, bi.count - 1) : 0
      if (bi.count > 0 && first !== 0) timeErrs.push(`sampler[${si}] 首帧 t=${first} ≠ 0`)
      duration = Math.max(duration, last)
      const key = `${bi.count}:${first}:${last}`
      inputsSeen.set(key, (inputsSeen.get(key) ?? 0) + 1)
    }
  }
  ck('A-02', 'sampler 的 input/output 类型与 count 自洽', samplerErrs.length === 0, samplerErrs.slice(0, 4).join('; ') || `${anim.samplers?.length ?? 0} sampler`)
  ck('A-03', '采样时间严格递增、首帧为 0、非负', timeErrs.length === 0, timeErrs.slice(0, 3).join('; ') || `duration=${duration.toFixed(6)}s，input 组合数=${inputsSeen.size}`)

  // ── 四元数
  let qBad = 0, qNaN = 0, qCount = 0, maxDev = 0
  for (const ch of anim.channels ?? []) {
    if (ch.target?.path !== 'rotation') continue
    const a = g.accessors[anim.samplers[ch.sampler].output]
    for (let i = 0; i < a.count; i++) {
      const x = readFloat(glb, anim.samplers[ch.sampler].output, i, 0)
      const y = readFloat(glb, anim.samplers[ch.sampler].output, i, 1)
      const z = readFloat(glb, anim.samplers[ch.sampler].output, i, 2)
      const w = readFloat(glb, anim.samplers[ch.sampler].output, i, 3)
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(w)) { qNaN++; continue }
      const n = Math.hypot(x, y, z, w)
      const dev = Math.abs(n - 1)
      if (dev > maxDev) maxDev = dev
      qCount++
      if (dev >= 1e-3) qBad++
    }
  }
  ck('Q-01', '全部旋转四元数归一化（|q|−1| < 1e-3）', qBad === 0, qBad ? `${qBad}/${qCount} 未归一化，最大偏差 ${maxDev.toExponential(3)}` : `${qCount} 个四元数，最大偏差 ${maxDev.toExponential(3)}`)
  ck('Q-02', '四元数无 NaN/Inf', qNaN === 0, qNaN ? `${qNaN} 个非有限值` : 'ok')

  // ── 轨道语义
  const transBad = [], deadRot = []
  const rotBones = new Set(), transBones = new Set()
  for (const ch of anim.channels ?? []) {
    const bone = nodeToBone.get(ch.target?.node)
    if (bone == null) { if (ch.target?.path === 'rotation' || ch.target?.path === 'translation') deadRot.push(`node${ch.target?.node}`); continue }
    if (ch.target.path === 'translation') { transBones.add(bone); if (bone !== 'hips') transBad.push(bone) }
    if (ch.target.path === 'rotation') rotBones.add(bone)
  }
  ck('T-01', 'translation 轨道只出现在 hips', transBad.length === 0, transBad.length ? `违规: ${transBad.join(',')}` : `translation 骨: ${[...transBones].join(',') || '(无)'}`)
  ck('T-02', '每条通道的 node 都在 humanBones 里', deadRot.length === 0, deadRot.length ? `游离节点: ${deadRot.slice(0, 6).join(',')}` : `rotation 骨数=${rotBones.size}`)

  // ── 非静态
  let maxAmp = 0
  for (const ch of anim.channels ?? []) {
    if (ch.target?.path !== 'rotation') continue
    const a = g.accessors[anim.samplers[ch.sampler].output]
    for (let c = 0; c < 4; c++) {
      let mn = Infinity, mx = -Infinity
      for (let i = 0; i < a.count; i++) { const v = readFloat(glb, anim.samplers[ch.sampler].output, i, c); if (v < mn) mn = v; if (v > mx) mx = v }
      if (mx - mn > maxAmp) maxAmp = mx - mn
    }
  }
  const frames = anim.channels?.length ? g.accessors[anim.samplers[anim.channels[0].sampler].input].count : 0
  ck('M-01', '动作非静态（有非零旋转幅度）或为单帧定格', frames <= 1 || maxAmp > 1e-3,
    frames <= 1 ? `单帧（${frames}）` : `最大分量幅度=${maxAmp.toFixed(6)}`)
  ck('M-02', '时长 > 0 且 ≤ 60s', duration > 0 && duration <= 60, `duration=${duration.toFixed(6)}s frames=${frames}`)

  return finish(path, checks, { duration, frames, bones: hbEntries.length, rotationTracks: rotBones.size, translationTracks: transBones.size })
}

function finish(path, checks, info = {}) {
  const pass = checks.filter((c) => c.ok).length
  return { path, checks, pass, fail: checks.length - pass, ok: pass === checks.length, info }
}

// ═════════════════════════════════════════════ CLI

const isDirectRun = (() => {
  try {
    const entry = process.argv[1] ? resolve(process.argv[1]) : ''
    return !!entry && resolve(fileURLToPath(import.meta.url)) === entry
  } catch { return false }
})()

if (isDirectRun) {
  const argv = process.argv.slice(2)
  const has = (f) => argv.includes(f)
  const valOf = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d }

  if (has('--help') || argv.length === 0) {
    console.log('用法: node validate-vrma.mjs --dir <目录> [--json <报告.json>] | --in <file.vrma>')
    process.exit(argv.length === 0 ? 2 : 0)
  }

  let files = []
  if (has('--in')) {
    const p = valOf('--in')
    if (!existsSync(p)) { console.error(`[环境不可用] 文件不存在：${p}`); process.exit(2) }
    files = [p]
  } else {
    const dir = valOf('--dir', null)
    if (!dir) { console.error('必须给 --dir 或 --in'); process.exit(2) }
    if (!existsSync(dir)) { console.error(`[环境不可用] 目录不存在：${dir}`); process.exit(2) }
    files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.vrma')).sort().map((f) => join(dir, f))
    if (!files.length) { console.error(`[环境不可用] ${dir} 下没有 .vrma`); process.exit(2) }
  }

  const results = []
  let totalFail = 0
  const verbose = has('--verbose')
  for (const f of files) {
    let r
    try { r = validateFile(f) } catch (e) { r = { path: f, checks: [{ id: 'X', name: `解析异常：${e.message}`, ok: false, detail: e.stack?.split('\n')[1] ?? '' }], pass: 0, fail: 1, ok: false, info: {} } }
    results.push(r)
    if (!r.ok) totalFail++
    console.log(`\n=== ${basename(f)} (${statSync(f).size} 字节) ===`)
    for (const c of r.checks) console.log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.id.padEnd(6)} ${c.name}${c.detail ? `  —— ${c.detail}` : ''}`)
    const inf = r.info
    console.log(`  汇总: PASS ${r.pass}/${r.checks.length}  ${r.ok ? '✅' : '❌'}` + (inf.bones != null ? `   骨=${inf.bones} 帧=${inf.frames} 时长=${inf.duration?.toFixed(3)}s rot轨=${inf.rotationTracks} trans轨=${inf.translationTracks}` : ''))
  }

  console.log(`\n===== 逐文件 PASS/FAIL 表 =====`)
  console.log('文件'.padEnd(34) + '结果'.padStart(6) + 'PASS'.padStart(7) + 'FAIL'.padStart(6) + '骨'.padStart(5) + '帧'.padStart(7) + '时长s'.padStart(9) + '字节'.padStart(10))
  for (const r of results) {
    const inf = r.info ?? {}
    console.log(
      basename(r.path).slice(0, 33).padEnd(34) +
      (r.ok ? 'PASS' : 'FAIL').padStart(6) +
      String(r.pass).padStart(7) + String(r.fail).padStart(6) +
      String(inf.bones ?? '-').padStart(5) + String(inf.frames ?? '-').padStart(7) +
      String(inf.duration != null ? inf.duration.toFixed(3) : '-').padStart(9) +
      String(statSync(r.path).size).padStart(10))
  }
  console.log(`\n合计 ${results.length} 个文件；FAIL ${totalFail} 个`)
  console.log(totalFail ? 'VERDICT: FAIL' : 'VERDICT: ALL PASS')

  if (has('--json')) {
    const jp = valOf('--json')
    mkdirSync(dirname(jp), { recursive: true })
    writeFileSync(jp, JSON.stringify({
      schema: 'vrma-validation-report/1',
      generated: new Date().toISOString(),
      // 独立校验器：明确记录"没有 import 生成器"
      independence: '本报告由 validate-vrma.mjs 生成，该脚本不 import convert-anim.mjs / humanoid-map.mjs / parse-anim.mjs',
      nodeVersion: process.version,
      summary: { files: results.length, failed: totalFail, verdict: totalFail ? 'FAIL' : 'PASS' },
      files: results.map((r) => ({ path: r.path, file: basename(r.path), bytes: statSync(r.path).size, ok: r.ok, pass: r.pass, fail: r.fail, info: r.info, checks: r.checks })),
    }, null, 2), 'utf8')
    console.log(`JSON 报告: ${jp}`)
  }
  process.exit(totalFail ? 1 : 0)
}

export { validateFile, parseGlb, CORE_BONES }
