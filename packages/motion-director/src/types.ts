/**
 * @airimate/motion-director —— 冻结的数据契约
 *
 * 纪律（不可协商）
 * ----------------
 *   1. 本包是**纯逻辑**：整个 `src/` 里**不允许**出现 `three` / `@pixiv/*` / DOM 的任何 import。
 *      理由：动作决策必须在 Node 里可以 `node --test` 单测，也必须能在没有渲染器的
 *      宿主（例如 Unity 侧或服务端）里复用。渲染是 `avatar-stage` 的事。
 *   2. 时间**一律由外部注入**（`nowMs: number`），director 自己不读 `Date.now()`、
 *      不注册 `setInterval`。这样测试可复现、可快进。
 *   3. 随机**一律走注入的种子 PRNG**（`seed` → 确定性序列），不用 `Math.random()`。
 *      理由：待机轮换要可复现，否则"同一段输入为何播了不同 clip"无法复现/回归。
 *   4. 本文件与 `dist/` 里的 `.d.ts` 是**契约**：字段一经发布不得改名或改语义，
 *      只能新增可选字段。这与 `tools/motion-lab/convert-anim.mjs` 产出的
 *      `motion-clip-manifest/1` sidecar JSON 一一对应（见 `manifest.ts` 的映射说明）。
 */

// ═══════════════════════════════════════════════════ 图层

/**
 * 图层种类。
 *   `base`    —— **基础动作**：同一时刻**必须恰有一个**在活动（否则就是 T-pose 窗口）。
 *   `overlay` —— **叠加层**：乘/加在基础动作之上，允许多个并存（呼吸、眨眼、视线、道具手）。
 */
export type MotionLayerKind = 'base' | 'overlay'

// ═══════════════════════════════════════════════════ 优先级

/**
 * 优先级。**数值越大越优先**，且顺序是硬要求：
 *
 *      drag (3) > oneshot (2) > state (1) > idle (0)
 *
 * 用 `const enum`-like 的对象 + 字面量联合类型，保证编译期与运行期都能查。
 * ⚠ 不要用 TS `enum`：`isolatedModules` / `verbatimModuleSyntax` 下会被降级成运行期对象，
 *   而本包要求 `src/` 是纯类型 + 纯函数，便于被任意打包器 consuming。
 */
export const MotionPriority = {
  /** 待机轮换：最低。可被任何更高优先级抢占，且会被 12s 定时器轮换。 */
  Idle: 0,
  /** 状态动作：行走 / 坐下 / 睡眠等持续状态。 */
  State: 1,
  /** 一次性动作：挥手、点头等。播完回退到进入前的状态。 */
  OneShot: 2,
  /** 拖拽：最高。抢占一切；释放后回退到进入前的状态。 */
  Drag: 3,
} as const

export type MotionPriority = (typeof MotionPriority)[keyof typeof MotionPriority]

/** 数值序 → 名字（日志/调试用） */
export const MOTION_PRIORITY_NAMES: Readonly<Record<MotionPriority, string>> = Object.freeze({
  [MotionPriority.Idle]: 'idle',
  [MotionPriority.State]: 'state',
  [MotionPriority.OneShot]: 'oneshot',
  [MotionPriority.Drag]: 'drag',
})

// ═══════════════════════════════════════════════════ 命令

/** 所有命令的公共字段 */
export interface MotionCommandBase {
  /** 命令类型判别式 */
  readonly kind: string
  /**
   * 发起时刻（毫秒，单调时钟，由外部注入）。
   * director 只用它做"这条命令是否已过期"的判断，不参与插值。
   */
  readonly atMs: number
}

/**
 * 播放一个动作。
 *   `oneShot: true`  ⇒ 归入 `MotionPriority.OneShot`，播完自动回退。
 *   `oneShot: false` / 省略 ⇒ 归入 `MotionPriority.State`（持续状态）。
 * 想播待机请用 `setIdlePool` / 不指定；`MotionPriority.Idle` 不接受 `MotionCommand`。
 */
export interface MotionCommand extends MotionCommandBase {
  readonly kind: 'motion'
  /** 目标 clip 的 manifest name（= `MotionClipManifest.name`） */
  readonly clip: string
  /** 是否一次性动作（播完回退）。默认 false = 状态动作。 */
  readonly oneShot?: boolean
  /** 期望的交叉淡化时长（秒）。省略则用默认 3s（见 `MotionTuning.crossFadeSec`）。 */
  readonly fadeSec?: number
  /** 一次性动作播完后的回退目标；省略则回退到"进入前的状态" */
  readonly returnTo?: string
}

/** 表情（叠加层，不影响基础动作） */
export interface EmotionCommand extends MotionCommandBase {
  readonly kind: 'emotion'
  /** 表情名（VRM expression preset 或自定义名） */
  readonly expression: string
  /** 强度 0..1 */
  readonly weight: number
}

/** 口型 / 语音（叠加层） */
export interface SpeechCommand extends MotionCommandBase {
  readonly kind: 'speech'
  /** true = 开始说话，false = 停止 */
  readonly speaking: boolean
  /** 口型幅度 0..1（`speaking=false` 时忽略） */
  readonly amplitude?: number
}

/** 可见性（叠加层 / 表现层开关） */
export interface VisibilityCommand extends MotionCommandBase {
  readonly kind: 'visibility'
  /** 'avatar' = 整个人；'accessory:<id>' = 某个配件 */
  readonly target: string
  readonly visible: boolean
}

/** 窗口模式（表现层开关；不参与动作优先级） */
export interface WindowModeCommand extends MotionCommandBase {
  readonly kind: 'windowMode'
  readonly mode: 'desktop' | 'windowed' | 'fullscreen' | 'hidden'
}

/** 拖拽开始 / 结束（最高优先级） */
export interface DragCommand extends MotionCommandBase {
  readonly kind: 'drag'
  readonly active: boolean
  /** 拖拽中要播的 clip（省略则用 `MotionTuning.dragClip`） */
  readonly clip?: string
}

/** 所有命令的联合 */
export type AnyCommand =
  | MotionCommand
  | EmotionCommand
  | SpeechCommand
  | VisibilityCommand
  | WindowModeCommand
  | DragCommand

// ═══════════════════════════════════════════════════ 调参

/**
 * 调参。**全部可注入**，默认值即契约（不要偷偷改）：
 *   idleSwitchSec   12  —— 待机每 12 秒换一个 clip（任务书硬要求）
 *   crossFadeSec     3  —— 交叉淡化 3 秒（任务书硬要求）
 *   oneShotFadeSec   0.25 —— 一次性动作进出用短淡化（否则"挥手"会拖成 3 秒）
 */
export interface MotionTuning {
  readonly idleSwitchSec: number
  readonly crossFadeSec: number
  readonly oneShotFadeSec: number
  /** `MotionTuning.dragClip` 缺省时用的拖拽 clip 名 */
  readonly dragClip: string
  /** 待机池为空时的兜底 clip 名（若也没有则 director 进入 error 态） */
  readonly fallbackClip: string | null
}

export const DEFAULT_MOTION_TUNING: MotionTuning = Object.freeze({
  idleSwitchSec: 12,
  crossFadeSec: 3,
  oneShotFadeSec: 0.25,
  dragClip: 'misc_pet_dragging',
  fallbackClip: null,
})

// ═══════════════════════════════════════════════════ manifest

/**
 * 单个动作 clip 的清单。**与 `tools/motion-lab/convert-anim.mjs` 写出的
 * `motion-clip-manifest/1` sidecar JSON 字段一一对应**（映射见 `manifest.ts`）。
 *
 * 字段名一旦发布不改：这是 frozen contract。
 */
export interface MotionClipManifest {
  /** 唯一 id；约定等于 `.vrma` 文件名去掉扩展名，例如 `idle_pet_idle_2` */
  readonly name: string
  /** 图层：`base`（基础动作）或 `overlay`（叠加层） */
  readonly layer: MotionLayerKind
  /** 语义标签：`idle` / `walk` / `sit` / `sleep` / `drag` / `pose` / `oneShot` / `other` */
  readonly semantic: MotionSemantic
  /** 源 `.anim` 的绝对路径（可追溯） */
  readonly source: string
  /** 产出的 `.vrma` 相对路径 */
  readonly file: string
  /** `.vrma` 字节数（用于加载预算与完整性核对） */
  readonly bytes: number
  /** 时长（秒） */
  readonly durationSec: number
  /** 是否首尾可无缝循环（转换器自动判定） */
  readonly loopable: boolean
  /** 根位移范围 [x,y,z]（米） */
  readonly rootDisplacementRange: readonly [number, number, number]
  /** 逐骨总角行程（度），键为 VRM 归一化骨名 */
  readonly boneActivityDeg: Readonly<Record<string, number>>
  /** 腿活动量合计（度） */
  readonly legActivityDeg: number
  /** 允许叠加的层（转换器按活动量给的建议） */
  readonly allowedOverlayLayers: readonly string[]
  /** 可选的优先级提示（一般由 semantic 推出，不用手填） */
  readonly priorityHint?: MotionPriority
}

/** 动作语义 */
export type MotionSemantic = 'idle' | 'walk' | 'sit' | 'sleep' | 'drag' | 'pose' | 'oneShot' | 'other'

// ═══════════════════════════════════════════════════ 决策输出

/** director 的状态机相位 */
export type DirectorPhase = 'uninitialized' | 'idle' | 'state' | 'oneShot' | 'drag' | 'error'

/** 一条 clip 的目标权重 */
export interface ClipWeight {
  readonly clip: string
  /** 0..1 */
  readonly weight: number
  /** 这条权重达到当前值所经历的淡化时长（秒） */
  readonly fadeSec: number
}

/** director 每帧产出的决策（纯数据，由 avatar-stage 执行到 AnimationMixer） */
export interface DirectorFrame {
  readonly phase: DirectorPhase
  /** 当前活动的基础动作（**任何时刻都必须有且只有一个**，否则是 T-pose 窗口） */
  readonly baseClip: string | null
  /** 正在淡出的旧基础动作（交叉淡化期间非空） */
  readonly fadingOutClip: string | null
  /** 交叉淡化进度 0..1（无淡化时为 1） */
  readonly crossFadeProgress: number
  /** 本帧的完整权重表（含叠加层；总和应为 1 左右，见 `director.ts` 的备注） */
  readonly weights: readonly ClipWeight[]
  /** 当前生效的叠加层（表情 / 语音 / 可见性 / 窗口模式） */
  readonly overlays: DirectorOverlays
  /** 自 director 启动以来的逻辑时间（毫秒） */
  readonly elapsedMs: number
  /** 当前活动优先级 */
  readonly priority: MotionPriority
  /** 诊断：本帧发生的状态迁移（正常帧为空） */
  readonly transitions: readonly string[]
}

/** 叠加层当前状态 */
export interface DirectorOverlays {
  /** 表情名 → 强度 */
  readonly emotions: Readonly<Record<string, number>>
  readonly speaking: boolean
  readonly speechAmplitude: number
  /** 可见性：target → visible */
  readonly visibility: Readonly<Record<string, boolean>>
  readonly windowMode: 'desktop' | 'windowed' | 'fullscreen' | 'hidden'
}

/** director 的构造参数 */
export interface DirectorOptions {
  /** 全部可用 clip（`MotionClipManifest[]`，已通过 `validateManifest`） */
  readonly clips: readonly MotionClipManifest[]
  /** 待机池（`name` 列表）。空数组 ⇒ 用全部 `semantic === 'idle'` 的 clip */
  readonly idlePool?: readonly string[]
  /** 调参覆盖（部分） */
  readonly tuning?: Partial<MotionTuning>
  /** 确定性随机种子（整数）。相同种子 + 相同命令序列 ⇒ 完全相同的行为 */
  readonly seed?: number
  /** 起始时间（毫秒）。默认 0 */
  readonly startMs?: number
}
