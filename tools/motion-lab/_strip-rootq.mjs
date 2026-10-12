/**
 * _strip-rootq.mjs —— 诊断用：把 VRMA 里 hips 的 rotation 轨道换成单位四元数，
 * 看骨架是否变成直立（用来验证"RootQ 是 180° 的根节点朝向，不该写进 VRMA"）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { Buffer } from 'node:buffer'

const src = process.argv[2]
const dst = process.argv[3]
const buf = readFileSync(src)
const jl = buf.readUInt32LE(12)
const json = JSON.parse(buf.subarray(20, 20 + jl).toString('utf8'))
const binChunkOff = 20 + jl
const binLen = buf.readUInt32LE(binChunkOff)
const bin = buf.subarray(binChunkOff + 8, binChunkOff + 8 + binLen)

const hb = json.extensions.VRMC_vrm_animation.humanoid.humanBones
const hipsNode = hb.hips.node
const anim = json.animations[0]
let patched = 0
for (const ch of anim.channels) {
  if (ch.target.node !== hipsNode) continue
  if (ch.target.path !== 'rotation') continue
  const s = anim.samplers[ch.sampler]
  const acc = json.accessors[s.output]
  const bv = json.bufferViews[acc.bufferView]
  const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0)
  for (let i = 0; i < acc.count; i++) {
    bin.writeFloatLE(0, base + i * 16)
    bin.writeFloatLE(0, base + i * 16 + 4)
    bin.writeFloatLE(0, base + i * 16 + 8)
    bin.writeFloatLE(1, base + i * 16 + 12)
  }
  patched++
}
console.log(`hips node=${hipsNode}，patch 了 ${patched} 条 rotation 轨道（共 ${anim.channels.length} 条通道）`)

let jb = Buffer.from(JSON.stringify(json), 'utf8')
if (jb.length % 4) jb = Buffer.concat([jb, Buffer.alloc(4 - (jb.length % 4), 0x20)])
const head = Buffer.alloc(12); head.write('glTF', 0, 'ascii'); head.writeUInt32LE(2, 4)
const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b }
const total = 12 + 8 + jb.length + 8 + binLen
head.writeUInt32LE(total, 8)
const out = Buffer.concat([head, ch(jb.length, 0x4e4f534a), jb, ch(binLen, 0x004e4942), bin])
writeFileSync(dst, out)
console.log(`写出 ${dst}（${out.length} 字节）`)
