/**
 * @airimate/avatar-stage/overlays —— 表演叠加层（表情 / 眨眼 / 口型 / 视线）
 *
 * 纪律（PRD FR-5.3、Tech-Spec §6.2 L2）：
 *   这些层**只**操作 VRM 的 expressionManager 与 lookAt，**不触碰骨骼**，
 *   因此永远不会覆盖 MotionDirector 决定的身体主动作。
 */
import type { VRM } from '@pixiv/three-vrm'
import type { EmotionName, VisemeName } from '@airimate/shared'

/** 本地 clamp：avatar-stage **不**依赖 motion-director 的工具函数（避免两个包互相牵扯） */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : (v > hi ? hi : v)
}

export interface EmotionLayerOptions {
  fadeInSec?: number
  fadeOutSec?: number
}

interface EmotionState {
  name: EmotionName
  target: number
  current: number
  fadeInSec: number
  fadeOutSec: number
  /** 到期时间（ms）；null = 保持 */
  untilMs: number | null
}

const VISEMES: readonly VisemeName[] = ['aa', 'ih', 'ou', 'ee', 'oh']

export class OverlayController {
  private vrm: VRM | null = null
  private emotion: EmotionState | null = null
  private blinkValue = 0
  private manualBlinkWeight = 1
  private visemeWeights = new Map<VisemeName, number>()
  private lookTarget: { x: number, y: number } | null = null
  private reduced = false

  attach(vrm: VRM, reduced = false): void {
    this.vrm = vrm
    this.reduced = reduced
  }

  setReducedMotion(on: boolean): void {
    this.reduced = on
  }

  // ───────────────────────────────────────────────────── 表情

  /**
   * 设置表情。`durationMs` 为 null 表示保持到被覆盖。
   * 表情名只用 VRM 标准名（happy/angry/sad/relaxed/surprised/neutral）。
   */
  setEmotion(name: EmotionName, intensity: number, durationMs: number | null, opts: EmotionLayerOptions = {}): void {
    this.emotion = {
      name,
      target: clamp(intensity, 0, 1),
      current: this.emotion?.current ?? 0,
      fadeInSec: opts.fadeInSec ?? 0.3,
      fadeOutSec: opts.fadeOutSec ?? 0.5,
      untilMs: durationMs === null ? null : Date.now() + durationMs,
    }
  }

  clearEmotion(): void {
    if (this.emotion) this.emotion.target = 0
  }

  currentEmotion(): { name: EmotionName, value: number } | null {
    return this.emotion ? { name: this.emotion.name, value: this.emotion.current } : null
  }

  // ───────────────────────────────────────────────────── 眨眼 / 口型

  /** 由 motion-director 的 stepBlink 提供 0..1 的闭眼权重 */
  setBlink(value: number): void {
    this.blinkValue = clamp(value, 0, 1)
  }

  /** 口型：按权重写入 5 个元音 expression */
  setViseme(name: VisemeName, weight: number): void {
    this.visemeWeights.set(name, clamp(weight, 0, 1))
  }

  clearVisemes(): void {
    this.visemeWeights.clear()
  }

  /**
   * 用音频幅度驱动口型（TTS 播放时每帧调用）。
   * 简化模型：按幅度选一个主元音并给权重；幅度→开口度。
   */
  driveVisemeByAmplitude(amplitude: number, seed: number): void {
    const a = clamp(amplitude, 0, 1)
    if (a < 0.02) { this.clearVisemes(); return }
    const idx = Math.abs(Math.floor(seed * 5)) % VISEMES.length
    const main = VISEMES[idx] as VisemeName
    this.visemeWeights.clear()
    this.visemeWeights.set(main, a)
    // 次要元音：让口型不那么"打点"
    const second = VISEMES[(idx + 2) % VISEMES.length] as VisemeName
    this.visemeWeights.set(second, a * 0.35)
  }

  // ───────────────────────────────────────────────────── 视线

  /** 屏幕归一化坐标（-1..1，原点在角色舞台中心） */
  setLookTarget(x: number | null, y: number | null): void {
    this.lookTarget = (x === null || y === null) ? null : { x: clamp(x, -1, 1), y: clamp(y, -1, 1) }
  }

  // ───────────────────────────────────────────────────── 每帧

  update(dtSec: number): void {
    const vrm = this.vrm
    if (!vrm) return
    const em = vrm.expressionManager
    if (em) {
      // ① 表情淡入淡出
      if (this.emotion) {
        const e = this.emotion
        const expired = e.untilMs !== null && Date.now() > e.untilMs
        const goal = expired ? 0 : e.target
        const rate = goal > e.current ? (1 / Math.max(0.001, e.fadeInSec)) : (1 / Math.max(0.001, e.fadeOutSec))
        const step = rate * dtSec
        e.current = e.current + clamp(goal - e.current, -step, step)
        try { em.setValue(e.name, e.current) } catch { /* 模型可能没有该 expression */ }
      }
      // ② 眨眼（叠加在表情之上；blink 是独立 expression，不会与情绪冲突）
      try { em.setValue('blink', this.blinkValue * this.manualBlinkWeight) } catch { /* ignore */ }
      // ③ 口型
      for (const v of VISEMES) {
        try { em.setValue(v, this.visemeWeights.get(v) ?? 0) } catch { /* ignore */ }
      }
    }
    // ④ 视线
    if (vrm.lookAt) {
      if (this.lookTarget) {
        // 用归一化坐标轻微偏移注视点（不做射线拾取，避免每帧矩阵重建）
        vrm.lookAt.lookAt?.({ x: this.lookTarget.x * 0.5, y: vrm.lookAt.target ? 0 : 0, z: 0 } as unknown as never)
      }
    }
  }

  /** 诊断快照 */
  snapshot(): { emotion: { name: string, value: number } | null, blink: number, visemes: Record<string, number>, lookAtActive: boolean } {
    return {
      emotion: this.currentEmotion(),
      blink: this.blinkValue,
      visemes: Object.fromEntries(this.visemeWeights),
      lookAtActive: this.lookTarget !== null,
    }
  }
}
