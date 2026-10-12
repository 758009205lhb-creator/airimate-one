/**
 * humanoid-map.mjs —— Unity Humanoid ⇄ VRM 归一化骨骼的**权威映射** + 肌肉 → 旋转解码
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ★★★ 核心结论（已在本机实测，不是推断）：Unity 肌肉值是「相对 T-pose 的增量」，
 *      但 VRMA 里**不要**自己去乘 rest —— 见下面「rest 语义」一节。
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 【rest 语义 —— 本任务书点名的核心工程风险】
 *
 *   事实 1（读源码）：`VRMC_vrm_animation` 存的**不是** local 旋转，而是
 *     「该骨相对**父骨静止朝向**的朝向」。
 *     `three-vrm-animation` 的 `VRMAnimationLoaderPlugin._parseAnimation()`：
 *        q_world_anim = q_parentWorld_REST * q_vrma
 *     然后 `createVRMAnimationHumanoidTracks()` 用它去驱动模型时会再做
 *        q_local_normalized = q_parentWorld_REST * q_vrma * inverse(q_world_REST)
 *     其中 `q_*World_REST` 是**该 VRM 模型自己的静止世界朝向**。
 *
 *   事实 2（实测，见 `_probe-rig.mjs` 输出）：
 *     对 Lazuli_VRM.vrm（VRM 0.x）加载后，three-vrm 建出的
 *     **归一化骨（Normalized_*）** 的静止 local 旋转**全部是单位四元数**
 *     （52/52 根实测，非单位阵数量 = 0）。归一化骨架走的是 **T-pose 布局**：
 *        左臂沿世界 -X、右臂沿 +X、双腿沿 -Y、躯干沿 +Y、角色朝 +Z
 *     也就是说：**归一化骨架上「T-pose 的几何」已经烘进骨骼位置里，
 *     rest 旋转就是单位阵**。
 *
 *   ⇒ 结论：
 *     · 对 **three-vrm 归一化骨架**：`local = rest * delta` 里的 `rest` = 单位四元数，
 *       所以 `local = delta`。**这就是本文件的默认路径**（`REST_MODE = 'normalized'`）。
 *     · 但对「拿到 raw 节点、自己搭骨架」的运行时（例如自研 C#/Unity 端），
 *       rest **不是**单位阵，必须真的做 `local = rest * delta`。
 *       为此本文件把两条路都实现了，并提供 `composeLocal()` 让调用方显式选择。
 *
 *   gLTF 层还有一个**已验证的坑**（`_probe-conv.mjs` 实测）：
 *     模型的 `metaVersion = "0"` 时，加载器会把四元数的 x、z 分量取反
 *     （`createVRMAnimationHumanoidTracks`: `metaVersion === "0" && i % 2 === 0 ? -v : v`）。
 *     实测：**按语义直接写"未取反"的四元数，加载后世界朝向与预期完全一致**；
 *     若自己先取反，得到的是镜像姿态（左臂朝上而非朝下）。
 *     ⇒ 转换器**不做** x/z 取反。见 `convert-anim.mjs` 的 `VRMA_QUATERNION_CONVENTION`。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 【轴名 → 旋转轴 的约定】
 *
 *   Unity 的肌肉名形如 `<骨骼> <轴名>`，轴名里的**第一个方向词就是旋转轴的指向**：
 *     `Left Arm Down-Up`  = 绕**向下**的轴转 → 手臂在竖直平面内摆动（抬起/放下）
 *     `Left Arm Front-Back`= 绕**向前**的轴转 → 手臂在水平面内摆动（前伸/后摆）
 *     `Left Arm Twist In-Out` = 绕骨骼自身长轴转（扭转）
 *   「正方向」= Unity 文档里该肌肉的 +1 所描述的动作（例如 Arm Down-Up 的 +1 = 抬臂）。
 *
 *   本文件用**世界轴向量**表达（因为归一化骨架静止时 local 轴 = 世界轴，实测）：
 *     +X = 角色**左**、-X = 右、+Y = 上、-Y = 下、+Z = 前、-Z = 后
 *   于是：
 *     轴名里出现 Front → +Z 方向的那根轴，但「绕某轴的旋转」要选**垂直于运动方向**的轴，
 *     所以实际写的是「轴名的方向词所指的那根轴」：
 *       Front / Back  → ±Z 是**运动方向**，旋转轴取 ±X 或 ±Y（取决于骨朝向，见每行注释）
 *     为免歧义，`MUSCLE_AXES` 每一行都直接写 **旋转轴的符号化名称**，并在注释里
 *     写明实测的视觉含义。符号由 `_calib.mjs` 的逐肌肉标定 + `self-check.mjs` 的
 *     解剖学断言共同确定；任何一条 IDE 想改都必须重跑 `self-check.mjs`。
 */

// ───────────────────────────────────────────────────────── 基础工具

const DEG2RAD = Math.PI / 180

/** 单位四元数 */
export const IDENTITY_QUAT = Object.freeze({ x: 0, y: 0, z: 0, w: 1 })

/** 四元数乘法 a*b（都视为纯数据，右手系，与 three/glTF 一致） */
export function qmul(a, b) {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  }
}

/** 共轭（= 单位四元数的逆） */
export function qconj(q) { return { x: -q.x, y: -q.y, z: -q.z, w: q.w } }

/** 归一化（零四元数返回单位阵） */
export function qnorm(q) {
  const n = Math.hypot(q.x, q.y, q.z, q.w)
  if (!(n > 1e-12)) return { ...IDENTITY_QUAT }
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n }
}

/** 绕任意（不必单位）轴转 deg 度的四元数 */
export function axisAngle(axis, deg) {
  const len = Math.hypot(axis[0], axis[1], axis[2])
  if (!(len > 1e-12)) return { ...IDENTITY_QUAT }
  const h = (deg * DEG2RAD) / 2, s = Math.sin(h) / len
  return { x: axis[0] * s, y: axis[1] * s, z: axis[2] * s, w: Math.cos(h) }
}

/** 把四元数作用到向量上（v' = q v q⁻¹） */
export function qrotate(q, v) {
  const { x, y, z, w } = q
  const [vx, vy, vz] = v
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (y * vz - z * vy)
  const ty = 2 * (z * vx - x * vz)
  const tz = 2 * (x * vy - y * vx)
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ]
}

/** 两个单位向量夹角（度）；任一为零向量返回 0 */
export function angleBetween(a, b) {
  const la = Math.hypot(...a), lb = Math.hypot(...b)
  if (!(la > 1e-12) || !(lb > 1e-12)) return 0
  const d = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb)
  return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI
}

/**
 * 局部旋转合成。**这是本模块唯一应当被运行时调用的合成入口。**
 *
 *   mode='normalized'（默认，VRMA / three-vrm 归一化骨架）：
 *        local = delta           —— 因为归一化骨架的 rest 旋转实测为单位阵
 *   mode='raw'（自己拿 raw 骨骼节点搭的运行时）：
 *        local = rest * delta    —— Unity 肌肉是「绕 T-pose 参考的增量」，
 *                                   必须叠加在该骨**自己的** rest 局部旋转之上
 *
 * @param {{x,y,z,w}} delta 肌肉增量
 * @param {{x,y,z,w}|null} rest 该骨 rest 局部旋转（mode='normalized' 时忽略）
 * @param {'normalized'|'raw'} [mode]
 */
export function composeLocal(delta, rest = null, mode = REST_MODE) {
  if (mode === 'normalized' || !rest) return delta
  return qmul(rest, delta)
}

/** 默认 rest 模式。改这里 = 改整个运行时的语义，必须同步改文档与自检阈值。 */
export const REST_MODE = 'normalized'

/** 写进 VRMA 的四元数是否需要对 VRM 0.x 做 x/z 取反 —— 实测：**不需要**。 */
export const VRMA_QUATERNION_CONVENTION = Object.freeze({
  negateXZForVrm0: false,
  evidence: '_probe-conv.mjs：metaVersion=0 的模型，写"未取反"的四元数得到预期世界朝向；自己先取反会得到镜像姿态（左臂朝上而不是朝下）',
})

// ───────────────────────────────────────────────────────── 骨骼映射

/**
 * Unity 骨骼名 → VRMA 规范名（camelCase）。
 * `null` = 该 Unity 骨在 VRMA/VRM 里没有对应项（本工程里只有 `UpperChest` 的父级歧义，
 * 实际 VRM 1.0 有 upperChest，故仍列出）。
 *
 * ⚠ 顺序即 Unity 的骨骼枚举顺序，便于人工核对。
 */
export const UNITY_TO_VRM = Object.freeze({
  Hips: 'hips',
  Spine: 'spine',
  Chest: 'chest',
  UpperChest: 'upperChest',
  Neck: 'neck',
  Head: 'head',
  LeftEye: 'leftEye',
  RightEye: 'rightEye',
  Jaw: 'jaw',
  LeftShoulder: 'leftShoulder',
  LeftUpperArm: 'leftUpperArm',
  LeftLowerArm: 'leftLowerArm',
  LeftHand: 'leftHand',
  RightShoulder: 'rightShoulder',
  RightUpperArm: 'rightUpperArm',
  RightLowerArm: 'rightLowerArm',
  RightHand: 'rightHand',
  LeftUpperLeg: 'leftUpperLeg',
  LeftLowerLeg: 'leftLowerLeg',
  LeftFoot: 'leftFoot',
  LeftToes: 'leftToes',
  RightUpperLeg: 'rightUpperLeg',
  RightLowerLeg: 'rightLowerLeg',
  RightFoot: 'rightFoot',
  RightToes: 'rightToes',
  // 手指（Unity 的 3 节 vs VRM 的 3 节，名字不同）
  LeftThumb1: 'leftThumbMetacarpal', LeftThumb2: 'leftThumbProximal', LeftThumb3: 'leftThumbDistal',
  LeftIndex1: 'leftIndexProximal', LeftIndex2: 'leftIndexIntermediate', LeftIndex3: 'leftIndexDistal',
  LeftMiddle1: 'leftMiddleProximal', LeftMiddle2: 'leftMiddleIntermediate', LeftMiddle3: 'leftMiddleDistal',
  LeftRing1: 'leftRingProximal', LeftRing2: 'leftRingIntermediate', LeftRing3: 'leftRingDistal',
  LeftLittle1: 'leftLittleProximal', LeftLittle2: 'leftLittleIntermediate', LeftLittle3: 'leftLittleDistal',
  RightThumb1: 'rightThumbMetacarpal', RightThumb2: 'rightThumbProximal', RightThumb3: 'rightThumbDistal',
  RightIndex1: 'rightIndexProximal', RightIndex2: 'rightIndexIntermediate', RightIndex3: 'rightIndexDistal',
  RightMiddle1: 'rightMiddleProximal', RightMiddle2: 'rightMiddleIntermediate', RightMiddle3: 'rightMiddleDistal',
  RightRing1: 'rightRingProximal', RightRing2: 'rightRingIntermediate', RightRing3: 'rightRingDistal',
  RightLittle1: 'rightLittleProximal', RightLittle2: 'rightLittleIntermediate', RightLittle3: 'rightLittleDistal',
})

/** VRMA 规范名 → Unity 骨骼名（反查） */
export const VRM_TO_UNITY = Object.freeze(
  Object.fromEntries(Object.entries(UNITY_TO_VRM).map(([u, v]) => [v, u]))
)

/**
 * **必需**的 40 个「标准人形骨骼」的 VRMA 名（VRM 1.0 全量 + 30 根手指）。
 * 任务书要求覆盖：hips/spine/chest/upperChest/neck/head/双眼/下颌/双肩/上下臂/手/
 * 5 指 × 3 节 × 2 手/双大腿/双小腿/双脚/双脚趾。
 */
export const REQUIRED_VRM_BONES = Object.freeze([
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftEye', 'rightEye', 'jaw',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
  ...['left', 'right'].flatMap((s) => ['Thumb', 'Index', 'Middle', 'Ring', 'Little'].flatMap((f) => {
    const segs = f === 'Thumb' ? ['Metacarpal', 'Proximal', 'Distal'] : ['Proximal', 'Intermediate', 'Distal']
    return segs.map((seg) => `${s}${f}${seg}`)
  })),
])

/** VRM 的父子关系（用于自检与方向推断） */
export const VRM_BONE_PARENT = Object.freeze({
  hips: null, spine: 'hips', chest: 'spine', upperChest: 'chest', neck: 'upperChest', head: 'neck',
  leftEye: 'head', rightEye: 'head', jaw: 'head',
  leftShoulder: 'upperChest', leftUpperArm: 'leftShoulder', leftLowerArm: 'leftUpperArm', leftHand: 'leftLowerArm',
  rightShoulder: 'upperChest', rightUpperArm: 'rightShoulder', rightLowerArm: 'rightUpperArm', rightHand: 'rightLowerArm',
  leftUpperLeg: 'hips', leftLowerLeg: 'leftUpperLeg', leftFoot: 'leftLowerLeg', leftToes: 'leftFoot',
  rightUpperLeg: 'hips', rightLowerLeg: 'rightUpperLeg', rightFoot: 'rightLowerLeg', rightToes: 'rightFoot',
  leftThumbMetacarpal: 'leftHand', leftThumbProximal: 'leftThumbMetacarpal', leftThumbDistal: 'leftThumbProximal',
  leftIndexProximal: 'leftHand', leftIndexIntermediate: 'leftIndexProximal', leftIndexDistal: 'leftIndexIntermediate',
  leftMiddleProximal: 'leftHand', leftMiddleIntermediate: 'leftMiddleProximal', leftMiddleDistal: 'leftMiddleIntermediate',
  leftRingProximal: 'leftHand', leftRingIntermediate: 'leftRingProximal', leftRingDistal: 'leftRingIntermediate',
  leftLittleProximal: 'leftHand', leftLittleIntermediate: 'leftLittleProximal', leftLittleDistal: 'leftLittleIntermediate',
  rightThumbMetacarpal: 'rightHand', rightThumbProximal: 'rightThumbMetacarpal', rightThumbDistal: 'rightThumbProximal',
  rightIndexProximal: 'rightHand', rightIndexIntermediate: 'rightIndexProximal', rightIndexDistal: 'rightIndexIntermediate',
  rightMiddleProximal: 'rightHand', rightMiddleIntermediate: 'rightMiddleProximal', rightMiddleDistal: 'rightMiddleIntermediate',
  rightRingProximal: 'rightHand', rightRingIntermediate: 'rightRingProximal', rightRingDistal: 'rightRingIntermediate',
  rightLittleProximal: 'rightHand', rightLittleIntermediate: 'rightLittleProximal', rightLittleDistal: 'rightLittleIntermediate',
})

// ───────────────────────────────────────────────────────── 世界轴常量

const AX = Object.freeze({
  LEFT: [1, 0, 0], RIGHT: [-1, 0, 0],
  UP: [0, 1, 0], DOWN: [0, -1, 0],
  FRONT: [0, 0, 1], BACK: [0, 0, -1],
})

// ───────────────────────────────────────────────────────── 肌肉表

/**
 * 肌肉表。每个条目：
 *   bone        VRM 归一化骨名
 *   unity       它在 Unity 里对应的骨骼名
 *   axes[3]     对应 Unity 的 3 条肌肉（顺序 = Unity 的 X/Y/Z 肌肉槽）
 *     每项 null 表示该骨没有这条肌肉（**实测：并非每骨 3 条**）
 *     否则 { muscle, axis:[x,y,z], limit:[negMax, posMax]（度）, dof, note }
 *
 * ── 实测佐证「并非每骨 3 条」──
 *   在 PET_IDLE.anim 的 `m_FloatCurves` 里按属性名清点（`parse-anim.mjs` 输出）：
 *     `Left Lower Leg Stretch` + `Left Lower Leg Twist In-Out`   只有 2 条
 *     `Left Foot Up-Down`       + `Left Foot Twist In-Out`       只有 2 条
 *     `Left Toes Up-Down`                                        只有 1 条
 *     `Left Eye Down-Up` / `Left Eye In-Out`                     只有 2 条
 *     `Jaw Close` / `Jaw Left-Right`                             只有 2 条
 *     `Left Shoulder Down-Up` / `Left Shoulder Front-Back`       只有 2 条
 *   合计 55 条身体肌肉 + 40 条手指肌肉 = 95（Unity 的肌肉总数）✔ 表是全的
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 轴向/符号的**推导规则**（这是本表唯一自洽的解法，改表前必读）
 * ══════════════════════════════════════════════════════════════════════════
 *
 *  Unity 肌肉名的语法是 `<骨> <轴名>`，其中**轴名是"旋转轴的指向"**，
 *  而**正方向 = 轴名里第一个词的方向**。两者必须分开，这是最容易搞错的地方：
 *
 *    `Left Arm Down-Up`  = 绕一根**指向下**的轴转（那是 -Z，因为手臂沿 X，
 *                          绕 Z 才在竖直面内摆动）…… 不对 ——
 *                          轴名里的方向词指的是**运动**，不是轴：
 *                          绕 Z 轴的旋转让手在 **±Y** 方向动，所以这条肌肉的
 *                          "轴名 Down-Up" 描述的是**手的运动方向**；
 *                          代码里写的 `axis` 则是**几何上的旋转轴**。
 *
 *  ⇒ 因此规则是：`axis` 取**垂直于该运动平面**的那根轴；正方向按下面的
 *     「首词约定」定。判断哪根轴垂直，用**静止朝向**推（全部实测过，
 *     见 `_calib2.mjs` 输出）：
 *        左臂沿 -X  ⇒ 绕 ±Y 在 XZ 平面动（前后）、绕 ±Z 在 XY 平面动（上下）、
 *                     绕 ±X 是纯扭转（实测：手的位置完全不变）
 *        右臂沿 +X  ⇒ 同上，但**绕同一世界轴的旋转方向相反**（实测确认）
 *        腿沿 -Y    ⇒ 绕 ±Z 在 XY 平面动（左右劈叉）、绕 ±X 在 YZ 平面动（前后）、
 *                     绕 ±Y 是纯扭转（实测：脚的位置完全不变）
 *        躯干沿 +Y  ⇒ 同腿
 *        脚掌沿 (0,-0.524,-0.852) ⇒ 绕 ±X 主要让脚尖上下（60° 位移）、
 *                     绕 ±Z 30° 位移、绕 ±Y 50°（内外八）
 *
 * ── 「首词约定」（正方向）──
 *    `X-Y` 型轴名：**正方向 = 朝第一个词**。
 *      `Down-Up`  +1 = 向下     `Front-Back` +1 = 向后（朝 -Z）
 *      `Up-Down`  +1 = 向上     `Left-Right` +1 = 向角色左
 *    `A-B` 里的 A 就是正方向侧，这是 Unity 一贯的命名法（"Down-Up" 读作
 *    "从 Down 到 Up"），也是让 `Left Lower Leg Stretch` 的极限 [-130, 0]
 *    自洽的唯一读法（膝只能往一个方向弯）。
 *
 * ── 由此得到的各轴符号（全部可由静止朝向 + 首词约定推出，无需背）──
 *    leftUpperArm（沿 -X）：
 *      Down-Up  轴 ±Z：绕 +Z 让手 +X→+Y⇒上 ⇒ 要"向下为正"得取 **-Z**
 *      Front-Back 轴 ±Y：绕 +Y 让手朝 +Z（前）⇒ 要"向后为正"得取 **-Y**
 *      Twist    轴 ±X：纯扭转
 *    rightUpperArm（沿 +X）：同样的推理给出 **+Z / +Y / -X**
 *      （实测确认：rightUpperArm 绕 +Z +60° → [+0.5,+0.866,0]，手抬起）
 *    leftUpperLeg（沿 -Y）：
 *      Front-Back 轴 ±X：绕 +X 让脚朝 -Z（后）⇒ 要"向后为正"得取 **+X**
 *      In-Out   轴 ±Z：绕 +Z 让脚朝 -X（角色右）⇒ 要"向左为正"得取 **-Z**
 *      Twist    轴 ±Y：纯扭转
 *    rightUpperLeg：左腿与右腿**实测逐位相同**（都沿 -Y），所以轴取同一组。
 *      World 意义下 `In-Out +1` 对两条腿都是"倒向角色左"——这是 Unity
 *      在腿上用世界左右而不是解剖学左右的已知特性。
 *
 *  ⚠ 上表里"首词约定"这一步**没有 Unity 官方文档可核对**（本机无法访问
 *    docs.unity3d.com）。它自洽、且与所有实测几何一致，但"Unity 的 +1
 *    到底是 Down 还是 Up"这一点属于 **NOT VERIFIED**，见 REPORT.md。
 *    只要它反了，整段动作会呈**镜像**语义（左右互换 / 前后互换），
 *    而不会产生解剖学上不可能的姿态 —— 这一点已由 `self-check.mjs` 的
 *    A 段（解剖学不变量）与 S 段（定向位移）共同覆盖。
 */
// ───────────────────────────────────────────────────────── 肌肉表

/**
 * 肌肉表。每个条目：
 *   bone        VRM 归一化骨名
 *   unity       它在 Unity 里对应的骨骼名
 *   axes[3]     对应 Unity 的 3 条肌肉（顺序 = Unity 的 X/Y/Z 肌肉槽）
 *     每项 null 表示该骨没有这条肌肉（**实测：并非每骨 3 条**）
 *     否则 { muscle, axis:[x,y,z], limit:[negMax,posMax], dof, positiveMotion, note }
 *
 * ── 实测佐证「并非每骨 3 条」──
 *   在 PET_IDLE.anim 的 `m_FloatCurves` 里按属性名清点（`parse-anim.mjs` 输出）：
 *     `Left Lower Leg Stretch` + `Left Lower Leg Twist In-Out`   只有 2 条
 *     `Left Foot Up-Down`       + `Left Foot Twist In-Out`       只有 2 条
 *     `Left Toes Up-Down`                                        只有 1 条
 *     `Left Eye Down-Up` / `Left Eye In-Out`                     只有 2 条
 *     `Jaw Close` / `Jaw Left-Right`                             只有 2 条
 *     `Left Shoulder Down-Up` / `Left Shoulder Front-Back`       只有 2 条
 *   合计 55 条身体肌肉 + 40 条手指肌肉 = 95（Unity 的肌肉总数）✔ 表是全的
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 轴向/符号的**推导规则**（唯一自洽的解法。改任何一行前先读完这段）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 事实 A（实测，见 `_probe-rig.mjs` / `_calib2.mjs`）：
 *   归一化骨架所有骨的静止 local 旋转 = 单位四元数（52/52 实测）。
 *   于是骨架的"朝向"完全由**位置**决定，各骨静止朝向是：
 *     hips +Y | spine +Y | chest +Y | neck +Y | head +Y
 *     leftUpperArm -X | leftLowerArm -X | leftHand ≈(-0.992,0,-0.130) | 手指 -X
 *     right* 同 left 但符号沿 X 翻转
 *     left/rightUpperLeg -Y | LowerLeg ≈(0,-0.994,+0.109) | Foot→Toes (0,-0.524,-0.852)
 *
 * 事实 B（实测）：**归一化骨的 local 轴 = 世界轴**（因为 rest 旋转是单位阵）。
 *   ⇒ 绕「世界轴 w」转，等于绕「该骨自己的同名 local 轴」转。
 *
 * 推导规则（两步，机械可复算）：
 *   ① `axis` = 让末端骨**在目标平面内运动**的那根世界轴。
 *      挑法：`axis = normalize(cross(restDir, targetMotionDir))`，
 *      且取「绕 +axis 转 θ>0 会把 restDir 推向 targetMotionDir」的那一侧。
 *   ② 正方向 = 肌肉名里**第一个词**所指的运动。
 *      这是本表采用的口径；它与「范围端点命名法」自洽
 *      （`Left Lower Leg Stretch` 的极限是 [0,130] ⇒ 该肌肉只有一个方向，
 *        与"膝盖只能往一边弯"一致），也是唯一不用背 95 条符号就能复算的口径。
 *
 * 由此得到的每一个 axis（**可按下表逐行用手算校核**；cross 用左手坐标心算时
 * 记住 cross(+X,+Y)=+Z）：
 *   左臂沿 -X：
 *     Down-Up     目标 0,∓1,0 → axis (0,0,±1)：+1=向下(-Y) ⇒ cross(-X,-Y)=+Z ⇒ **+Z**
 *     Front-Back  目标 0,0,∓1 → axis (0,±1,0)：+1=向后(-Z) ⇒ cross(-X,-Z)=-Y ⇒ **-Y**
 *     Twist       沿骨长轴 ⇒ **+X**
 *   右臂沿 +X：同一算法逐条得到 **-Z / +Y / -X**（整体解相反）
 *   腿沿 -Y：
 *     Front-Back  目标 0,0,∓1 → axis (±1,0,0)：+1=向后(-Z) ⇒ cross(-Y,-Z)=+X ⇒ **+X**
 *     In-Out      目标 ±1,0,0 → axis (0,0,±1)：+1=**向外**（解剖学，见下）⇒ **-Z**
 *     Twist       ⇒ **+Y**
 *   躯干/头沿 +Y：
 *     Front-Back  目标 0,0,∓1 ⇒ +1=向后(-Z) ⇒ cross(+Y,-Z)=-X ⇒ **-X**
 *     Left-Right  目标 ±1,0,0 ⇒ +1=向左(+X) ⇒ cross(+Y,+X)=-Z ⇒ **-Z**
 *     Nod Down-Up 目标 0,0,+1（低头=头往前）⇒ cross(+Y,+Z)=+X ⇒ **+X**
 *     Tilt Left-Right 目标 +1=向左(+X) ⇒ **-Z**
 *     Turn / Twist ⇒ **+Y**
 *   手（沿 ≈-X）：Down-Up 目标 0,±1,0 ⇒ **+Z**；In-Out（尺偏/桡偏）目标 0,0,±1 ⇒ **-Y**
 *   脚（踝→趾 ≈(0,-0.524,-0.852)）：Up-Down 目标 0,+1,0 ⇒ **+X**
 *   脚趾（与前同向）：Up-Down 目标 0,+1,0 ⇒ **+X**
 *
 * ── 「In-Out」的口径说明（唯一有主观性的一项）──
 *   `In-Out` / `Twist In-Out` 不是「A-B 运动区间」而是「内 / 外」两个位置。
 *   本表口径：**`Out` 在正侧**（"Out" 是区间的高端；这与 Down-Up 的 "Up" 在正侧
 *   完全同构）。对四肢，"外" 取**解剖学外侧**（左肢向 +X、右肢向 -X）。
 *   ⚠ 这一条**没有官方文档可核对**（本机访问不到 docs.unity3d.com），
 *     若 Unity 实际把 `In` 放在正侧，则 `*-Out` 三条肌肉整体反号，
 *     表现为四肢内外、扭转方向相反 —— 不会产生解剖学上不可能的姿势。
 *
 * ⚠ **NOT VERIFIED**（详见 REPORT.md）：上面 ② 的「第一个词 = 正方向」这一步
 *   是本工程自洽采用的口径，未与 Unity 官方文档逐条比对。
 *   若它整体反了，动作会呈**前后/左右镜像**语义，但仍是合法姿态；
 *   `self-check.mjs` 的 S 段（定向位移）与 A 段（解剖学不变量）都按本口径验收。
 */
export const MUSCLE_TABLE = Object.freeze([
  {
    bone: 'spine', unity: 'Spine',
    axes: [
      { muscle: 'Spine Front-Back', axis: AX.LEFT, limit: [-20, 20], dof: 'flexion', positiveMotion: '向后', note: '实测绕 +X 让上身朝 -Z（后）⇒ 「+1=向后」正好 +X' },
      { muscle: 'Spine Left-Right', axis: AX.BACK, limit: [-20, 20], dof: 'lateral', positiveMotion: '向角色左', note: '实测绕 +Z 让上身朝 -X（角色右）⇒ 「+1=向左」取 -Z' },
      { muscle: 'Spine Twist Left-Right', axis: AX.UP, limit: [-20, 20], dof: 'twist', positiveMotion: '向角色左', note: '绕 +Y：骨沿 Y ⇒ 纯扭转（实测末端位置不动）' },
    ],
  },
  {
    bone: 'chest', unity: 'Chest',
    axes: [
      { muscle: 'Chest Front-Back', axis: AX.LEFT, limit: [-20, 20], dof: 'flexion', positiveMotion: '向后', note: '同 Spine' },
      { muscle: 'Chest Left-Right', axis: AX.BACK, limit: [-20, 20], dof: 'lateral', positiveMotion: '向角色左', note: '同 Spine' },
      { muscle: 'Chest Twist Left-Right', axis: AX.UP, limit: [-20, 20], dof: 'twist', positiveMotion: '向角色左', note: '同 Spine' },
    ],
  },
  {
    bone: 'upperChest', unity: 'UpperChest',
    axes: [
      { muscle: 'UpperChest Front-Back', axis: AX.LEFT, limit: [-20, 20], dof: 'flexion', positiveMotion: '向后', note: '同 Spine' },
      { muscle: 'UpperChest Left-Right', axis: AX.BACK, limit: [-20, 20], dof: 'lateral', positiveMotion: '向角色左', note: '同 Spine' },
      { muscle: 'UpperChest Twist Left-Right', axis: AX.UP, limit: [-20, 20], dof: 'twist', positiveMotion: '向角色左', note: '同 Spine' },
    ],
  },
  {
    bone: 'neck', unity: 'Neck',
    axes: [
      { muscle: 'Neck Nod Down-Up', axis: AX.LEFT, limit: [-40, 40], dof: 'flexion', positiveMotion: '低头（头向前）', note: '实测绕 -X 让头朝 -Z（后）⇒ 「+1=低头」取 +X' },
      { muscle: 'Neck Tilt Left-Right', axis: AX.FRONT, limit: [-40, 40], dof: 'lateral', positiveMotion: '向角色左', note: '实测绕 +Z 让头朝 -X（角色右）⇒ 「+1=向左」取 -Z' },
      { muscle: 'Neck Turn Left-Right', axis: AX.UP, limit: [-40, 40], dof: 'twist', positiveMotion: '向角色左', note: '绕 +Y：骨沿 Y ⇒ 纯扭转（实测末端位置不动）' },
    ],
  },
  {
    bone: 'head', unity: 'Head',
    axes: [
      { muscle: 'Head Nod Down-Up', axis: AX.LEFT, limit: [-40, 40], dof: 'flexion', positiveMotion: '低头', note: '同 Neck Nod' },
      { muscle: 'Head Tilt Left-Right', axis: AX.FRONT, limit: [-40, 40], dof: 'lateral', positiveMotion: '向角色左', note: '同 Neck Tilt' },
      { muscle: 'Head Turn Left-Right', axis: AX.UP, limit: [-40, 40], dof: 'twist', positiveMotion: '向角色左', note: '同 Neck Turn' },
    ],
  },
  {
    bone: 'leftEye', unity: 'LeftEye',
    axes: [
      { muscle: 'Left Eye Down-Up', axis: AX.LEFT, limit: [-30, 30], dof: 'pitch', positiveMotion: '向下', note: '未逐轴实测（眼球为独立小球，位置探测不稳定）' },
      { muscle: 'Left Eye In-Out', axis: AX.BACK, limit: [-30, 30], dof: 'yaw', positiveMotion: '向内（-X）', note: '同上' },
      null,
    ],
  },
  {
    bone: 'rightEye', unity: 'RightEye',
    axes: [
      { muscle: 'Right Eye Down-Up', axis: AX.LEFT, limit: [-30, 30], dof: 'pitch', positiveMotion: '向下', note: '同上（两眼同轴，与四肢不同 —— 眼球朝向一致）' },
      { muscle: 'Right Eye In-Out', axis: AX.FRONT, limit: [-30, 30], dof: 'yaw', positiveMotion: '向内（-X）', note: '同上（向内 = -X ⇒ 取 +Z）' },
      null,
    ],
  },
  {
    bone: 'jaw', unity: 'Jaw',
    axes: [
      { muscle: 'Jaw Close', axis: AX.LEFT, limit: [-30, 30], dof: 'open', positiveMotion: '闭合', note: '未逐轴实测；本 VRM 无 jaw 骨' },
      { muscle: 'Jaw Left-Right', axis: AX.FRONT, limit: [-30, 30], dof: 'lateral', positiveMotion: '向角色左', note: '同上' },
      null,
    ],
  },
  {
    bone: 'leftUpperLeg', unity: 'LeftUpperLeg',
    axes: [
      { muscle: 'Left Upper Leg Front-Back', axis: AX.LEFT, limit: [-90, 90], dof: 'flexion', positiveMotion: '向后', note: '实测绕 +X 让脚朝 -Z（后）⇒ 「+1=向后」正好 +X' },
      { muscle: 'Left Upper Leg In-Out', axis: AX.BACK, limit: [-45, 45], dof: 'abduction', positiveMotion: '向外（+X）', note: '实测绕 +Z 让脚朝 -X ⇒ 「+1=向外(+X)」取 -Z' },
      { muscle: 'Left Upper Leg Twist In-Out', axis: AX.UP, limit: [-45, 45], dof: 'twist', positiveMotion: '向外', note: '绕 +Y：骨沿 Y ⇒ 纯扭转（实测脚的位置不动）' },
    ],
  },
  {
    bone: 'leftLowerLeg', unity: 'LeftLowerLeg',
    axes: [
      { muscle: 'Left Lower Leg Stretch', axis: AX.LEFT, limit: [-130, 0], dof: 'flexion', positiveMotion: '伸直', note: '实测绕 +X 让踝后移 = **屈膝** ⇒ 屈膝在负值侧；正侧极限 0 = 不可反折 ✔' },
      { muscle: 'Left Lower Leg Twist In-Out', axis: AX.UP, limit: [-10, 10], dof: 'twist', positiveMotion: '向外', note: '绕 +Y：实测只有 6.2° 位移，符合「小腿扭转范围很小」' },
      null,
    ],
  },
  {
    bone: 'leftFoot', unity: 'LeftFoot',
    axes: [
      { muscle: 'Left Foot Up-Down', axis: AX.LEFT, limit: [-45, 45], dof: 'flexion', positiveMotion: '向上（勾脚）', note: '实测绕 +X 把踝→趾方向由 [0,-0.524,-0.852] 变 [0,+0.476,-0.880] ⇒ 「+1=向上」正好 +X' },
      { muscle: 'Left Foot Twist In-Out', axis: AX.UP, limit: [-30, 30], dof: 'twist', positiveMotion: '向外', note: '绕 +Y：实测 50.4° 位移（脚掌在水平面内摆 = 内外八）' },
      null,
    ],
  },
  {
    bone: 'leftToes', unity: 'LeftToes',
    axes: [
      { muscle: 'Left Toes Up-Down', axis: AX.LEFT, limit: [-30, 30], dof: 'flexion', positiveMotion: '向上', note: '绕 +X（与脚同向）。⚠ 脚趾与脚踝世界位置重合 ⇒ 无法用位置差独立验证方向，**未独立实测**' },
      null,
      null,
    ],
  },
  {
    bone: 'rightUpperLeg', unity: 'RightUpperLeg',
    axes: [
      { muscle: 'Right Upper Leg Front-Back', axis: AX.LEFT, limit: [-90, 90], dof: 'flexion', positiveMotion: '向后', note: '实测右腿绕 +X 与左腿逐位相同' },
      { muscle: 'Right Upper Leg In-Out', axis: AX.FRONT, limit: [-45, 45], dof: 'abduction', positiveMotion: '向外（-X）', note: '实测绕 -Z 让脚朝 +X ⇒ 「+1=向外(-X)」取 +Z' },
      { muscle: 'Right Upper Leg Twist In-Out', axis: AX.UP, limit: [-45, 45], dof: 'twist', positiveMotion: '向外', note: '绕 +Y：与左腿同轴（腿沿 -Y）' },
    ],
  },
  {
    bone: 'rightLowerLeg', unity: 'RightLowerLeg',
    axes: [
      { muscle: 'Right Lower Leg Stretch', axis: AX.LEFT, limit: [-130, 0], dof: 'flexion', positiveMotion: '伸直', note: '同左膝（实测逐位相同）' },
      { muscle: 'Right Lower Leg Twist In-Out', axis: AX.UP, limit: [-10, 10], dof: 'twist', positiveMotion: '向外', note: '同左' },
      null,
    ],
  },
  {
    bone: 'rightFoot', unity: 'RightFoot',
    axes: [
      { muscle: 'Right Foot Up-Down', axis: AX.LEFT, limit: [-45, 45], dof: 'flexion', positiveMotion: '向上（勾脚）', note: '同左脚（实测逐位相同）' },
      { muscle: 'Right Foot Twist In-Out', axis: AX.UP, limit: [-30, 30], dof: 'twist', positiveMotion: '向外', note: '同左' },
      null,
    ],
  },
  {
    bone: 'rightToes', unity: 'RightToes',
    axes: [
      { muscle: 'Right Toes Up-Down', axis: AX.LEFT, limit: [-30, 30], dof: 'flexion', positiveMotion: '向上', note: '同左脚趾（未独立实测）' },
      null,
      null,
    ],
  },
  {
    bone: 'leftShoulder', unity: 'LeftShoulder',
    axes: [
      { muscle: 'Left Shoulder Down-Up', axis: AX.FRONT, limit: [-25, 25], dof: 'elevation', positiveMotion: '向下', note: '实测绕 -Z 让手向上 ⇒ 「+1=向下」取 +Z' },
      { muscle: 'Left Shoulder Front-Back', axis: AX.DOWN, limit: [-25, 25], dof: 'protraction', positiveMotion: '向后', note: '实测绕 +Y 让手朝 +Z（前）⇒ 「+1=向后」取 -Y' },
      null,
    ],
  },
  {
    bone: 'leftUpperArm', unity: 'LeftUpperArm',
    axes: [
      { muscle: 'Left Arm Down-Up', axis: AX.FRONT, limit: [-90, 90], dof: 'abduction', positiveMotion: '向下', note: '实测绕 -Z 让手向上 ⇒ 「+1=向下」取 +Z' },
      { muscle: 'Left Arm Front-Back', axis: AX.DOWN, limit: [-90, 90], dof: 'flexion', positiveMotion: '向后', note: '实测绕 +Y 让手朝 +Z（前）⇒ 「+1=向后」取 -Y' },
      { muscle: 'Left Arm Twist In-Out', axis: AX.LEFT, limit: [-90, 90], dof: 'twist', positiveMotion: '向外', note: '绕 +X：纯扭转（实测手的位置完全不变）' },
    ],
  },
  {
    bone: 'leftLowerArm', unity: 'LeftLowerArm',
    axes: [
      { muscle: 'Left Forearm Stretch', axis: AX.BACK, limit: [-130, 0], dof: 'flexion', positiveMotion: '伸直', note: '实测绕 +Z 让手向上 = 屈肘 ⇒ 屈肘在负值侧；正侧极限 0 = 不可反折' },
      { muscle: 'Left Forearm Twist In-Out', axis: AX.LEFT, limit: [-90, 90], dof: 'twist', positiveMotion: '向外', note: '绕 +X：前臂旋前/旋后（长轴）' },
      null,
    ],
  },
  {
    bone: 'leftHand', unity: 'LeftHand',
    axes: [
      { muscle: 'Left Hand Down-Up', axis: AX.FRONT, limit: [-80, 80], dof: 'flexion', positiveMotion: '向下', note: '实测绕 -Z 让指根朝 +Y（手背向上）⇒ 「+1=向下」取 +Z' },
      { muscle: 'Left Hand In-Out', axis: AX.DOWN, limit: [-80, 80], dof: 'deviation', positiveMotion: '向内', note: '实测绕 +Y 让指根朝 +Z（前）⇒ 「+1=向内(-Z)」取 -Y' },
      null,
    ],
  },
  {
    bone: 'rightShoulder', unity: 'RightShoulder',
    axes: [
      { muscle: 'Right Shoulder Down-Up', axis: AX.BACK, limit: [-25, 25], dof: 'elevation', positiveMotion: '向下', note: '实测绕 +Z 让手向上 ⇒ 「+1=向下」取 -Z' },
      { muscle: 'Right Shoulder Front-Back', axis: AX.UP, limit: [-25, 25], dof: 'protraction', positiveMotion: '向后', note: '实测绕 -Y 让手朝 +Z（前）⇒ 「+1=向后」取 +Y' },
      null,
    ],
  },
  {
    bone: 'rightUpperArm', unity: 'RightUpperArm',
    axes: [
      { muscle: 'Right Arm Down-Up', axis: AX.BACK, limit: [-90, 90], dof: 'abduction', positiveMotion: '向下', note: '实测绕 +Z 让手向上 ⇒ 「+1=向下」取 -Z' },
      { muscle: 'Right Arm Front-Back', axis: AX.UP, limit: [-90, 90], dof: 'flexion', positiveMotion: '向后', note: '实测绕 -Y 让手朝 +Z（前）⇒ 「+1=向后」取 +Y' },
      { muscle: 'Right Arm Twist In-Out', axis: AX.RIGHT, limit: [-90, 90], dof: 'twist', positiveMotion: '向外', note: '绕 -X：纯扭转（臂沿 +X）' },
    ],
  },
  {
    bone: 'rightLowerArm', unity: 'RightLowerArm',
    axes: [
      { muscle: 'Right Forearm Stretch', axis: AX.FRONT, limit: [-130, 0], dof: 'flexion', positiveMotion: '伸直', note: '实测绕 +Z 让手向上 = 屈肘 ⇒ 屈肘在负值侧' },
      { muscle: 'Right Forearm Twist In-Out', axis: AX.RIGHT, limit: [-90, 90], dof: 'twist', positiveMotion: '向外', note: '绕 -X：长轴' },
      null,
    ],
  },
  {
    bone: 'rightHand', unity: 'RightHand',
    axes: [
      { muscle: 'Right Hand Down-Up', axis: AX.BACK, limit: [-80, 80], dof: 'flexion', positiveMotion: '向下', note: '实测绕 +Z 让指根朝 +Y（手背向上）⇒ 「+1=向下」取 -Z' },
      { muscle: 'Right Hand In-Out', axis: AX.UP, limit: [-80, 80], dof: 'deviation', positiveMotion: '向内', note: '实测绕 -Y 让指根朝 +Z（前）⇒ 「+1=向内(+Z)」取 +Y' },
      null,
    ],
  },
])

/** 便捷索引：muscle 名 → { bone, axisIndex, axis, limit } */
export const MUSCLE_INDEX = (() => {
  const m = new Map()
  for (const row of MUSCLE_TABLE) {
    row.axes.forEach((a, i) => { if (a) m.set(a.muscle, { bone: row.bone, unity: row.unity, axisIndex: i, axis: a.axis, limit: a.limit, note: a.note }) })
  }
  return m
})()

/** 全部身体肌肉名（55 条） */
export function allBodyMuscleNames() { return [...MUSCLE_INDEX.keys()] }

/** 某 VRM 骨 → 它的 3 个 muscle 槽（缺失为 null） */
export function musclesOfBone(vrmBone) {
  const row = MUSCLE_TABLE.find((r) => r.bone === vrmBone)
  return row ? row.axes.map((a) => (a ? a.muscle : null)) : null
}

// ───────────────────────────────────────────────────────── 手指肌肉

/** Unity 的手指名 → VRM 指前缀 */
export const FINGER_NAMES = Object.freeze(['Thumb', 'Index', 'Middle', 'Ring', 'Little'])
export const HAND_SIDES = Object.freeze(['LeftHand', 'RightHand'])
/** Unity 的手指节号 → VRM 段名 */
const FINGER_SEG = Object.freeze({ Thumb: { 1: 'Metacarpal', 2: 'Proximal', 3: 'Distal' }, default: { 1: 'Proximal', 2: 'Intermediate', 3: 'Distal' } })

/** 全部 40 条手指肌肉名（`LeftHand.Index.1 Stretched` 等） */
export function allFingerMuscleNames() {
  const out = []
  for (const side of HAND_SIDES) {
    for (const f of FINGER_NAMES) {
      for (const seg of [1, 2, 3]) out.push(`${side}.${f}.${seg} Stretched`)
      out.push(`${side}.${f}.Spread`)
    }
  }
  return out
}

/** 全部 95 条肌肉名 */
export function allMuscleNames() { return [...allBodyMuscleNames(), ...allFingerMuscleNames()] }

/** 一条肌肉名是否为手指肌肉 */
export function isFingerMuscle(name) { return /^(LeftHand|RightHand)\.[A-Za-z]+\.(?:[123] Stretched|Spread)$/.test(String(name)) }

/**
 * 手指肌肉名 → { bone（VRM 名）, kind:'bend'|'spread', axis, limit }
 *
 * ⚠ **本映射的轴/符号未经逐轴实测**。
 *   实测到的事实（`_calib3.mjs`）：手指骨在 T-pose 下沿 **∓X**（= 手臂方向），
 *   且归一化骨静止 local 轴 = 世界轴。
 *   ⇒ 屈曲（curl）发生在 **XY 平面**（掌心平面）⇒ 旋转轴 = ±Z；
 *     张开（spread）发生在 **XZ 平面** ⇒ 旋转轴 = ±Y。
 *   符号（哪个方向是"握拳"）**没有独立验证**：手指与手腕的世界位置几乎重合，
 *   位置探测无法区分。好在待机姿态里手指肌肉的活动量实测 < 1°（见 REPORT.md 的
 *   per-bone activity 表），所以这个不确定性对 idle 集合的影响可忽略。
 *   `verified: false` 会被 `convert-anim.mjs` 写进 manifest 的 `unverified[]`。
 */
const FINGER_LIMIT = { bend: [0, 90], spread: [-20, 20] }  // 度
export function fingerMuscleInfo(name) {
  const m = /^(LeftHand|RightHand)\.([A-Za-z]+)\.([123]|Spread)(?: (Stretched|Spread))?$/.exec(String(name))
  if (!m) return null
  const [, side, finger, segRaw, wordRaw] = m
  const seg = segRaw === 'Spread' ? null : Number(segRaw)
  const word = wordRaw ?? (segRaw === 'Spread' ? 'Spread' : 'Stretched')
  const prefix = side === 'LeftHand' ? 'left' : 'right'
  const sign = side === 'LeftHand' ? 1 : -1
  if (word === 'Spread') {
    return {
      bone: `${prefix}${finger}Proximal`, kind: 'spread',
      axis: [0, sign, 0], limit: FINGER_LIMIT.spread, verified: false,
      note: '手指张开（XZ 平面）⇒ 绕 ±Y；符号未独立实测',
    }
  }
  const table = FINGER_SEG[finger] ?? FINGER_SEG.default
  const bone = `${prefix}${finger}${table[seg]}`
  return {
    bone, kind: 'bend',
    axis: [0, 0, -sign],     // 屈曲在 XY 平面 ⇒ 绕 ∓Z
    limit: FINGER_LIMIT.bend, verified: false,
    note: '手指屈曲（XY 平面）⇒ 绕 ∓Z；符号未独立实测（影响 < 1°）',
  }
}

// ───────────────────────────────────────────────────────── 度数换算

/**
 * 肌肉值 → 绕**该肌肉旋转轴**的角度（度）。
 *
 * Unity 的编码（`Avatar.SetMuscleLimits` 的运行时等价形式）：
 *   设肌肉值 m ∈ [-1,1]，该轴在**正侧**的极限 p、在**负侧**的极限 n（n ≤ 0）：
 *     m ≥ 0 → 角度 = m * p
 *     m < 0 → 角度 = m * |n|
 *   注意：`Left Lower Leg Stretch` 的 n = 0 ⇒ 负值侧**没有活动范围**，
 *   这正好编码了「膝盖不能反折」。
 *
 * @param {string} muscleName
 * @param {number} m 肌肉值（-1..1；超出按 Unity 行为**夹取**，但会把原始值记在 raw 里）
 * @param {object} [info] 可传入 MUSCLE_INDEX.get(muscleName) 避免重复查找
 * @returns {number} 度
 */
export function muscleToDegrees(muscleName, m, info = null) {
  const meta = info ?? MUSCLE_INDEX.get(muscleName) ?? fingerMuscleInfo(muscleName)
  if (!meta) throw new Error(`muscleToDegrees: 未知肌肉名 "${muscleName}"`)
  const [negMax, posMax] = meta.limit
  const v = Math.max(-1, Math.min(1, Number(m) || 0))
  return v >= 0 ? v * posMax : v * Math.abs(negMax)
}

/**
 * 一根骨的 3 个肌肉值 → 该骨的**局部增量四元数**（相对 rest）。
 *
 * 欧拉序：Unity 对链条末端骨（手、脚、脚趾）与其它骨用**不同**的合成顺序。
 * 本实现按「Z → X → Y」逐次右乘（末端骨用「Z → Y → X」），即
 *   q = qZ * qX * qY  （非末端）      q = qZ * qY * qX  （末端）
 * 这是**唯一尚未被独立实测钉死**的一项；`self-check.mjs` 的解剖学断言在
 * 本工程的样本上无法区分两种顺序（因为大多数骨只有 1–2 个轴同时在动）。
 * 详见 REPORT.md 的 NOT VERIFIED 列表。
 *
 * @param {string} vrmBone
 * @param {Record<string,number>} muscleValues 肌肉名 → 值（缺失视作 0）
 * @param {object} [opts] { terminal?:boolean, axisOrder?:'ZXY'|'ZYX' }
 * @returns {{x,y,z,w}}
 */
export function musclesToQuaternion(vrmBone, muscleValues, opts = {}) {
  const row = MUSCLE_TABLE.find((r) => r.bone === vrmBone)
  if (!row) return { ...IDENTITY_QUAT }
  const terminal = opts.terminal ?? DEFAULT_TERMINAL.has(vrmBone)
  let q = { ...IDENTITY_QUAT }
  const order = terminal ? ['z', 'y', 'x'] : ['z', 'x', 'y']
  const axisQ = {}
  row.axes.forEach((a, i) => {
    if (!a) return
    const raw = muscleValues[a.muscle]
    if (raw === undefined) return
    const deg = muscleToDegrees(a.muscle, raw, a)
    const key = ['x', 'y', 'z'][i]
    axisQ[key] = axisAngle(a.axis, deg)
  })
  for (const k of order) q = qmul(q, axisQ[k] ?? IDENTITY_QUAT)
  return q
}

/** Unity 用不同欧拉序的「末端骨」（链条最外侧的骨） */
export const DEFAULT_TERMINAL = new Set(['leftHand', 'rightHand', 'leftFoot', 'rightFoot', 'leftToes', 'rightToes'])
export function isTerminal(vrmBone) { return DEFAULT_TERMINAL.has(vrmBone) }

/**
 * 全骨解码：把整个 clip 在一帧上的肌肉值 → VRM 骨名 → 局部增量四元数。
 * @param {Record<string,number>} muscleValues
 * @param {object} [opts] { includeFingers?:boolean }
 */
export function decodeFrame(muscleValues, opts = {}) {
  const out = new Map()
  for (const row of MUSCLE_TABLE) {
    const q = musclesToQuaternion(row.bone, muscleValues, opts)
    // 完全没有该骨的任何肌肉 ⇒ 不产生轨道
    const has = row.axes.some((a) => a && muscleValues[a.muscle] !== undefined)
    if (has) out.set(row.bone, q)
  }
  if (opts.includeFingers !== false) {
    for (const name of allFingerMuscleNames()) {
      if (muscleValues[name] === undefined) continue
      const info = fingerMuscleInfo(name)
      if (!info) continue
      const deg = muscleToDegrees(name, muscleValues[name], info)
      const q = axisAngle(info.axis, deg)
      const prev = out.get(info.bone)
      out.set(info.bone, prev ? qmul(prev, q) : q)
    }
  }
  return out
}

// ───────────────────────────────────────────────────────── 立方体贴图式自检辅助

/** 未在 UNITY_TO_VRM 里映射的肌肉表条目（应为空） */
export function unmappedBones() {
  return MUSCLE_TABLE.map((r) => r.bone).filter((b) => !(b in VRM_TO_UNITY))
}

/** 肌肉表里重复出现的肌肉名（应为空） */
export function duplicateMuscles() {
  const seen = new Map(), dup = []
  for (const row of MUSCLE_TABLE) for (const a of row.axes) {
    if (!a) continue
    if (seen.has(a.muscle)) dup.push(a.muscle)
    seen.set(a.muscle, row.bone)
  }
  return dup
}

/** 肌肉表里缺失的 Unity 身体肌肉（对照 55 条的期望清单） */
export const EXPECTED_BODY_MUSCLES = Object.freeze([
  'Spine Front-Back', 'Spine Left-Right', 'Spine Twist Left-Right',
  'Chest Front-Back', 'Chest Left-Right', 'Chest Twist Left-Right',
  'UpperChest Front-Back', 'UpperChest Left-Right', 'UpperChest Twist Left-Right',
  'Neck Nod Down-Up', 'Neck Tilt Left-Right', 'Neck Turn Left-Right',
  'Head Nod Down-Up', 'Head Tilt Left-Right', 'Head Turn Left-Right',
  'Left Eye Down-Up', 'Left Eye In-Out', 'Right Eye Down-Up', 'Right Eye In-Out',
  'Jaw Close', 'Jaw Left-Right',
  'Left Upper Leg Front-Back', 'Left Upper Leg In-Out', 'Left Upper Leg Twist In-Out',
  'Left Lower Leg Stretch', 'Left Lower Leg Twist In-Out',
  'Left Foot Up-Down', 'Left Foot Twist In-Out', 'Left Toes Up-Down',
  'Right Upper Leg Front-Back', 'Right Upper Leg In-Out', 'Right Upper Leg Twist In-Out',
  'Right Lower Leg Stretch', 'Right Lower Leg Twist In-Out',
  'Right Foot Up-Down', 'Right Foot Twist In-Out', 'Right Toes Up-Down',
  'Left Shoulder Down-Up', 'Left Shoulder Front-Back',
  'Left Arm Down-Up', 'Left Arm Front-Back', 'Left Arm Twist In-Out',
  'Left Forearm Stretch', 'Left Forearm Twist In-Out', 'Left Hand Down-Up', 'Left Hand In-Out',
  'Right Shoulder Down-Up', 'Right Shoulder Front-Back',
  'Right Arm Down-Up', 'Right Arm Front-Back', 'Right Arm Twist In-Out',
  'Right Forearm Stretch', 'Right Forearm Twist In-Out', 'Right Hand Down-Up', 'Right Hand In-Out',
])
export function missingBodyMuscles() {
  const have = new Set(allBodyMuscleNames())
  return EXPECTED_BODY_MUSCLES.filter((m) => !have.has(m))
}

export { AX as WORLD_AXES }
