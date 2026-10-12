/** _rootq.mjs —— 检查 RootQ 与 hips 旋转 */
import { parseAnim, authoritativeCurves, indexCurves, sampleCurve } from './parse-anim.mjs'
const base = 'F:/deepseek harness/AI女友/repos/Mate-Engine/Assets/MATE ENGINE - Animations/'
for (const rel of ['PET_IDLE/PET_IDLE.anim', 'PET_IDLE/PET_IDLE_2.anim', 'PET_POSE/PET_POSE_1.anim', 'PET_LOCOMOTION/PET_WALK_LEFT.anim']) {
  const p = parseAnim(base + rel)
  const { map } = indexCurves(authoritativeCurves(p))
  const q = {}
  for (const a of ['x', 'y', 'z', 'w']) {
    const c = map.get(`RootQ.${a}`)
    q[a] = c ? sampleCurve(c.keys, 0) : (a === 'w' ? 1 : 0)
  }
  const n = Math.hypot(q.x, q.y, q.z, q.w)
  const ang = 2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180 / Math.PI
  const s = Math.sqrt(Math.max(0, 1 - q.w * q.w))
  const axis = s > 1e-6 ? [q.x / s, q.y / s, q.z / s].map((v) => +v.toFixed(3)) : [0, 0, 0]
  // Unity 的欧拉（ZXY 抽取，仅供直觉）
  console.log(`${rel.replace(/.*\//, '').padEnd(22)} RootQ t=0 = [${q.x.toFixed(5)}, ${q.y.toFixed(5)}, ${q.z.toFixed(5)}, ${q.w.toFixed(5)}]  |q|=${n.toFixed(5)}  角=${ang.toFixed(2)}°  轴=[${axis.join(',')}]`)
  // 全段范围
  for (const a of ['x', 'y', 'z', 'w']) {
    const c = map.get(`RootQ.${a}`); if (!c) continue
    let mn = 1e9, mx = -1e9
    for (const k of c.keys) { if (k[1] < mn) mn = k[1]; if (k[1] > mx) mx = k[1] }
    console.log(`    RootQ.${a} range=[${mn.toFixed(4)}, ${mx.toFixed(4)}]`)
  }
}
