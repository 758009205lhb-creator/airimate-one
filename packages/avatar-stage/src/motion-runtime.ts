/**
 * @airimate/avatar-stage/motion-runtime —— 舞台内的动作运行时（**自足实现**）
 *
 * 为什么放在 avatar-stage 而不是 import `@airimate/motion-director`：
 *   曾经直接依赖该包，但它的 API 正在被动作管线同步改造（manifest 契约对齐中），
 *   为避免"每帧渲染路径被上游重构打断"，这里把**执行侧**（mixer 交叉淡化 + 叠加层数学 + 决策骨架）
 *   做成自足实现；`@airimate/motion-director` 保留为纯决策模块，待其 frozen 后再通过
 *   明确的适配层接入（见 docs/Tech-Spec.md §6）。
 *
 * 纪律不变：
 *   - 优先级：拖拽 > 一次性 > 状态 > 待机轮换；
 *   - 待机 12s 切换、3s 交叉淡化（照抄 Mate）；
 *   - 任何采样时刻都必须有活动基础动作（无 T-pose 窗口）；
 *   - 叠加层只做**乘法**叠加，不覆盖基础动作。
 */

// ───────────────────────────────────────────────────────── 常量（照抄 Mate，不得随手改）

export const TUNING = {
  idleSwitchSec: 12,
  idleTransitionSec: 3,
  dragFadeInSec: 0.18,
  dragFadeOutSec: 0.25,
  oneShotFadeSec: 0.3,
  stateFadeSec: 0.4,
  springFrequency: 2.6,
  dampingRatio: 0.35,
  maxLeanZDeg: 25,
  maxLeanXDeg: 12,
  limbLag: 6,
  horizontalVelocityToLean: 0.25,
  verticalVelocityToPitch: 0.15,
  mouseSensitivity: 0.6,
  leanFilterPerSec: 12,
  blendSpeed: 8,
} as const

// ───────────────────────────────────────────────────────── 决策骨架

export type DirectorPhase = 'uninitialized' | 'idle' | 'state' | 'oneShot' | 'drag' | 'error'

export interface MotionTarget { clipId: string, weight: number, fadeSec: number }

export interface ClipRecord { name: string, semantic: string, loopable: boolean }

export interface DirectorEvent {
  kind: 'switch' | 'oneshot-start' | 'oneshot-end' | 'drag-start' | 'drag-end' | 'state-enter' | 'state-exit' | 'error' | 'noop'
  clipId?: string
  from?: string
  durationSec?: number
  detail?: string
  atMs: number
}

export interface DecisionOptions {
  now: () => number
  tuning?: Partial<typeof TUNING>
  onEvent?: (e: DirectorEvent) => void
}

/**
 * 纯决策状态机（不做渲染）。由 `Stage` 每帧调用，产出"该播哪个 clip、淡化多久"。
 */
export class DecisionEngine {
  private readonly now: () => number
  private readonly t: typeof TUNING
  private readonly onEvent: (e: DirectorEvent) => void
  private phase: DirectorPhase = 'uninitialized'
  private clips = new Map<string, ClipRecord>()
  private idlePool: string[] = []
  private idleIndex = -1
  private baseClipId: string | null = null
  private lastSwitchAtMs = 0
  private currentFadeSec = 0
  private dragging = false
  private previousPhase: DirectorPhase = 'idle'
  private previousClipId: string | null = null
  private stateClipId: string | null = null
  private oneShotClipId: string | null = null
  /**
   * 一次性动作的**起始时刻与时长**。
   * 需要它们是为了回答"被拖拽打断的那次一次性动作还在播吗"——
   * 拖拽可能持续几秒甚至几十秒，久到那个动作早就播完了（见 `endDrag()`）。
   * 由 `setOneShotDuration()` 在**实际装载 clip 时**由 Stage 告知（时长来自 VRMA 资产）。
   */
  private oneShotStartedAtMs: number | null = null
  private oneShotDurationMs = 0
  /** clip 真实时长（ms），由 Stage 在装载后告知；未知的 clip 不参与"是否已播完"判断 */
  private readonly clipDurationsMs = new Map<string, number>()
  private warnings: string[] = []

  constructor(o: DecisionOptions) {
    this.now = o.now
    this.onEvent = o.onEvent ?? ((): void => { /* noop */ })
    this.t = { ...TUNING, ...(o.tuning ?? {}) }
  }

  getPhase(): DirectorPhase { return this.phase }
  getBaseClipId(): string | null { return this.baseClipId }
  getIdleIndex(): number { return this.idleIndex }
  getIdleTotal(): number { return this.idlePool.length }
  isDragging(): boolean { return this.dragging }
  getFadeSec(): number { return this.currentFadeSec }
  getWarnings(): string[] { return [...this.warnings] }

  private warn(detail: string): void {
    if (!this.warnings.includes(detail)) this.warnings.push(detail)
    this.onEvent({ kind: 'noop', detail, atMs: this.now() })
  }

  /** 装载 clip 清单；没有可用待机动作 ⇒ error + 可见告警（禁止静默静止） */
  load(clips: readonly ClipRecord[]): { ok: boolean, idleCount: number, warnings: string[] } {
    this.clips = new Map(clips.map(c => [c.name, c]))
    const idles = clips.filter(c => c.semantic === 'idle' || /idle/i.test(c.name)).map(c => c.name).sort((a, b) => a.localeCompare(b, 'en'))
    this.idlePool = idles.length ? idles : clips.map(c => c.name).sort((a, b) => a.localeCompare(b, 'en'))
    if (!clips.length) {
      this.phase = 'error'
      this.warn('没有可用动作（清单为空或全部加载失败）')
      return { ok: false, idleCount: 0, warnings: this.getWarnings() }
    }
    if (idles.length < 10) this.warn(`待机动作只有 ${idles.length} 个（硬目标 ≥10，判据 A13）`)
    this.phase = 'idle'
    this.idleIndex = -1
    this.lastSwitchAtMs = 0
    this.switchIdle(true)
    return { ok: true, idleCount: this.idlePool.length, warnings: this.getWarnings() }
  }

  /** 每帧推进；返回是否发生了待机切换 */
  tick(): boolean {
    if (this.phase !== 'idle') return false
    if ((this.now() - this.lastSwitchAtMs) / 1000 < this.t.idleSwitchSec) return false
    this.switchIdle(false)
    return true
  }

  nextIdle(first = false): MotionTarget {
    return this.switchIdle(first)
  }

  private switchIdle(first: boolean): MotionTarget {
    if (!this.idlePool.length) {
      this.phase = 'error'
      this.warn('待机池为空，无法切换待机动作')
      return { clipId: '', weight: 1, fadeSec: 0 }
    }
    const next = first ? 0 : (this.idleIndex + 1) % this.idlePool.length
    const prev = this.baseClipId
    this.idleIndex = next
    this.baseClipId = this.idlePool[next] ?? null
    // 首个动作直接满权重（长淡化会在开头形成近似 T-pose 的半权重）
    this.currentFadeSec = first ? 0 : this.t.idleTransitionSec
    this.lastSwitchAtMs = this.now()
    this.onEvent({ kind: 'switch', clipId: this.baseClipId ?? undefined, from: prev ?? undefined, durationSec: this.currentFadeSec, atMs: this.now() })
    return { clipId: this.baseClipId ?? '', weight: 1, fadeSec: this.currentFadeSec }
  }

  /** 语义请求（找不到对应 clip 时返回 null 并**显式告警**） */
  request(semantic: string, opts: { once?: boolean, fadeMs?: number } = {}): MotionTarget | null {
    const fadeSec = (opts.fadeMs ?? 0) > 0 ? (opts.fadeMs as number) / 1000 : undefined
    /**
     * **拖拽是最高优先级**（文件头纪律：拖拽 > 一次性 > 状态 > 待机轮换）。
     * 这里曾漏掉这道闸门：拖拽进行中调用 `request('wave')` 会直接 `playOneShot()`，
     * 把 `baseClipId` 从 `PET_DRAGGING` 换成 `wave`、相位从 `drag` 改成 `oneShot`，
     * 于是"拖拽中松手 → 回到拖拽前动作"的暂存逻辑失效，角色手上还攥着却被要求跳舞
     * ——单测 `优先级：拖拽中的 motion 请求不得抢占` 暴露了它。
     * 只有 `request('idle')` 这类**结束拖拽**的意图不在此列（由调用方先 `endDrag()`）。
     */
    if (this.dragging) {
      this.warn(`拖拽中，忽略语义请求 "${semantic}"（拖拽优先级最高）`)
      return null
    }
    if (semantic === 'idle' || semantic === 'wake' || semantic === 'stand') {
      if (this.phase === 'state') {
        this.onEvent({ kind: 'state-exit', clipId: this.stateClipId ?? undefined, atMs: this.now() })
        this.stateClipId = null
      }
      this.phase = 'idle'
      this.lastSwitchAtMs = 0
      return this.switchIdle(false)
    }
    const hit = [...this.clips.values()].find(c => c.semantic === semantic) ?? [...this.clips.values()].find(c => new RegExp(semantic, 'i').test(c.name))
    if (!hit) {
      this.warn(`动作语义 "${semantic}" 没有对应 clip（清单缺失）`)
      return null
    }
    if (semantic === 'drag') return this.beginDrag()
    if (opts.once) return this.playOneShot(hit.name, fadeSec ?? this.t.oneShotFadeSec)
    return this.enterState(semantic, hit.name, fadeSec ?? this.t.stateFadeSec)
  }

  playOneShot(clipId: string, fadeSec: number = this.t.oneShotFadeSec): MotionTarget {
    if (this.phase !== 'oneShot') {
      this.previousPhase = this.phase
      this.previousClipId = this.baseClipId
    }
    this.phase = 'oneShot'
    this.oneShotClipId = clipId
    this.baseClipId = clipId
    this.currentFadeSec = fadeSec
    // 记下起始时刻（时长由 Stage 通过 setOneShotDuration 告知，默认 0 = 未知）
    this.oneShotStartedAtMs = this.now()
    this.oneShotDurationMs = this.clipDurationsMs.get(clipId) ?? 0
    this.onEvent({ kind: 'oneshot-start', clipId, from: this.previousClipId ?? undefined, durationSec: fadeSec, atMs: this.now() })
    return { clipId, weight: 1, fadeSec }
  }

  /**
   * 告知某个 clip 的真实时长（来自 VRMA 资产）。仅用于判断
   * "被拖拽打断的一次性动作是否已播完"（见 `endDrag()`）。
   */
  setClipDuration(clipId: string, durationMs: number): void {
    if (Number.isFinite(durationMs) && durationMs > 0) this.clipDurationsMs.set(clipId, durationMs)
  }

  /** 一次性动作播完时调用 */
  finishOneShot(): MotionTarget | null {
    if (this.phase !== 'oneShot') return null
    this.onEvent({ kind: 'oneshot-end', clipId: this.oneShotClipId ?? undefined, atMs: this.now() })
    this.oneShotClipId = null
    if (this.dragging) return this.beginDrag()
    if (this.previousPhase === 'state' && this.stateClipId) {
      this.phase = 'state'
      this.baseClipId = this.stateClipId
      return { clipId: this.stateClipId, weight: 1, fadeSec: this.t.oneShotFadeSec }
    }
    this.phase = 'idle'
    if (this.previousClipId && this.clips.has(this.previousClipId)) {
      this.baseClipId = this.previousClipId
      this.lastSwitchAtMs = this.now()
      return { clipId: this.previousClipId, weight: 1, fadeSec: this.t.oneShotFadeSec }
    }
    this.lastSwitchAtMs = 0
    return this.switchIdle(true)
  }

  enterState(semantic: string, clipId: string, fadeSec: number = this.t.stateFadeSec): MotionTarget {
    this.phase = 'state'
    this.stateClipId = clipId
    this.baseClipId = clipId
    this.currentFadeSec = fadeSec
    this.onEvent({ kind: 'state-enter', clipId, detail: semantic, durationSec: fadeSec, atMs: this.now() })
    return { clipId, weight: 1, fadeSec }
  }

  /** 拖拽：最高优先级，抢占一切并暂停待机轮换 */
  beginDrag(): MotionTarget {
    const dragClip = [...this.clips.values()].find(c => c.semantic === 'drag') ?? [...this.clips.values()].find(c => /drag/i.test(c.name))
    if (!dragClip) this.warn('缺少 PET_DRAGGING 转换动作（拖拽将只有弹簧摇晃；判据 A14 未满足）')
    if (!this.dragging) {
      this.previousPhase = this.phase === 'drag' ? this.previousPhase : this.phase
      this.previousClipId = this.baseClipId
      this.dragging = true
      this.onEvent({ kind: 'drag-start', clipId: dragClip?.name, from: this.previousClipId ?? undefined, atMs: this.now() })
    }
    this.phase = 'drag'
    this.currentFadeSec = this.t.dragFadeInSec
    if (dragClip) this.baseClipId = dragClip.name
    return { clipId: this.baseClipId ?? '', weight: 1, fadeSec: this.t.dragFadeInSec }
  }

  endDrag(): MotionTarget | null {
    if (!this.dragging) return null
    this.dragging = false
    this.onEvent({ kind: 'drag-end', from: this.baseClipId ?? undefined, atMs: this.now() })
    if (this.previousPhase === 'state' && this.stateClipId) {
      this.phase = 'state'
      this.baseClipId = this.stateClipId
      this.currentFadeSec = this.t.dragFadeOutSec
      return { clipId: this.stateClipId, weight: 1, fadeSec: this.t.dragFadeOutSec }
    }
    /**
     * 被拖拽打断的**一次性动作**要按相位恢复成 `oneShot`，不能一律落回 `idle`。
     *
     * 这里曾写死 `this.phase = 'idle'`，于是出现"相位=idle 但 baseClip=wave(一次性)"的
     * 不一致状态：`tick()` 在 idle 相位照常推进待机轮换，会把一次性动作**中途抢走**，
     * 再叠加 3s 淡化 —— 表现是"拖完松手，动作跳一下就没了"。
     *
     * 注意判据用的是 `oneShotClipId`（**动作本身还在不在**），不是 `previousPhase`：
     * 拖拽会把 `phase` 改成 `'drag'`，所以 `previousPhase` 只反映"拖拽之前"的相位，
     * 而这里要回答的是"手上那个一次性动作现在还在播吗"。
     */
    if (this.oneShotClipId && this.isOneShotLive()) {
      this.phase = 'oneShot'
      this.baseClipId = this.oneShotClipId
      // 淡化用**一次性动作**的时长：这是"回到被中断的一次性动作"，不是拖拽的收尾。
      this.currentFadeSec = this.t.oneShotFadeSec
      return { clipId: this.oneShotClipId, weight: 1, fadeSec: this.t.oneShotFadeSec }
    }
    // 动作已经播完（或根本没有）：如实落回 idle，不重播一个已经结束的动作
    this.phase = 'idle'
    const finished = this.oneShotClipId
    this.oneShotClipId = null
    this.oneShotStartedAtMs = null
    /**
     * ⚠ `previousClipId` 就是**那个刚播完的一次性动作本身**时不能拿它当"待机动作"
     * （`playOneShot` 会把 `baseClipId` 设成它，`beginDrag` 随后把它存进 `previousClipId`），
     * 否则会出现"动作已经播完，松手后又摆一次"——单测 `早已播完 ⇒ 落回 idle` 抓到过。
     */
    if (this.previousClipId && this.previousClipId !== finished && this.clips.has(this.previousClipId)) {
      this.baseClipId = this.previousClipId
      this.lastSwitchAtMs = this.now()
      this.currentFadeSec = this.t.dragFadeOutSec
      return { clipId: this.previousClipId, weight: 1, fadeSec: this.t.dragFadeOutSec }
    }
    this.lastSwitchAtMs = 0
    const t = this.switchIdle(true)
    return { ...t, fadeSec: this.t.dragFadeOutSec }
  }

  /**
   * 当前一次性动作是否**仍在播放**。
   *
   * 时长未知（`0`，即 Stage 还没告知）时按"仍在播"处理 —— 宁可多播一次也不要
   * 把用户刚触发的动作吞掉；时长已知时按墙钟判断，因为拖拽可能持续几十秒，
   * 久到那个动作早就结束了。
   */
  private isOneShotLive(): boolean {
    if (this.oneShotStartedAtMs == null) return true
    if (!(this.oneShotDurationMs > 0)) return true
    return this.now() < this.oneShotStartedAtMs + this.oneShotDurationMs
  }
}

// ───────────────────────────────────────────────────────── 叠加层数学（纯函数）

export interface Spring1D { x: number, v: number }
export interface SwayState {
  leanZ: Spring1D
  leanX: Spring1D
  filteredX: number
  filteredY: number
  limbZ: number
  limbX: number
  weight: number
}

const MAX_DT = 1 / 30
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : (v > hi ? hi : v))
export const clampDt = (dt: number, maxDt = MAX_DT): number => (!Number.isFinite(dt) || dt <= 0 ? 0 : Math.min(dt, maxDt))

export function createSwayState(): SwayState {
  return { leanZ: { x: 0, v: 0 }, leanX: { x: 0, v: 0 }, filteredX: 0, filteredY: 0, limbZ: 0, limbX: 0, weight: 0 }
}

/**
 * 阻尼弹簧（与 Mate `AvatarSwayController` 同式）：
 *   w = 2π·freq ; a = w²·(target − x) − 2ζwv ; v += a·dt ; x += v·dt
 */
export function springStep(s: Spring1D, target: number, freq: number, zeta: number, dtSec: number): Spring1D {
  const dt = clampDt(dtSec)
  if (dt === 0) return { x: s.x, v: s.v }
  const w = Math.max(0.01, freq) * 2 * Math.PI
  const a = w * w * (target - s.x) - 2 * zeta * w * s.v
  const v = s.v + a * dt
  const x = s.x + v * dt
  const lim = TUNING.maxLeanZDeg * 1.5
  return { x: clamp(x, -lim, lim), v }
}

export function stepSway(s: SwayState, input: { dx: number, dy: number, dragging: boolean, dtSec: number }): SwayState {
  const dt = clampDt(input.dtSec)
  const k = dt === 0 ? 0 : 1 - Math.exp(-TUNING.leanFilterPerSec * dt)
  const fx = s.filteredX + ((input.dragging ? input.dx : 0) - s.filteredX) * k
  const fy = s.filteredY + ((input.dragging ? input.dy : 0) - s.filteredY) * k
  const targetZ = clamp(-fx * TUNING.horizontalVelocityToLean, -TUNING.maxLeanZDeg, TUNING.maxLeanZDeg)
  const targetX = clamp(fy * TUNING.verticalVelocityToPitch, -TUNING.maxLeanXDeg, TUNING.maxLeanXDeg)
  const leanZ = springStep(s.leanZ, input.dragging ? targetZ : 0, TUNING.springFrequency, TUNING.dampingRatio, dt)
  const leanX = springStep(s.leanX, input.dragging ? targetX : 0, TUNING.springFrequency, TUNING.dampingRatio, dt)
  const kl = 1 - Math.exp(-TUNING.limbLag * dt)
  const limbZ = s.limbZ + (-leanZ.x - s.limbZ) * kl
  const limbX = s.limbX + (-leanX.x - s.limbX) * kl
  const step = (input.dragging ? TUNING.blendSpeed : TUNING.blendSpeed * 2) * dt
  const weight = s.weight + clamp((input.dragging ? 1 : 0) - s.weight, -step, step)
  return { leanZ, leanX, filteredX: fx, filteredY: fy, limbZ, limbX, weight }
}

export function swayAtRest(s: SwayState, eps = 0.05): boolean {
  return Math.abs(s.leanZ.x) < eps && Math.abs(s.leanX.x) < eps && Math.abs(s.leanZ.v) < eps && Math.abs(s.leanX.v) < eps
}

export interface BlinkState { nextBlinkAtSec: number, closing: boolean, value: number }

export function createBlinkState(nowSec: number): BlinkState {
  return { nextBlinkAtSec: nowSec + 2 + Math.random() * 3, closing: false, value: 0 }
}

export function stepBlink(s: BlinkState, nowSec: number, dtSec: number, reduced = false): number {
  const dt = clampDt(dtSec)
  if (s.closing) {
    s.value += dt * 9
    if (s.value >= 1) { s.value = 1; s.closing = false }
  } else {
    s.value -= dt * 7
    if (s.value <= 0) {
      s.value = 0
      if (nowSec >= s.nextBlinkAtSec) {
        s.closing = true
        s.nextBlinkAtSec = nowSec + (reduced ? 6 : 2.4) + Math.random() * (reduced ? 6 : 3.6)
      }
    }
  }
  return s.value
}

/** 呼吸（**只作叠加层**，不冒充待机动作） */
export function breathValue(tSec: number, periodSec = 3.6): number {
  return Math.sin((tSec * 2 * Math.PI) / Math.max(0.5, periodSec))
}
