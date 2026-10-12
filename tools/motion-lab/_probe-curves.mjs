import { readFileSync } from 'node:fs'
const P = 'F:/deepseek harness/AI女友/repos/Mate-Engine/Assets/MATE ENGINE - Animations/PET_IDLE/PET_IDLE.anim'
const lines = readFileSync(P, 'utf8').split(/\r?\n/)
const floats = []
const editors = []
for (let i = 0; i < lines.length; i++) {
  const m = /^    attribute: ?(.*)$/.exec(lines[i])
  if (!m) continue
  const rec = { i, attr: m[1].trim(), vals: [], times: [] }
  for (let j = i; j < lines.length; j++) {
    if (j > i && /^    attribute: /.test(lines[j])) break
    if (/^  m_[A-Za-z]+:/.test(lines[j])) break
    const t = /^ {8}time: ?(-?[0-9.eE+-]+)$/.exec(lines[j]); if (t) rec.times.push(Number(t[1]))
    const v = /^ {8}value: ?(-?[0-9.eE+-]+)$/.exec(lines[j]); if (v) rec.vals.push(Number(v[1]))
  }
  ;(i < 18285 ? floats : editors).push(rec)
}
console.log('float curve count', floats.length, ' editor curve count', editors.length)
const find = (arr, a) => arr.find((r) => r.attr === a)
for (const a of ['Spine Front-Back', 'Left Arm Down-Up', 'Left Eye Down-Up', 'LeftUpperLeg Front-Back', 'Left Upper Leg Front-Back', 'LeftHand.Index.1 Stretched']) {
  const f = find(floats, a), e = find(editors, a)
  console.log(`\n[${a}]`)
  console.log('  float  keys=' + (f ? f.vals.length : 'N/A') + '  head=' + (f ? f.vals.slice(0, 6).map((v) => v.toFixed(5)).join(', ') : ''))
  console.log('  editor keys=' + (e ? e.vals.length : 'N/A') + '  head=' + (e ? e.vals.slice(0, 6).map((v) => v.toFixed(5)).join(', ') : ''))
}
// 用 editor 的属性名集合与 float 对比
const sf = new Set(floats.map((r) => r.attr)), se = new Set(editors.map((r) => r.attr))
console.log('\n仅 float 有:', [...sf].filter((x) => !se.has(x)))
console.log('仅 editor 有:', [...se].filter((x) => !sf.has(x)))
console.log('float 里的非肌肉/非标准项:', [...sf].filter((x) => !/^Root[TO]\.|Hand|Foot/.test(x)).length)
console.log('全部 float 属性名:')
console.log([...sf].join('\n'))
