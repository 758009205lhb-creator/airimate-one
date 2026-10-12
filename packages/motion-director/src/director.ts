/**
 * @airimate/motion-director/director —— 动作状态机（**纯逻辑**）
 *
 * 硬约束（每条都有对应的单测，见 `test/director.test.mjs`）
 * ---------------------------------------------------------
 *   D1 优先级：drag(3) > oneshot(2) > state(1) > idle(0)。高优先级抢占低优先级。
 *   D2 待机轮换：每 12s（`tuning.idleSwitchSec`）换下一个待机 clip。
 *   D3 交叉淡化：基础动作切换用 3s（`tuning.crossFadeSec`）线性交叉。
 *   D4 拖拽：抢占一切；`active=false` 时**回退到进入拖拽前的状态**（含当时的相位、
 *      优先级、待机 clip 与剩余轮换计时）。
 *   D5 一次性动作：播完（`durationSec`）后**回退到进入前的状态**，或 `returnTo` 指定的 clip。
 *   D6 **无 T-pose 窗口**：从 `frame()` 首帧起，任意采样时刻 `baseClip != null`，
 *      且**基础动作的权重之和恒为 1**（含 t=0 与所有过渡中间帧）。
 *   D7 确定性：相同 `seed` + 相同命令序列 + 相同时间步 ⇒ 完全相同的输出。
 *      待机选择用注入种子的 mulberry32，绝不用 `Math.random()`。
 *   D8 纯逻辑时钟：所有时间由外部 `frame(nowMs)` 注入；不读系统时钟、不起定时器。
 *
 * 为什么"权重和为 1"必须成立（这正是不变量的物理含义）
 * ---------------------------------------------------
 *   three 的 `AnimationMixer` 做的是**加权平均**：若基础动作权重只有 0.5，
 *   剩下的 0.5 会留给"绑定姿势（bind pose）"—— 那就是 T-pose 窗口。
 *   所以过渡期的正确做法是 `out: 1−p` + `in: p`，两者之和恒为 1。
 *   本文件把它做成了每帧执行的 `assertInvariants()`：一旦违反立刻抛错，
 *   而不是让画面"只是抖一下"这种静默失效。
 *
 * 本文件**不 import** `three` / `@pixiv/*` / DOM。渲染是 `avatar-stage` 的事。
 */

import type {
  AnyCommand, ClipWeight, DirectorFrame, DirectorOptions, DirectorOverlays, DirectorPhase,
  DragCommand, EmotionCommand, MotionClipManifest, MotionCommand, MotionPriority, MotionTuning,
  SpeechCommand, VisibilityCommand, WindowModeCommand,
} from './types.js'
import { DEFAULT_MOTION_TUNING, MotionPriority as P } from './types.js'
import { assertManifest, SEMANTIC_TO_PRIORITY } from './manifest.js'

// ───────────────────────────────────────────────────── 确定性 PRNG

/**
 * mulberry32：32 位种子、周期 2^32 的确定性 PRNG。
 * 选它而不是 `Math.random()`：待机轮换必须可复现（D7），
 * 否则"同一段输入为什么播了不同 clip"永远无法回归。
 */
export function mulberry32(seed: number): () => number {
  let a = (seed >>> 0) || 0x9e3779b9
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ───────────────────────────────────────────────────── 内部类型

interface BaseSlot {
  clip: string
  weight: number
  fadeSec: number
  enteredAtMs: number
}

interface Snapshot {
  clip: string | null
  priority: MotionPriority
  phase: DirectorPhase
  /** 快照时刻"当前这个待机片段已经播了多久"（ms）。用于把待机轮换计时**暂停**再恢复。 */
  idleElapsedMs: number
  idleIndex: number
  oneShotReturnTo: string | null
  /** 快照时刻那次一次性动作的结束时刻（用于"回到还没播完的 oneshot"） */
  oneShotEndsAtMs: number | null
}

const PRIORITY_NAME: Readonly<Record<number, string>> = Object.freeze({
  [P.Idle]: 'idle', [P.State]: 'state', [P.OneShot]: 'oneshot', [P.Drag]: 'drag',
})
const pname = (p: MotionPriority): string => PRIORITY_NAME[p] ?? String(p)

// ───────────────────────────────────────────────────── Director

export class MotionDirector {
  private readonly tuning: MotionTuning
  private readonly clips: readonly MotionClipManifest[]
  private readonly byName: Map<string, MotionClipManifest>
  private idlePool: readonly string[]
  private readonly rng: () => number

  private phase: DirectorPhase = 'uninitialized'
  private nowMs: number
  private readonly startMs: number
  private priority: MotionPriority = P.Idle

  private base: BaseSlot | null = null
  private fading: BaseSlot | null = null

  private nextIdleSwitchAtMs = 0
  /** 当前待机片段是从哪一刻开始播的（用于"暂停/恢复"轮换计时） */
  private idlePhaseStartedAtMs = 0
  private idleIndex = 0

  private stack: Snapshot[] = []
  private oneShotEndsAtMs: number | null = null
  private oneShotReturnTo: string | null = null
  private dragClipActive: string | null = null
  /**
   * 被拖拽**打断**时暂存的一次性动作结束时刻。
   * 为什么需要它：一次性动作的时长按**墙钟**走（它就是一段动画），
   * 因此拖拽期间它应当继续计时。若不暂存，拖拽释放后会回退到"被打断的 oneshot"，
   * 而那个 oneshot 可能早就播完了 —— 表现是卡在一个永远播不完的动作上（实测踩到过）。
   */
  private oneShotEndsAtMsBeforeDrag: number | null = null

  private overlays: DirectorOverlays = {
    emotions: {}, speaking: false, speechAmplitude: 0, visibility: {}, windowMode: 'desktop',
  }

  private transitionLog: string[] = []

  constructor(options: DirectorOptions) {
    const { clips } = assertManifest({ clips: options.clips })
    this.clips = clips
    this.byName = new Map(clips.map((c) => [c.name, c]))
    this.tuning = Object.freeze({ ...DEFAULT_MOTION_TUNING, ...(options.tuning ?? {}) })
    this.rng = mulberry32(options.seed ?? 0x5eed)
    this.startMs = options.startMs ?? 0
    this.nowMs = this.startMs

    const declared = options.idlePool && options.idlePool.length
      ? [...options.idlePool]
      : clips.filter((c) => c.semantic === 'idle' && c.layer === 'base').map((c) => c.name)
    const unknown = declared.filter((n) => !this.byName.has(n))
    if (unknown.length) throw new Error(`idlePool 里有未知 clip：${unknown.join(', ')}`)

    let pool = declared
    if (pool.length === 0 && this.tuning.fallbackClip && this.byName.has(this.tuning.fallbackClip)) pool = [this.tuning.fallbackClip]
    if (pool.length === 0) {
      this.phase = 'error'
      throw new Error("idlePool 为空且没有可用的 fallbackClip —— director 无法保证「任何时刻都有基础动作」")
    }
    this.idlePool = Object.freeze(pool)
    // 起始待机由种子决定 ⇒ 确定性
    this.idleIndex = Math.floor(this.rng() * this.idlePool.length) % this.idlePool.length
  }

  // ── 只读查询

  get currentPhase(): DirectorPhase { return this.phase }
  get currentPriority(): MotionPriority { return this.priority }
  get currentBaseClip(): string | null { return this.base?.clip ?? null }
  get idlePoolNames(): readonly string[] { return this.idlePool }
  get clipCount(): number { return this.clips.length }
  get tuningSnapshot(): MotionTuning { return this.tuning }

  // ── 命令入口

  /**
   * 投递一条命令；返回本次产生的迁移描述（便于日志与测试断言）。
   *
   * ⚠ **调用约定**：命令按顺序应用在 director **当前**的逻辑时刻（`nowMs`）上。
   *   正确用法是 `frame(t)` 之后再 `dispatch({ atMs: t, ... })`，
   *   也就是"先推进时钟，再投递这一刻的命令"。
   *   实测踩到过：先 dispatch 再 frame，会让淡化起点落在上一帧的时刻，
   *   表现为"交叉淡化比预期短一截"（测试里 13.5s 那帧已经淡完了）。
   *   命令里的 `atMs` 只用于记录/过期判断，不会被用来隐式推进时钟
   *   —— 隐式推进会静默改掉本帧的 base clip，那比"淡化短一截"更难查。
   */
  dispatch(cmd: AnyCommand): readonly string[] {
    const before = this.transitionLog.length
    switch (cmd.kind) {
      case 'motion': this.onMotion(cmd); break
      case 'emotion': this.onEmotion(cmd); break
      case 'speech': this.onSpeech(cmd); break
      case 'visibility': this.onVisibility(cmd); break
      case 'windowMode': this.onWindowMode(cmd); break
      case 'drag': this.onDrag(cmd); break
      default: this.log(`未知命令 kind=${(cmd as { kind: string }).kind}（已忽略）`); break
    }
    return this.transitionLog.slice(before)
  }

  /** 一次投递多条（按数组顺序；同优先级先到先得） */
  dispatchAll(cmds: readonly AnyCommand[]): readonly string[] {
    const before = this.transitionLog.length
    for (const c of cmds) this.dispatch(c)
    return this.transitionLog.slice(before)
  }

  // ── 推进

  /**
   * 推进到 `nowMs` 并返回本帧决策。
   *
   * ⚠ 这是**唯一**的时间入口。首次调用完成初始化（启动待机），
   *   所以"t=0 就必须有基础动作"（D6）在首帧即成立。
   */
  frame(nowMs: number): DirectorFrame {
    if (!Number.isFinite(nowMs)) throw new Error(`frame(nowMs) 必须是有限数，收到 ${nowMs}`)
    if (nowMs < this.nowMs) throw new Error(`时间不能回退：nowMs=${nowMs} < 上次 ${this.nowMs}（director 要求单调时钟）`)
    this.transitionLog = []
    this.nowMs = nowMs

    if (this.phase === 'uninitialized') this.enterIdle(nowMs, 'init')

    // ① 一次性动作到点 ⇒ 回退（D5）
    if (this.phase === 'oneShot' && this.oneShotEndsAtMs != null && nowMs >= this.oneShotEndsAtMs) {
      this.exitToSnapshot(nowMs, 'oneShot-finished')
    }

    // ② 待机轮换（D2）。只在 idle 相位推进；被抢占期间计时**冻结**，
    //    回退后从剩余时间继续 ⇒"抢占不消耗待机时长"。
    if (this.phase === 'idle') {
      let guard = 0
      while (nowMs >= this.nextIdleSwitchAtMs && guard++ < 1000) this.nextIdleClip(nowMs)
    }

    // ③ 交叉淡化推进（D3）
    this.advanceFade(nowMs)

    const f = this.buildFrame()
    this.assertInvariants(f)
    return f
  }

  // ── 命令处理

  private onMotion(cmd: MotionCommand): void {
    const meta = this.byName.get(cmd.clip)
    if (!meta) { this.log(`motion 命令指向未知 clip "${cmd.clip}"（已忽略）`); return }
    if (meta.layer === 'overlay') { this.log(`clip "${cmd.clip}" 属于 overlay 层，不能用 motion 命令播（已忽略）`); return }

    if (this.priority === P.Drag) { this.log(`拖拽中，忽略 motion("${cmd.clip}")`); return }
    const targetPriority: MotionPriority = cmd.oneShot ? P.OneShot : P.State
    if (targetPriority < this.priority) {
      this.log(`忽略 motion("${cmd.clip}")：优先级 ${pname(targetPriority)} < 当前 ${pname(this.priority)}`)
      return
    }

    const fade = cmd.fadeSec ?? (cmd.oneShot ? this.tuning.oneShotFadeSec : this.tuning.crossFadeSec)

    if (cmd.oneShot) {
      if (this.phase !== 'oneShot') this.stack.push(this.snapshot())
      this.oneShotReturnTo = cmd.returnTo ?? null
      this.oneShotEndsAtMs = this.nowMs + meta.durationSec * 1000
      this.phase = 'oneShot'
      this.priority = P.OneShot
      this.switchBase(cmd.clip, fade, this.nowMs)
      this.log(`oneShot("${cmd.clip}") 时长 ${meta.durationSec.toFixed(3)}s，之后回退到 ${this.oneShotReturnTo ?? this.stack[this.stack.length - 1]?.clip ?? '(无)'}`)
      return
    }

    if (this.phase === 'oneShot') { this.log(`一次性动作播放中，忽略 state("${cmd.clip}")`); return }
    if (this.base?.clip === cmd.clip && this.phase === 'state') return
    if (this.phase !== 'state') this.stack.push(this.snapshot())
    this.phase = 'state'
    this.priority = P.State
    this.switchBase(cmd.clip, fade, this.nowMs)
    this.log(`state("${cmd.clip}") fade=${fade}s`)
  }

  private onDrag(cmd: DragCommand): void {
    if (cmd.active) {
      if (this.phase === 'drag') return
      // 拖拽**打断**一次性动作：把它的结束时刻暂存起来，拖拽期间继续按墙钟计时
      this.oneShotEndsAtMsBeforeDrag = this.phase === 'oneShot' ? this.oneShotEndsAtMs : null
      this.stack.push(this.snapshot())
      const clip = cmd.clip ?? this.tuning.dragClip
      this.dragClipActive = this.byName.has(clip) ? clip : null
      if (!this.dragClipActive) this.log(`drag clip "${clip}" 不在 manifest 里 —— 拖拽仍生效，基础动作保持不变`)
      this.phase = 'drag'
      this.priority = P.Drag
      if (this.dragClipActive) this.switchBase(this.dragClipActive, this.tuning.crossFadeSec, this.nowMs)
      this.log(`drag(active=true) clip=${this.dragClipActive ?? '(不变)'}`)
      return
    }
    if (this.phase !== 'drag') { this.log('收到 drag(active=false) 但当前不在 drag 相位（已忽略）'); return }
    // 一次性动作在拖拽期间是否已经按墙钟播完？
    const oneshotExpired = this.oneShotEndsAtMsBeforeDrag != null && this.nowMs >= this.oneShotEndsAtMsBeforeDrag
    this.oneShotEndsAtMsBeforeDrag = null
    this.exitToSnapshot(this.nowMs, oneshotExpired ? 'drag-released(oneshot-already-finished)' : 'drag-released')
    if (oneshotExpired) {
      // 被打断的 oneshot 已经播完 ⇒ 不该回退到它，应当再退一层到它之前的状态
      this.exitToSnapshot(this.nowMs, 'drag-released(oneshot-skip)')
    }
  }

  private onEmotion(cmd: EmotionCommand): void {
    if (cmd.weight <= 0) {
      const next = { ...this.overlays.emotions }
      delete next[cmd.expression]
      this.overlays = { ...this.overlays, emotions: next }
    } else {
      this.overlays = { ...this.overlays, emotions: { ...this.overlays.emotions, [cmd.expression]: cmd.weight } }
    }
  }

  private onSpeech(cmd: SpeechCommand): void {
    this.overlays = { ...this.overlays, speaking: cmd.speaking, speechAmplitude: cmd.speaking ? (cmd.amplitude ?? 0.5) : 0 }
  }

  private onVisibility(cmd: VisibilityCommand): void {
    this.overlays = { ...this.overlays, visibility: { ...this.overlays.visibility, [cmd.target]: cmd.visible } }
  }

  private onWindowMode(cmd: WindowModeCommand): void {
    this.overlays = { ...this.overlays, windowMode: cmd.mode }
  }

  // ── 相位迁移

  private snapshot(): Snapshot {
    return {
      clip: this.base?.clip ?? null,
      priority: this.priority,
      phase: this.phase,
      idleElapsedMs: Math.max(0, this.nowMs - this.idlePhaseStartedAtMs),
      idleIndex: this.idleIndex,
      oneShotReturnTo: this.oneShotReturnTo,
      oneShotEndsAtMs: this.oneShotEndsAtMs,
    }
  }

  /**
   * 用**快照里记下的已播时长**恢复待机计时。
   *
   * ⚠ 这里踩过一个真实的坑：早期版本在回退时写的是
   *   `nextIdleSwitchAtMs = snap.nextIdleSwitchAtMs > nowMs ? snap.nextIdleSwitchAtMs : nowMs + 12s`
   *   看起来"暂停了计时"，实际是**保留绝对截止时刻** —— 只要被抢占的时间没跨过原截止点，
   *   轮换就仍按原时刻发生，等于"暂停"根本没生效（实测：5s 拖拽到 9s，轮换仍在 12s 而不是 16s）。
   *   正确做法是存**已播时长**，恢复时重算截止时刻。
   */
  private restoreIdleClock(elapsedMs: number, nowMs: number): void {
    const remain = this.tuning.idleSwitchSec * 1000 - (elapsedMs % (this.tuning.idleSwitchSec * 1000))
    this.idlePhaseStartedAtMs = nowMs - (elapsedMs % (this.tuning.idleSwitchSec * 1000))
    this.nextIdleSwitchAtMs = nowMs + (remain <= 0 ? this.tuning.idleSwitchSec * 1000 : remain)
  }

  /**
   * 进入待机相位。
   * @param resumeElapsedMs 若这个待机是"从快照恢复"的，传入**已经播过的时长**（ms），
   *        以便把轮换截止点算成 `now + (12s − 已播)`，而不是重开一个 12s。
   *        省略 ⇒ 全新开始（`now + 12s`）。
   */
  private enterIdle(nowMs: number, why: string, resumeElapsedMs?: number): void {
    this.phase = 'idle'
    this.priority = P.Idle
    const clip = this.pickIdle(this.idleIndex)
    if (resumeElapsedMs != null) {
      this.restoreIdleClock(resumeElapsedMs, nowMs)
      this.log(`idle("${clip}") 恢复（${why}），已播 ${(resumeElapsedMs / 1000).toFixed(2)}s，${((this.nextIdleSwitchAtMs - nowMs) / 1000).toFixed(2)}s 后轮换`)
    } else {
      this.idlePhaseStartedAtMs = nowMs
      this.nextIdleSwitchAtMs = nowMs + this.tuning.idleSwitchSec * 1000
      this.log(`idle("${clip}") 起步（${why}），下次切换 @+${this.tuning.idleSwitchSec}s`)
    }
    this.base = { clip, weight: 1, fadeSec: 0, enteredAtMs: nowMs }
    this.fading = null
  }

  /**
   * 从待机池取第 i 个（对池长取模）。
   * 独立成方法是为了让 `noUncheckedIndexedAccess` 下的"取不到"有**一个明确出口**：
   * 这里不可能为空（构造函数已保证池非空），所以抛错而不是返回 undefined。
   */
  private pickIdle(i: number): string {
    const n = this.idlePool.length
    if (n === 0) throw new Error('idlePool 为空 —— 构造函数的保证被破坏')
    const clip = this.idlePool[((i % n) + n) % n]
    if (clip === undefined) throw new Error(`idlePool[${i % n}] 取不到（池长 ${n}）`)
    return clip
  }

  /** 顺序轮换到待机池里的下一个（起点由种子决定 ⇒ 确定性且不会原地重复） */
  private nextIdleClip(nowMs: number): void {
    const prev = this.base?.clip ?? null
    this.idleIndex = (this.idleIndex + 1) % this.idlePool.length
    let next = this.pickIdle(this.idleIndex)
    if (this.idlePool.length > 1 && next === prev) {
      this.idleIndex = (this.idleIndex + 1) % this.idlePool.length
      next = this.pickIdle(this.idleIndex)
    }
    this.nextIdleSwitchAtMs += this.tuning.idleSwitchSec * 1000
    if (this.nextIdleSwitchAtMs <= nowMs) this.nextIdleSwitchAtMs = nowMs + this.tuning.idleSwitchSec * 1000
    this.idlePhaseStartedAtMs = this.nextIdleSwitchAtMs - this.tuning.idleSwitchSec * 1000
    this.switchBase(next, this.tuning.crossFadeSec, nowMs)
    this.log(`idle 轮换 "${prev}" → "${next}"（交叉淡化 ${this.tuning.crossFadeSec}s）`)
  }

  /**
   * 回退到最近的快照（D4/D5）。
   *
   * 相位恢复规则（踩过的坑都在这里）：
   *   · 快照相位是 `oneShot` 且**它的结束时刻还没到** ⇒ 恢复为 `oneShot`，
   *     并恢复 `oneShotEndsAtMs`，让剩下的部分继续播完（否则会卡在 wave 上不动）。
   *   · 快照相位是 `oneShot` 但**已过期** ⇒ 退化为 `idle`（该动作已经播完了）。
   *   · 快照相位是 `drag`（嵌套拖拽）⇒ 退化为 `idle`。
   */
  private exitToSnapshot(nowMs: number, why: string): void {
    const snap = this.stack.pop() ?? null

    // `returnTo` 优先于快照里的 clip
    if (this.oneShotReturnTo && this.byName.has(this.oneShotReturnTo)) {
      this.phase = (snap?.phase && snap.phase !== 'oneShot' && snap.phase !== 'uninitialized' && snap.phase !== 'drag') ? snap.phase : 'state'
      this.priority = (snap && snap.priority !== P.OneShot && snap.priority !== P.Drag) ? snap.priority : P.State
      this.restoreIdleClock(snap?.idleElapsedMs ?? 0, nowMs)
      this.oneShotEndsAtMs = null
      this.switchBase(this.oneShotReturnTo, this.tuning.oneShotFadeSec, nowMs)
      this.oneShotReturnTo = null
      this.log(`回退（${why}）→ returnTo "${this.base?.clip}"`)
      return
    }

    if (!snap) { this.enterIdle(nowMs, `${why}-no-snapshot`); return }

    // 回到一个**还没播完**的一次性动作：恢复它的结束时刻，让它把剩下的部分播完
    const resumeEndsAt = snap.oneShotEndsAtMs
    const resumeOneShot = snap.phase === 'oneShot' && resumeEndsAt != null && nowMs < resumeEndsAt
    if (resumeOneShot && resumeEndsAt != null) {
      this.phase = 'oneShot'
      this.priority = P.OneShot
      this.oneShotEndsAtMs = resumeEndsAt
      this.oneShotReturnTo = snap.oneShotReturnTo
      this.idleIndex = snap.idleIndex
      this.restoreIdleClock(snap.idleElapsedMs, nowMs)
      const target = snap.clip && this.byName.has(snap.clip) ? snap.clip : this.pickIdle(this.idleIndex)
      this.switchBase(target, this.tuning.oneShotFadeSec, nowMs)
      this.log(`回退（${why}）→ 继续未播完的 oneShot "${target}"（剩余 ${((resumeEndsAt - nowMs) / 1000).toFixed(2)}s）`)
      return
    }

    this.phase = (snap.phase === 'oneShot' || snap.phase === 'uninitialized' || snap.phase === 'error') ? 'idle' : snap.phase
    this.priority = snap.priority === P.OneShot ? P.Idle : snap.priority
    if (this.priority === P.Drag) { this.priority = P.Idle; this.phase = 'idle' }
    if (this.phase === 'drag') { this.phase = 'idle'; this.priority = P.Idle }
    this.idleIndex = snap.idleIndex
    // 待机计时**暂停**：用快照里记的"已播时长"重算截止点
    this.restoreIdleClock(snap.idleElapsedMs, nowMs)
    this.oneShotEndsAtMs = null
    this.oneShotReturnTo = null
    const target = snap.clip && this.byName.has(snap.clip) ? snap.clip : this.pickIdle(this.idleIndex)
    this.switchBase(target, this.tuning.crossFadeSec, nowMs)
    this.log(`回退（${why}）→ "${target}"（相位 ${this.phase}；待机已播 ${(snap.idleElapsedMs / 1000).toFixed(2)}s，${((this.nextIdleSwitchAtMs - nowMs) / 1000).toFixed(2)}s 后轮换）`)
  }

  /**
   * 切换基础动作：把当前 base 推到 fading，新建 base，权重从 0 线性升到 1（D3）。
   * 若在淡化途中再次切换，把"当前可见权重"固化为新的淡出起点，
   * 这样**不会出现权重和不为 1 的瞬间**（D6）。
   */
  private switchBase(clip: string, fadeSec: number, nowMs: number): void {
    if (!this.byName.has(clip)) { this.log(`switchBase 目标 "${clip}" 不在 manifest 里（已忽略）`); return }
    if (this.base && this.base.clip === clip) {
      this.base = { ...this.base, enteredAtMs: nowMs, fadeSec: 0 }
      this.fading = null
      return
    }
    const eff = Math.max(0, fadeSec)
    if (this.base) {
      const cur = this.base
      const fadingWeight = this.fading?.weight ?? 0
      this.fading = cur.weight >= fadingWeight ? { ...cur, fadeSec: eff } : { ...(this.fading as BaseSlot), fadeSec: eff }
    } else {
      this.fading = null
    }
    this.base = { clip, weight: eff > 0 ? 0 : 1, fadeSec: eff, enteredAtMs: nowMs }
  }

  /** 线性推进交叉淡化 */
  private advanceFade(nowMs: number): void {
    if (!this.base) return
    if (!this.fading || this.base.fadeSec <= 0) {
      if (this.base.weight !== 1) this.base = { ...this.base, weight: 1 }
      this.fading = null
      return
    }
    const elapsedSec = (nowMs - this.base.enteredAtMs) / 1000
    const p = Math.min(1, Math.max(0, elapsedSec / this.base.fadeSec))
    this.base = { ...this.base, weight: p }
    this.fading = { ...this.fading, weight: 1 - p }
    if (p >= 1) this.fading = null
  }

  // ── 输出

  private buildFrame(): DirectorFrame {
    if (!this.base) this.enterIdle(this.nowMs, 'buildFrame-fallback')   // D6 兜底
    const weights: ClipWeight[] = []
    if (this.fading && this.fading.weight > 1e-9) weights.push({ clip: this.fading.clip, weight: this.fading.weight, fadeSec: this.fading.fadeSec })
    if (this.base) weights.push({ clip: this.base.clip, weight: this.base.weight, fadeSec: this.base.fadeSec })
    // 叠加层以 0 权重列出（stage 据此知道要挂哪些层），不参与基础权重和
    for (const c of this.clips) {
      if (c.layer === 'overlay' && !weights.some((w) => w.clip === c.name)) weights.push({ clip: c.name, weight: 0, fadeSec: 0 })
    }
    return {
      phase: this.phase === 'uninitialized' ? 'idle' : this.phase,
      baseClip: this.base?.clip ?? null,
      fadingOutClip: this.fading?.clip ?? null,
      crossFadeProgress: this.base ? (this.base.fadeSec > 0 ? this.base.weight : 1) : 1,
      weights,
      overlays: this.overlays,
      elapsedMs: this.nowMs - this.startMs,
      priority: this.priority,
      transitions: this.transitionLog.slice(),
    }
  }

  /**
   * 不变量自检（D6）。**每帧都跑**。
   * 「权重和不为 1」就是 T-pose 窗口，而它一旦发生是**静默**的（画面只抖一下），
   * 所以必须主动炸出来，不能等美术发现。
   */
  private assertInvariants(f: DirectorFrame): void {
    if (!f.baseClip) throw new Error(`不变量 D6 违反：baseClip 为 null（相位 ${f.phase}）—— 会出现 T-pose 窗口`)
    const baseSum = f.weights
      .filter((w) => w.weight > 0 && this.byName.get(w.clip)?.layer === 'base')
      .reduce((a, w) => a + w.weight, 0)
    if (Math.abs(baseSum - 1) > 1e-6) {
      throw new Error(`不变量 D6 违反：基础动作权重和 = ${baseSum}（应为 1）—— 会出现 T-pose 窗口。权重表：` +
        JSON.stringify(f.weights.filter((w) => w.weight > 0)))
    }
  }

  private log(msg: string): void { this.transitionLog.push(msg) }
}

// ───────────────────────────────────────────────────── 便捷工具

/** 从 `MotionClipManifest[]` 造一个 registry（`name → manifest`） */
export function buildRegistry(clips: readonly MotionClipManifest[]): ReadonlyMap<string, MotionClipManifest> {
  return new Map(clips.map((c) => [c.name, c]))
}

/** 从语义推断优先级（供外部构造 manifest 时自查） */
export function priorityOf(manifest: MotionClipManifest): MotionPriority {
  return manifest.priorityHint ?? SEMANTIC_TO_PRIORITY[manifest.semantic]
}
