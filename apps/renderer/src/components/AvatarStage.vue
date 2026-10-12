/**
 * apps/renderer/src/components/AvatarStage.vue —— 角色舞台（**唯一** VRM 实例的宿主）
 *
 * 职责：
 *   - 创建并持有唯一 `Stage`（Scene/WebGLRenderer/AnimationMixer/VRM 各一个）；
 *   - 左键**只**拖拽：pointerdown → 主进程 `window:drag-begin`，每帧上报光标屏幕坐标；
 *   - 右键**只**开合轮盘（F1 亦然）；
 *   - 每帧把角色包围盒与轮盘几何上报给主进程（命中区域 ⇒ 透明区域不吃桌面点击）；
 *   - 暴露只读诊断快照供验收探针读取。
 */
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { Stage } from '@airimate/avatar-stage'
import { RadialMenu } from '@airimate/radial-menu'
import type { MotionCommand, StageCommand } from '@airimate/shared'
import { bridge, BridgeError } from '../bridge'
import { useApp } from '../store'
import { getOverlayRects, setAnchorProvider } from '../stage-bus'

const app = useApp()
const canvas = ref<HTMLCanvasElement | null>(null)
const stage = shallowRef<Stage | null>(null)
const modelError = ref<string | null>(null)
const loading = ref(true)
const wheelHost = ref<HTMLDivElement | null>(null)
let menu: RadialMenu | null = null
let unsubscribe: Array<() => void> = []
let boxRaf = 0
// ───────────────────────────────────────────────────── 左键手势状态机
//
// ⚠ 旧的实现是**按下即拖拽**：`onPointerDown` 收到左键就立刻 `bridge.dragBegin()`，
//   `pointerup` 又立刻 `endDrag()`。后果：
//     · 短按 / 单击 / 误触都进入窗口拖动（用户看到的"点一下她就乱跑"）；
//     · 且**没有命中判定** —— 点画布空白处也会拖窗口。
//   现在改成显式的三态手势：按下只**记录**，移动超过阈值才**开始拖**。
//
// 阈值 4 CSS px：小于它属于手抖/系统指针噪声；大于它才是"用户想拖"。
const DRAG_THRESHOLD_PX = 4

interface LeftGesture {
  pointerId: number
  /** 按下时的屏幕坐标（用于算位移） */
  startScreenX: number
  startScreenY: number
  /** 按下时的画布内坐标（用于"是否落在角色上"的一次性判定） */
  startClientX: number
  startClientY: number
  /**
   * 按下点是否落在角色命中区域内 —— **在按下时判定一次**并记下来。
   *
   * ⚠ 这一项必须参与后续的拖动判定（实测踩到）：只在 `pointerdown` 里用它决定
   *   "要不要 setPointerCapture"是不够的 —— 那样在画布空白处按下、再移动，
   *   仍然会进入拖动。A11 探针的 `blankDrag` 用例正是这么把它抓出来的
   *   （左上角 6px 处按下并移动 20px ⇒ `dragging` 变 true）。
   */
  onAvatar: boolean
  /** 是否已经越阈值并进入拖拽 */
  dragging: boolean
  /** 本次手势是否已被判定为"消费掉的点击"（拖拽结束后要吞掉随后的 click） */
  consumedClick: boolean
}

let leftGesture: LeftGesture | null = null
/** 上一次 click 被吞掉的时间戳（用于抑制拖拽后的 click） */
let suppressClickUntil = 0
let dragging = false
let lastReportedSeq = 0

/** asset 协议基址（动作/模型都走 app:// 白名单根） */
function assetBase(): string {
  return 'app://asset'
}

function modelUrl(path: string): string {
  // 模型目录单独授权为 app://model（主进程按 AIRIMATE_MODEL_ROOT 打开该根）
  const norm = path.replace(/\\/g, '/')
  const idx = norm.lastIndexOf('/')
  return `app://model/${idx >= 0 ? norm.slice(idx + 1) : norm}`
}

async function initStage(): Promise<void> {
  const cv = canvas.value
  if (!cv) return
  try {
    const s = new Stage({
      canvas: cv,
      // ⚠ 不能带结尾斜杠：否则拼出 `app://asset//x.vrma`，双斜杠会被路径校验判为
      //   UNC 风格路径而拒绝（实测踩到：16 个动作全部 404）
      assetBaseUrl: assetBase(),
      /**
       * 帧率上限：允许通过 `?fpsCap=` 覆盖（QA 用）。
       * 用途：分清"渲染成本不足"与"调度开销"——把上限抬到 120，
       * 若实测 fps 明显超过 60，说明渲染本身够快、瓶颈在 60 上限与调度；
       * 若仍只有 ~50，则是渲染成本问题。
       */
      fpsCap: Number(new URLSearchParams(location.search).get('fpsCap') ?? '') || (app.settings?.fpsCap ?? 90),
      reducedMotion: app.settings?.reducedMotion ?? false,
      onWarning: (message, code) => {
        app.toast(code === 'MOTION_CLIP_FAILED' ? 'error' : 'warn', `角色/动作告警（${code}）`, message, false)
        app.updateStageStatus({ warnings: [...app.stageStatus.warnings, `[${code}] ${message}`] })
      },
    })
    stage.value = s
    /**
     * 舞台锚点：**固定**在画布水平 50% / 垂直 92%（底部基线）。
     * 本轮规格要求角色常驻锚点；锚点只在 `anchorAndFrameOnce()` 里用一次 rest 姿势算取景，
     * 之后 clip 切换、resize、拖动都不得改它。
     */
    s.setStageAnchor(0.50, 0.92)
    /** 显式缩放：**唯一**允许改变角色大小的入口（设置面板，0.70–1.40 步进 0.05） */
    s.setAvatarScale(app.settings?.avatarScale ?? 1)

    // ① 角色
    await app.loadAvatarCatalog()
    const av = app.avatar
    if (!av) {
      modelError.value = '没有找到可用角色（assets/models/catalog.json 缺少条目）'
      app.toast('error', '找不到角色模型', '请检查 catalog.json 或其 path 指向的文件是否存在', true)
      return
    }
    try {
      await s.loadAvatar(modelUrl(av.path), av.id)
    } catch (e) {
      modelError.value = e instanceof Error ? e.message : String(e)
      // 缺模型是**必须可见**的失败：显示告警位，不静默空白（PRD FR-5.5）
      app.toast('error', '角色模型加载失败', `${av.label}：${modelError.value}`, true)
      return
    }

    // ② 动作（清单由主进程读取校验后下发；renderer 不自己扫目录）
    await app.loadMotion()
    console.debug('[stage] 动作清单就绪', { manifests: app.motion.manifests.length, clipIds: app.motion.clipIds.length })
    const res = await s.loadMotions(app.motion.manifests, app.motion.clipIds)
    console.debug('[stage] clip 装载完成', { loaded: res.loaded, failed: res.failed.length })
    if (res.failed.length) {
      app.toast('error', `${res.failed.length} 个动作加载失败`, res.failed.slice(0, 5).map(f => `${f.id}: ${f.error}`).join('\n'), false)
    }

    console.debug('[stage] 调用 start()')
    s.start()
    console.debug('[stage] start() 已返回')
    loading.value = false
    startBoxReporting()
    exposeDiagnostics()
  } catch (e) {
    modelError.value = e instanceof Error ? e.message : String(e)
    app.toast('error', '角色舞台初始化失败', modelError.value, true)
  }
}

/** 每帧上报包围盒（节流到 ~15Hz，且只在变化时发送） */
function startBoxReporting(): void {
  const tick = (): void => {
    boxRaf = requestAnimationFrame(tick)
    const s = stage.value
    if (!s) return
    const now = performance.now()
    if (now - lastBoxReportAt < 66) return
    lastBoxReportAt = now
    const box = s.avatarBox()
    const wheelBox = menu?.visualBox() ?? null
    const regions: Array<{ id: string, kind: 'character' | 'wheel' | 'bubble' | 'panel', x: number, y: number, w: number, h: number, pad: number }> = []
    if (box && box.w > 0 && box.h > 0) {
      regions.push({ id: 'character', kind: 'character', x: box.x, y: box.y, w: box.w, h: box.h, pad: 18 })
    }
    if (wheelBox) {
      regions.push({ id: 'wheel', kind: 'wheel', x: wheelBox.x, y: wheelBox.y, w: wheelBox.w, h: wheelBox.h, pad: 24 })
    }
    /**
     * ★ 覆盖层（本轮新增）：对话框与气泡的矩形由组件自己每帧写入 `stage-bus`，
     *   在这里**统一**随其它区域一起上报。
     *
     * 为什么统一在这里发（而不是各组件自己调 `reportHitRegions`）：
     *   `HitRegionService.update()` 是"**整体替换**"语义（后到的 seq 覆盖前一份），
     *   两个来源各发一次会互相把对方的区域清掉 —— 表现为"只有最后上报的那个能点"。
     *   同源汇总还满足了 FR-7.7 的"命中测试与视觉一致"。
     * 尺寸变化后矩形会重新算（组件每帧重算 + 这里的签名变化检测）⇒ 绝不沿用旧矩形。
     */
    const overlays = getOverlayRects()
    if (overlays.dock) {
      const d = overlays.dock
      regions.push({ id: 'dock', kind: 'panel', x: d.x, y: d.y, w: d.w, h: d.h, pad: 6 })
    }
    if (overlays.bubble) {
      const b = overlays.bubble
      regions.push({ id: 'bubble', kind: 'bubble', x: b.x, y: b.y, w: b.w, h: b.h, pad: 6 })
    }
    const sig = JSON.stringify(regions)
    if (sig === lastBoxSig) return
    lastBoxSig = sig
    lastReportedSeq += 1
    bridge.reportHitRegions({ regions, seq: lastReportedSeq })
  }
  boxRaf = requestAnimationFrame(tick)
}
let lastBoxReportAt = 0
let lastBoxSig = ''

function exposeDiagnostics(): void {
  // 只读快照：既挂到 window 供页面内自查，也**主动推送**给主进程（诊断/验收探针用）
  const refresh = (): void => {
    const s = stage.value
    if (!s) return
    const snap = s.snapshot()
    // 画布在**视口坐标**里的位置与可见性（三层坐标对照：视口 / 画布 / 窗口）
    const cv = canvas.value
    if (cv) {
      const r = cv.getBoundingClientRect()
      const cs = getComputedStyle(cv)
      snap.view.canvasViewport = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
      snap.view.canvasStyle = {
        display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
        zIndex: cs.zIndex, position: cs.position,
      }
    }
    if (menu) {
      const g = { open: menu.isOpen(), box: menu.visualBox() }
      snap.wheel = { open: g.open, cx: g.box ? g.box.x + g.box.w / 2 : 0, cy: g.box ? g.box.y + g.box.h / 2 : 0, scale: g.box ? g.box.w / ((104 + 62) * 2) : 0 }
    }
    ;(snap as unknown as { disabledMotionHits?: unknown }).disabledMotionHits = s.disabledMotionHits
    /** 固定锚点读数（本轮新增）：锚点像素、命中椭圆、显式缩放、每个 clip 的根位移策略。
     * 验收探针 `idleAnchor60s` / `avatarVisible` / `rootMotionIdle` 直接读这些字段。
     */
    ;(snap as unknown as { anchor?: unknown }).anchor = {
      anchorXRatio: 0.50,
      anchorYRatio: 0.92,
      anchorPx: s.stageAnchorPx(),
      hitEllipse: s.avatarHitEllipse(),
      anchorBox: s.avatarAnchorBox(),
      avatarScale: s.getAvatarScale(),
      /** 相机签名：切换 10 个 clip 前后必须**逐位相等** */
      camera: s.cameraSignature(),
      rootMotion: s.rootMotion(),
      framing: s.framingDiagnostics(),
    }
    /**
     * 验收探针：轮盘几何 + 开合入口（供 QA 通过主进程 `--probe <name>` 调用）。
     *
     * 为什么不让 QA 直接点屏幕：A10 要求"开→关→开锚点误差 ≤2px"，
     * 用像素级鼠标注入误差大且不可复现；这里直接读取轮盘**自身的几何**
     * （与命中测试、命中区域上报同源），得到的数字才是确定性的。
     */
    ;(window as unknown as { __AIRIMATE_WHEEL_PROBE__?: (op: string) => unknown }).__AIRIMATE_WHEEL_PROBE__ = (op: string) => {
      if (!menu) return { error: 'no-menu' }
      const geo = () => {
        const s = stage.value
        // 锚点源：**固定锚点包围盒**（与 `anchorBox()` 同源），不是动态蒙皮包围盒
        const box = s?.avatarAnchorBox() ?? s?.avatarBox() ?? null
        const dyn = s?.avatarBox() ?? null
        // 与 show() 同源的锚点；打开后直接读轮盘自身的实际锚点
        const anchor = menu ? (menu.isOpen() ? menu.currentAnchor() : menu.anchorOf(box)) : { x: 0, y: 0 }
        return {
          open: menu ? menu.isOpen() : false,
          anchorX: Number(anchor.x.toFixed(3)),
          anchorY: Number(anchor.y.toFixed(3)),
          scale: menu ? Number(menu.currentScale().toFixed(4)) : 0,
          visualBox: menu?.visualBox() ?? null,
          avatarBox: box,
          /** 动态包围盒只作为**对照读数**保留：锚点与它的差就是"动作姿态引起的漂移" */
          avatarBoxDynamic: dyn,
        }
      }
      if (op === 'open') { menu.show(stage.value?.avatarAnchorBox() ?? null); return geo() }
      if (op === 'close') { menu.hide(); return geo() }
      if (op === 'toggle') { menu.toggle(stage.value?.avatarAnchorBox() ?? null); return geo() }
      if (op === 'state') return geo()
      if (op === 'bounds') {
        /**
         * **可判定的"不越界"检查**：逐项计算 8 个选项的**视觉矩形**（含尺寸），
         * 判断是否完整落在窗口内；并给出各项之间的最小间距。
         * 这是"轮盘视觉是否被裁 / 选项是否过挤"的客观判据，不靠肉眼看截图。
         */
        const a = geo()
        const n = menu.itemList().length
        const info = menu.sizeInfo()
        const rects = menu.itemRects()
        const outOfWindow: number[] = []
        let minGap = Number.POSITIVE_INFINITY
        for (let i = 0; i < rects.length; i++) {
          const r = rects[i]!
          if (r.x < 0 || r.y < 0 || r.x + r.w > window.innerWidth || r.y + r.h > window.innerHeight) outOfWindow.push(i)
        }
        for (let i = 0; i < rects.length; i++) {
          for (let j = i + 1; j < rects.length; j++) {
            const A = rects[i]!; const B = rects[j]!
            const gx = Math.max(0, Math.max(A.x - (B.x + B.w), B.x - (A.x + A.w)))
            const gy = Math.max(0, Math.max(A.y - (B.y + B.h), B.y - (A.y + A.h)))
            minGap = Math.min(minGap, Math.hypot(gx, gy))
          }
        }
        return {
          window: [window.innerWidth, window.innerHeight],
          anchor: [a.anchorX, a.anchorY],
          scale: a.scale,
          sizeInfo: info,
          itemCount: n,
          outOfWindow,
          passInWindow: outOfWindow.length === 0,
          minGapPx: Number.isFinite(minGap) ? Number(minGap.toFixed(1)) : null,
          visualBox: a.visualBox,
        }
      }
      if (op === 'settle') {
        // 等弹出动画收敛到 scale≈1（用于让命中测试跑在"动画结束"的确定状态上）
        return new Promise(resolve => setTimeout(() => resolve(geo()), 700))
      }
      if (op === 'hitTest') {
        /**
         * 命中测试与视觉同源：沿整圈的 8 个方向，按**当前实际半径**（自适应后的 `sizeInfo().radius`）
         * 取点做扫描。
         * ⚠ 不能硬编码默认半径 104：自适应后窄画布下半径会变（实测 56），
         *   硬编码会让测量点落到选项之外，产生"间隔命中"的假失败。
         */
        const items = 8
        const r = menu.sizeInfo().radius
        const a = geo()
        const hits: boolean[] = []
        for (let i = 0; i < items; i++) {
          const ang = ((-90 + (360 / items) * i) * Math.PI) / 180
          hits.push(menu.hitTest(a.anchorX + Math.cos(ang) * r, a.anchorY + Math.sin(ang) * r) !== null)
        }
        return { hits, allHit: hits.every(Boolean), anchor: [a.anchorX, a.anchorY], scale: a.scale, radiusUsed: r, sizeInfo: menu.sizeInfo() }
      }
      /**
       * ★ 2026-10-08 返工轮新增：**点击轮盘里的「对话」项**（第 1 条入口）。
       *
       * 为什么不能只调 `app.openConversation('wheel')`：那样测的是"IPC 通道通不通"，
       * 测不到"轮盘那一项到底有没有接上"。这里走的是**几何命中 → onSelect 回调**的
       * 真实路径（与用户点它同源）。
       *
       * ⚠ 命中点必须取**该项自己的视觉矩形中心**（`itemRects()`，与 `hitTest` 同源），
       *   不能自己按 `startAngleDeg` 和半径算 —— 实测踩到：自适应半径是 95 而不是
       *   默认 104，用固定角度算出来的点落在了项与项之间的空隙里，`hitTest` 返回 null，
       *   于是"点了没反应"看起来像入口坏了，其实是探针算错了点。
       * 返回 `clicked=false` + `reason` 时**不假装成功** —— 探针据此判失败。
       */
      if (op === 'clickChat') {
        try {
          /**
           * ⚠ **必须先让弹出动画收敛**（实测踩到的真实原因，留档）：
           *   `menu.show()` 会把 `scale` 置 0，而 `hitTest()` 在 `scale <= 0.001` 时
           *   **直接返回 null** —— 所以"show 之后立刻 hitTest"永远拿到 null。
           *   真实用户点击发生在动画之后（那时 scale ≈ 1），探针必须复现那个时刻，
           *   否则测出来的是"动画还没开始"，不是"入口坏了"。
           */
          if (!menu.isOpen() || menu.currentScale() < 0.99) {
            menu.show(stage.value?.avatarAnchorBox() ?? null)
            return { clicked: false, reason: 'settling', retry: true, scale: menu.currentScale() }
          }
          const items = menu.itemList()
          const idx = items.findIndex(i => i.id === 'chat')
          if (idx < 0) return { clicked: false, reason: 'no-chat-item', ids: items.map(i => i.id) }
          const rects = menu.itemRects()
          const r = rects[idx]
          if (!r) return { clicked: false, reason: 'no-rect' }
          const x = r.x + r.w / 2
          const y = r.y + r.h / 2
          /**
           * ★ 自诊断：把 `hitTest` 的每一步中间量都带出来。
           *
           * 为什么必须这么做（实测踩到）：第一版只返回 `hit-test-mismatch:null`，
           * 于是"点没算对"与"`hitTest` 真的坏了"分不出来 —— 只能靠猜。
           * 现在一次就把 `scale / 未缩放坐标 / 目标矩形 / 逐项命中结果` 全带出。
           */
          const s = menu.currentScale()
          const anchor = menu.currentAnchor()
          const lx = anchor.x + (x - anchor.x) / (s > 0.001 ? s : 1)
          const ly = anchor.y + (y - anchor.y) / (s > 0.001 ? s : 1)
          const hit = menu.hitTest(x, y)
          const diag = {
            scale: s,
            anchor: [anchor.x, anchor.y],
            unscaledPoint: [lx, ly],
            point: [x, y],
            rect: r,
            allRects: rects,
            radius: menu.sizeInfo().radius,
            itemSize: menu.sizeInfo().itemSize,
            perItem: items.map((it, i) => ({
              id: it.id, r: rects[i],
              hit: menu.hitTest(rects[i]!.x + rects[i]!.w / 2, rects[i]!.y + rects[i]!.h / 2),
            })),
          }
          if (hit !== 'chat') return { clicked: false, reason: `hit-test-mismatch:${String(hit)}`, ...diag }
          menu.hide()
          void handleWheelSelect('chat')
          return { clicked: true, id: 'chat', ...diag }
        } catch (e) {
          return { clicked: false, reason: `threw:${e instanceof Error ? e.message : String(e)}` }
        }
      }
      /**
       * ★★ **轮盘动画是否在真的推进**（2026-10-09 完善轮新增的诊断口）。
       *
       * 为什么单独一个 op（而不是从 `clickChat` 的读数里猜）：
       *   `clickChat` 只报告"此刻 scale 是多少"，而 `scale` 停在那里**有两种完全不同的病因**：
       *     ① `requestAnimationFrame` 没在跑（窗口隐藏/被遮挡时 Chromium 会冻结它）；
       *     ② 动画在跑但被别的东西按住。
       *   两者处置完全不同，而单看一个 `scale: 0` 分不出来。
       *   ⇒ 这里**主动**等 400ms 再看一次：
       *     · `rafAdvanced === true`  ⇒ rAF 在跑（scale 应当已经涨起来）；
       *     · `rafAdvanced === false` ⇒ **帧循环是停的**（读数里同时给 `document.hidden`
       *       与 `visibilityState`，直接指向"窗口是不是隐藏/被遮挡"）。
       * 只读，不改任何状态。
       */
      if (op === 'wheelDiag') {
        try {
          const before = { scale: menu ? menu.currentScale() : null, open: menu ? menu.isOpen() : null }
          /**
           * ⚠ 不只看 `scale` 变没变 —— 直接**数 rAF 回调次数**。
           *   两次采样只差一个 `scale` 值时，分不清"rAF 完全没跑"与"跑了但被夹住"；
           *   计数把这两件事彻底分开（0 次 ⇒ 帧循环停着）。
           */
          let rafCount = 0
          const t0 = Date.now()
          const loop = (): void => {
            rafCount += 1
            if (Date.now() - t0 < 1500) requestAnimationFrame(loop)
          }
          requestAnimationFrame(loop)
          return new Promise(resolve => {
            setTimeout(() => {
              const after = { scale: menu ? menu.currentScale() : null, open: menu ? menu.isOpen() : null }
              resolve(JSON.parse(JSON.stringify({
                before,
                after,
                advanced: before.scale !== null && after.scale !== null && after.scale > before.scale,
                /** 1.5 秒内我们自己挂的 rAF 回调被调了几次（0 = 帧循环是停的） */
                rafCallbacksIn1500ms: rafCount,
                elapsedMs: Date.now() - t0,
                documentHidden: document.hidden,
                visibilityState: document.visibilityState,
                hasFocus: document.hasFocus(),
                menuPresent: menu !== null,
                innerSize: { w: window.innerWidth, h: window.innerHeight },
              })))
            }, 1500)
          })
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) }
        }
      }
      if (op === 'rafProbe') {
        /**
         * ★ 帧循环健康度的**最小读数**（2026-10-09 完善轮新增）。
         *
         * 为什么单独一个 op：`rAF` 的冻结与"动画写错了"在界面上长得一模一样
         * （都是"点了没动静"）。这个 op 只数 700ms 内 rAF 回调被调了几次 ——
         * `0` 或 `1` 就是帧循环停着，与业务代码无关。
         * 只读、无副作用；每次调用自己挂一个回调，结束后不再续挂。
         */
        let n = 0
        const t0 = Date.now()
        const loop = (): void => { n += 1; if (Date.now() - t0 < 700) requestAnimationFrame(loop) }
        requestAnimationFrame(loop)
        return new Promise(resolve => {
          setTimeout(() => {
            resolve(JSON.parse(JSON.stringify({
              rafCallbacks: n,
              elapsedMs: Date.now() - t0,
              hasFocus: document.hasFocus(),
              hidden: document.hidden,
              visibility: document.visibilityState,
            })))
          }, 760)
        })
      }
      /** 当前锚点（A10 回归的旁证读数；完整 A10 由 run-probe.ps1 -Name a10 覆盖） */
      if (op === 'anchorNow') {
        const a = geo()
        return { anchorX: a.anchorX, anchorY: a.anchorY, scale: a.scale, open: a.open }
      }
      return { error: 'unknown-op' }
    }

    /**
     * 验收探针：拖拽（A14）。
     * `start` 模拟按下（走真实的 `setDragging(true)`），`feed` 喂入已知窗口位移并推进帧，
     * `release` 模拟松手（`setDragging(false)`），`state` 读当前摇晃状态。
     * 与真实拖拽**共用同一条代码路径**，因此读数可复现。
     */
    ;(window as unknown as { __AIRIMATE_DRAG_PROBE__?: (op: string, arg?: unknown) => unknown }).__AIRIMATE_DRAG_PROBE__ = (op: string, arg?: unknown) => {
      const s = stage.value
      if (!s) return { error: 'no-stage' }
      if (op === 'start') { s.setDragging(true); return { dragging: true, base: s.snapshot().baseClipId } }
      if (op === 'release') { s.setDragging(false); return { dragging: false, base: s.snapshot().baseClipId } }
      if (op === 'feed') {
        const a = arg as { deltas?: Array<[number, number]>, dragging?: boolean, fps?: number } | undefined
        const r = s.probeSway(a?.deltas ?? [], a?.dragging ?? true, a?.fps ?? 60)
        return r
      }
      if (op === 'state') {
        const snap = s.snapshot()
        const hips = snap.bones?.hips ?? null
        return { dragging: snap.dragging, base: snap.baseClipId, hipsQuat: hips, warnings: snap.warnings.slice(0, 3) }
      }
      return { error: 'unknown-op' }
    }

    /**
     * 验收探针：动作活性（A12 腿部有运动 / A13 待机数与轮换）。
     *
     * 为什么单独开一个探针而不是并进拖拽探针：`__AIRIMATE_DRAG_PROBE__` 的语义是
     * "拖拽"，把动作活性塞进去会让两个判据的读数混在一起、也更容易接错钩子
     * （实测踩到过：把 op 加进了拖拽探针，而主进程调的是舞台快照钩子，
     *   结果是 `Script failed to execute`）。
     *
     * `resetTravel` 必须先调：`boneTravel` 是**自启动以来的累计**角行程，
     * 不清零就只能证明"历史上动过"，证明不了"这 5 秒在动"。
     */
    ;(window as unknown as { __AIRIMATE_MOTION_PROBE__?: (op: string) => unknown }).__AIRIMATE_MOTION_PROBE__ = (op: string) => {
      const s = stage.value
      if (!s) return { error: 'no-stage' }
      if (op === 'resetTravel') { s.resetBoneTravel(); return { reset: true } }
      if (op === 'legTravel') {
        const snap = s.snapshot()
        return {
          legTravel: s.legTravel(),
          idleTotal: snap.idleTotal,
          baseClipId: snap.baseClipId,
          phase: snap.phase,
          dragging: snap.dragging,
        }
      }
      if (op === 'state') {
        const snap = s.snapshot()
        return { base: snap.baseClipId, phase: snap.phase, idleTotal: snap.idleTotal }
      }
      /**
       * **完整快照**（浸泡采样的唯一取数口，判据 A15/A16）。
       *
       * 为什么要新开一个 op 而不是复用 `state`：浸泡要求长时间、周期性地取
       * 17 根骨骼四元数 + 场景/渲染器/混音器/VRM 计数 + fps/heap。
       * `state` 只回三个字段，取不到"多了一个 renderer/多了一个 VRM"这类**不变量破坏** ——
       * 而那正是 2 小时浸泡真正要发现的东西。
       *
       * 只读：不触碰任何渲染状态。
       */
      if (op === 'full') {
        const snap = s.snapshot()
        return {
          baseClipId: snap.baseClipId,
          activeClip: snap.activeClip,
          activeWeight: snap.activeWeight,
          /** 动画时钟：浸泡判定"还在动"的直接证据（见 StageSnapshotSchema 的注释） */
          activeTimeSec: snap.activeTimeSec,
          activeDurationSec: snap.activeDurationSec,
          phase: snap.phase,
          idleIndex: snap.idleIndex,
          idleTotal: snap.idleTotal,
          dragging: snap.dragging,
          fps: snap.fps,
          heapMB: snap.heapMB,
          sceneCount: snap.sceneCount,
          rendererCount: snap.rendererCount,
          mixerCount: snap.mixerCount,
          vrmCount: snap.vrmCount,
          live2dCount: snap.live2dCount,
          boneCount: Object.keys(snap.bones ?? {}).length,
          bones: snap.bones,
          warnings: snap.warnings,
        }
      }
      /**
       * 骨骼是否**真的在动**。
       *
       * 为什么单独探这一条（实测踩到）：浸泡采样里 `bones` 的四元数在 5 个采样点之间
       * **逐字节完全相同**，而 `baseClipId` 明明在轮换（idle → _2 → _3 …）。
       * 这有两种可能，必须区分开：
       *   ⓐ 那些待机 clip 的骨骼姿态真的高度相似（那就没问题）；
       *   ⓑ 读的是一个**冻住**的源（那"看起来在动"就是假的）。
       * 区分办法：同一个采样里同时读 `humanoid.getNormalizedBoneNode()`（快照用的源）
       * 与 `getRawBoneNode()`（未归一化的原始节点），并**隔一小段时间再读一次**比差异。
       */
      if (op === 'boneMotion') {
        const vrm = s.getVrm()
        if (!vrm) return { error: 'no-vrm' }
        const KEYS = ['hips', 'spine', 'head', 'leftUpperArm', 'rightUpperArm', 'leftUpperLeg'] as const
        /**
         * 同时读**两条源**：
         *   · `normalized` —— `getNormalizedBoneNode()`，**快照 `snapshot().bones` 用的就是它**；
         *   · `raw`        —— `getRawBoneNode()`，VRM 原始节点，动画曲线直接驱动的那个。
         * 实测：`normalized` 在 1.2s 内几乎不动（≈0.02°），而 `raw` 明显在动。
         * 也就是说 `snapshot().bones` 是一个**近乎静止**的源 —— 它不能用来判断
         * "角色是不是卡住了"，用它做 T-pose 判定会**永远通不出问题**。
         */
        const read = (which: 'normalized' | 'raw'): Record<string, { x: number, y: number, z: number, w: number }> => {
          const out: Record<string, { x: number, y: number, z: number, w: number }> = {}
          for (const b of KEYS) {
            const n = which === 'normalized' ? vrm.humanoid?.getNormalizedBoneNode(b) : vrm.humanoid?.getRawBoneNode(b)
            if (n) out[b] = { x: n.quaternion.x, y: n.quaternion.y, z: n.quaternion.z, w: n.quaternion.w }
          }
          return out
        }
        const angle = (p: { x: number, y: number, z: number, w: number }, q: { x: number, y: number, z: number, w: number }): number => {
          const dot = Math.min(1, Math.abs(p.x * q.x + p.y * q.y + p.z * q.z + p.w * q.w))
          return Number(((2 * Math.acos(dot) * 180) / Math.PI).toFixed(3))
        }
        const nA = read('normalized'); const rA = read('raw')
        return new Promise(resolve => {
          /**
           * 采多个间隔并**分别**记录，而不是只比首尾。
           *
           * 为什么（实测踩到）：`legTravelAccum` 在整段会话里累计到 259°，说明骨骼**确实在动**；
           * 但 1.2 秒的首尾对比只测到 0.026°。如果只看首尾，
           * 就会得出"骨骼完全静止"这个**错误结论** —— 而真相可能是
           * "这段时间恰好落在动作的静止段"。
           * 采一串样本才能看出到底有没有在动。
           */
          const series: Array<{ atMs: number, normalized: Record<string, number>, raw: Record<string, number> }> = []
          let lastN = nA; let lastR = rA
          let step = 0
          const STEPS = 10
          const EVERY = 500
          const timer = setInterval(() => {
            step += 1
            const n = read('normalized'); const r = read('raw')
            const dn: Record<string, number> = {}; const dr: Record<string, number> = {}
            for (const k of KEYS) {
              const pn = lastN[k]; const qn = n[k]; if (pn && qn) dn[k] = angle(pn, qn)
              const pr = lastR[k]; const qr = r[k]; if (pr && qr) dr[k] = angle(pr, qr)
            }
            series.push({ atMs: step * EVERY, normalized: dn, raw: dr })
            lastN = n; lastR = r
            if (step < STEPS) return
            clearInterval(timer)
            const allN = series.flatMap(s2 => Object.values(s2.normalized))
            const allR = series.flatMap(s2 => Object.values(s2.raw))
            const snap = s.snapshot()
            resolve({
              baseClipId: snap.baseClipId,
              activeClip: snap.activeClip,
              activeWeight: snap.activeWeight,
              idleIndex: snap.idleIndex,
              windowMs: STEPS * EVERY,
              series,
              maxNormalizedDeg: Number(Math.max(...allN).toFixed(3)),
              maxRawDeg: Number(Math.max(...allR).toFixed(3)),
              sumNormalizedDeg: Number(allN.reduce((a, b) => a + b, 0).toFixed(3)),
              sumRawDeg: Number(allR.reduce((a, b) => a + b, 0).toFixed(3)),
              /** 只要**任何一次**间隔里某根骨动了 > 0.1°，就证明动画在推进 */
              rawIsAnimating: Math.max(...allR) > 0.1,
              normalizedLooksFrozen: Math.max(...allN) < 0.1,
              legTravelDeg: Object.values(s.legTravel()).reduce((a, b) => a + b, 0),
            })
          }, EVERY)
        })
      }
      return { error: 'unknown-op' }
    }

    /**
     * 验收探针：输入语义（A11）。
     * 用**真实的 DOM 事件派发**到画布上（pointerdown / contextmenu），
     * 与用户点击走同一条事件路径；然后读轮盘开关状态与舞台 dragging 状态。
     * 这样"左键只拖拽、不开轮盘""右键开轮盘""F1 开合"三件事都能被机械判定。
     */
    ;(window as unknown as { __AIRIMATE_INPUT_PROBE__?: (op: string) => unknown }).__AIRIMATE_INPUT_PROBE__ = (op: string) => {
      const cv = canvas.value
      if (!cv) return { error: 'no-canvas' }
      const state = (): { wheelOpen: boolean, dragging: boolean } => ({
        wheelOpen: menu ? menu.isOpen() : false,
        dragging: stage.value?.snapshot().dragging === true,
      })
      const dispatchPointerDown = (button: number): void => {
        const ev = new PointerEvent('pointerdown', {
          button, buttons: button === 0 ? 1 : 2, bubbles: true, cancelable: true,
          clientX: 10, clientY: 10,
        })
        cv.dispatchEvent(ev)
      }
      const dispatchContextMenu = (): void => {
        cv.dispatchEvent(new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true, clientX: 10, clientY: 10 }))
      }
      const dispatchKey = (key: string): void => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      }
      /**
       * 左键按下是**异步**路径：`onPointerDown` 先 `await bridge.dragBegin(...)`，
       * 之后才 `stage.setDragging(true)`。所以**同步**读 `state()` 必然读到 `dragging:false`
       * —— 那测的是"微任务还没跑"，不是"左键没启动拖拽"。
       *
       * 这里返回一个 Promise，等一个宏任务（让 `await` 之后的代码跑完）再读状态。
       * 判据本身没变（仍然是"左键必须开始拖拽、且不得开轮盘"），
       * 变的只是**测量的时刻** —— 原来那条断言其实一直在测错的时间点。
       */
      if (op === 'leftDown') {
        const before = state()
        dispatchPointerDown(0)
        return new Promise(resolve => setTimeout(() => { resolve({ before, after: state() }) }, 350))
      }
      /**
       * ★ 2026-10-08 返工轮新增：**双击角色**的探针操作。
       *
       * 为什么要它：双击是本轮五个入口之一，而"打开独立对话窗口"这件事必须能被机械验证。
       * 这里合成的是**真实 `dblclick` DOM 事件**（不是直接调 `app.openConversation`），
       * 所以整条链路都被覆盖：Vue 的 `@dblclick` → `onDoubleClick` →
       * `isOnAvatar()` 命中判定 → `app.openConversation('dblclick')` → IPC → 主进程建窗。
       * 坐标取 `hitCenter()`（角色命中椭圆的中心，与拖拽/命中区域同源），
       * 因此"点在空白处不会开窗"这条隐含约束也随之成立。
       */
      if (op === 'dblclickAvatar') {
        /**
         * ⚠ 命中点**在本地现算**，不复用下面的 `hitCenter()`。
         *
         * 实测踩到：`hitCenter` 是同作用域后面用 `const` 声明的，探针在 `onMounted` 里
         * 挂载、而这个函数体在挂载那一刻就被调用过一次 ⇒ 同步引用会踩进暂时性死区，
         * 抛出压缩后变量名的错误（"Cannot access 'ge' before initialization"），
         * 主进程只收到一句 "Script failed to execute"，完全无法归因。
         * 计算方式与 `hitCenter()` **逐字一致**（同一个 `avatarHitEllipse()` + 同一个
         * 画布矩形），所以不存在"两套几何"。
         */
        try {
          const s0 = stage.value
          const cvv0 = canvas.value
          if (!s0 || !cvv0) return { dispatched: false, reason: 'no-stage-or-canvas' }
          const e0 = s0.avatarHitEllipse()
          if (!e0) return { dispatched: false, reason: 'no-hit-ellipse' }
          const r0 = cvv0.getBoundingClientRect()
          const c = { clientX: r0.left + e0.cx, clientY: r0.top + e0.cy + e0.ry * 0.10 }
          const before = { open: app.conversationOpen }
          cv.dispatchEvent(new MouseEvent('dblclick', {
            button: 0, buttons: 0, bubbles: true, cancelable: true, composed: true,
            clientX: c.clientX, clientY: c.clientY,
          }))
          return { dispatched: true, point: c, before }
        } catch (e) {
          /**
           * ⚠ 必须自己在探针里兜住异常（实测踩到）：
           *   角色还没加载完时 `hitCenter()` 内部会抛（stage/命中椭圆尚未就绪），
           *   而抛出的异常会让整条 `executeJavaScript` 失败并只回一句
           *   "Script failed to execute" —— 那既看不出是"角色没就绪"还是"双击没接上"，
           *   也会让这条探针变成不可判定的噪声。
           */
          return { dispatched: false, reason: `threw:${e instanceof Error ? e.message : String(e)}` }
        }
      }
      /** 单击角色（对照：单击**不该**打开对话窗口 —— A11 的"短按什么都不做"） */
      if (op === 'clickAvatar') {
        const c = hitCenter()
        if (!c) return { dispatched: false, reason: 'no-hit-center' }
        cv.dispatchEvent(new MouseEvent('click', {
          button: 0, buttons: 0, bubbles: true, cancelable: true, composed: true,
          clientX: c.clientX, clientY: c.clientY,
        }))
        return { dispatched: true, point: c }
      }
      if (op === 'rightMenu') { const before = state(); dispatchContextMenu(); return { before, after: state() } }
      if (op === 'keyF1') { const before = state(); dispatchKey('F1'); return { before, after: state() } }
      if (op === 'keyEsc') { const before = state(); dispatchKey('Escape'); return { before, after: state() } }
      if (op === 'state') return state()
      /**
       * 诊断：左键按下这条链路**到底断在哪一环**。
       *
       * 为什么需要它：`leftDown` 失败时只能看到"dragging 还是 false"，
       * 无法区分 ① 事件没进 Vue 处理器、② 处理器抛错、③ 主进程拒绝了 drag-begin。
       * 这里把三环分别探一遍：事件是否被监听到、处理器是否抛错、IPC 是否返回错误。
       */
      if (op === 'leftDownDiag') {
        const cvv = canvas.value
        if (!cvv) return { error: 'no-canvas' }
        const seen: string[] = []
        const capture = (e: Event): void => { seen.push(`capture:${e.type}`) }
        const bubble = (e: Event): void => { seen.push(`bubble:${e.type}`) }
        cvv.addEventListener('pointerdown', capture, true)
        cvv.addEventListener('pointerdown', bubble, false)
        /**
         * 一次性 A/B 对照，**内部自带超时**，绝不挂住探针。
         *
         * 结论（实测）：`setPointerCapture()` 对合成 `pointerdown` 的 `pointerId`
         * 会抛 `DOMException`，且抛出点位于 `setDragging(true)` **之前** ⇒
         * 处理器中断、`dragging` 恒为 false、且不产生我们自己的错误记录。
         * 修法是把 `setPointerCapture` 包进 try/catch（见 `onPointerDown`）。
         *
         * ⚠ 这里**不直接调用** `onPointerDown()`：用合成事件调它会让异常在探针里冒泡，
         * 整条 `executeJavaScript` 永不 resolve（实测：进程不退出、JSON 不写）。
         * 也不在这里自己调 `setPointerCapture` —— 同样会把异常留在探针里。
         */
        dispatchPointerDown(0)
        cvv.removeEventListener('pointerdown', capture, true)
        cvv.removeEventListener('pointerdown', bubble, false)
        return new Promise(resolve => {
          const timer = setTimeout(() => resolve({ timedOut: true, listenersSeen: seen }), 1500)
          setTimeout(() => {
            clearTimeout(timer)
            const st = state()
            void bridge.dragEnd().catch(() => { /* 清理 */ })
            if (dragging) { dragging = false; stage.value?.setDragging(false) }
            resolve({ listenersSeen: seen, after: st, stageExists: stage.value !== null })
          }, 500)
        })
      }
      /**
       * ─────────────────────────────────────────────────────────────
       * 本轮新增的**手势 / 取景**探针操作。
       *
       * 技术说明（**必须如实记录在证据里**）：指针事件由页面内**合成派发**，
       * 不是 OS 级鼠标注入。选择它的理由：
       *   · 它走的是完整的真实链路 —— Vue 处理器 → `isOnAvatar()` 命中判定 →
       *     阈值判定 → `bridge.dragBegin` IPC → 主进程 `beginDrag/setBounds`；
       *   · OS 级注入无法给出可复现的坐标（A14 已实测过"两个驱动源"造成的假漂移）。
       * 因此**能**验证：单击不拖窗口、拖动越阈值才拖、窗口尺寸不变、相机不变；
       * **不能**验证：真实鼠标在桌面上的物理手感（那一项保持 NOT VERIFIED）。
       * ─────────────────────────────────────────────────────────────
       */
      /** 角色命中椭圆中心（画布内 CSS 坐标 → 视口 client 坐标） */
      const hitCenter = (): { clientX: number, clientY: number } | null => {
        const s = stage.value
        const cvv = canvas.value
        if (!s || !cvv) return null
        const e = s.avatarHitEllipse()
        if (!e) return null
        const r = cvv.getBoundingClientRect()
        return { clientX: r.left + e.cx, clientY: r.top + e.cy + e.ry * 0.10 }
      }
      /**
       * 合成指针事件。`screenX/screenY` 按 `window.screenX/screenY + client` 推算 ——
       * 与 Chromium 对真实鼠标事件给出的值同一算法（无边框窗口，无客户区偏移）。
       */
      const pev = (
        type: string, clientX: number, clientY: number,
      ): PointerEvent => new PointerEvent(type, {
        button: 0, buttons: type === 'pointerup' ? 0 : 1,
        pointerId: 1, pointerType: 'mouse', isPrimary: true,
        bubbles: true, cancelable: true, composed: true,
        clientX, clientY,
        screenX: Math.round(window.screenX + clientX),
        screenY: Math.round(window.screenY + clientY),
      })
      /** 采样：一切"角色/相机有没有动"的读数都从这里取（真实投影 + 真实像素） */
      const sample = (): Record<string, unknown> => {
        const s = stage.value
        if (!s) return { error: 'no-stage' }
        const snap = s.snapshot()
        const px = s.pixelStats()
        return {
          baseClipId: snap.baseClipId,
          dragging: snap.dragging,
          screenRect: s.screenRect(),
          /**
           * ⚠ `inFrustum` 在 `snapshot().view` 里，不在顶层。
           *   这里曾写成 `snap.inFrustum` ⇒ 永远是 `undefined` ⇒ 探针把"在视锥内"判成 false
           *   （实测：画面上角色明明完整可见，`passInFrustum` 却是 false）。
           */
          inFrustum: snap.view?.inFrustum === true,
          /**
           * ⚠ 画布视口**必须在这里现算**：`viewDiagnostics()` 只给渲染器尺寸，
           *   `canvasViewport` 是 `exposeDiagnostics()` 在快照上补的字段，
           *   而探针直接调 `s.snapshot()` ⇒ 拿不到它（实测：字段为空、
           *   `insideRatio` 因此算不出来）。
           */
          canvasViewport: (() => {
            const cvv = canvas.value
            if (!cvv) return null
            const r = cvv.getBoundingClientRect()
            return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
          })(),
          canvasBuffer: snap.view?.canvasBuffer ?? null,
          camera: s.cameraSignature(),
          avatarBox: s.avatarBox(),
          anchorBox: s.avatarAnchorBox(),
          hitEllipse: s.avatarHitEllipse(),
          avatarScale: s.getAvatarScale(),
          pixelRatio: px.ratio,
          pixelBox: px.contentBox,
        }
      }
      const centerPx = (r: { x: number, y: number, w: number, h: number } | null): { cx: number, cy: number, bottom: number } | null =>
        r ? { cx: r.x + r.w / 2, cy: r.y + r.h / 2, bottom: r.y + r.h } : null

      if (op === 'hitCenter') return hitCenter()
      /** DOM 布局实测：pet/panel 下舞台槽位到底占了多大（"角色缩在角落"类问题的定位读数） */
      if (op === 'layout') {
        const pick = (sel: string): Record<string, unknown> | null => {
          const el = document.querySelector(sel) as HTMLElement | null
          if (!el) return null
          const r = el.getBoundingClientRect()
          const cs = getComputedStyle(el)
          return {
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            display: cs.display, position: cs.position, flex: cs.flex, width: cs.width, height: cs.height,
          }
        }
        return {
          inner: [window.innerWidth, window.innerHeight],
          devicePixelRatio: window.devicePixelRatio,
          shellClass: (document.querySelector('.shell') as HTMLElement | null)?.className ?? null,
          html: pick('html'), body: pick('body'), app: pick('#app'),
          shell: pick('.shell'), shellBody: pick('.shell__body'),
          side: pick('.side'), stageSlot: pick('.stage-slot'), stageRoot: pick('.stage-root'),
          canvas: pick('.stage-canvas'),
        }
      }
      if (op === 'sample') return sample()
      /** 单击（按下 + 抬起，**不移动**）：不得进入拖拽、不得开轮盘、不得改缩放 */
      if (op === 'clickOnce' || op.startsWith('clickRepeat')) {
        const n = op.startsWith('clickRepeat') ? Math.max(1, Number(op.split(':')[1] ?? 1)) : 1
        const c = hitCenter()
        if (!c) return { error: 'no-hit-center' }
        const before = state()
        const scaleBefore = stage.value?.getAvatarScale() ?? null
        const camBefore = JSON.stringify(stage.value?.cameraSignature() ?? null)
        for (let i = 0; i < n; i++) {
          cv.dispatchEvent(pev('pointerdown', c.clientX, c.clientY))
          cv.dispatchEvent(pev('pointerup', c.clientX, c.clientY))
          cv.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true, cancelable: true, clientX: c.clientX, clientY: c.clientY }))
        }
        return new Promise(resolve => setTimeout(() => resolve({
          n, at: c, before, after: state(),
          scaleBefore, scaleAfter: stage.value?.getAvatarScale() ?? null,
          cameraUnchanged: camBefore === JSON.stringify(stage.value?.cameraSignature() ?? null),
        }), 400))
      }
      /**
       * 拖动：`dragBegin:<dx>,<dy>[,steps]` 只按下并移动（用于观察"已进入拖拽"），
       * `dragFinish` 抬起，`dragCycle:<dx>,<dy>` 一次做完。
       */
      const parseXY = (spec: string): { dx: number, dy: number, steps: number } => {
        const p = spec.split(',').map(Number)
        return { dx: p[0] ?? 20, dy: p[1] ?? 12, steps: Math.max(1, p[2] ?? 4) }
      }
      if (op.startsWith('dragBegin') || op.startsWith('dragCycle')) {
        const isCycle = op.startsWith('dragCycle')
        const { dx, dy, steps } = parseXY(op.slice(op.indexOf(':') + 1))
        const c = hitCenter()
        if (!c) return { error: 'no-hit-center' }
        const before = state()
        cv.dispatchEvent(pev('pointerdown', c.clientX, c.clientY))
        for (let i = 1; i <= steps; i++) {
          cv.dispatchEvent(pev('pointermove', c.clientX + (dx * i) / steps, c.clientY + (dy * i) / steps))
        }
        const afterDown = state()
        if (!isCycle) {
          return new Promise(resolve => setTimeout(() => resolve({
            mode: 'begin', requested: { dx, dy, steps }, at: c, before, afterDown, after: state(),
          }), 200))
        }
        cv.dispatchEvent(pev('pointerup', c.clientX + dx, c.clientY + dy))
        return new Promise(resolve => setTimeout(() => resolve({
          mode: 'cycle', requested: { dx, dy, steps }, at: c, before, afterDown, after: state(),
        }), 260))
      }
      if (op === 'dragFinish') {
        const c = hitCenter() ?? { clientX: 0, clientY: 0 }
        cv.dispatchEvent(pev('pointerup', c.clientX, c.clientY))
        return new Promise(resolve => setTimeout(() => resolve({ after: state() }), 260))
      }
      /** 阈值以下的小位移：**不得**进入拖拽（判据：4 CSS px） */
      if (op.startsWith('dragBarelyMove')) {
        const { dx, dy } = parseXY(op.slice(op.indexOf(':') + 1))
        const c = hitCenter()
        if (!c) return { error: 'no-hit-center' }
        const before = state()
        cv.dispatchEvent(pev('pointerdown', c.clientX, c.clientY))
        cv.dispatchEvent(pev('pointermove', c.clientX + dx, c.clientY + dy))
        const after = state()
        cv.dispatchEvent(pev('pointerup', c.clientX + dx, c.clientY + dy))
        return new Promise(resolve => setTimeout(() => resolve({ requested: { dx, dy }, at: c, before, after, afterUp: state() }), 200))
      }
      /** 空白处按下+移动：不得拖窗口（命中判定） */
      if (op.startsWith('blankDrag')) {
        const { dx, dy } = parseXY(op.slice(op.indexOf(':') + 1))
        const cvv = canvas.value
        const r = cvv?.getBoundingClientRect()
        // 画布**左上角**内 6px 处：固定锚点在底部中央，这里必然在角色椭圆之外
        const clientX = (r?.left ?? 0) + 6
        const clientY = (r?.top ?? 0) + 6
        const before = state()
        cv.dispatchEvent(pev('pointerdown', clientX, clientY))
        cv.dispatchEvent(pev('pointermove', clientX + dx, clientY + dy))
        const after = state()
        cv.dispatchEvent(pev('pointerup', clientX + dx, clientY + dy))
        return new Promise(resolve => setTimeout(() => resolve({ requested: { dx, dy }, at: { clientX, clientY }, before, after }), 200))
      }
      /** 取景/锚点采样（60s 稳定性测试按固定间隔反复调用它） */
      if (op === 'anchorSample') {
        const s = stage.value
        if (!s) return { error: 'no-stage' }
        const snap = s.snapshot()
        return {
          t: Math.round(performance.now()),
          baseClipId: snap.baseClipId,
          anchorPx: s.stageAnchorPx(),
          hitEllipse: s.avatarHitEllipse(),
          screenRect: s.screenRect(),
          screenCenter: centerPx(s.screenRect()),
          avatarBox: s.avatarBox(),
          boxCenter: centerPx(s.avatarBox()),
          inFrustum: snap.view?.inFrustum === true,
          /** ★ 关键骨骼的屏幕坐标：hips 是"根位移有没有被钉住"的直接读数 */
          bones: s.boneScreenPositions(),
          /** ★ 锚点几何自检：投影回来的锚点与目标锚点的误差 */
          anchorProjection: s.anchorProjection(),
          camera: s.cameraSignature(),
          fps: snap.fps,
          avatarScale: s.getAvatarScale(),
          rootPosition: s.framingDiagnostics().rootPosition,
        }
      }
      /** 强制切到下一个待机动作，返回切换前后读数（判据：相机必须逐位不变） */
      if (op === 'nextIdle') {
        const s = stage.value
        if (!s) return { error: 'no-stage' }
        const before = { clipId: s.snapshot().baseClipId, camera: s.cameraSignature(), box: s.avatarBox(), screenRect: s.screenRect() }
        const r = s.probeNextIdle()
        return new Promise(resolve => setTimeout(() => resolve({
          switched: r,
          before,
          after: { clipId: s.snapshot().baseClipId, camera: s.cameraSignature(), box: s.avatarBox(), screenRect: s.screenRect() },
          cameraUnchanged: JSON.stringify(before.camera) === JSON.stringify(s.cameraSignature()),
        }), 260))
      }
      /** 播放指定语义的 clip（动作转换验证：根位移策略必须在转换时也成立） */
      if (op.startsWith('motion:')) {
        const s = stage.value
        if (!s) return { error: 'no-stage' }
        const name = op.slice('motion:'.length)
        const before = { clipId: s.snapshot().baseClipId, box: s.avatarBox(), screenRect: s.screenRect() }
        const ok = s.requestMotion(name, { once: false, fadeMs: 600 })
        return new Promise(resolve => setTimeout(() => resolve({
          requested: name, accepted: ok,
          before,
          after: { clipId: s.snapshot().baseClipId, box: s.avatarBox(), screenRect: s.screenRect() },
          phase: s.snapshot().phase,
          frustum: s.snapshot().view?.inFrustum === true,
          pixels: (() => { const p = s.pixelStats(); return { ratio: p.ratio, box: p.contentBox } })(),
        }), 1600))
      }
      /** 回到待机（动作转换验证后复位） */
      if (op === 'motionIdle') {
        const s = stage.value
        if (!s) return { error: 'no-stage' }
        const ok = s.requestMotion('idle', { once: false, fadeMs: 400 })
        return new Promise(resolve => setTimeout(() => resolve({ accepted: ok, clipId: s.snapshot().baseClipId }), 900))
      }
      /** 真实像素读数（非背景像素比例 + 内容像素包围盒） */
      if (op === 'pixels') {
        const s = stage.value
        if (!s) return { error: 'no-stage' }
        const px = s.pixelStats()
        return { ratio: px.ratio, nonBg: px.nonBg, total: px.total, box: px.contentBox, bgMode: px.bgMode, canvas: [window.innerWidth, window.innerHeight] }
      }
      /** 根位移策略读数（`none` 的 clip 横纵行程必须为 0） */
      if (op === 'rootMotion') {
        const s = stage.value
        if (!s) return { error: 'no-stage' }
        return { records: s.rootMotion() }
      }
      /** 显式缩放：验证"围绕锚点缩放 ⇒ 相机不动" */
      if (op.startsWith('setScale')) {
        const s = stage.value
        if (!s) return { error: 'no-stage' }
        const v = Number(op.split(':')[1] ?? 1)
        const before = { camera: s.cameraSignature(), screenRect: s.screenRect(), anchorPx: s.stageAnchorPx() }
        s.setAvatarScale(v)
        return new Promise(resolve => setTimeout(() => resolve({
          requested: v, applied: s.getAvatarScale(), before,
          after: { camera: s.cameraSignature(), screenRect: s.screenRect(), anchorPx: s.stageAnchorPx() },
          cameraUnchanged: JSON.stringify(before.camera) === JSON.stringify(s.cameraSignature()),
        }), 300))
      }
      return { error: 'unknown-op' }
    }

    window.__AIRIMATE_STAGE__ = snap
    /**
     * 自拍探针：把「读帧缓冲」与「拷画布」两条读数都暴露出来，供 QA 直接取。
     * 只读、不改渲染状态。
     */
    ;(window as unknown as { __AIRIMATE_SELFCAP__?: () => unknown }).__AIRIMATE_SELFCAP__ = () => {
      const r = s.selfCapture()
      return { readPixelsNonBg: r.readPixelsNonBg, copyNonBg: r.copyNonBg, size: r.size, pngLen: r.png ? r.png.length : 0, png: r.png }
    }
    /**
     * 诊断探针：红方块对照实验。
     * `add` 放入方块并返回它的 NDC 投影；`ratio` 读回"接近该红色的像素比例"。
     * 两者一起就能判定"相机/投影/画布"这一侧是否健康。
     */
    ;(window as unknown as { __AIRIMATE_TESTBOX__?: (op: string) => unknown }).__AIRIMATE_TESTBOX__ = (op: string) => {
      if (op === 'add') {
        const r = s.addTestBox()
        // 下一帧再读，保证方块已经进入这一帧的绘制
        return new Promise(resolve => setTimeout(() => {
          resolve({ ...r, redRatio: s.colorRatio({ r: 255, g: 45, b: 85 }, 70) })
        }, 260))
      }
      if (op === 'remove') { s.removeTestBox(); return { removed: true } }
      if (op === 'hideModel') { s.setModelVisible(false); return { hidden: true } }
      if (op === 'showModel') { s.setModelVisible(true); return { shown: true } }
      if (op === 'stopAnimation') { s.stopAnimationForProbe(); return { stopped: true } }
      if (op === 'ratio') { return { redRatio: s.colorRatio({ r: 255, g: 45, b: 85 }, 70) } }
      return { error: 'unknown-op' }
    }
    app.updateStageStatus({
      stageId: snap.stageId,
      baseClipId: snap.baseClipId,
      idleTotal: snap.idleTotal,
      dragging: snap.dragging,
      warnings: snap.warnings,
      fps1s: snap.fps.avg1s,
      heapMB: snap.heapMB,
    })
    bridge.reportStageSnapshot(snap)
    setTimeout(refresh, 200)
  }
  refresh()
}

// ───────────────────────────────────────────────────── 轮盘

function buildWheel(): void {
  const host = wheelHost.value
  if (!host) return
  menu = new RadialMenu({
    host,
    onSelect: (id) => { void handleWheelSelect(id) },
    /**
     * 按**可用空间**自适应轮盘尺寸。
     * 依据（实测）：panel 模式的舞台画布只有 150×630 CSS px，默认半径 104 会让轮盘超出画布被裁。
     * 这里用画布的实际矩形作为可用空间（没有画布时退回视口）。
     */
    onBeforeOpen: () => {
      const cv = canvas.value
      const r = cv?.getBoundingClientRect()
      /**
       * ★ 尺寸按**画布**自适应，但**收夹边界用整窗**。
       *
       * 为什么两者不同（实测两次回归后定下的结论）：
       *   · 尺寸：画布窄（panel 模式仅 150px）⇒ 半径必须缩小，否则视觉溢出；
       *   · 收夹：**不能**限制在画布里 —— 轮盘半径 56 + 内边距 70 = 126，
       *     而画布只有 150px 宽、收夹窗口仅剩 8px ⇒ 锚点被挤到画布中心，
       *     轮盘整个跑出屏幕（实测截图里完全看不到轮盘）。
       *   轮盘本质是**窗口级覆盖层**：它锚定角色头部，但允许延伸到面板区域上方
       *   （截图已验证该形态观感正常），因此收夹必须用窗口尺寸。
       */
      menu?.setAvailableRect(null)
      if (r && r.width > 0 && r.height > 0) menu?.setAvailableSpace(r.width, r.height)
      else menu?.setAvailableSpace(window.innerWidth, window.innerHeight)
    },
    onToggleState: (id) => {
      if (id === 'chat') return app.conversationOpen
      if (id === 'hearing') return app.settings?.hearingEnabled ?? false
      if (id === 'speaker') return app.settings?.ttsEnabled ?? false
      if (id === 'alwaysOnTop') return app.settings?.alwaysOnTop ?? true
      return true
    },
    onOpenChange: (open) => {
      app.wheelOpen = open
      // 每次开轮盘都同步一次勾选态：「对话」项的开关状态可能在关闭期间被托盘/快捷键改过
      if (open) menu?.syncToggles()
    },
    onGeometry: (g) => {
      const s = stage.value
      if (!s) return
      const snap = window.__AIRIMATE_STAGE__ as { wheel?: unknown } | undefined
      if (snap) snap.wheel = { open: g.open, cx: g.cx, cy: g.cy, scale: g.scale }
    },
  })
}

function anchorBox(): { x: number, y: number, w: number, h: number } | null {
  /**
   * 轮盘锚点用**固定锚点包围盒**，不用 `avatarBox()`（动态蒙皮包围盒）。
   * 依据（判据 A10）：动态包围盒随在播动作的关节姿态每帧变几像素，
   * 三次开合会读到三个不同的锚点，`≤2px` 必然不过。
   * 角色命中区域的上报仍用动态包围盒（那要贴真实像素，见 `startBoxReporting`）。
   */
  return stage.value?.avatarAnchorBox() ?? stage.value?.avatarBox() ?? null
}

function toggleWheel(): void {
  if (!menu) return
  menu.toggle(anchorBox())
  menu.syncToggles()
}

async function handleWheelSelect(id: string): Promise<void> {
  try {
    /**
     * ★ 轮盘「对话」项（id 仍是 `chat`，**契约不变**）。
     *
     * 本轮规格明确：行为从 `setMode('panel')` 改成"在当前窗口打开/关闭对话框"，
     * **点它不许再切 panel 模式**。
     * 为什么这个改动是必须的：旧行为本质是"切回面板看字"，
     * 而改造后主界面已经没有文字流水了 —— 再切过去只会让用户看到一片空白。
     */
    if (id === 'chat') { await app.toggleConversation('wheel') }
    else if (id === 'avatar') { await app.setMode('panel'); app.toast('info', '角色设置', '角色与外观在设置面板的「角色」分区', false) }
    else if (id === 'settings') { await app.setMode('panel') }
    else if (id === 'center') { await bridge.center() }
    else if (id === 'hearing') { await app.patch({ hearingEnabled: !(app.settings?.hearingEnabled ?? false) }) }
    else if (id === 'speaker') { await app.patch({ ttsEnabled: !(app.settings?.ttsEnabled ?? false) }) }
    else if (id === 'alwaysOnTop') { await app.patch({ alwaysOnTop: !(app.settings?.alwaysOnTop ?? true) }) }
    /**
     * ⛔ `sleep` 分支已随轮盘项一起临时摘除（用户 2026-09-27 方案 C）。
     *    原因：该 clip 的根位移放大后是荒谬值，钉死后呈现"站姿抱臂"这个明显错误的姿态。
     *    注意：即使这里保留分支也没用 —— 真正的屏蔽点在 `Stage.requestMotion()`
     *    （见 `DISABLED_MOTION_SEMANTICS`），那里同时挡住聊天 Act 标记与探针。
     */
  } catch (e) {
    app.reportFailure(`轮盘项「${id}」执行失败`, e)
  }
}

// ───────────────────────────────────────────────────── 左键手势（短按 / 拖动）

/** 画布内坐标是否落在角色命中区域内（基于**固定锚点**，不用会漂移的动态包围盒） */
function isOnAvatar(clientX: number, clientY: number): boolean {
  const s = stage.value
  const cv = canvas.value
  if (!s || !cv) return false
  const rect = cv.getBoundingClientRect()
  const px = clientX - rect.left
  const py = clientY - rect.top
  const hit = s.avatarHitEllipse()
  if (!hit) return false
  const dx = (px - hit.cx) / Math.max(1, hit.rx)
  const dy = (py - hit.cy) / Math.max(1, hit.ry)
  return dx * dx + dy * dy <= 1
}

/**
 * 左键按下：**只记录，不拖拽**。
 *
 * 这里刻意不做 `preventDefault` 之外的事情 —— 任何"按下就生效"的行为
 * 都会把单击变成拖拽（这正是本轮要修的缺陷）。
 */
function onPointerDown(ev: PointerEvent): void {
  if (ev.button !== 0) return
  // 左键**只**用于角色交互：绝不在此打开轮盘
  ev.preventDefault()
  /**
   * `setPointerCapture` 包在 try/catch 里：它只是**优化**（保证拖出元素后仍收到事件），
   * 不是拖拽的前提。实测：合成 `pointerdown` 的 `pointerId` 不对应活动指针时会抛
   * `DOMException`，而它在旧代码里位于 `setDragging(true)` **之前** ⇒ 整段中断、
   * 左键完全没反应且不产生任何错误记录。
   */
  const onAvatar = isOnAvatar(ev.clientX, ev.clientY)
  leftGesture = {
    pointerId: ev.pointerId,
    startScreenX: Math.round(ev.screenX),
    startScreenY: Math.round(ev.screenY),
    startClientX: ev.clientX,
    startClientY: ev.clientY,
    onAvatar,
    dragging: false,
    consumedClick: false,
  }
  /**
   * ⚠ 只有**命中了角色**才建立指针捕获。
   *   空白处按下应当什么都不做（包括不捕获），否则会把本该给桌面的事件吃掉。
   */
  if (onAvatar) {
    try { (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId) } catch { /* 捕获失败不影响后续 */ }
  }
}

/**
 * 左键移动：**只有越阈值**才进入拖拽并调用 `dragBegin`。
 *
 * 位移用**屏幕坐标**算（与主进程推进拖拽用的坐标同一空间），
 * 阈值用 **CSS px 到屏幕 px 的换算**后的值比较，避免 DPI 缩放下阈值失真。
 */
function onPointerMove(ev: PointerEvent): void {
  const g = leftGesture
  if (!g || ev.pointerId !== g.pointerId) return
  if (g.dragging) return
  /**
   * ⚠ **命中判定参与拖动门槛**：按下点不在角色上 ⇒ 本次手势永远不会变成拖动。
   *   （规格：只有"点在角色上并移动"才拖窗口；点画布空白处不得移动窗口。）
   */
  if (!g.onAvatar) return
  const sx = Math.round(ev.screenX)
  const sy = Math.round(ev.screenY)
  const moved = Math.hypot(sx - g.startScreenX, sy - g.startScreenY)
  /**
   * 阈值换算：`devicePixelRatio` 是"CSS px → 设备 px"，而 screenX/screenY 是
   * 屏幕 DIP（与 CSS px 同尺度，受系统缩放影响）。这里按 DPR 归一，
   * 保证阈值在任何缩放下都约等于 4 个 CSS px。
   */
  const dpr = Math.max(1, window.devicePixelRatio || 1)
  const thresholdScreen = DRAG_THRESHOLD_PX * dpr
  if (moved < thresholdScreen) return

  // 越阈值 ⇒ 记下当前指针位置，让主进程以"当前位置"为拖拽起点
  g.dragging = true
  dragging = true
  stage.value?.setDragging(true)
  void bridge.dragBegin({ x: sx, y: sy }).catch((e) => {
    // 启动失败要**回滚**状态，否则 UI 会一直停在"拖拽中"
    g.dragging = false
    dragging = false
    stage.value?.setDragging(false)
    app.reportFailure('拖拽启动失败', e)
  })
}

/**
 * 左键抬起：短按 = 点击（**不碰窗口**），已拖拽 = 结束拖拽。
 *
 * 注意 `endDrag()` 只在**真的拖过**时才调用 —— 旧代码无条件调用，
 * 于是单击也走了一遍"开始拖 + 结束拖"。
 */
function onPointerUp(ev: PointerEvent): void {
  const g = leftGesture
  if (!g || ev.pointerId !== g.pointerId) return
  leftGesture = null
  try { (ev.target as HTMLElement).releasePointerCapture?.(ev.pointerId) } catch { /* ignore */ }

  if (g.dragging) {
    g.consumedClick = true
    // 拖拽结束后的 click 必须被吞掉，否则会紧接着触发一次"单击"
    suppressClickUntil = performance.now() + 400
    void endDrag()
    return
  }
  /**
   * **短按**：按规格只允许"很轻的视线/表情反馈或什么都不做"，
   * 绝不能移动窗口、缩放、重取景或改模型缩放。
   * 这里选择"什么都不做"——最安全，且没有副作用可验证。
   */
}

/** 手势取消（`pointercancel` / 失焦 / 窗口 blur）——必须清理，避免卡在拖拽态 */
function cancelGesture(): void {
  const g = leftGesture
  leftGesture = null
  if (g?.dragging) {
    suppressClickUntil = performance.now() + 400
    void endDrag()
  }
}

async function endDrag(): Promise<void> {
  if (!dragging) return
  dragging = false
  stage.value?.setDragging(false)
  try { await bridge.dragEnd() } catch (e) { app.reportFailure('拖拽结束失败', e) }
}

/** 拖拽后抑制一次 click（浏览器在 pointerup 后还会派发 click） */
function onClick(ev: MouseEvent): void {
  if (performance.now() < suppressClickUntil) {
    ev.preventDefault()
    ev.stopPropagation()
  }
}

/**
 * ★ 双击角色区域 = 打开对话框（本轮新增的第五个入口）。
 *
 * 三条纪律：
 *   ① **只落在角色上**才算（`isOnAvatar`，与拖拽门槛、命中区域同源）；
 *      点画布空白处双击不该冒出对话框；
 *   ② **不动 A11 的行为**：单击仍然只记录手势、什么都不做；
 *      双击只是浏览器在两次短按之后额外派发的一个事件，不改变 pointerdown/up 的处理；
 *   ③ 拖拽结束后的那次 click 会被 `suppressClickUntil` 吞掉，
 *      因此"拖完手一抖点了两下"也不会误开对话框。
 */
function onDoubleClick(ev: MouseEvent): void {
  if (performance.now() < suppressClickUntil) return
  if (!isOnAvatar(ev.clientX, ev.clientY)) return
  ev.preventDefault()
  ev.stopPropagation()
  if (app.conversationOpen) return
  void app.openConversation('dblclick')
}

function onContextMenu(ev: MouseEvent): void {
  // 右键单击角色 = 开合轮盘（与 F1 等价）
  ev.preventDefault()
  ev.stopPropagation()
  toggleWheel()
}

// ───────────────────────────────────────────────────── 生命周期

function onKeyDown(ev: KeyboardEvent): void {
  if (ev.key === 'F1') {
    ev.preventDefault()
    toggleWheel()
    return
  }
  if (menu?.isOpen() && menu.handleKey(ev)) ev.preventDefault()
}

onMounted(async () => {
  buildWheel()
  /**
   * ★ 把角色锚点**提供**给覆盖层（气泡）—— 依赖方向是单向的：
   *   AvatarStage → stage-bus ← SpeechBubble。
   *
   * 坐标系：返回**视口坐标**（画布坐标 + 画布的视口偏移）。
   * 为什么必须换算：pet 模式下画布铺满窗口、两者相同，但 panel 模式下画布左侧
   * 有侧边栏、上方有标题栏 —— 直接给画布坐标会让气泡偏到窗口外面去。
   * 覆盖层用 `position: fixed`（视口坐标），所以这一处换算就够了。
   */
  setAnchorProvider(() => {
    const s = stage.value
    const cv = canvas.value
    if (!s || !cv) return null
    const box = s.avatarAnchorBox() ?? s.avatarBox()
    if (!box) return null
    const r = cv.getBoundingClientRect()
    return { x: box.x + r.left, y: box.y + r.top, w: box.w, h: box.h }
  })
  await initStage()
  /**
   * panel 模式用**不透明清屏**，pet 模式用透明清屏。
   *
   * 依据（实测）：panel 模式的窗口本身就不透明，"透明 WebGL canvas 合成到透明窗口"
   * 这条路径只在 pet 模式才真正需要。把它限定在 pet 模式可以：
   *   ① 消除 panel 模式下一整类透明合成隐患（渲染内容不可见的典型成因）；
   *   ② 让 panel 模式的舞台背景与面板底色一致，观感更整；
   *   ③ 为"角色看不见"的对照实验提供一个开关（不透明可见 ⇒ 问题在合成而非取景）。
   */
  stage.value?.setOpaqueBackground(app.mode === 'panel', 0x151824)
  window.addEventListener('keydown', onKeyDown)
  /**
   * 手势必须能被**外部打断**：窗口失焦 / 页面隐藏时，`pointerup` 可能永远不来
   * （右键菜单、Alt+Tab、锁屏…），若不清理就会卡在"拖拽中"——
   * 表现为窗口跟着鼠标乱跑、设置无法保存（拖动期冻结写入）。
   */
  window.addEventListener('blur', cancelGesture)
  document.addEventListener('visibilitychange', cancelGesture)
  /**
   * 显式缩放的**唯一**入口：设置面板改了 `avatarScale` 才施加。
   * 单击 / 拖动 / 滚轮 / 轮盘 / 动作切换都**不**触发这里。
   */
  watch(() => app.settings?.avatarScale, (v) => {
    if (typeof v === 'number') stage.value?.setAvatarScale(v)
  })
  // 拖拽期间：主进程以 60Hz 回报**真实窗口位移**，直接驱动摇晃叠加层
  unsubscribe.push(bridge.onDragPos((p) => {
    if (p.dx || p.dy) stage.value?.onWindowDelta(p.dx, p.dy)
  }))
  // 动作事件的**唯一**来源：主进程推送的 StageCommand（renderer 不解析任何文本标记）
  unsubscribe.push(bridge.onStageCommand((cmd: StageCommand) => {
    app.applyStageCommand(cmd)
    const s = stage.value
    if (!s) return
    if (cmd.type === 'motion') {
      const m = cmd as MotionCommand
      s.requestMotion(m.motion, { once: m.once, fadeMs: m.fadeMs, interrupt: m.interrupt })
    } else if (cmd.type === 'emotion') {
      s.setEmotion(cmd.emotion, cmd.intensity, cmd.durationMs ?? null)
    } else if (cmd.type === 'speech') {
      // 口型由 TTS 音频驱动；此处先给出文本节奏的占位（阶段 2 接 TTS 后替换）
      s.setViseme('aa', 0.15)
    } else if (cmd.type === 'visibility' && cmd.target === 'wheel') {
      if (cmd.visible) menu?.show(anchorBox()); else menu?.hide()
    }
  }))
})

onBeforeUnmount(() => {  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('blur', cancelGesture)
  document.removeEventListener('visibilitychange', cancelGesture)
  // 注销锚点提供者：组件已卸载还留在总线上，气泡就会去读一个死掉的 Stage
  setAnchorProvider(null)
  for (const u of unsubscribe) u()
  unsubscribe = []
  if (boxRaf) cancelAnimationFrame(boxRaf)
  menu?.dispose()
  menu = null
  stage.value?.dispose()
  stage.value = null
})
</script>

<template>
  <div class="stage-root" :class="{ 'is-pet': app.mode === 'pet' }">
    <canvas
      ref="canvas"
      class="stage-canvas"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="cancelGesture"
      @lostpointercapture="cancelGesture"
      @click="onClick"
      @dblclick="onDoubleClick"
      @contextmenu="onContextMenu"
    />
    <div v-if="loading" class="stage-hint">正在加载角色…</div>
    <div v-if="modelError" class="stage-error" role="alert">
      <b>角色加载失败</b>
      <span>{{ modelError }}</span>
    </div>
    <!-- 轮盘宿主（DOM 覆盖层，与 Canvas 分离，便于独立命中区域上报） -->
    <div ref="wheelHost" class="wheel-host" />
  </div>
</template>
