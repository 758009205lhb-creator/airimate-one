/**
 * apps/desktop/src/main/hit-region.ts —— pet 模式"透明区域不吃桌面点击"的唯一实现
 *
 * 问题：pet 模式窗口透明、无边框、置顶。若整窗可点，会挡住桌面；
 *       若整窗 pass-through，角色与轮盘也点不到。
 *
 * 方案（Tech-Spec §4.3）：
 *   ① renderer 上报**可交互区域**（角色包围盒 / 轮盘圆周包围盒 / 气泡），窗口内 CSS 像素坐标；
 *   ② 主进程按 60ms 轮询 `screen.getCursorScreenPoint()`，换算到窗口坐标，判定是否落在区域（含外扩 pad）；
 *   ③ `win.setIgnoreMouseEvents(!inside, { forward: true })` —— forward 让窗口在"被忽略"时仍能收到
 *      mousemove，用于悬停高亮与区域自更新；
 *   ④ 质量约束：`ignore=false` 有 120ms 最短保持时间（防抖动）；区域来源与视觉同源（同一几何函数）。
 *
 * 注意：panel 模式恒为 `ignore=false`（窗口不透明，不需要穿透）。
 */
import { BrowserWindow, screen } from 'electron'
import type { HitRegions } from '@airimate/shared'
import { log } from './log.js'

const POLL_MS = 60
const MIN_HOLD_MS = 120

interface Rect { x: number, y: number, w: number, h: number, pad: number }

export class HitRegionService {
  private win: BrowserWindow | null = null
  private timer: NodeJS.Timeout | null = null
  private regions: Rect[] = []
  /**
   * 区域元数据（id / kind），与 `regions` 同序。
   * 几何用于命中判定，元数据只用于**可观测性**（探针要能读到"上报了哪些区域"）。
   */
  private regionMeta: Array<{ id: string, kind: string }> = []
  private lastSeq = -1
  private ignoring: boolean | null = null
  private lastSwitchAt = 0
  private enabled = false
  /** 轮盘打开时强制不忽略（保证键盘与点击都能到达） */
  private forcedInteractive = false

  attach(win: BrowserWindow): void {
    this.win = win
  }

  setEnabled(on: boolean): void {
    this.enabled = on
    if (!on) this.setIgnore(false, 'disabled')
  }

  forceInteractive(on: boolean, reason: string): void {
    this.forcedInteractive = on
    if (on) this.setIgnore(false, `force:${reason}`)
  }

  /** 收到 renderer 上报（乱序丢弃） */
  update(payload: HitRegions): void {
    if (payload.seq <= this.lastSeq) return
    this.lastSeq = payload.seq
    this.regions = payload.regions
      .filter(r => r.w > 0 && r.h > 0)
      .map(r => ({ x: r.x, y: r.y, w: r.w, h: r.h, pad: r.pad }))
    // 元数据与几何同时替换（整体替换语义），避免"几何被清了、清单还留着旧项"
    this.regionMeta = payload.regions
      .filter(r => r.w > 0 && r.h > 0)
      .map(r => ({ id: r.id, kind: r.kind }))
  }

  /**
   * ★★ **回到"未显示"的干净态**（2026-10-09 完善轮新增）。
   *
   * 为什么必须有它（这是一个真实且不可见的缺陷形态）：
   *   窗口被隐藏时 renderer 的上报**停了**（`rAF` 被 Chromium 节流），
   *   于是 `regions` 里留着**上一次可见时**的矩形。而在 `tick()` 里，
   *   命中判定与窗口可见性**无关** ⇒ 只要鼠标划过那块**已经看不见的**区域，
   *   `setIgnoreMouseEvents(false)` 就会被设上 ——
   *   表现是"桌宠明明收起来了，那块地方却点不动桌面"。
   *   这类缺陷不会有任何报错，也不会被截图发现（窗口是不可见的）。
   *
   * 处置：清空矩形**与元数据**（诊断里 `regions=0`），
   * 并把窗口恢复成"可交互"（窗口不可见时这个设置本来就没有效果，
   * 但留着 `ignore=true` 会让"下次呼出后第一帧点不动"成为一个偶发问题）。
   */
  reset(reason: string): void {
    const had = this.regions.length
    this.regions = []
    this.regionMeta = []
    /**
     * ⚠ **不重置 `lastSeq`**：它是"乱序丢弃"的依据，而 renderer 的序号是单调递增的。
     *   清零会让隐藏期间迟到的旧报文被当成新报文收下 —— 那正是我们要避免的残留。
     */
    this.setIgnore(false, `reset:${reason}`)
    if (had > 0) log().info('命中区域已回到未显示态', { reason, cleared: had }, 'hitreg.reset')
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), POLL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
  }

  private tick(): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    if (!this.enabled) { this.setIgnore(false, 'not-pet'); return }
    /**
     * ★★ **窗口不可见时不得参与命中判定**（2026-10-09 完善轮）。
     *
     * 这一条是"桌宠收回后那块地方还能吃点击"的**结构性**修法（对照 `reset()` 的说明）：
     * `reset()` 处理"收回那一刻"，这里处理"收回之后 renderer 又上报了一次"、
     * 或者"我们根本没走到 reset 的那条路径"（例如窗口被系统最小化）。
     * 两道一起才是完整的：**判据（regions 清空）+ 不变量（不可见就不判定）**。
     */
    if (!win.isVisible()) { this.setIgnore(false, 'hidden'); return }
    if (this.forcedInteractive) { this.setIgnore(false, 'forced'); return }

    let inside = false
    try {
      const pt = screen.getCursorScreenPoint()
      const b = win.getBounds()
      // 窗口坐标（CSS 像素）：DIP 与 screen 坐标同为 DIP，无需再乘 scaleFactor
      const wx = pt.x - b.x
      const wy = pt.y - b.y
      for (const r of this.regions) {
        if (wx >= r.x - r.pad && wx <= r.x + r.w + r.pad && wy >= r.y - r.pad && wy <= r.y + r.h + r.pad) { inside = true; break }
      }
      // 不在任何区域 ⇒ 让桌面可点；在区域内 ⇒ 接收事件
      this.setIgnore(!inside, inside ? 'hit' : 'miss')
    } catch (e) {
      // 轮询失败不应该影响使用；保守地保持可交互
      log().debug('hit-region 轮询异常', { err: e instanceof Error ? e.message : String(e) }, 'hitreg.error')
      this.setIgnore(false, 'error')
    }
  }

  private setIgnore(next: boolean, why: string): void {
    const win = this.win
    if (!win || win.isDestroyed()) return
    if (this.ignoring === next) return
    const now = Date.now()
    if (this.ignoring === false && next === true && now - this.lastSwitchAt < MIN_HOLD_MS) return
    try {
      win.setIgnoreMouseEvents(next, { forward: true })
      this.ignoring = next
      this.lastSwitchAt = now
    } catch (e) {
      log().debug('setIgnoreMouseEvents 失败', { why, err: e instanceof Error ? e.message : String(e) }, 'hitreg.set.failed')
    }
  }

  state(): { ignoring: boolean, regions: number, ids: string[], kinds: string[] } {
    return {
      ignoring: this.ignoring === true,
      regions: this.regions.length,
      /**
       * ★ 区域清单（本轮新增）：只有数量证明不了"对话框与气泡**真的**上报了"。
       *   探针需要能回答"当前可交互区域里有 `dock` 与 `bubble` 吗" ——
       *   否则"命中区域没上报"这类问题只能靠人肉点屏幕去发现。
       *   只给 id 与 kind，**不含任何内容**。
       */
      ids: this.regionMeta.map(r => r.id),
      kinds: [...new Set(this.regionMeta.map(r => r.kind))],
    }
  }
}
