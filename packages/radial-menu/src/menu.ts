/**
 * @airimate/radial-menu/menu —— 径向轮盘（**唯一**）
 *
 * 规格来源：PRD FR-7 / Tech-Spec §4.3 / 判据 A10。逐条落实：
 *   ① 开合切换由调用方决定（右键角色 / F1）；左键**不**触发开关；
 *   ② 锚点跟随角色包围盒上沿（`anchorRatioY = 0.30`），打开期间每帧跟随；
 *   ③ 弹出动画：`scale` 从 0 到 1，每帧 `lerp(scale, target, 0.2)`，**rAF 驱动**，
 *      明确**不使用** CSS transition（否则与 JS 动画打架）；
 *   ④ 悬停高亮；点击后关闭并执行；方向键切换 / Enter 执行 / Esc 关闭；
 *   ⑤ 命中测试与视觉**同源**：用同一个 `itemRect()` 计算几何，导出的区域直接给主进程
 *      做 `setIgnoreMouseEvents` 判定（透明区域不吃桌面点击）。
 */
import { WHEEL_SPEC } from '@airimate/shared'
import type { WheelItemId } from '@airimate/shared'
import { ICONS, ICON_LABELS, type IconName } from './icons.js'

export interface WheelItem {
  id: string
  label: string
  icon: IconName
  kind: 'panel' | 'toggle' | 'action'
}

export interface Rect { x: number, y: number, w: number, h: number }

export interface AnchorBox { x: number, y: number, w: number, h: number }

export interface RadialMenuOptions {
  host: HTMLElement
  items?: readonly WheelItem[]
  onSelect: (id: string) => void
  onToggleState: (id: string) => boolean
  onOpenChange?: (open: boolean) => void
  /** 每次打开前调用：让宿主按当前可用空间调整尺寸（窄画布必需） */
  onBeforeOpen?: () => void
  /** 每帧回调：把当前轮盘几何报给宿主（用于命中区域上报与诊断） */
  onGeometry?: (g: { open: boolean, cx: number, cy: number, scale: number, box: Rect | null }) => void
}

const RADIUS = WHEEL_SPEC.radiusPx
const HUB = WHEEL_SPEC.hubRadiusPx
const ITEM_SIZE = 62
const LERP = WHEEL_SPEC.scaleLerpPerFrame
const EPS = WHEEL_SPEC.scaleEpsilon
const PAD = WHEEL_SPEC.hitPadPx

const DEFAULT_ITEMS: WheelItem[] = WHEEL_SPEC.items.map(i => ({
  id: i.id,
  label: i.label,
  icon: i.icon as IconName,
  kind: i.kind as WheelItem['kind'],
}))

export class RadialMenu {
  private readonly host: HTMLElement
  private readonly items: WheelItem[]
  private readonly onSelect: (id: string) => void
  private readonly onToggleState: (id: string) => boolean
  private readonly onOpenChange: (open: boolean) => void
  private readonly onGeometry: (g: { open: boolean, cx: number, cy: number, scale: number, box: Rect | null }) => void
  private readonly onBeforeOpen: () => void

  private root: HTMLDivElement
  private hub: HTMLDivElement
  private itemEls: Array<{ item: WheelItem, el: HTMLDivElement }> = []
  private open = false
  private scale = 0
  private raf = 0
  /** ★ 兜底泵句柄（见 `startRaf()` 的说明：rAF 在未聚焦窗口上会被冻结到 ~1Hz） */
  private pump = 0
  /** ★ 动画是否在跑（替代原先"`raf !== 0` 即视为在跑"的判断 —— 现在有两个驱动源） */
  private animating = false
  /** ★ 上次真正推进动画的时刻（时间基 lerp 用；`0` = 还没推进过） */
  private lastAnimAt = 0
  private cx = 0
  private cy = 0
  /** 当前半径/选项尺寸（按画布尺寸自适应后可能与默认常量不同） */
  private radius: number = RADIUS
  private itemSize: number = ITEM_SIZE
  /**
   * 可用矩形（窗口坐标）。默认整窗，但**宿主必须传舞台画布的矩形**。
   *
   * 为什么（实测）：panel 模式下角色舞台只是窗口右侧一小块（画布仅 150×630 CSS px），
   * 而 `show()` 原先按 `window.innerWidth` 收夹 ⇒ 轮盘右侧选项贴着画布右边界、有被裁风险。
   */
  private avail: { x: number, y: number, w: number, h: number } | null = null
  private highlight: string | null = null
  private keyboardIndex = -1

  constructor(o: RadialMenuOptions) {
    this.host = o.host
    this.items = [...(o.items ?? DEFAULT_ITEMS)]
    this.onSelect = o.onSelect
    this.onToggleState = o.onToggleState
    this.onOpenChange = o.onOpenChange ?? (() => { /* noop */ })
    this.onGeometry = o.onGeometry ?? (() => { /* noop */ })
    this.onBeforeOpen = o.onBeforeOpen ?? (() => { /* noop */ })
    this.root = document.createElement('div')
    this.root.className = 'rmenu'
    this.root.setAttribute('role', 'menu')
    this.root.setAttribute('aria-hidden', 'true')
    this.hub = document.createElement('div')
    this.hub.className = 'rmenu__hub'
    this.root.appendChild(this.hub)
    this.buildItems()
    this.host.appendChild(this.root)
    this.applyScale(0)
  }

  private buildItems(): void {
    const n = this.items.length
    const step = 360 / n
    this.items.forEach((item, i) => {
      const angle = ((WHEEL_SPEC.startAngleDeg + step * i) * Math.PI) / 180
      const el = document.createElement('div')
      el.className = 'rmenu__item'
      el.dataset.id = item.id
      el.setAttribute('role', 'menuitem')
      el.setAttribute('tabindex', '-1')
      el.setAttribute('aria-label', ICON_LABELS[item.icon] ?? item.label)
      el.innerHTML = `<svg class="rmenu__icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[item.icon]}</svg><span class="rmenu__label">${item.label}</span>`
      const x = Math.cos(angle) * this.radius
      const y = Math.sin(angle) * this.radius
      el.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`
      el.addEventListener('mouseenter', () => this.setHighlight(item.id))
      el.addEventListener('click', (ev) => {
        // 只接受左键点击（右键留给"开合"语义，避免与打开动作互相触发）
        if (ev.button !== 0) return
        ev.preventDefault()
        ev.stopPropagation()
        this.select(item.id)
      })
      this.root.appendChild(el)
      this.itemEls.push({ item, el })
    })
    this.root.addEventListener('mouseleave', () => this.setHighlight(null))
    this.syncToggles()
  }

  // ───────────────────────────────────────────────────── 开合

  isOpen(): boolean { return this.open }

  /** 设置可用矩形（窗口坐标）。宿主应在每次打开前用**舞台画布的 rect** 调用它。 */
  setAvailableRect(r: { x: number, y: number, w: number, h: number } | null): void {
    this.avail = r && r.w > 0 && r.h > 0 ? r : null
  }

  /** 收夹锚点到可用矩形内（矩形为空时退回整窗） */
  private clampAnchor(cx: number, cy: number): { x: number, y: number } {
    const pad = this.radius + 70
    if (!this.avail) {
      const vw = window.innerWidth
      const vh = window.innerHeight
      return { x: Math.max(pad, Math.min(vw - pad, cx)), y: Math.max(pad, Math.min(vh - pad, cy)) }
    }
    const a = this.avail
    // 可用区太窄时（例如宽度不足 2*pad），把 pad 收窄到"半宽的 90%"，保证仍能放下轮盘中心
    const padX = Math.min(pad, Math.max(8, (a.w / 2) * 0.9))
    const padY = Math.min(pad, Math.max(8, (a.h / 2) * 0.9))
    return {
      x: Math.max(a.x + padX, Math.min(a.x + a.w - padX, cx)),
      y: Math.max(a.y + padY, Math.min(a.y + a.h - padY, cy)),
    }
  }

  /**
   * **按可用空间自适应尺寸**（治"窄画布下轮盘超出边界"）。
   *
   * 依据（实测）：panel 模式的舞台画布只有 150×630 CSS px，而默认半径 104 + 选项半宽 31 = 135，
   * 远超画布半宽 75 ⇒ `show()` 的收夹把锚点夹到 `x=174`（画布宽 150），部分选项会被裁到画布外。
   * 做法：半径取"可用短边"的一个比例并夹在 [56, 104]，选项尺寸按半径同比例缩放（夹在 [40, 62]），
   * 保证小画布下既不越界、又保持可点面积（最小 40px 仍远大于常见 24px 触控目标）。
   */
  setAvailableSpace(width: number, height: number): { radius: number, itemSize: number } {
    const shortEdge = Math.max(80, Math.min(width, height))
    // 半径占短边 28%，并夹在 [64, 104]（下限 64 是为了保证选项之间有足够间距，实测 56 太挤）
    const r = Math.max(64, Math.min(RADIUS, Math.round(shortEdge * 0.28)))
    // 选项尺寸按半径比例缩放（基准：radius 104 ↔ item 62），夹在 [44, 62]
    const item = Math.max(44, Math.min(ITEM_SIZE, Math.round((r / RADIUS) * ITEM_SIZE)))
    this.radius = r
    this.itemSize = item
    // 位置也要跟着重排（否则半径变了但选项还在老位置）
    const n = Math.max(1, this.items.length)
    this.items.forEach((item2, i) => {
      const angle = ((WHEEL_SPEC.startAngleDeg + (360 / n) * i) * Math.PI) / 180
      const el = this.itemEls.find(e => e.item.id === item2.id)?.el
      if (!el) return
      el.style.width = `${item}px`
      el.style.height = `${item}px`
      el.style.transform = `translate(-50%, -50%) translate(${Math.cos(angle) * r}px, ${Math.sin(angle) * r}px)`
    })
    const hub = (r / RADIUS) * (HUB * 2)
    this.hub.style.width = `${Math.round(hub)}px`
    this.hub.style.height = `${Math.round(hub)}px`
    return { radius: r, itemSize: item }
  }

  /** 当前尺寸参数（诊断用） */
  sizeInfo(): { radius: number, itemSize: number } {
    return { radius: this.radius, itemSize: this.itemSize }
  }

  /** 选项数量（诊断用） */
  itemList(): readonly WheelItem[] { return this.items }

  /** 全部选项的视觉矩形（诊断/验收用，与命中测试同源） */
  itemRects(): Rect[] {
    return this.items.map(i => this.itemRect(i))
  }

  /** 打开：从 scale=0 弹出；锚点来自角色包围盒上沿 */
  show(box: AnchorBox | null): { x: number, y: number } {
    // 打开前先让宿主按当前可用空间调整尺寸（窄画布下必需，否则轮盘会被裁到画布外）
    try { this.onBeforeOpen() } catch { /* ignore */ }
    let cx = window.innerWidth / 2
    let cy = window.innerHeight * 0.42
    if (box && box.w > 0 && box.h > 0) {
      cx = box.x + box.w / 2
      cy = box.y + box.h * WHEEL_SPEC.anchorRatioY
    }
    const clamped = this.clampAnchor(cx, cy)
    cx = clamped.x
    cy = clamped.y
    this.cx = cx
    this.cy = cy
    this.root.style.left = `${cx}px`
    this.root.style.top = `${cy}px`
    this.open = true
    this.root.classList.add('is-open')
    this.root.setAttribute('aria-hidden', 'false')
    this.scale = 0            // ★ 每次打开都从 0 弹开（不是淡入）
    this.applyScale(0)
    this.setHighlight(null)
    this.keyboardIndex = -1
    this.startRaf()
    this.onOpenChange(true)
    return { x: cx, y: cy }
  }

  hide(): void {
    if (!this.open) return
    this.open = false
    this.root.classList.remove('is-open')
    this.root.setAttribute('aria-hidden', 'true')
    this.setHighlight(null)
    this.startRaf()           // 反向缩小
    this.onOpenChange(false)
  }

  toggle(box: AnchorBox | null): boolean {
    if (this.open) { this.hide(); return false }
    this.show(box)
    return true
  }

  /** 打开期间每帧调用：跟随锚点（角色在动、窗口在动都要跟） */
  followAnchor(box: AnchorBox | null): void {
    if (!this.open || !box || box.w <= 0) return
    const c = this.clampAnchor(box.x + box.w / 2, box.y + box.h * WHEEL_SPEC.anchorRatioY)
    const cx = c.x
    const cy = c.y
    if (Math.abs(cx - this.cx) < 0.01 && Math.abs(cy - this.cy) < 0.01) return
    this.cx = cx
    this.cy = cy
    this.root.style.left = `${cx}px`
    this.root.style.top = `${cy}px`
  }

  // ───────────────────────────────────────────────────── 动画（rAF + 兜底泵 + 时间基 lerp）

  /**
   * ★★ **兜底泵**（2026-10-09 完善轮新增；修的是一个真实且已实测的可用性缺陷）。
   *
   * ── 为什么必须有它（实测读数，不是推理）──────────────────────────────
   * 本轮改了启动行为：**打开软件只出现对话窗口，桌宠要另外呼出**。
   * 于是"用户从托盘/菜单呼出桌宠"成了一条常规路径 —— 而那条路径下
   * **桌宠窗口没有焦点**（焦点在对话窗口或别的应用上）。
   * 实测（`docs/evidence/phase17/chatwindow.json` 的 `engineTicks`）：
   *   · 2 秒内 `rafTicks` 只涨 **2**（rAF 被 Chromium 冻结到 ~1Hz）；
   *   · 同一窗口的 8ms `setInterval` 兜底泵却涨了 **243**（≈122Hz，完全正常）；
   *   · 舞台渲染仍 62.6 fps（因为 `AvatarStage` 早就有自己的兜底泵）。
   * ⇒ 轮盘弹出动画原先**只**跑在 rAF 上 ⇒ `scale` 永远停在 0
   *   ⇒ `hitTest()` 因 `scale <= 0.001` 直接返回 null ⇒ **点不动**。
   *
   * ── 为什么不是"让窗口拿到焦点" ────────────────────────────────────
   * 试过并实测无效（同一份证据的 `rafAb`）：`showWindow()` 之后
   * `hasFocus=false`、rAF 1 次/765ms；补 `webContents.focus()` 之后
   * **`hasFocus=true` 但 rAF 仍然只有 1 次/767ms**。
   * ⇒ 这不是"没聚焦"，是 Chromium 的绘制节流；靠抢焦点解决不了，
   *   而且**不该**为了打开一个轮盘去抢用户的焦点。
   *
   * ── 与舞台的做法一致 ─────────────────────────────────────────────
   * `packages/avatar-stage/src/stage.ts` 早就有同一条兜底泵（那里的注释写着
   * "桌宠场景下窗口经常被别的窗口盖住，所以必须有一个不依赖 RAF 的驱动源"）。
   * 轮盘此前没有，是因为**以前桌宠是唯一窗口、总是聚焦的** —— 前提变了，结构就得跟着变。
   *
   * ── 关键细节：改增量式**不能**改变动画速度 ──────────────────────────
   * 原先每帧 `scale += (target - scale) * 0.2`。现在两个驱动源都可能推进动画，
   * 如果各自都做一次 0.2 的 lerp，速度就会翻倍（而且随帧率变化）。
   * ⇒ 改成**时间基**：`1 - 0.2^dt`（`dt` 归一化到"一帧 = 1/60s"），
   *   在 60Hz 下与原来的 0.2 逐帧 lerp **数值等价**，但与"谁在驱动、多快"无关。
   */
  private startRaf(): void {
    if (this.animating) return
    this.animating = true
    this.lastAnimAt = 0
    const loop = (): void => {
      this.raf = requestAnimationFrame(loop)
      this.stepAnimation()
    }
    this.raf = requestAnimationFrame(loop)
    /**
     * 兜底泵 8ms（与舞台同参数）：`stepAnimation()` 内部按时间差去重，
     * 所以两条驱动源一起跑也不会重复推进 —— 只是"谁先到谁推进"。
     */
    this.pump = window.setInterval(() => { this.stepAnimation() }, 8)
  }

  /**
   * 推进一次动画（rAF 与兜底泵共用；**幂等**）。
   *
   * 幂等的实现方式：比较"距上次真正推进过去了多久"，不足一帧就**不推进**。
   * 这样两条驱动源叠加时不会加速，只剩其中一条时也不会变慢。
   */
  private stepAnimation(): void {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now())
    if (this.lastAnimAt !== 0) {
      const dt = now - this.lastAnimAt
      if (dt < 1000 / 120) return           // 上限 120 步/秒（去重，不是限速）
      const target = this.open ? 1 : 0
      this.scale = this.scale + (target - this.scale) * (1 - Math.pow(1 - LERP, dt / (1000 / 60)))
    } else {
      const target = this.open ? 1 : 0
      this.scale = this.scale + (target - this.scale) * LERP
    }
    this.lastAnimAt = now
    const target = this.open ? 1 : 0
    if (Math.abs(target - this.scale) < EPS) this.scale = target
    this.applyScale(this.scale)
    this.onGeometry({ open: this.open, cx: this.cx, cy: this.cy, scale: this.scale, box: this.visualBox() })
    if (!this.open && this.scale === 0) {
      this.animating = false
      if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0 }
      if (this.pump) { window.clearInterval(this.pump); this.pump = 0 }
    }
  }

  private applyScale(s: number): void {
    this.root.style.transform = `scale(${s.toFixed(4)})`
    this.root.style.opacity = s <= 0.001 ? '0' : '1'
  }

  // ───────────────────────────────────────────────────── 契约式几何（视觉 = 命中 = 上报）

  /** 每个选项的**视觉**矩形（窗口内 CSS 像素），命中测试与主进程上报都用它 */
  itemRect(item: WheelItem): Rect {
    const idx = this.items.findIndex(i => i.id === item.id)
    const n = Math.max(1, this.items.length)
    const angle = ((WHEEL_SPEC.startAngleDeg + (360 / n) * idx) * Math.PI) / 180
    const size = this.itemSize
    const x = this.cx + Math.cos(angle) * this.radius - size / 2
    const y = this.cy + Math.sin(angle) * this.radius - size / 2
    return { x, y, w: size, h: size }
  }

  /** 整圈的视觉包围盒（含 scale 缩放） */
  visualBox(): Rect | null {
    const s = this.scale
    if (s <= 0.001) return null
    const pad = this.radius + this.itemSize
    const total = pad * 2 * s
    return { x: this.cx - (total / 2), y: this.cy - (total / 2), w: total, h: total }
  }

  /**
   * 命中测试（与视觉同源）。
   *
   * ⚠ 两处必须与视觉一致，否则"看起来能点、实际点不到"：
   *   ① 基准点用**实际锚点** `this.cx/cy`（已含 `show()` 的边界收夹），不是外部算的锚点；
   *   ② 结果按**当前缩放** `this.scale` 折算 —— 弹出动画期间视觉在放大，
   *      命中区域必须跟着放大（否则动画前几帧"看得到、点不到"）。
   */
  hitTest(px: number, py: number): WheelItemId | null {
    if (!this.open) return null
    const s = this.scale
    if (s <= 0.001) return null
    for (const { item } of this.itemEls) {
      const r = this.itemRect(item)
      // 把点换算回"未缩放的轮盘坐标系"再比较：与 applyScale 的 transform 一致
      const lx = this.cx + (px - this.cx) / s
      const ly = this.cy + (py - this.cy) / s
      if (lx >= r.x - PAD && lx <= r.x + r.w + PAD && ly >= r.y - PAD && ly <= r.y + r.h + PAD) return item.id as WheelItemId
    }
    return null
  }

  /** 当前缩放（诊断用） */
  currentScale(): number { return this.scale }

  // ───────────────────────────────────────────────────── 交互

  private setHighlight(id: string | null): void {
    if (this.highlight === id) return
    this.highlight = id
    for (const { item, el } of this.itemEls) {
      const on = item.id === id
      el.classList.toggle('is-active', on)
      el.setAttribute('aria-current', on ? 'true' : 'false')
    }
    const cur = this.items.find(i => i.id === id)
    this.hub.innerHTML = cur
      ? `<b>${cur.label}</b><span>${cur.kind === 'toggle' ? (this.onToggleState(cur.id) ? '点击关闭' : '点击开启') : '点击执行'}</span>`
      : '<b>菜单</b><span>方向键选择 · Enter 执行 · Esc 关闭</span>'
  }

  private select(id: string): void {
    const item = this.items.find(i => i.id === id)
    if (!item) return
    this.hide()
    this.onSelect(item.id)
  }

  /** 键盘：方向键切换 / Enter 执行 / Esc 关闭 */
  handleKey(ev: KeyboardEvent): boolean {
    if (!this.open) return false
    const n = this.items.length
    if (ev.key === 'Escape') { this.hide(); return true }
    if (ev.key === 'Enter' || ev.key === ' ') {
      const cur = this.keyboardIndex >= 0 ? this.items[this.keyboardIndex] : undefined
      if (cur) this.select(cur.id)
      return true
    }
    let delta = 0
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') delta = 1
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') delta = -1
    if (delta === 0) return false
    this.keyboardIndex = this.keyboardIndex < 0
      ? (delta > 0 ? 0 : n - 1)
      : (this.keyboardIndex + delta + n) % n
    const cur = this.items[this.keyboardIndex]
    if (cur) this.setHighlight(cur.id)
    return true
  }

  /** 开关项的状态同步（听力/扬声器/置顶） */
  syncToggles(): void {
    for (const { item, el } of this.itemEls) {
      if (item.kind !== 'toggle') continue
      const on = this.onToggleState(item.id)
      el.classList.toggle('is-off', !on)
      el.setAttribute('aria-checked', String(on))
    }
    if (this.highlight) this.setHighlight(this.highlight)
  }

  /**
   * 锚点计算（**与 `show()` 完全同源**）。
   *
   * ⚠ 必须做与 `show()` **完全相同**的边界收夹，否则"对外报告的锚点"与
   *   "实际摆放轮盘的锚点"会不一致 —— 实测踩到：探针拿未收夹的锚点去做命中测试，
   *   8 个方向里 3 个被判为未命中，看起来像"命中区域与视觉不一致"，
   *   其实是两个锚点根本不在同一处。
   */
  anchorOf(box: AnchorBox | null): { x: number, y: number } {
    let cx = window.innerWidth / 2
    let cy = window.innerHeight * 0.42
    if (box && box.w > 0 && box.h > 0) {
      cx = box.x + box.w / 2
      cy = box.y + box.h * WHEEL_SPEC.anchorRatioY
    }
    // 与 show() 共用**同一套**收夹逻辑（含可用矩形），保证"报告的锚点 == 实际锚点"
    return this.clampAnchor(cx, cy)
  }

  /** 当前实际锚点（打开后才有意义） */
  currentAnchor(): { x: number, y: number } {
    return { x: this.cx, y: this.cy }
  }

  dispose(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    /** ★ 兜底泵必须一起停 —— 否则 dispose 之后它还在跑（每 8ms 一次空推进） */
    if (this.pump) { window.clearInterval(this.pump); this.pump = 0 }
    this.animating = false
    this.lastAnimAt = 0
    this.root.remove()
    this.itemEls = []
  }
}
