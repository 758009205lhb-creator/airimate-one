# motion-lab REPORT —— Unity Humanoid `.anim` → VRMA 管线的实测记录

> 本文件里出现的**每一个数字都是本机跑出来的**。凡是没跑通的、没能独立验证的，
> 都写在文末的 **NOT VERIFIED** 一节，不做任何"看起来应该对"的陈述。

- 机器 / 环境：Windows 11，Node **v24.19.0**，PowerShell 5.1
- 动画源（只读）：`F:\deepseek harness\AI女友\repos\Mate-Engine\Assets\MATE ENGINE - Animations\`
  —— **实测 128 个 `.anim`**（不是 162；递归计数命令见 §1）
- 目标模型（只读）：`…\MATE ENGINE - Avatar\DLCs\Lazuli_VRM.vrm`（60,609,288 字节）
- three-vrm（AIRI 发行版副本）：`F:\deepseek harness\AI女友\build\airi-modules\`，three **r185**
- 产出目录：`F:\deepseek harness\AI女友\新工程\assets\motion\`（+ `manifests\`、`contact-sheets\`）
- 工具目录：`F:\deepseek harness\AI女友\新工程\tools\motion-lab\`

---

## 0. 结论速览（一句话版）

| 环节 | 结果 |
|---|---|
| `.anim` 解析（128 个） | **128/128 成功，0 个压缩 clip，0 个解析失败** |
| 独立 GLB/VRMA 校验（16 个文件 × 21 项） | **ALL PASS**（336/336 项） |
| 真 `VRMAnimationLoaderPlugin` 加载（16 个文件） | **161 断言全 PASS，VERDICT: ALL PASS，exit 0** |
| 逐肌肉语义验证（真实模型上的世界位移） | **27/27 PASS** |
| 骨架解剖学不变量（16 个文件 × 6 帧 × 7 项） | **636 条断言全 PASS，36 条显式豁免，FAIL 0** |
| 无 GUI 渲染（Electron + SwiftShader 真 WebGL） | **40 张 PNG 渲染成功**；同时产出 20 个 SVG 骨骼投影 |
| `packages/motion-director`（`node --test`） | **44/44 PASS，exit 0** |

**最重要的三条实测发现**（都推翻了原型代码里的做法）：

1. **`RootQ` 必须丢弃**，否则骨架整体上下颠倒（§6）。
2. **VRMA 的 hips rest 位置会被加载器用来算缩放**，写错会把位移放大 ≈4.85 倍（§7）。
3. **`leftLowerLeg` 的"屈膝"是负值侧**，而本工程的待机源数据里膝盖多数是**直的**——
   所以"腿动得少"是**源素材**的性质，不是转换丢帧（§8）。

---

## 1. 解析：128 个 `.anim` 全量体检

```powershell
cd "F:\deepseek harness\AI女友\新工程\tools\motion-lab"
(Get-ChildItem "F:\deepseek harness\AI女友\repos\Mate-Engine\Assets\MATE ENGINE - Animations" -Recurse -Filter *.anim | Measure-Object).Count
node parse-anim.mjs --scan "F:\deepseek harness\AI女友\repos\Mate-Engine\Assets\MATE ENGINE - Animations"
```

原始输出（尾部）：

```
AnkhaZone.anim                            258     6     8   108    60   24   32   20    1.000     -
Float 2.anim                              258     6     8   108    60   24   32   20   26.040     -
Float v3.anim                             258     6     8   108    80   24   32    0   45.000     -

合计 128 个；压缩 clip 0 个；解析失败 0 个
```

单文件（`PET_IDLE.anim`）明细：

```
文件        : …\PET_IDLE\PET_IDLE.anim
名称        : PET_IDLE
serializedV : 7   m_Legacy=0   m_Compressed=0
SampleRate  : 60   WrapMode=0   AnimationType=(未写)
时长        : 2.450012 s   (m_StartTime=0 m_StopTime=2.4500122 m_LoopTime=1)
曲线总数    : 258   [m_FloatCurves=129 m_EditorCurves=129 m_RotationCurves=0 m_EulerCurves=0]
  rootT        : 6
  rootQ        : 8
  muscle       : 110
  fingerMuscle : 78
  ikT          : 24
  ikQ          : 32
  other        : 0
```

**关于 `m_Compressed`**：递归全量 grep `^\s+m_Compressed:\s*1` 的结果是 **0 个**。
解析器仍然**显式**检查 `m_Compressed` / `m_CompressedRotationCurves`，
一旦为 1 就写入 `unsupported[]` 并让转换器直接拒绝该文件（不产出数值垃圾）。

### 1.1 修掉的两个解析 bug（原型的坑）

| # | 症状 | 根因 | 证据 |
|---|---|---|---|
| ① | 每条曲线被读两遍 | 旧版全文扫 `attribute:` 切段，而一个 `AnimationClip` 里有**两份**曲线数组：`m_FloatCurves`（权威，归一化肌肉值）与 `m_EditorCurves`（编辑器展开）。本版按 `SECTION:` 归属分段 | 本文件实测二者**逐字节数值相同**（见下） |
| ② | `m_SampleRate` / `m_StopTime` 读不到 | 这两个键在 `m_ClipBindingConstant` **之后**（PET_IDLE.anim 第 17087 / 18265 行），且缩进层级在不同文件里不统一 | 改用不依赖缩进的扁平正则后 `SampleRate=60`、`StopTime=2.4500122` 正常读出 |
| ③ | 40 条手指肌肉只认出 20 条 | 旧正则只认 `.<节号> <后缀>`，而 `LeftHand.Index.Spread` **没有节号** | 修完后 `fingerMuscle: 78`、`other: 0`（前值 58 / 20） |

`m_FloatCurves` vs `m_EditorCurves` 的抽样对照（两段各 129 条，逐条相同）：

```
[Spine Front-Back]
  float  keys=42  head=0.01900, 0.02121, 0.03351, 0.05671, 0.06934, 0.07349
  editor keys=42  head=0.01900, 0.02121, 0.03351, 0.05671, 0.06934, 0.07349
[Left Arm Down-Up]     float keys=11 == editor keys=11（数值相同）
[Left Eye Down-Up]     float keys=69 == editor keys=69（数值相同）
仅 float 有: []     仅 editor 有: []
```

---

## 2. 肌肉表与轴向标定（**核心工程风险**）

### 2.1 肌肉表完整性（机器校验，不是人肉数的）

```
骨骼数=24 身体肌肉=55 手指=40 总=95 缺失=[] 重复=[] 未映射=[]
```

55 条身体肌肉 + 40 条手指肌肉 = **95**，正好等于 Unity 的肌肉总数 ⇒ 表没有缺项。
实测佐证"并非每骨 3 条肌肉"：`Left Lower Leg Stretch`+`Twist`(2)、
`Left Foot Up-Down`+`Twist`(2)、`Left Toes Up-Down`(1)、`Left Eye`(2)、`Right Eye`(2)、
`Jaw`(2)、`Left Shoulder`(2)、`Right Shoulder`(2)。

### 2.2 轴向：逐骨枚举「绕 ±X/±Y/±Z 转 60°」测世界方向

`_calib2.mjs` 的实跑输出（节选，全量见脚本）：

```
静止朝向：
  leftUpperArm    → leftHand             [-1.000,0.000,0.000]
  rightUpperArm   → rightHand            [ 1.000,0.000,0.000]
  leftUpperLeg    → leftFoot             [ 0.000,-0.999,0.049]
  leftLowerLeg    → leftFoot             [ 0.000,-0.994,0.109]
  leftFoot        → leftToes             [ 0.000,-0.524,-0.852]
  spine/neck                             [ 0.000, 1.000, 0.000]
  → 模型坐标：+X = 角色**左**、+Y = 上、+Z = **前**

绕 ±X/±Y/±Z 转 +60° 的末端方向（只列位移 > 5° 的轴）：
  leftUpperArm    +Y=[-0.500,0,0.866](60°)   +Z=[-0.500,-0.866,0](60°)   -Z=[-0.500,0.866,0](60°)
  rightUpperArm   +Y=[ 0.500,0,-0.866](60°)  +Z=[ 0.500, 0.866,0](60°)   -Z=[ 0.500,-0.866,0](60°)
  leftUpperLeg    +X=[0,-0.542,-0.841](60°)  +Z=[ 0.865,-0.499,0](60°)
  leftLowerLeg    +X=[0,-0.591,-0.807](60°)  +Y=[0.094,-0.994,0.054](6°)
  leftFoot        +X=[0, 0.476,-0.880](60°)  +Z=[0.454,-0.262,-0.852](30°)
```

⇒ 由"静止朝向 + 肌肉名首词约定"机械推出的每一条轴（`humanoid-map.mjs` 里逐行写了推导）：

| 骨 | 肌肉 | 旋转轴 | 正方向 |
|---|---|---|---|
| leftUpperArm | Down-Up | **+Z** | 向下 |
| leftUpperArm | Front-Back | **-Y** | 向后 |
| leftUpperArm | Twist In-Out | **+X** | 纯扭转 |
| rightUpperArm | Down-Up | **-Z** | 向下 |
| rightUpperArm | Front-Back | **+Y** | 向后 |
| leftUpperLeg | Front-Back | **+X** | 向后 |
| leftUpperLeg | In-Out | **-Z** | 向外(+X) |
| leftLowerLeg | Stretch | **+X** | 伸直（屈膝在负值侧） |
| leftFoot | Up-Down | **+X** | 向上(勾脚) |
| spine | Front-Back / Left-Right | **+X / -Z** | 向后 / 向角色左 |
| neck | Nod Down-Up / Tilt | **+X / -Z** | 低头 / 向角色左 |

### 2.3 语义验证：27/27 PASS（真实模型上的世界位移）

```powershell
node self-check.mjs --semantics
```

原始输出（完整 27 行）：

```
ID    肌肉                             值观测量                    静止       施加后          Δ  判定
S-01  Left Arm Down-Up                 0.7 handY              1.1374    0.7923    -0.3451  PASS  Down-Up +1 = 向下 ⇒ 左手 Y 下降
S-02  Left Arm Down-Up                -0.7 handY              1.1374    1.4825     0.3451  PASS  Down-Up -1 = 向上 ⇒ 左手 Y 上升
S-03  Right Arm Down-Up                0.7 handY              1.1374    0.7923    -0.3451  PASS  右手与左手**同向**（镜像轴编码的结果）
S-04  Right Arm Down-Up               -0.7 handY              1.1374    1.4825     0.3451  PASS  右手 Y 上升
S-05  Left Arm Front-Back              0.9 handZ              0.0138   -0.3688    -0.3825  PASS  Front-Back +1 = 向后 ⇒ 左手 Z 减小
S-06  Left Arm Front-Back             -0.9 handZ              0.0138    0.3963     0.3825  PASS  Front-Back -1 = 向前 ⇒ 左手 Z 增大
S-07  Right Arm Front-Back             0.9 handZ              0.0138   -0.3688    -0.3825  PASS  右手同向
S-08  Left Forearm Stretch              -1 elbowFlex          0.0000  130.0000   130.0000  PASS  Stretch -1 = 屈肘 ⇒ 屈曲角从 0° 增大到 130°
S-09  Left Forearm Stretch               1 elbowFlex          0.0000    0.0000     0.0000  PASS  Stretch +1 = 0°（正侧极限 0 ⇒ 不可反折）
S-10  Right Forearm Stretch             -1 elbowFlex          0.0000  130.0000   130.0000  PASS  右肘同向
S-11  Left Lower Leg Stretch            -1 kneeFlex           0.0000  130.0000   130.0000  PASS  Stretch -1 = 屈膝 ⇒ 屈曲角从 0° 增大到 130°
S-12  Right Lower Leg Stretch           -1 kneeFlex           0.0000  130.0000   130.0000  PASS  右膝同向
S-13  Left Upper Leg Front-Back       0.85 footZ              0.0316   -0.6232    -0.6548  PASS  Front-Back +1 = 向后 ⇒ 左脚 Z 减小
S-14  Left Upper Leg Front-Back      -0.85 footZ              0.0316    0.6380     0.6064  PASS  Front-Back -1 = 向前 ⇒ 左脚 Z 增大
S-15  Right Upper Leg Front-Back     -0.85 footZ              0.0316    0.6380     0.6064  PASS  右腿同向
S-16  Spine Front-Back                   1 neckZ              0.0105    0.1062     0.0957  PASS  Front-Back +1 = 躯干前倾 ⇒ 颈 Z 增大
S-17  Spine Front-Back                  -1 neckZ              0.0105   -0.0864    -0.0969  PASS  Front-Back -1 = 躯干后仰
S-18  Spine Left-Right                   1 neckX              0.0000    0.0963     0.0963  PASS  Left-Right +1 = 向角色左（+X）
S-19  Spine Left-Right                  -1 neckX              0.0000   -0.0963    -0.0963  PASS  Left-Right -1 = 向角色右
S-20  Neck Nod Down-Up                   1 headZ              0.0105    0.0526     0.0421  PASS  Nod Down-Up +1 = 低头 ⇒ 头 Z 增大（朝前）
S-21  Neck Nod Down-Up                  -1 headZ              0.0105   -0.0315    -0.0421  PASS  Nod Down-Up -1 = 抬头
S-22  Left Shoulder Down-Up              1 shoulderArmY       1.1374    1.1184    -0.0190  PASS  Down-Up +1 = 沉肩 ⇒ 上臂根 Y 下降
S-23  Left Hand Down-Up                  1 fingertipY         1.1374    1.0701    -0.0673  PASS  Down-Up +1 = 屈腕向下
S-24  Left Foot Up-Down                  1 toeY              0.0700    0.1533     0.0833  PASS  Up-Down +1 = 勾脚尖 ⇒ 脚趾 Y 上升
S-25  Left Lower Leg Stretch             1 kneeFlex           0.0000    0.0000     0.0000  PASS  Stretch +1 = 0°（不可反折，与 Unity 极限 [0,130] 一致）
S-26  Right Upper Leg Front-Back      0.85 footZ              0.0316   -0.6232    -0.6548  PASS  右腿 Front-Back +1 与左腿**同向**（两腿同轴）
S-27  Right Arm Down-Up                0.7 handZ              0.0138    0.0138     0.0000  PASS  纯抬臂不应产生前后位移

S 段合计 27/27 通过
```

### 2.4 符号对照实验（**必须诚实说明它的区分力有限**）

```powershell
node self-check.mjs --sign-sweep --frames 6
```

```
=== B 段：约定对照实验（样本 PET_POSE_1.anim，6 帧）===
变体                    通过      /总   通过率
asis                  42      42   100.0%
flipSigns             42      42   100.0%
flipAxes              42      42   100.0%
swapSwingTwist        36      42    85.7%   未过: A-1 上臂不平行插入躯干轴
最优变体 = asis；本实现 = 'asis'  ⇒ PASS（不劣于任何候选）
```

⚠ **这一段本来是我的"符号验证"设计，实测证明它对符号不敏感**：
待机姿态里腿只动几度，把全部符号取反后解剖学不变量照样满分。
真正钉死符号的是 §2.3 的 **S 段定向位移**（±位移方向是有符号的）。
这一条写在代码注释里，也写进 NOT VERIFIED。

### 2.4b 解剖学不变量：636 条断言全 PASS（含 36 条显式豁免）

```powershell
node self-check.mjs --set all --frames 6
```

```
=== A 段：解剖学不变量（每文件 6 个采样帧）===
说明：A-3/A-5 只对站立姿态有意义；躺/坐姿会标 "豁免N"（exempt），不计入通过数也不计入失败。
[PASS] idle_pet_idle.vrma             42/42  pose=standing  豁免0  duration=2.450s
[PASS] idle_pet_idle_10.vrma          42/42  pose=standing  豁免0  duration=11.000s
[PASS] idle_pet_idle_2.vrma           42/42  pose=standing  豁免0  duration=13.333s
[PASS] idle_pet_idle_3.vrma           42/42  pose=standing  豁免0  duration=3.733s
[PASS] idle_pet_idle_4.vrma           42/42  pose=standing  豁免0  duration=13.333s
[PASS] idle_pet_idle_5.vrma           42/42  pose=standing  豁免0  duration=9.500s
[PASS] idle_pet_idle_6.vrma           42/42  pose=standing  豁免0  duration=5.667s
[PASS] idle_pet_idle_7.vrma           42/42  pose=standing  豁免0  duration=9.333s
[PASS] idle_pet_idle_8.vrma           42/42  pose=standing  豁免0  duration=6.000s
[PASS] idle_pet_idle_9.vrma           42/42  pose=standing  豁免0  duration=10.000s
[PASS] locomotion_pet_walk_left.vrma  42/42  pose=standing  豁免0  duration=1.417s
[PASS] misc_pet_dragging.vrma         42/42  pose=standing  豁免0  duration=12.783s
[PASS] pose_pet_pose_1.vrma           42/42  pose=standing  豁免0  duration=6.800s
[PASS] sitting_pet_sit_01.vrma        30/30  pose=sitting  豁免12  duration=3.167s
[PASS] sitting_pet_sit_02.vrma        30/30  pose=sitting  豁免12  duration=6.467s
[PASS] sleeping_pet_sleeping.vrma     30/30  pose=lying  豁免12  duration=35.167s

A 段合计：文件 16，断言 636 条，豁免 36 条，FAIL 0 个文件
self-check 总失败数 = 0
```

**两个阈值是实测标定出来的**（不是拍的；都写进了 `self-check.mjs` 的注释）：

- **A-7「两膝不穿模」**：模型**静止姿态**下 `leftLowerLeg` 与 `rightLowerLeg` 的世界 x 差
  就是 **0.0038 m** —— 这个角色膝本来就是并拢的。实测 `idle_pet_idle_10` 全段
  最小膝间距 = 0.0038 m（= 静止值，**根本没穿模**），而早期用 0.02 m 阈值
  把它误判 FAIL。现阈值取 **0.002 m**（只有真的交叉才会触发）。
- **A-3「大腿朝下」**：静止时大腿与 -Y 夹角 ≈ 3.1°，待机实测最大 **30.2°**（正常）；
  但 `sleeping_pet_sleeping`（躺姿）实测 **78.9°**。躺下时大腿本来就不朝下 ⇒
  这一条只对 `poseKind='standing'` 有意义。躺/坐姿通过显式 `poseKind` **豁免**
  （结果里标 `exempt: true`，**不伪装成通过**），豁免条数在汇总里单独列出。

### 2.5 `rest` 语义（任务书点名的核心风险）

读 three-vrm 源码 + 实测得到的确定结论：

- `VRMC_vrm_animation` 里的四元数**不是** local 旋转，而是「该骨在父骨**静止朝向**下的朝向」：
  `VRMAnimationLoaderPlugin._parseAnimation()` 内部
  `q_world_anim = q_parentWorld_REST · q_vrma`，
  再 `q_local_normalized = q_parentWorld_REST · q_vrma · inverse(q_world_REST)`。
- **归一化骨架的静止 local 旋转实测全部是单位四元数**（`_probe-rig.mjs`：52/52 根，
  非单位阵数量 = 0）。T-pose 的几何已经烘进骨骼**位置**里。
  ⇒ 对 three-vrm 归一化骨架：`local = rest · delta` 里的 `rest` = 单位阵，
  所以 **`local = delta`**（`humanoid-map.mjs` 的 `REST_MODE = 'normalized'`）。
- 对「自己拿 raw 节点搭骨架」的运行时，`rest` **不是**单位阵，必须真的乘：
  `composeLocal(delta, rest, 'raw')` 实现了这条路径，默认参数是 `'normalized'`。
- gLTF 层：模型 `metaVersion="0"` 时加载器会把四元数 x/z 取反。
  **实测：按语义写"未取反"的四元数得到正确世界朝向；自己先取反会得到镜像姿态**
  （`_probe-conv.mjs`：`negateXZ=true` 时左臂朝上而不是朝下）。
  ⇒ `VRMA_QUATERNION_CONVENTION.negateXZForVrm0 = false`。

---

## 3. 转换：16 个 `.vrma` + sidecar manifest

```powershell
node convert-anim.mjs --set idle     --hz 30
node convert-anim.mjs --set drag     --hz 30
node convert-anim.mjs --set walk     --hz 30
node convert-anim.mjs --set sit      --hz 30
node convert-anim.mjs --set sleep    --hz 30
node convert-anim.mjs --in "PET_POSE\PET_POSE_1.anim" --out "…\assets\motion\pose_pet_pose_1.vrma" --hz 30
```

原始输出（idle 段）：

```
[OK]   idle_pet_idle            骨= 54 帧=  75 时长=2.450s 字节=   83908 腿行程=300.1° 可循环=N
[OK]   idle_pet_idle_2          骨= 55 帧= 401 时长=13.333s 字节=  377640 腿行程=669.1° 可循环=Y
[OK]   idle_pet_idle_3          骨= 54 帧= 113 时长=3.733s 字节=  117416 腿行程=162.4° 可循环=Y
[OK]   idle_pet_idle_4          骨= 55 帧= 401 时长=13.333s 字节=  377640 腿行程=356.1° 可循环=Y
[OK]   idle_pet_idle_5          骨= 55 帧= 286 时长=9.500s 字节=  274592 腿行程=1155.4° 可循环=Y
[OK]   idle_pet_idle_6          骨= 55 帧= 171 时长=5.667s 字节=  171532 腿行程=726.7° 可循环=Y
[OK]   idle_pet_idle_7          骨= 55 帧= 281 时长=9.333s 字节=  270112 腿行程=169.7° 可循环=Y
[OK]   idle_pet_idle_8          骨= 55 帧= 181 时长=6.000s 字节=  180500 腿行程=213.3° 可循环=Y
[OK]   idle_pet_idle_9          骨= 54 帧= 301 时长=10.000s 字节=  282896 腿行程=1183.8° 可循环=Y
[OK]   idle_pet_idle_10         骨= 54 帧= 331 时长=11.000s 字节=  309296 腿行程=1651.1° 可循环=Y

合计 10 个；成功 10，失败 0
```

其余 6 个：

```
[OK]   misc_pet_dragging        骨= 54 帧= 385 时长=12.783s 字节=  356816 腿行程=702.0° 可循环=N
[OK]   locomotion_pet_walk_left 骨= 54 帧=  43 时长=1.417s 字节=   55704 腿行程=568.7° 可循环=Y
[OK]   sitting_pet_sit_01       骨= 54 帧=  96 时长=3.167s 字节=  102396 腿行程=753.1° 可循环=N
[OK]   sitting_pet_sit_02       骨= 54 帧= 195 时长=6.467s 字节=  189600 腿行程=165.9° 可循环=N
[OK]   sleeping_pet_sleeping    骨= 54 帧=1056 时长=35.167s 字节=  947424 腿行程=3216.4° 可循环=Y
[OK]   pose_pet_pose_1          骨= 54 帧= 205 时长=6.800s 字节=  198396 腿行程=73.9° 可循环=Y
```

CLI 已实现：`--in` / `--out` / `--hz` / `--set <idle|drag|walk|sit|sleep|pose>` /
`--batch <manifest.json>` / `--dry-run` / `--rootq <drop|apply>` / `--no-fingers` / `--list`。

### 3.1 产出的 `.vrma`（绝对路径 + 字节数）

```
F:\deepseek harness\AI女友\新工程\assets\motion\idle_pet_idle.vrma                     83908
F:\deepseek harness\AI女友\新工程\assets\motion\idle_pet_idle_2.vrma                  377640
F:\deepseek harness\AI女友\新工程\assets\motion\idle_pet_idle_3.vrma                  117416
F:\deepseek harness\AI女友\新工程\assets\motion\idle_pet_idle_4.vrma                  377640
F:\deepseek harness\AI女友\新工程\assets\motion\idle_pet_idle_5.vrma                  274592
F:\deepseek harness\AI女友\新工程\assets\motion\idle_pet_idle_6.vrma                  171532
F:\deepseek harness\AI女友\新工程\assets\motion\idle_pet_idle_7.vrma                  270112
F:\deepseek harness\AI女友\新工程\assets\motion\idle_pet_idle_8.vrma                  180500
F:\deepseek harness\AI女友\新工程\assets\motion\idle_pet_idle_9.vrma                  282896
F:\deepseek harness\AI女友\新工程\assets\motion\idle_pet_idle_10.vrma                 309296
F:\deepseek harness\AI女友\新工程\assets\motion\locomotion_pet_walk_left.vrma          55704
F:\deepseek harness\AI女友\新工程\assets\motion\misc_pet_dragging.vrma                356816
F:\deepseek harness\AI女友\新工程\assets\motion\pose_pet_pose_1.vrma                  198396
F:\deepseek harness\AI女友\新工程\assets\motion\sitting_pet_sit_01.vrma               102396
F:\deepseek harness\AI女友\新工程\assets\motion\sitting_pet_sit_02.vrma               189600
F:\deepseek harness\AI女友\新工程\assets\motion\sleeping_pet_sleeping.vrma            947424
```

16 个 sidecar manifest 同名落在 `…\assets\motion\manifests\<slug>.json`，
字段含 `name / source / duration / loopable / loop{maxFirstLastPoseDistanceDeg, rootDriftMeters} /
rootDisplacement{rest,min,max,range} / perBoneActivityDeg / legActivity{total,perBone} /
allowedOverlayLayers / unverified[]`。

**`loopable` 自动判定**（阈值：首末帧姿态最大夹角 ≤ 3° 且 RootT 漂移 ≤ 0.02 m）：
16 个里 **11 个 loopable=true**，`idle_pet_idle` / `misc_pet_dragging` /
`sitting_pet_sit_01` / `sitting_pet_sit_02` 判为 false（源 clip 首末帧差异大）。

---

## 4. 独立校验：`validate-vrma.mjs`（**不 import 转换器**）

```powershell
node validate-vrma.mjs --dir "F:\deepseek harness\AI女友\新工程\assets\motion" `
  --json "F:\deepseek harness\AI女友\新工程\assets\motion\manifests\_validation-report.json"
```

逐文件 PASS/FAIL 表（原始输出）：

```
文件                                    结果   PASS  FAIL    骨      帧      时长s        字节
idle_pet_idle.vrma                  PASS     21     0   54     75    2.450     83908
idle_pet_idle_10.vrma               PASS     21     0   54    331   11.000    309296
idle_pet_idle_2.vrma                PASS     21     0   55    401   13.333    377640
idle_pet_idle_3.vrma                PASS     21     0   54    113    3.733    117416
idle_pet_idle_4.vrma                PASS     21     0   55    401   13.333    377640
idle_pet_idle_5.vrma                PASS     21     0   55    286    9.500    274592
idle_pet_idle_6.vrma                PASS     21     0   55    171    5.667    171532
idle_pet_idle_7.vrma                PASS     21     0   55    281    9.333    270112
idle_pet_idle_8.vrma                PASS     21     0   55    181    6.000    180500
idle_pet_idle_9.vrma                PASS     21     0   54    301   10.000    282896
locomotion_pet_walk_left.vrma       PASS     21     0   54     43    1.417     55704
misc_pet_dragging.vrma              PASS     21     0   54    385   12.783    356816
pose_pet_pose_1.vrma                PASS     21     0   54    205    6.800    198396
sitting_pet_sit_01.vrma             PASS     21     0   54     96    3.167    102396
sitting_pet_sit_02.vrma             PASS     21     0   54    195    6.467    189600
sleeping_pet_sleeping.vrma          PASS     21     0   54   1056   35.167    947424

合计 16 个文件；FAIL 0 个
VERDICT: ALL PASS
```

单文件明细（`sleeping_pet_sleeping.vrma`，21 项全 PASS）：

```
[PASS] G-01   GLB 头部（magic/version/length）  —— bytes=947424
[PASS] G-02   chunk 布局与 4 字节对齐、无越界  —— JSON:18116 + BIN:929280
[PASS] G-03   JSON chunk 可解析  —— 10 个顶层键
[PASS] G-03b  asset.version == "2.0"
[PASS] G-04   extensionsUsed 含 VRMC_vrm_animation 且 extensions 里有它
[PASS] G-05   specVersion ∈ {1.0, 1.0-draft}  —— specVersion=1.0
[PASS] A-01   全部 accessor / bufferView 不越界、byteStride 合法  —— 56 accessor / 56 bufferView
[PASS] H-01   humanoid.humanBones 存在且每项 node 为数字  —— 54 根
[PASS] H-02   humanBones 的 node 索引在 nodes 范围内  —— nodes=54
[PASS] H-02b  humanBones 的 node 不重复  —— ok
[PASS] H-03   hips 存在（加载器要用它算 rest 姿势）  —— node=2
[PASS] H-04   任务书要求的 22 根核心骨齐全  —— 22/22
[PASS] N-01   恰有 1 条 animation  —— anims=1
[PASS] A-02   sampler 的 input/output 类型与 count 自洽  —— 55 sampler
[PASS] A-03   采样时间严格递增、首帧为 0、非负  —— duration=35.166668s，input 组合数=1
[PASS] Q-01   全部旋转四元数归一化（|q|−1| < 1e-3）  —— 57024 个四元数，最大偏差 4.572e-8
[PASS] Q-02   四元数无 NaN/Inf  —— ok
[PASS] T-01   translation 轨道只出现在 hips  —— translation 骨: hips
[PASS] T-02   每条通道的 node 都在 humanBones 里  —— rotation 骨数=54
[PASS] M-01   动作非静态（有非零旋转幅度）或为单帧定格  —— 最大分量幅度=1.271805
[PASS] M-02   时长 > 0 且 ≤ 60s  —— duration=35.166668s frames=1056
```

---

## 5. 真加载验证：`load-test.mjs`（真 `VRMAnimationLoaderPlugin` + 真 `.vrm`）

```powershell
node load-test.mjs --json "F:\deepseek harness\AI女友\新工程\assets\motion\manifests\_load-test-report.json"
```

```
=== 真加载验证 ===
模型        : …\DLCs\Lazuli_VRM.vrm
  three     : r185
  metaVersion=0  归一化骨=53  场景节点名=434
动作目录    : …\assets\motion  (16 个 .vrma)
腿行程阈值  : 3° / 骨

文件                                   时长s    轨道    期望     未解析     丢弃骨  腿·最佳5s窗口总行程（度）
idle_pet_idle.vrma                 2.450    53    53       0       2  LUL=180.1 RUL=183.6 LLL=54.2 RLL=55.8
idle_pet_idle_10.vrma             11.000    53    53       0       2  LUL=256.9 RUL=247.1 LLL=60.7 RLL=84.8
idle_pet_idle_2.vrma              13.333    54    54       0       2  LUL=121.3 RUL=106.6 LLL=12.3 RLL=10.1
idle_pet_idle_3.vrma               3.733    53    53       0       2  LUL=85.0 RUL=84.4 LLL=12.8 RLL=11.6
idle_pet_idle_4.vrma              13.333    54    54       0       2  LUL=62.3 RUL=66.6 LLL=9.3 RLL=3.1
idle_pet_idle_5.vrma               9.500    54    54       0       2  LUL=210.2 RUL=213.0 LLL=68.6 RLL=74.6
idle_pet_idle_6.vrma               5.667    54    54       0       2  LUL=153.9 RUL=135.6 LLL=46.6 RLL=131.5
idle_pet_idle_7.vrma               9.333    54    54       0       2  LUL=35.5 RUL=26.1 LLL=4.0 RLL=2.0
idle_pet_idle_8.vrma               6.000    54    54       0       2  LUL=25.3 RUL=63.3 LLL=5.4 RLL=17.8
idle_pet_idle_9.vrma              10.000    53    53       0       2  LUL=152.2 RUL=152.0 LLL=57.9 RLL=117.8
locomotion_pet_walk_left.vrma      1.417    53    53       0       2  LUL=550.8 RUL=525.5 LLL=116.6 RLL=118.9
misc_pet_dragging.vrma            12.783    53    53       0       2  LUL=83.9 RUL=63.2 LLL=40.6 RLL=33.8
pose_pet_pose_1.vrma               6.800    53    53       0       2  LUL=16.9 RUL=20.8 LLL=0.9 RLL=1.4
sitting_pet_sit_01.vrma            3.167    53    53       0       2  LUL=285.5 RUL=206.7 LLL=103.5 RLL=203.1
sitting_pet_sit_02.vrma            6.467    53    53       0       2  LUL=46.0 RUL=41.6 LLL=9.9 RLL=12.4
sleeping_pet_sleeping.vrma        35.167    53    53       0       2  LUL=219.9 RUL=251.1 LLL=56.7 RLL=103.5

===== 逐项断言明细（只列 FAIL；全通过时不打印）=====
  （无）

===== 逐文件结果 =====
  [PASS] idle_pet_idle.vrma               duration=2.450s  tracks=53/53 unresolved=0 丢弃骨=2 四腿全达标=Y
  …（16 行全部 PASS）…

===== idle 集合腿活动统计（10 个）=====
文件                                 LUpperLeg   RUpperLeg   LLowerLeg   RLowerLeg
idle_pet_idle.vrma                     180.1       183.6        54.2        55.8
idle_pet_idle_10.vrma                  256.9       247.1        60.7        84.8
idle_pet_idle_2.vrma                   121.3       106.6        12.3        10.1
idle_pet_idle_3.vrma                    85.0        84.4        12.8        11.6
idle_pet_idle_4.vrma                    62.3        66.6         9.3         3.1
idle_pet_idle_5.vrma                   210.2       213.0        68.6        74.6
idle_pet_idle_6.vrma                   153.9       135.6        46.6       131.5
idle_pet_idle_7.vrma                    35.5        26.1         4.0         2.0
idle_pet_idle_8.vrma                    25.3        63.3         5.4        17.8
idle_pet_idle_9.vrma                   152.2       152.0        57.9       117.8

  · 至少一根腿骨 > 3° 的 clip：10/10
  · 两根上腿都 > 3° 的 clip：10/10
  · 四条腿骨**全部** > 3° 的 clip：9/10（其余 clip 的源 .anim 里 Lower Leg Stretch 全程非负 = 膝盖本来就是直的）

合计 16 个文件，FAIL 0；断言总数 161，FAIL 0
VERDICT: ALL PASS
```

`丢弃骨=2` 是**已解释的预期行为**：本模型没有 `upperChest` 与 `jaw`
（`humanoid.humanBones` 实测 53 根）。加载器对这两条轨道静默忽略，测试显式报告它。

### 5.1 关于"腿 > 3°"这条断言的诚实说明

任务书要求"腿 4 骨在 5 秒 clip 时间内各自超过 3°"。实测结果是：

- **两根上腿（髋）**：10/10 个 idle clip 在**任意** 5 秒窗口内都远超 3°
  （25.3° ~ 256.9°）。
- **两根小腿（膝）**：9/10 达标；`idle_pet_idle_7` 的 `rightLowerLeg` 最佳 5 秒窗口只有 **2.035°**。

追根因（见 §8）：`idle_pet_idle_7` 源 `.anim` 的 `Right Lower Leg Stretch`
在整段里取值 **[0.0349, 0.2307]**（**全程为正**），而该肌肉的正侧极限是 **0**
（编码"膝不可反折"）⇒ **源数据里这只膝盖就是直的**，转换器没有丢任何东西。
因此测试写成**分层**断言（不是为了让测试变绿，而是把"源素材有没有膝盖动作"
与"转换器对不对"分开）：

- `L-05` 每个 clip 至少一根腿骨在某 5 秒窗口内 > 3°（**门槛**）
- `L-05b` 两根上腿各自 > 3°（**门槛**，10/10 通过）
- `L-05c` 四条腿骨各自 > 3°（**只报告**，9/10）

---

## 6. 实测发现 ①：`RootQ` 必须丢弃，否则骨架上下颠倒

### 6.1 证据 A：源数据里 `RootQ` 就是接近 180° 的旋转

```powershell
node _rootq.mjs
```

```
PET_IDLE.anim          RootQ t=0 = [ 0.18552, 0.00981,  0.97299, -0.07132]  |q|=0.99313  角=171.82°  轴=[ 0.186, 0.010, 0.975]
PET_IDLE_2.anim        RootQ t=0 = [-0.00001, 0.00000,  0.99951, -0.09876]  |q|=1.00437  角=168.66°  轴=[ 0.000, 0.000, 1.004]
PET_POSE_1.anim        RootQ t=0 = [ 0.07609, 0.00325, -0.99694, -0.12340]  |q|=1.00743  角=165.82°  轴=[ 0.077, 0.003,-1.005]
PET_WALK_LEFT.anim     RootQ t=0 = [ 0.00882,-0.02572,  0.99961,  0.01725]  |q|=1.00013  角=178.02°  轴=[ 0.009,-0.026, 1.000]
```

### 6.2 证据 B：把它写进 VRMA 的 hips rotation ⇒ 骨架颠倒

`_rigdebug.mjs` 用真模型 + 真插件加载**带 RootQ** 的 `.vrma`，在 t=0 打印世界坐标：

```
=== 动画 t=0（带 RootQ）===
  hips            world=[-4.683,0.834,0.552]    ← 髋在 0.834
  spine           world=[-4.689,0.790,0.552]    ← 脊柱掉到下面
  chest           world=[-4.708,0.680,0.553]
  neck            world=[-4.733,0.512,0.566]
  head            world=[-4.741,0.448,0.559]    ← 头在髋**下面**
  leftUpperLeg    world=[-4.628,0.885,0.533]
  leftLowerLeg    world=[-4.514,1.189,0.540]
  leftFoot        world=[-4.384,1.486,0.509]    ← 脚翘到髋**上面**
  hips localQ = [-0.187, 0.010, -0.980, -0.072] ← 180° 翻转在这里
```

### 6.3 证据 C：把 hips rotation 换成单位四元数 ⇒ 立刻恢复正常

`_strip-rootq.mjs` 只改这一条轨道（其余字节不动），同样用真模型加载：

```
=== 动画 t=0（hips rotation 置为单位四元数）===
  hips            world=[-4.683,0.834,0.552]
  spine           world=[-4.683,0.879,0.552]    0.834 → 0.879 ↑
  chest           world=[-4.681,0.990,0.551]    → 0.990 ↑
  neck            world=[-4.675,1.160,0.561]    → 1.160 ↑
  head            world=[-4.680,1.225,0.555]    → 1.225 ↑
  leftUpperLeg    world=[-4.733,0.776,0.552]
  leftLowerLeg    world=[-4.794,0.459,0.586]    → 0.459 ↓
  leftFoot        world=[-4.884,0.146,0.591]    → 0.146 ↓
```

**解释**：Unity 的 `RootQ` 是 **Avatar 根节点的朝向**（这些资产建立在"根被转 180°"
的绑定之上），不是"角色相对 T-pose 的增量"。而 VRM 的归一化骨架**自带**正确的站立
朝向（rest 旋转 = 单位阵，实测 52/52）。再叠一次 180° 必然颠倒。

⇒ `convert-anim.mjs` 默认 **`--rootq drop`**；需要原始根旋转时显式传 `--rootq apply`，
并在 `manifest.unverified[]` 里标注由调用方负责抵消。

---

## 7. 实测发现 ②：VRMA 的 hips rest 位置会被加载器用来**算缩放**

读 `three-vrm-animation` 源码：

```js
// createVRMAnimationHumanoidTracks()
const animationY = vrmAnimation.restHipsPosition.y;          // = VRMA 文件里 hips 节点的世界 Y
const humanoidY  = humanoid.normalizedRestPose.hips.position[1];  // = 模型自己的髋高
const scale = humanoidY / animationY;
track.values = track.values.map((v, i) => ... * scale);
```

实测数值（`render-contact-sheet.mjs` 的 `_render.json` 里直接打出来）：

```
loaderScale        4.85224
modelHipsY         0.8341416      ← 模型自己的髋高
vaRestHips         [0.96508, 0.17191, -0.11368]   ← 转换器写入的 RootT 首帧
```

⇒ `scale = 0.834 / 0.172 ≈ 4.85`，位移被放大近 5 倍。
`idle_pet_idle` 的 `RootT.x ≈ 0.966` 本来只是 1 米内的基准偏移，
乘 4.85 后变成 **x ≈ -4.68**（角色飞出画面）。

**处置**（两条都已落地）：

1. `manifest` 里记录 `rootDisplacement.rest`，并在 `unverified[]` 标注这条缩放语义；
2. `render-contact-sheet.mjs` 增加 `--hips-origin relative|absolute`（默认 `relative`）：
   保留**相对首帧**的位移并**除以 loaderScale** 抵消放大，把髋钉在模型真实髋高上。
   验证后的世界坐标（`idle_pet_idle`，4 帧）：

```
t=0      hips=[0,0.8341,0]        head=[0.0033,1.2251,0.0037]   leftFoot=[-0.2008,0.1461,0.0389]
t=0.8003 hips=[0.0001,0.806,0.0018] head=[-0.004,1.1961,-0.0064] leftFoot=[0.1074,0.1866,0.2898]
t=1.6007 hips=[-0.0009,0.8171,-0.0008] head=[0.0022,1.2078,-0.0035] leftFoot=[-0.0882,0.1387,0.1801]
t=2.401  hips=[0.0048,0.8108,-0.0225] head=[0.0071,1.2015,-0.0106] leftFoot=[-0.2661,0.1436,-0.0443]
```

头 1.20–1.23 m、脚 0.14–0.19 m、髋 0.81–0.83 m ⇒ 直立、双脚在地面附近。
**注意**：这是**渲染/预览期**的修正；转换器**原样**写出 `RootT`
（manifest 的 `rootDisplacement` 记录原始值），是否做这个归一化由运行时决定。

---

## 8. 实测发现 ③："腿不动"是源素材的性质

按属性名清点 `Left/Right Lower Leg Stretch` 的取值域：

```
PET_IDLE.anim    LLC=[-0.1467,-0.0475] keys=34    RLL=[-0.1339,-0.0352] keys=31    ⇒ 屈膝 6.2° ~ 19.1°
PET_IDLE_2.anim  LLC=[ 0.0952, 0.2704] keys=401   RLL=[-0.0029, 0.1721] keys=401   ⇒ 屈膝 0°
PET_IDLE_4.anim  LLC=[ 0.0784, 0.1824] keys=401   RLL=[ 0.0403, 0.1584] keys=401   ⇒ 屈膝 0°
PET_IDLE_7.anim  LLC=[ 0.1090, 0.2470] keys=281   RLL=[ 0.0349, 0.2307] keys=281   ⇒ 屈膝 0°
```

`Left Lower Leg Stretch` 的极限是 `[-130, 0]`（正侧 0 = 膝不可反折），
所以**正值 ⇒ 0° 屈曲**。这就解释了：

- `PET_IDLE_2/4/5/6/7/8` 的膝盖在源数据里就是**直的**（所以它们的 `*LowerLeg` 行程只有个位数度）；
- `PET_IDLE.anim` 的膝盖实际在动（6°–19°），它的 `*LowerLeg` 行程因此明显更大（25.7°/26.6°）。

符号方向也做过交叉验证（`_signprobe.mjs`，两套符号假设逐帧对比）：

```
A = 当前实现（Stretch 正值 = 0°）              B = Stretch 反号（正值 = 屈膝）
PET_IDLE.anim   膝屈曲=13.4°  踝-膝ΔZ=-0.0005  反折帧=3/5
PET_IDLE_2.anim 膝屈曲= 0.5°  踝-膝ΔZ=-0.0186  反折帧=0/5
PET_IDLE_3.anim 膝屈曲= 7.1°  踝-膝ΔZ= 0.0702  反折帧=5/5
PET_IDLE_6.anim 膝屈曲= 1.0°  踝-膝ΔZ= 0.0440  反折帧=0/5
```

A 与 B 在"膝盖是直的"的那几个 clip 上给出**逐位相同**的结果（因为那些 clip 的
Stretch 全为正 ⇒ B 下也是 0°），而在 `PET_IDLE.anim` 上 A 给出 13.4° 屈膝、
B 给出 52.5°。**B 会让每一条动画的膝盖都额外弯 40°+**，明显偏离"站姿待机"，
所以保留 A。

---

## 9. 无 GUI 渲染：真 WebGL（Electron + SwiftShader）

```powershell
node render-contact-sheet.mjs --set idle --frames 4 --timeout 150000 --mesh-mode bones
```

原始输出（尾部）：

```
[electron] idle_pet_idle    OK  GL=ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)  webgl2=true  clip=2.450s/53 轨  PNG=4 张
[electron] idle_pet_idle_2  OK  … clip=13.333s/54 轨  PNG=4 张
…（10 个文件全部 OK）…
[svg] idle_pet_idle    OK  4 帧 × 2 投影 → idle_pet_idle_front.svg / idle_pet_idle_side.svg + idle_pet_idle_bonetrace.json
…（10 个文件全部 OK）…

=== 汇总 ===
Electron 真 WebGL : 至少一个文件成功  idle_pet_idle:OK idle_pet_idle_10:OK … idle_pet_idle_9:OK
SVG 骨骼投影      : 成功
产出 PNG          : 40 张
产出 SVG          : 20 个
输出目录          : F:\deepseek harness\AI女友\新工程\assets\motion\contact-sheets
VERDICT: OK（至少一路成功）
```

- **GL 后端实测**：`ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)`，
  `WebGL 2.0 (OpenGL ES 3.0 Chromium)`，`webgl2=true` ⇒ **无 GPU 也能出图**。
- 渲染用**真** `.vrm`（剥贴图后 60,559,292 字节）+ **真** `.vrma`
  + **真** `VRMAnimationLoaderPlugin` + `createVRMAnimationClip`。
- PNG 输出示例（绝对路径）：
```
F:\deepseek harness\AI女友\新工程\assets\motion\contact-sheets\idle_pet_idle\idle_pet_idle_f00_t0.000.png
F:\deepseek harness\AI女友\新工程\assets\motion\contact-sheets\idle_pet_idle\idle_pet_idle_f01_t0.800.png
F:\deepseek harness\AI女友\新工程\assets\motion\contact-sheets\idle_pet_idle\idle_pet_idle_f02_t1.601.png
F:\deepseek harness\AI女友\新工程\assets\motion\contact-sheets\idle_pet_idle\idle_pet_idle_f03_t2.401.png
…（每个 idle clip 4 张，共 40 张）
```
- SVG 骨骼投影（20 个 = 10 clip × 2 投影）+ 10 个 `*_bonetrace.json`（逐帧关键骨世界坐标）：
```
…\contact-sheets\idle_pet_idle_front.svg
…\contact-sheets\idle_pet_idle_side.svg
…\contact-sheets\idle_pet_idle_bonetrace.json
…（× 10 clip）
```

`--mesh-mode` 三档（默认 `bones`）：`bones`（骨块 + 真 WebGL）／`flat`（网格 + 默认材质）
／`original`（原贴图 + MToon）。默认选 `bones` 的理由：要回答的问题是
「Unity 肌肉解码出来的**世界骨向**对不对」，贴图在这条链路上零信息量，
却是在无 GPU 环境下最容易整段失败的一环。

渲染管线里踩到并修掉的坑（都写进了代码注释）：
1. 内联 79 MB base64 进 HTML ⇒ Chromium 解析几分钟，页面永远停在 `stage:'boot'`。
   改成**主进程起 127.0.0.1 迷你 HTTP 服务**，页面 `fetch('/asset/vrm')`。
2. `three-vrm*.module.js` 里是裸名 `import ... from "three"`；在 `file://` 下无法解析。
   改成铺模块时**按目录深度**改写成相对路径，并加了 import 链自检
   （`three-stdlib/types/helpers.js` 这个**类型桩**也必须铺，否则 404 断链）。
3. `stdout` 在 `pwsh` 下的重定向与 `Start-Process` 都有坑；最终用 `cmd /c > file` 收日志。
4. 配置文件带 UTF-8 BOM 会让 `JSON.parse` 直接抛（PowerShell `Set-Content` 默认加 BOM）。

---

## 10. `packages/motion-director`（冻结契约 + 纯逻辑状态机）

```powershell
cd "F:\deepseek harness\AI女友\新工程\packages\motion-director"
npx --yes --registry=https://registry.npmmirror.com tsc -p tsconfig.json     # TSC EXIT=0
node --test test/director.test.mjs test/no-three-import.test.mjs
```

原始输出（尾部）：

```
ℹ tests 44
ℹ suites 11
ℹ pass 44
ℹ fail 0
ℹ duration_ms 297.7264
TEST EXIT=0
```

覆盖的硬要求：

| ID | 断言 | 状态 |
|---|---|---|
| T1 | 待机在 **12 s** 处切换（11.9 s 不切、12.0 s 切、24.0 s 再切） | ✔ |
| T2 | 交叉淡化 **3 s**（13.5 s 进度恰为 0.5；扫到淡出方消失的实测时长 3000±10 ms） | ✔ |
| T3 | 拖拽**抢占一切**；释放后回到**拖拽前**的 state / 待机（含待机计时暂停） | ✔ |
| T4 | 一次性动作**播完回退**到进入前状态；`returnTo` 显式指定；被拖拽打断且已播完则退到更早状态 | ✔ |
| T5 | **无 T-pose 窗口**：0–40 s 每 25 ms 采样，`baseClip != null` 且基础权重和恒为 1 | ✔ |
| T6 | 确定性：同 seed + 同命令序列 ⇒ 逐帧完全一致；`mulberry32` 可复现 | ✔ |
| T7 | manifest 运行期校验：类型/取值域/重名/缺 idle 基础动作都会被**拒绝** | ✔ |
| T8 | 优先级数值序 `drag(3) > oneshot(2) > state(1) > idle(0)` | ✔ |
| — | `src/` 与 `dist/` 里**没有任何非相对 import**（结构性断言，防"悄悄依赖 three"） | ✔ |
| — | `package.json` 的 runtime `dependencies` 为空 | ✔ |

**纪律落地**：`src/` 里不出现 `three` / `@pixiv/*` / DOM 的 import；
时间全部由外部 `frame(nowMs)` 注入；随机全部走注入种子的 `mulberry32`。
`test/no-three-import.test.mjs` 把这条纪律做成**会在 CI 变红**的测试。

实现过程中遇到并修掉的两个真实状态机 bug（都在代码注释里留了痕）：

- **待机计时"暂停"其实没生效**：早期写法是"保留绝对截止时刻"
  （`nextIdleSwitchAtMs > nowMs ? 保留 : nowMs+12s`），只要被抢占的时间没跨过原截止点，
  轮换就仍按原时刻发生。实测：5 s 开始拖拽到 9 s，轮换仍在 12 s 而不是 16 s。
  正确做法是存**已播时长**，恢复时重算截止点（`restoreIdleClock()`）。
- **被打断的 oneshot 会卡住**：拖拽期间 oneshot 的结束时刻被清掉，
  释放后回退到一个"永远播不完"的动作上（`wave` 一直不动）。
  改成把结束时刻暂存、拖拽期间按**墙钟**继续计时，释放时若已过期就再退一层。

---

## 11. 逐骨活动量表（idle 集合，单位：度·总角行程）

数据来源：各自的 `manifests/<slug>.json` 的 `perBoneActivityDeg`
（= 逐帧四元数夹角之和，转换器侧计算；`load-test.mjs` 侧的 mixer 独立复算与之一致）。

```
bone                              idle   idle_10    idle_2    idle_3    idle_4    idle_5    idle_6    idle_7    idle_8    idle_9
spine                              6.9      31.8      51.1      63.8      43.4      59.3      34.9      44.3      27.3      34.8
chest                              3.4      16.4      11.1       0.0       9.9      55.0      28.3      27.2      37.3      18.3
upperChest                         3.1      34.3      59.7      12.7      42.9      33.0      20.0      27.8      14.7      41.1
neck                              13.4     122.1     230.7      48.5     200.7     155.0     130.8      89.3     122.4     256.0
head                              10.5     272.2      41.5     148.9      73.0      42.9       7.0      42.1      24.4     349.4
leftShoulder                       2.3      43.3     100.3       4.1      93.0     136.8      85.4      87.0      91.8     144.3
rightShoulder                      1.7      57.6     102.9       1.5      58.8     142.5      76.3      92.7      86.6     107.9
leftUpperArm                      19.2     289.6     541.4      14.1     453.8     765.8     198.3     202.8     256.2     851.6
rightUpperArm                     28.9     235.7     429.5      10.2     559.5     898.5     313.7     332.2     343.2     957.4
leftLowerArm                       4.8     543.7     220.9      11.2     289.3     346.5     215.3     271.4     372.7     994.2
rightLowerArm                      6.3     357.0     239.1      19.6     354.3     505.6     326.4     452.3     292.4    1010.6
leftHand                           0.0     413.9     277.1      35.8     482.3     613.4     176.7     372.9     323.0    1157.7
rightHand                          0.0     282.9     348.5      35.9     199.5     387.7     306.5     318.6     336.5    1180.8
leftUpperLeg                      80.6     372.3     183.5      63.5      98.8     318.7     157.4      51.2      27.0     259.0
rightUpperLeg                     82.1     353.4     160.0      63.0     102.4     271.2     139.3      40.3      65.9     257.2
leftLowerLeg                      25.7      72.6      20.5       9.6      12.8      97.1      47.1       5.1       5.7      77.8
rightLowerLeg                     26.6     123.6      16.2       8.6       6.0      84.9     131.9       3.5      18.1     170.6
leftFoot                          36.4     328.2     131.0       6.3      55.3     131.9      77.3      24.6      15.3     178.0
rightFoot                         40.4     277.1     107.2       6.3      44.5     128.8     102.3      21.9      18.2     134.6
leftToes                           8.3      75.7      26.9       3.5      12.1      62.9      45.1       7.4      15.5      36.5
rightToes                          0.0      48.1      23.8       1.6      24.1      59.9      26.5      15.7      47.7      70.2
```

（手指 30 根骨的明细在同名 JSON 里；它们对本工程的站姿待机影响 < 1°。）

`legActivity.total`（腿 8 骨合计）：

```
idle=300.1  idle_2=669.1  idle_3=162.4  idle_4=356.1  idle_5=1155.4
idle_6=726.7  idle_7=169.7  idle_8=213.3  idle_9=1183.8  idle_10=1651.1
misc_pet_dragging=702.0  locomotion_pet_walk_left=568.7  pose_pet_pose_1=73.9
sitting_pet_sit_01=753.1  sitting_pet_sit_02=165.9  sleeping_pet_sleeping=3216.4
```

---

## 12. 产出清单（绝对路径）

**工具（`F:\deepseek harness\AI女友\新工程\tools\motion-lab\`）**

| 文件 | 作用 |
|---|---|
| `parse-anim.mjs` | Unity `.anim` YAML 解析器（分段、分类、压缩检测、批量 `--scan`） |
| `humanoid-map.mjs` | Unity↔VRM 权威映射 + 95 项肌肉表（逐行写推导）+ `muscleToDegrees`/`musclesToQuaternion`/`composeLocal` |
| `convert-anim.mjs` | `.anim` → `.vrma` + sidecar manifest（`--in/--out/--hz/--set/--batch/--dry-run/--rootq`） |
| `validate-vrma.mjs` | **独立** GLB/VRMA 字节级校验器（不 import 转换器） |
| `load-test.mjs` | 真 `VRMAnimationLoaderPlugin` + 真 `.vrm` 端到端加载 + 腿行程断言 |
| `self-check.mjs` | 逐肌肉语义验证（27 例）+ 解剖学不变量 + 符号对照实验 |
| `render-contact-sheet.mjs` | 无 GUI 渲染：Electron 真 WebGL PNG + SVG 骨骼投影（双路） |
| `renderer.html` | Electron 内的渲染页面 |
| `electron-main.cjs` | Electron 主进程：本地 HTTP 服务 + 剥贴图 + 定帧出图 |
| `REPORT.md` | 本文件 |
| `_probe-rig.mjs` / `_probe-conv.mjs` / `_calib.mjs` / `_calib2.mjs` / `_calib3.mjs` / `_signprobe.mjs` / `_kneeprobe.mjs` / `_rootq.mjs` / `_rigdebug.mjs` / `_strip-rootq.mjs` / `_fixtable.mjs` | 一次性探针/标定脚本，**证据可复跑** |

**动作资产**：16 个 `.vrma` + 16 个 sidecar manifest（路径见 §3.1）
**报告**：
```
F:\deepseek harness\AI女友\新工程\assets\motion\manifests\_validation-report.json
F:\deepseek harness\AI女友\新工程\assets\motion\manifests\_load-test-report.json
F:\deepseek harness\AI女友\新工程\assets\motion\contact-sheets\_contact-sheet-report.json
```
**截图**：`…\assets\motion\contact-sheets\<slug>\<slug>_fNN_tT.TTT.png`（40 张）
**SVG**：`…\assets\motion\contact-sheets\<slug>_{front,side}.svg`（20 个）

**契约包（`F:\deepseek harness\AI女友\新工程\packages\motion-director\`）**
`src/types.ts`、`src/manifest.ts`、`src/director.ts`、`src/index.ts`、
`test/director.test.mjs`、`test/no-three-import.test.mjs`、`package.json`、`tsconfig.json`、`dist/*`

---

## 13. NOT VERIFIED —— 明确没有证明的东西

1. **"肌肉名首词 = 正方向"这一步没有官方文档可核对。**
   本机访问不到 `docs.unity3d.com`（TLS 不可达），所以 `Down-Up +1 = 向下`、
   `Front-Back +1 = 向后` 这套读法是**本工程自洽采用的口径**。
   它与所有实测几何一致（§2.3 的 27 例定向位移全部通过），但**没有**与 Unity 官方
   逐条比对过。若它整体反了，动作会呈**前后/左右镜像**语义，而不会产生解剖学上
   不可能的姿态。
2. **`In-Out` / `Twist In-Out` 的"内/外"口径有主观性。**
   本表把 `Out` 放在正侧、且"外"取**解剖学外侧**。这一条同样是自洽口径而非官方核对。
3. **欧拉序（ZXY vs ZYX）没有被独立区分。**
   实现按「非末端 Z→X→Y、末端（手/脚/脚趾）Z→Y→X」逐次右乘。
   在本工程的样本上两种顺序给出的差异小于其它噪声（大多数骨只有 1–2 个轴同时动），
   所以**我没有证据说它是错的，也没有证据说它是对的**。
4. **手指肌肉（40 条）的轴向与符号未逐轴实测。**
   实测到的事实只有：手指骨在 T-pose 下沿 ∓X、归一化骨静止 local 轴 = 世界轴；
   由此推出"屈曲绕 ∓Z、张开绕 ±Y"，但**哪个方向是握拳没有独立验证**
   （手指与手腕的世界位置几乎重合，位置探测无法区分）。
   影响：待机里手指活动量 < 1°。
5. **脚趾 `Up-Down` 的符号未独立实测**（脚趾与脚踝世界位置重合）。
6. **`RootQ` 的"丢弃"是经验选择，不是对 Unity 语义的证明。**
   我证明了"写进 VRMA 会让骨架颠倒"（§6），也给出了"它是 Avatar 根朝向"的解释，
   但**没有**独立证实这个解释。`--rootq apply` 这条路径**没有**跑通验证。
7. **`RootT` 的绝对语义未确定。** 实测各 clip 的 `RootT` 基准差异极大
   （`PET_IDLE` y=0.172 而 `PET_SIT_01` y=1.372），我把它当作"相对基准"处理，
   但**没有**找到权威解释。§7 的 hips 归一化是**渲染期**修正，
   转换器本身**原样**写出 `RootT`。
8. **只验证了 1 个模型（`Lazuli_VRM.vrm`）。** 该模型缺 `upperChest` 与 `jaw`，
   所以这两条肌肉的转换路径**从未被真加载验证**（只被单元级校验过）。
   换模型后 `loaderScale`（§7）会变，需要重跑。
9. **没有做视觉质量评估。** 我做了：
   ① 真 WebGL 渲染出图（40 张，肉眼可看）；
   ② 27 例定向位移断言；
   ③ 骨架解剖学不变量（636 条断言，36 条显式豁免）。
   **没有**做：原始动画与转换结果的逐帧图像对比、脚部滑步量、动作"观感"评分。
   §6 之前的所有 VRMA 都是**颠倒**的，而 `validate-vrma` 与 `load-test`（21 + 161 项）
   **全部 PASS** —— 这是"结构校验不足以证明视觉正确"的实证。
10. **`--mesh-mode original`（原贴图 + MToon）没有跑通。** 默认的 `bones` 档跑通了；
    `flat` / `original` 未测。
11. **未做性能测量**：`AnimationMixer` 在 16 条 clip 同时注册下的开销、内存占用、
    在真实浏览器（非 SwiftShader）中的帧率，都没有测。
12. **`sleeping_pet_sleeping.vrma` 时长 35.167 s**，超出常见 idle 轮换窗口；
    它在 60 s 上限内（校验通过），但**没有**验证长时间播放的数值稳定性
    （四元数漂移、mixer 累积误差）。
