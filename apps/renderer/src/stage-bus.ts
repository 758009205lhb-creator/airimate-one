/**
 * apps/renderer/src/stage-bus.ts —— 舞台几何的**只读总线**（本轮新增）
 *
 * 解决的问题：气泡必须**贴在角色头顶**并随着动作一起动，而对话框必须贴窗口底部；
 * 但真正知道角色包围盒的只有 `AvatarStage` 里的那**一个** `Stage`（唯一 VRM 实例）。
 *
 * 为什么不做成 Pinia state：
 *   · 这些值每帧都变（60Hz），写进响应式 store 会让整个组件树每帧重渲染一次 ——
 *     代价极高，而且和"气泡用 rAF 自己驱动"的规格冲突；
 *   · 规格明确要求气泡与轮盘用**同一种驱动方式**（rAF，禁止 CSS transition），
 *     rAF 循环直接读模块级变量是最省、也最可控的形态。
 *
 * 三条纪律：
 *   ① **只有一个方向**：AvatarStage 提供锚点读取函数，覆盖层只读不写；
 *   ② 覆盖层（对话框 / 气泡）把自己的矩形**写回**这里，由 AvatarStage 的
 *      命中区域上报循环统一发出 —— 保证"命中区域与视觉同源"（FR-7.7），
 *      而不是两个组件各报一份、互相覆盖；
 *   ③ 这里**不持有任何 three.js 句柄**，只有四个数字的矩形。
 */

export interface Box { x: number, y: number, w: number, h: number }

/** 角色**固定锚点**包围盒的提供者（由 AvatarStage 注册；未注册时返回 null） */
let anchorProvider: (() => Box | null) | null = null

export function setAnchorProvider(fn: (() => Box | null) | null): void {
  anchorProvider = fn
}

/**
 * 角色固定锚点包围盒（画布 CSS 像素）。
 *
 * ⚠ 用**固定锚点**包围盒而不是动态蒙皮包围盒：后者随在播动作每帧变几像素，
 *   气泡会跟着抖（与 A10 轮盘锚点不过的根因是同一个）。
 */
export function getAnchorBox(): Box | null {
  try { return anchorProvider ? anchorProvider() : null } catch { return null }
}

export interface OverlayRects {
  /**
   * 对话框的矩形。
   *
   * ⚠ 2026-10-08 返工轮：**恒为 `null`**。它原本由 `ConversationDock.vue`（pet 窗口内
   *   贴底的输入条）每帧写入；那个组件已被删除，输入框只活在独立的 chat 窗口里，
   *   而 chat 窗口是**普通不透明窗口**、不做命中区域上报。
   *   保留这个字段是为了让"旧形态还在不在"本身可被机械读取（恒 null = 确实没了）。
   */
  dock: Box | null
  /** 对话气泡（`SpeechBubble.vue` 每帧写入） */
  bubble: Box | null
  /**
   * 语音听写状态条。恒为 `null`（理由同 `dock`：它曾是对话坞的一部分）——
   * 现在"正在听"显示在 chat 窗口里，那个窗口不需要命中区域上报。
   */
  listening: Box | null
}

const rects: OverlayRects = { dock: null, bubble: null, listening: null }

/**
 * 覆盖层自检计数器（**只为让"链路断在哪一段"可判定**）。
 *
 * 为什么需要：命中区域"没上报"有三种完全不同的根因 ——
 *   ① 组件的 rAF 循环没在跑（`ticks` 不涨）；
 *   ② 循环在跑但算不出矩形（`ticks` 涨、`rects.dock` 恒 null）；
 *   ③ 都正常但主进程没收到（两侧都正常、主进程侧为空）。
 * 只看最终结果分不清这三者，而它们的修法完全不同。计数不含任何内容。
 */
const ticks: Record<keyof OverlayRects, number> = { dock: 0, bubble: 0, listening: 0 }

export function bumpOverlayTick(kind: keyof OverlayRects): void {
  ticks[kind] += 1
}

export function getOverlayTicks(): Record<keyof OverlayRects, number> {
  return { ...ticks }
}

/**
 * 覆盖层"最后一帧看到什么"的**探针读数**（`hasEl` / 尺寸）。
 *
 * 用途：命中区域链路要分三段定位 —— 循环是否在跑（`ticks`）、
 * 循环有没有拿到 DOM（`hasEl`）、矩形有没有算出来（`w`/`h`）。
 * 只有把这三段分开，"没上报"才是一个**可修**的结论而不是猜谜。
 * 只有布尔与整数尺寸，**不含任何内容**。
 */
const probes: Record<keyof OverlayRects, { hasEl: boolean, w: number, h: number, via: string, note: string }> = {
  dock: { hasEl: false, w: -1, h: -1, via: 'none', note: 'init' },
  bubble: { hasEl: false, w: -1, h: -1, via: 'none', note: 'init' },
  listening: { hasEl: false, w: -1, h: -1, via: 'none', note: 'init' },
}

export function setOverlayProbe(
  kind: keyof OverlayRects,
  p: { hasEl: boolean, w: number, h: number, via?: string, note?: string },
): void {
  probes[kind] = { hasEl: p.hasEl, w: p.w, h: p.h, via: p.via ?? 'ref', note: p.note ?? '' }
}

export function getOverlayProbes(): Record<keyof OverlayRects, { hasEl: boolean, w: number, h: number, via: string, note: string }> {
  return {
    dock: { ...probes.dock }, bubble: { ...probes.bubble }, listening: { ...probes.listening },
  }
}

/**
 * 取覆盖层的**真实可见元素**。
 *
 * ⚠ 为什么不能只用模板 ref（本轮实测踩到，如实记录）：
 *   `v-if` 控制的根元素 + 模板 ref 的组合下，rAF 循环**有时**会连续多帧读到 `root.value === null`
 *   （同一份代码在不同构建/时序下表现不同，日志里没有任何报错）——
 *   后果是命中区域永远不上报，而界面看上去完全正常。
 *   所以这里补一条**同源**的兜底查询：同一个组件、同一个类名、页面里唯一的那个元素。
 *   两者指向的必然是同一个 DOM 节点，不存在"两套几何"的风险。
 *   `setOverlayProbe(..., { via })` 把**实际用了哪一条**如实记下来，供探针读取。
 */
export function resolveOverlayEl(refEl: Element | null, selector: string): { el: HTMLElement | null, via: string } {
  if (refEl instanceof HTMLElement) return { el: refEl, via: 'ref' }
  const found = document.querySelector(selector)
  if (found instanceof HTMLElement) return { el: found, via: 'selector' }
  return { el: null, via: 'none' }
}

export function setOverlayRect(kind: keyof OverlayRects, box: Box | null): void {
  rects[kind] = box
}

export function getOverlayRects(): OverlayRects {
  return rects
}

/**
 * DOM 矩形 → 纯数据矩形（四舍五入到整数）。
 * 取整的理由：命中区域是"像素区域"，浮点尾数对判定没有任何帮助，
 * 反而会让"变化检测"（签名比较）在静止时也一直认为变了 ⇒ 每帧都上报。
 */
export function toBox(r: DOMRect | { x: number, y: number, width: number, height: number }): Box {
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    w: Math.round(r.width),
    h: Math.round(r.height),
  }
}
