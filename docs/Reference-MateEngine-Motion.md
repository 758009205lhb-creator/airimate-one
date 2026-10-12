# Reference · Mate Engine 动作系统技术栈与驱动机制

> 证据基准日：**2026-10-10**
> 调研对象：`shinyflvre/Mate-Engine`（GitHub `main` @ `2c5ea6b8f4cf5e1773a0816b46d9267cda5174d4`）
> 本地工作副本：`repos\Mate-Engine` @ `db0cf0f392c5c399758347c91fcbe3dd3c844af6`（2026-09-21）
> 方法：只读源码 + 资产清点；两份副本的机制逐条核对，读到的数值与代码结构完全一致。
> 用途：为 `packages/avatar-stage` 与 `packages/motion-director` 的动作层提供可追溯的上游参考，不引入其运行时。

## 0. 结论先行

Mate Engine 动作"自然"的原因不是算法实时生成姿态，而是：

**162 个美术手调的 Unity `AnimationClip` 打底 + 运行时只做"加法叠加 / 分层混合 / 物理"三层加工。**

程序化部分（鼠标跟随、脚 IK）只占观感的少数，且**全部是在已算出的动画姿态之上做乘法叠加**，从不覆盖基础动作。这正是它不会"像提线木偶"的结构性原因。

AiriMate One 的 `docs/Tech-Spec.md` §6.2 分层（L0–L3）与该模型同构。差异集中在三处：**每状态跟踪权限**、**分部位独立平滑**、**音频驱动**。

---

## 1. 技术栈

| 层 | Mate Engine 用的东西 | 备注 |
| --- | --- | --- |
| 引擎 | Unity + C#（1457 个 `.cs`） | 单进程桌面游戏外壳 |
| 模型 | **VRM 1.0**，`UniVRM10` / `UniGLTF`（`Vrm10Instance`） | Humanoid 标准骨骼，动作可跨模型复用 |
| 渲染 | Poiyomi Toon Shader 9.2.79 | toon 风格，非 PBR |
| 骨骼物理 | **DynamicBone**（发丝 / 衣物 / 饰品） | 对应本项目的 VRM `springBone` |
| 动画主体 | Unity `Animator` + 手调 `AnimationClip`（**162 个 `.anim`** / 17 个 `.controller`） | 不存在"程序生成全身姿态"的路径 |
| 局部程序化 | `AvatarMouseTracking`、`IKFix`、`AvatarSwayController` | 全部为叠加式 |
| LLM | **LLMUnity + Qwen 2.5 1.5B**（本地 GGUF） | 本地推理，不走云 API |
| 声音感知 | **NAudio** 监听系统音频会话峰值 | 用于"有音乐就跳舞" |
| 系统集成 | Win32 API（`EnumWindows`/`SetWindowPos`）、`uWindowCapture`、Steamworks、DiscordRPC | 窗口移动、贴屏、创意工坊 |

关键点：**模型是 VRM、动作是 VRMA 可表达的 Humanoid 剪辑**——这正是本项目 `tools/motion-lab` 能把 `.anim` 转成 `.vrma` 的前提。

---

## 2. 动作驱动机制

### 2.1 主状态机与参数

源文件：`Assets/MATE ENGINE - Scripts/AvatarHandlers/AvatarAnimatorController.cs`

Animator 参数：`isIdle`、`isDragging`、`isDancing`、`IdleIndex`、`DanceIndex`、`Blend`、`isMale`、`isFemale`、`HoverTrigger`、`WalkLeft`、`WalkRight`。

实测常量（本项目 `Tech-Spec.md` §6.3 已照搬并冻结这两个）：

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `totalIdleAnimations` | 10 | 待机剪辑数量 |
| `IDLE_SWITCH_TIME` | 12 s | 待机轮换周期 |
| `IDLE_TRANSITION_TIME` | 3 s | 待机交叉淡化时长 |
| `DANCE_CLIP_COUNT` | 5 | 舞蹈剪辑数量 |
| `DANCE_SWITCH_TIME` | 15 s | 舞蹈轮换周期 |
| `DANCE_TRANSITION_TIME` | 2 s | 舞蹈交叉淡化时长 |
| `SOUND_THRESHOLD` | 0.02 | 音频峰值触发阈值 |

状态覆盖：`Idle / Male / Female / Sitting / Hide / Eat / Drink / Cry / Angry / Happy / Head Pat / Intime Region / Alarm / Big Screen / Custom Dance / Walk`。

### 2.2 鼠标跟随：`LateUpdate` + 在动画姿态上相乘

源文件：`Assets/MATE ENGINE - Scripts/AvatarHandlers/AvatarMouseTracking.cs`（约 L153）

```csharp
var baseRot = headBone.localRotation;                       // 动画已算出的当前姿态
var delta   = headDriver.localRotation * Quaternion.Inverse(headInitRot);
headBone.localRotation = Quaternion.Slerp(baseRot, delta * baseRot, headBlend);
```

三个要点，缺一就会退化成"提线木偶"：

1. **时序**：写在 `LateUpdate`，即动画求值之后、渲染之前；
2. **叠加**：`delta * baseRot` 是右乘到基础姿态，而不是 `localRotation = delta`；
3. **有独立的 driver transform** 记录初始旋转，跟随量是相对初始值算的差值。

这与本项目 `Tech-Spec.md` §6.1 第 3 条「叠加而非替换 rest」是同一个数学约束。

### 2.3 分部位独立平滑（天然的层级延迟）

同一文件里的实测参数：

| 部位 | 平滑系数 | 角度上限 |
| --- | --- | --- |
| 头 | `headSmoothness = 10` | yaw 45° / pitch 30° |
| 脊椎 | `spineSmoothness = 25`（另有 `spineFadeSpeed = 5` 权重淡入） | ±15° |
| 眼 | `eyeSmoothness = 10` | yaw 12° / pitch 12° |

**不等于同一个数**才是关键：眼球与头响应快、脊椎响应慢，观察到的就是"眼先到、头跟上、身体最后转"的自然链。本项目 `TUNING.mouseSensitivity` 只有单一系数，尚无分部位差异。

### 2.4 每状态跟踪权限

`TrackingPermission { stateOrParameterName, isParameter, allowHead, allowSpine, allowEye }`，
在 `LateUpdate` 里按**当前状态**或**Animator 参数**查询是否允许跟随。

作用：做"被摸头 / 生气 / 睡觉"这类动作时关掉鼠标跟随，否则角色一边演动作一边被鼠标拽走，立刻穿帮。

### 2.5 表情走独立层

`FACE_LAYER/FACE_IDLE_1.anim` 等是**独立动画层**，只写 BlendShape（`m_FloatCurves`），不碰骨骼。
关键帧实测是不规则间隔与幅度：`t=0 → 0`、`t=0.5 → 1`、`t=1.25 → 0`、`t=2.5 → 0.3`，切线为自动平滑贝塞尔（`tangentMode 136`、权重 0.333）。

**不是正弦波**——这是"人味"的来源。本项目对应实现是 `packages/avatar-stage/src/overlays.ts`（`OverlayController`，L2 层）。

### 2.6 脚部 IK 按状态柔开关

源文件：`Assets/MATE ENGINE - Scripts/AvatarHandlers/IKFix.cs`

在 `OnAnimatorIK` 里按状态名查表决定目标权重，再用 `Mathf.MoveTowards(currentIKWeight, targetWeight, dt * blendSpeed)`（`blendSpeed = 5`）渐变，而不是硬切。

作用：修掉站姿脚部漂移，避免"被吊在半空"的观感。

**注意**：这条是 Unity `Animator` 特有 API，three.js + VRM 侧没有等价物，属于**不可直接迁移**项（见 §5）。

### 2.7 音频驱动跳舞

`AvatarAnimatorController.CheckSoundContinuously()` 每 2 s 轮询一次默认输出设备：

```
枚举 AudioSessionManager.Sessions → MasterPeakValue > SOUND_THRESHOLD(0.02)
→ 取 GetProcessID → 命中 allowedApps 白名单 → StartDancing()
```

即"系统里在放音乐（且来自允许的应用）就跳舞，停了就回待机"。本项目目前**没有任何系统音频监听**（全仓 `loopback` 命中项均为网络端口语义，与音频无关）。

### 2.8 移动与重力

`AvatarLocomotionController`：随机行走周期（250–550 帧）、窗口真实位移（`SetWindowPos`）、按角色包围盒做屏幕边缘阻挡、`OnlyMoveWhenFocused` 开关。
`AvatarGravityController`：把角色吸到前方窗口 / 任务栏上。

---

## 3. 与 AiriMate One 的对照

| Mate 机制 | AiriMate One 现状 | 判定 |
| --- | --- | --- |
| 手调 AnimationClip 打底（162 个） | `tools/motion-lab` 已转 VRMA，待机集合要求 ≥10 | **已覆盖**（资产层） |
| Animator 状态机 + 参数 | `packages/motion-director`（纯决策）+ `motion-runtime.ts`（执行侧） | **已覆盖** |
| 待机 12 s / 交叉淡化 3 s | `TUNING.idleSwitchSec / idleTransitionSec` | **已照搬冻结** |
| 叠加而非替换基础姿态 | `Tech-Spec.md` §6.1 第 3 条 + L1 摇晃叠加 | **已覆盖** |
| 表情独立层（BlendShape） | `overlays.ts` 的 `OverlayController`（L2，不碰骨骼） | **已覆盖** |
| DynamicBone 发丝 / 衣物 | 换用 VRM `springBone`（L3，`vrm.update` 内） | **等价覆盖** |
| 更新顺序（动画→叠加→物理） | §6.2 固定顺序 `mixer.update → L1 → L2 → vrm.update` | **已覆盖** |
| `LateUpdate` 时序 | three.js 的渲染循环内等价位置 | **已覆盖** |
| **分部位独立平滑（头 10 / 脊椎 25 / 眼 10）** | 仅单一 `mouseSensitivity`；`setLookTarget` 未分部位 | **缺口** |
| **每状态跟踪权限（`TrackingPermission`）** | 未见对应实现 | **缺口** |
| **音频驱动跳舞（NAudio 峰值 + 进程白名单）** | 无系统音频监听 | **缺口** |
| 舞蹈集合轮换（5 个 / 15 s / 2 s） | 未见 dance 相关实现 | **缺口** |
| 脚 IK 按状态柔开关 | — | **不可迁移**（Unity 特有 API） |
| 本地 LLM（LLMUnity + Qwen） | 走自建供应商 / API 架构 | **架构不同，不迁移** |

---

## 4. 缺口与建议落法（按性价比排序）

1. **分部位独立平滑**：把 `mouseSensitivity` 拆成 `headSmoothness / spineSmoothness / eyeSmoothness` 三个系数，并按"眼快、头中、脊椎慢"取值（起点可直接用 10 / 25 / 10）。改动集中在 `motion-runtime.ts` 的 `TUNING` 与 `stage.ts` 的 L1 应用点。
2. **每状态跟踪权限**：在 clip manifest 上增加 `allowHead / allowSpine / allowEye` 字段，随 `state` 一起被 `MotionDirector` 决策，执行侧据此把跟随权重淡到 0。这是"演动作时不被鼠标拽走"的唯一可靠做法。
3. **音频驱动**：Electron 主进程侧做系统音频采集（loopback），命中阈值后向 renderer 发一条"进入 dance 状态"的命令，复用现有 `state` 通道即可；先做"有 / 无音乐"二值，不做节拍对齐。
4. **舞蹈轮换**：复用待机轮换的同一套轮换逻辑（`DANCE_SWITCH_TIME=15s`、`DANCE_TRANSITION_TIME=2s`），无需新机制。

前两项是纯叠加层改动，不动资产、不动许可边界，风险最低。

---

## 5. 明确不迁移的部分

- **`OnAnimatorIK` 脚部 IK**：Unity `Animator` 专有，three.js / VRM 无等价 API。要复现只能自己做 FABRIK/TwoBoneIK 解算，成本远高于收益，且本项目当前没有脚部漂移的问题场景。
- **LLMUnity / Qwen 本地推理**：与本项目"主进程出网 + 自建供应商"的架构相斥，且违反"renderer 无出网原语"的既有边界。
- **Steamworks / 创意工坊 / DiscordRPC**：属发行与社交功能，本项目为私有自用，无需求。
- **162 个剪辑全量引入**：只取待机与状态集合即可；全量引入会放大许可与体积问题。

---

## 6. 许可边界（重申，不得放宽）

- Mate Engine 采用 **MateEngine Pro License v2.1**：允许私用与修改，含 copyleft 条款，**禁止商业与二进制再分发**；其 DLC 资产（VRM）没有独立许可文件。
- 本文档是**私有项目内的技术参考**，只记录机制与实测数值，不复制其实现代码。§2.2 的 3 行摘录用于说明"叠加而非替换"的数学约束，不进入任何产物。
- 本仓库继续**不分发** `VRM` / `VRMA` / `.anim`；分发包内永远不含这三类文件（由 `npm run build:dist` 的 scan + integrity 两关保证）。

---

## 附：本文档不构成验收证据

本文档是**上游技术参考**，不是本项目的验收证据。任何"AiriMate One 已实现某机制"的判断，仍须以
`docs/evidence/**` 下的探针 JSON（按 `pass*` / `checks{}` 计数）为准。
