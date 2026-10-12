/**
 * _fixtable.mjs —— 用**确定性字符串手术**把 humanoid-map.mjs 的 MUSCLE_TABLE 段
 * 整体替换为按「推导规则」算出的正确版本。
 *
 * 为什么用脚本而不是手改：手改 24 行 × 3 轴已经在本次会话里出过两次错
 * （轴写成了运动方向而不是旋转轴）。这里把规格写成数据，由脚本生成文本，
 * 生成后再由 `self-check.mjs --semantics` 逐条实测验收。
 *
 * 规格里的 axis 直接用符号化的世界轴名，便于人工核对：
 *   '+X' = 绕世界 +X（也就是骨的 local +X，因为归一化骨 rest 旋转 = 单位阵）
 */
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = 'humanoid-map.mjs'

// ── 规格：[骨, unity名, [槽0, 槽1, 槽2]]
//    槽 = null | [肌肉名, 轴, [负侧极限, 正侧极限], 自由度, 正方向说明, 备注]
const S = (muscle, axis, limit, dof, pos, note) => ({ muscle, axis, limit, dof, pos, note })

const SPEC = [
  ['spine', 'Spine', [
    S('Spine Front-Back', '+X', [-20, 20], 'flexion', '向后', '实测绕 +X 让上身朝 -Z（后）⇒ 「+1=向后」正好 +X'),
    S('Spine Left-Right', '-Z', [-20, 20], 'lateral', '向角色左', '实测绕 +Z 让上身朝 -X（角色右）⇒ 「+1=向左」取 -Z'),
    S('Spine Twist Left-Right', '+Y', [-20, 20], 'twist', '向角色左', '绕 +Y：骨沿 Y ⇒ 纯扭转（实测末端位置不动）'),
  ]],
  ['chest', 'Chest', [
    S('Chest Front-Back', '+X', [-20, 20], 'flexion', '向后', '同 Spine'),
    S('Chest Left-Right', '-Z', [-20, 20], 'lateral', '向角色左', '同 Spine'),
    S('Chest Twist Left-Right', '+Y', [-20, 20], 'twist', '向角色左', '同 Spine'),
  ]],
  ['upperChest', 'UpperChest', [
    S('UpperChest Front-Back', '+X', [-20, 20], 'flexion', '向后', '同 Spine'),
    S('UpperChest Left-Right', '-Z', [-20, 20], 'lateral', '向角色左', '同 Spine'),
    S('UpperChest Twist Left-Right', '+Y', [-20, 20], 'twist', '向角色左', '同 Spine'),
  ]],
  ['neck', 'Neck', [
    S('Neck Nod Down-Up', '+X', [-40, 40], 'flexion', '低头（头向前）', '实测绕 -X 让头朝 -Z（后）⇒ 「+1=低头」取 +X'),
    S('Neck Tilt Left-Right', '+Z', [-40, 40], 'lateral', '向角色左', '实测绕 +Z 让头朝 -X（角色右）⇒ 「+1=向左」取 -Z'),
    S('Neck Turn Left-Right', '+Y', [-40, 40], 'twist', '向角色左', '绕 +Y：骨沿 Y ⇒ 纯扭转（实测末端位置不动）'),
  ]],
  ['head', 'Head', [
    S('Head Nod Down-Up', '+X', [-40, 40], 'flexion', '低头', '同 Neck Nod'),
    S('Head Tilt Left-Right', '+Z', [-40, 40], 'lateral', '向角色左', '同 Neck Tilt'),
    S('Head Turn Left-Right', '+Y', [-40, 40], 'twist', '向角色左', '同 Neck Turn'),
  ]],
  ['leftEye', 'LeftEye', [
    S('Left Eye Down-Up', '+X', [-30, 30], 'pitch', '向下', '未逐轴实测（眼球为独立小球，位置探测不稳定）'),
    S('Left Eye In-Out', '-Z', [-30, 30], 'yaw', '向内（-X）', '同上'),
    null,
  ]],
  ['rightEye', 'RightEye', [
    S('Right Eye Down-Up', '+X', [-30, 30], 'pitch', '向下', '同上（两眼同轴，与四肢不同 —— 眼球朝向一致）'),
    S('Right Eye In-Out', '+Z', [-30, 30], 'yaw', '向内（-X）', '同上（向内 = -X ⇒ 取 +Z）'),
    null,
  ]],
  ['jaw', 'Jaw', [
    S('Jaw Close', '+X', [-30, 30], 'open', '闭合', '未逐轴实测；本 VRM 无 jaw 骨'),
    S('Jaw Left-Right', '+Z', [-30, 30], 'lateral', '向角色左', '同上'),
    null,
  ]],
  // 左腿：静止朝 -Y。front-back 在 YZ 面（轴 ±X），in-out 在 XY 面（轴 ±Z）
  ['leftUpperLeg', 'LeftUpperLeg', [
    S('Left Upper Leg Front-Back', '+X', [-90, 90], 'flexion', '向后', '实测绕 +X 让脚朝 -Z（后）⇒ 「+1=向后」正好 +X'),
    S('Left Upper Leg In-Out', '-Z', [-45, 45], 'abduction', '向外（+X）', '实测绕 +Z 让脚朝 -X ⇒ 「+1=向外(+X)」取 -Z'),
    S('Left Upper Leg Twist In-Out', '+Y', [-45, 45], 'twist', '向外', '绕 +Y：骨沿 Y ⇒ 纯扭转（实测脚的位置不动）'),
  ]],
  ['leftLowerLeg', 'LeftLowerLeg', [
    S('Left Lower Leg Stretch', '+X', [-130, 0], 'flexion', '伸直', '实测绕 +X 让踝后移 = **屈膝** ⇒ 屈膝在负值侧；正侧极限 0 = 不可反折 ✔'),
    S('Left Lower Leg Twist In-Out', '+Y', [-10, 10], 'twist', '向外', '绕 +Y：实测只有 6.2° 位移，符合「小腿扭转范围很小」'),
    null,
  ]],
  ['leftFoot', 'LeftFoot', [
    S('Left Foot Up-Down', '+X', [-45, 45], 'flexion', '向上（勾脚）', '实测绕 +X 把踝→趾方向由 [0,-0.524,-0.852] 变 [0,+0.476,-0.880] ⇒ 「+1=向上」正好 +X'),
    S('Left Foot Twist In-Out', '+Y', [-30, 30], 'twist', '向外', '绕 +Y：实测 50.4° 位移（脚掌在水平面内摆 = 内外八）'),
    null,
  ]],
  ['leftToes', 'LeftToes', [
    S('Left Toes Up-Down', '+X', [-30, 30], 'flexion', '向上', '绕 +X（与脚同向）。⚠ 脚趾与脚踝世界位置重合 ⇒ 无法用位置差独立验证方向，**未独立实测**'),
    null, null,
  ]],
  // 右腿：静止也朝 -Y ⇒ 与左腿**同轴**
  ['rightUpperLeg', 'RightUpperLeg', [
    S('Right Upper Leg Front-Back', '+X', [-90, 90], 'flexion', '向后', '实测右腿绕 +X 与左腿逐位相同'),
    S('Right Upper Leg In-Out', '+Z', [-45, 45], 'abduction', '向外（-X）', '实测绕 -Z 让脚朝 +X ⇒ 「+1=向外(-X)」取 +Z'),
    S('Right Upper Leg Twist In-Out', '+Y', [-45, 45], 'twist', '向外', '绕 +Y：与左腿同轴（腿沿 -Y）'),
  ]],
  ['rightLowerLeg', 'RightLowerLeg', [
    S('Right Lower Leg Stretch', '+X', [-130, 0], 'flexion', '伸直', '同左膝（实测逐位相同）'),
    S('Right Lower Leg Twist In-Out', '+Y', [-10, 10], 'twist', '向外', '同左'),
    null,
  ]],
  ['rightFoot', 'RightFoot', [
    S('Right Foot Up-Down', '+X', [-45, 45], 'flexion', '向上（勾脚）', '同左脚（实测逐位相同）'),
    S('Right Foot Twist In-Out', '+Y', [-30, 30], 'twist', '向外', '同左'),
    null,
  ]],
  ['rightToes', 'RightToes', [
    S('Right Toes Up-Down', '+X', [-30, 30], 'flexion', '向上', '同左脚趾（未独立实测）'),
    null, null,
  ]],
  // 左臂：静止朝 -X。down-up 在 XY 面（轴 ±Z），front-back 在 XZ 面（轴 ±Y）
  ['leftShoulder', 'LeftShoulder', [
    S('Left Shoulder Down-Up', '+Z', [-25, 25], 'elevation', '向下', '实测绕 -Z 让手向上 ⇒ 「+1=向下」取 +Z'),
    S('Left Shoulder Front-Back', '-Y', [-25, 25], 'protraction', '向后', '实测绕 +Y 让手朝 +Z（前）⇒ 「+1=向后」取 -Y'),
    null,
  ]],
  ['leftUpperArm', 'LeftUpperArm', [
    S('Left Arm Down-Up', '+Z', [-90, 90], 'abduction', '向下', '实测绕 -Z 让手向上 ⇒ 「+1=向下」取 +Z'),
    S('Left Arm Front-Back', '-Y', [-90, 90], 'flexion', '向后', '实测绕 +Y 让手朝 +Z（前）⇒ 「+1=向后」取 -Y'),
    S('Left Arm Twist In-Out', '+X', [-90, 90], 'twist', '向外', '绕 +X：纯扭转（实测手的位置完全不变）'),
  ]],
  ['leftLowerArm', 'LeftLowerArm', [
    S('Left Forearm Stretch', '-Z', [-130, 0], 'flexion', '伸直', '实测绕 +Z 让手向上 = 屈肘 ⇒ 屈肘在负值侧；正侧极限 0 = 不可反折'),
    S('Left Forearm Twist In-Out', '+X', [-90, 90], 'twist', '向外', '绕 +X：前臂旋前/旋后（长轴）'),
    null,
  ]],
  ['leftHand', 'LeftHand', [
    S('Left Hand Down-Up', '+Z', [-80, 80], 'flexion', '向下', '实测绕 -Z 让指根朝 +Y（手背向上）⇒ 「+1=向下」取 +Z'),
    S('Left Hand In-Out', '-Y', [-80, 80], 'deviation', '向内', '实测绕 +Y 让指根朝 +Z（前）⇒ 「+1=向内(-Z)」取 -Y'),
    null,
  ]],
  // 右臂：静止朝 +X ⇒ 同名肌肉取反轴
  ['rightShoulder', 'RightShoulder', [
    S('Right Shoulder Down-Up', '-Z', [-25, 25], 'elevation', '向下', '实测绕 +Z 让手向上 ⇒ 「+1=向下」取 -Z'),
    S('Right Shoulder Front-Back', '+Y', [-25, 25], 'protraction', '向后', '实测绕 -Y 让手朝 +Z（前）⇒ 「+1=向后」取 +Y'),
    null,
  ]],
  ['rightUpperArm', 'RightUpperArm', [
    S('Right Arm Down-Up', '-Z', [-90, 90], 'abduction', '向下', '实测绕 +Z 让手向上 ⇒ 「+1=向下」取 -Z'),
    S('Right Arm Front-Back', '+Y', [-90, 90], 'flexion', '向后', '实测绕 -Y 让手朝 +Z（前）⇒ 「+1=向后」取 +Y'),
    S('Right Arm Twist In-Out', '-X', [-90, 90], 'twist', '向外', '绕 -X：纯扭转（臂沿 +X）'),
  ]],
  ['rightLowerArm', 'RightLowerArm', [
    S('Right Forearm Stretch', '+Z', [-130, 0], 'flexion', '伸直', '实测绕 +Z 让手向上 = 屈肘 ⇒ 屈肘在负值侧'),
    S('Right Forearm Twist In-Out', '-X', [-90, 90], 'twist', '向外', '绕 -X：长轴'),
    null,
  ]],
  ['rightHand', 'RightHand', [
    S('Right Hand Down-Up', '-Z', [-80, 80], 'flexion', '向下', '实测绕 +Z 让指根朝 +Y（手背向上）⇒ 「+1=向下」取 -Z'),
    S('Right Hand In-Out', '+Y', [-80, 80], 'deviation', '向内', '实测绕 -Y 让指根朝 +Z（前）⇒ 「+1=向内(+Z)」取 +Y'),
    null,
  ]],
]

const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
/** 符号化世界轴 → humanoid-map.mjs 里的 AX.* 常量名（头部的 AX 表只导出 LEFT/RIGHT/UP/DOWN/FRONT/BACK） */
const AXNAME = { '+X': 'AX.LEFT', '-X': 'AX.RIGHT', '+Y': 'AX.UP', '-Y': 'AX.DOWN', '+Z': 'AX.FRONT', '-Z': 'AX.BACK' }
const lines = []
lines.push('export const MUSCLE_TABLE = Object.freeze([')
for (const [bone, unity, axes] of SPEC) {
  lines.push('  {')
  lines.push(`    bone: ${q(bone)}, unity: ${q(unity)},`)
  lines.push('    axes: [')
  for (const a of axes) {
    if (!a) { lines.push('      null,'); continue }
    lines.push(`      { muscle: ${q(a.muscle)}, axis: ${AXNAME[a.axis]}, limit: [${a.limit[0]}, ${a.limit[1]}], dof: ${q(a.dof)}, positiveMotion: ${q(a.pos)}, note: ${q(a.note)} },`)
  }
  lines.push('    ],')
  lines.push('  },')
}
lines.push('])')
const block = lines.join('\n')

// ── 字符串手术（注意：文件是 CRLF，标记必须按 CRLF 写）
let src = readFileSync(FILE, 'utf8')
const EOL = src.includes('\r\n') ? '\r\n' : '\n'
// 幂等保护：上一次手术可能留下 `])])` 尾巴
src = src.split('])])' + EOL).join('])' + EOL)
const blockC = EOL === '\r\n' ? block.split('\n').join('\r\n') : block
const startMarker = 'export const MUSCLE_TABLE = Object.freeze(['
const start = src.indexOf(startMarker)
if (start < 0) throw new Error('找不到 MUSCLE_TABLE 起点')
const endMarker = EOL + '])'
const end = src.indexOf(endMarker, start)
if (end < 0) throw new Error('找不到 MUSCLE_TABLE 终点')
// 后缀从「en) 的下一个换行」开始，并吃掉可能残留的第二个 `])`（幂等）
let suffix = src.slice(end + 2)
suffix = suffix.replace(/^\r?\n/, EOL).replace(/^\]\)\r?\n/, '')
const out = src.slice(0, start) + blockC + EOL + suffix
writeFileSync(FILE, out, 'utf8')
console.log(`EOL=${EOL === '\r\n' ? 'CRLF' : 'LF'}；已替换：旧 ${end + EOL.length - start} 字符 → 新 ${blockC.length} 字符`)
console.log(`文件行数：${src.split('\n').length} → ${out.split('\n').length}`)
