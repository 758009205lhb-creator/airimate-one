<script setup lang="ts">
/**
 * apps/renderer/src/components/SpeechBubble.vue —— 角色头顶的对话气泡（本轮新增）
 *
 * 它**不是** `ProactiveToast.vue`：那个是主动事件的提示卡（可堆叠、常驻、有操作按钮），
 * 这个是"她正在说的这句话"，语义与生命周期都不同 —— 混用一个组件会让两边的规则互相打架。
 *
 * 冻结的规格（本轮，先冻结数值再做动画）：
 *   · 锚点：角色**固定包围盒**上沿（`avatarAnchorBox`，与轮盘同源），
 *     气泡底边距包围盒顶 **10px**，水平居中；角色动气泡跟着动，不许漂到脸上；
 *   · 尺寸：圆角 12px，背景 rgba(18,20,28,.86)，字号 14px，行高 1.5，
 *     左右 padding 12px，最多 3 行，超过 120 字截断并以「…」结尾；
 *   · 动效：出现 scale 0.94→1 + **120ms** 淡入；消失 **160ms** 淡出；
 *   · 驱动：**rAF**，禁止 CSS transition（与轮盘同一种驱动方式，规格 §四/§禁九）；
 *   · 生命周期：TTS 开始 → 出现；TTS 结束 + `bubbleAutoHideSec` 秒 → 消失；
 *     悬停暂停倒计时；点击展开全文，再次点击收起；同一时刻只允许一个气泡。
 *
 * 命中区域：可见时不透明度 ≥ 0.5 才上报（`stage-bus` → AvatarStage 的命中区域循环）。
 * 理由：正在淡出的气泡如果还占着命中区域，会在**看不见**的地方吃掉桌面点击，
 * 而 FR-7.7 要求"透明区域不得吞掉桌面点击"。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useApp } from '../store'
import { getAnchorBox, bumpOverlayTick, resolveOverlayEl, setOverlayProbe, setOverlayRect, toBox } from '../stage-bus'

const app = useApp()

/** 气泡底边距角色包围盒顶的距离（规格：8–12px，取中值） */
const ANCHOR_GAP_PX = 10
/** 进入 / 退出动效时长（毫秒；规格冻结值） */
const ENTER_MS = 120
const EXIT_MS = 160
/** 低于这个不透明度就不上报命中区域（见文件头注释） */
const HIT_OPACITY_FLOOR = 0.5

const root = ref<HTMLDivElement | null>(null)
/** 是否渲染（淡出结束后置 false；不是 v-show —— 淡出期间还要继续画） */
const render = ref(false)
/** rAF 驱动的动画量（**不用** CSS transition） */
const opacity = ref(0)
const scale = ref(0.94)
/** 定位（视口坐标 = 无边框窗口的窗口坐标） */
const left = ref(0)
const top = ref(0)

let raf = 0
let animFrom = 1
let animStart = 0
let animDur = ENTER_MS
let target = 0

const text = computed(() => app.bubble.text)

/** 起一段动画（from → target，dur 毫秒），由 rAF 推进 */
function animateTo(next: number, dur: number): void {
  animFrom = opacity.value
  animStart = performance.now()
  animDur = Math.max(1, dur)
  target = next
}

/**
 * 每帧：推进动画 + 跟随角色锚点 + 上报命中区域。
 *
 * 为什么跟随也放在 rAF 里（而不是 CSS 定位到锚点）：锚点随动作每帧变化，
 * 用 DOM 事件的时机去更新会滞后一帧以上，气泡就会"粘在脸上又慢慢飘开"。
 */
function tick(): void {
  raf = requestAnimationFrame(tick)
  bumpOverlayTick('bubble')

  // ① 动画推进（时间驱动，线性；规格只冻结了时长与起止值）
  const now = performance.now()
  const t = Math.min(1, (now - animStart) / animDur)
  opacity.value = animFrom + (target - animFrom) * t
  scale.value = 0.94 + 0.06 * (target === 0 ? 1 - t : t)

  if (target === 0 && t >= 1) {
    // 淡出完毕 ⇒ 真正卸载，并**停止上报**命中区域
    render.value = false
    setOverlayProbe('bubble', { hasEl: false, w: -1, h: -1, note: 'done' })
    setOverlayRect('bubble', null)
    return
  }

  // ② 跟随锚点：底边-居中贴在角色包围盒上沿
  /**
   * 元素来源与对话框一致：优先模板 ref，取不到时按**同一个选择器**兜底
   * （理由见 `stage-bus.resolveOverlayEl` 的说明）。
   */
  const { el, via } = resolveOverlayEl(root.value, '.bubble')
  const box = getAnchorBox()
  if (!el || !box) {
    setOverlayProbe('bubble', { hasEl: el !== null, w: -1, h: -1, via, note: el ? 'no-anchor' : 'no-el' })
    setOverlayRect('bubble', null)
    return
  }
  const w = el.offsetWidth
  const h = el.offsetHeight
  setOverlayProbe('bubble', {
    hasEl: true, w, h, via,
    note: `op=${Math.round(opacity.value * 100)} target=${target}`,
  })
  const cx = box.x + box.w / 2
  const bottomY = box.y - ANCHOR_GAP_PX
  const vw = window.innerWidth
  // 收夹：气泡不许出窗口（贴边时仍保持完整可读），也不许盖到角色的脸以下
  const x = Math.min(Math.max(cx, w / 2 + 6), Math.max(w / 2 + 6, vw - w / 2 - 6))
  const y = Math.max(h + 4, bottomY)
  left.value = Math.round(x)
  top.value = Math.round(y)

  // ③ 命中区域（只有"看得见"的时候才算可点区域）
  if (render.value && opacity.value >= HIT_OPACITY_FLOOR && w > 0 && h > 0) {
    setOverlayRect('bubble', toBox({ x: x - w / 2, y: y - h, width: w, height: h }))
  } else {
    setOverlayRect('bubble', null)
  }
}

onMounted(() => {
  raf = requestAnimationFrame(tick)
})

onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf)
  setOverlayRect('bubble', null)
})

/** 显示 ⇒ 进入动画；隐藏 ⇒ 退出动画（**同一时刻只有一个气泡**，由 store 保证） */
watch(() => app.bubble.visible, (visible) => {
  if (visible) {
    render.value = true
    animateTo(1, ENTER_MS)
  } else {
    animateTo(0, EXIT_MS)
  }
})

/** 文本变化（流式预览刷新）时只重排，不重启动画 —— 否则气泡会一直闪 */
watch(() => app.bubble.text, () => { /* 位置由 rAF 每帧重算，这里刻意什么都不做 */ })
</script>

<template>
  <!-- v-if 只包自己：AvatarStage 是它的兄弟节点，任何情况下都不受影响 -->
  <div
    v-if="render"
    ref="root"
    class="bubble"
    :class="{ 'bubble--expanded': app.bubble.expanded }"
    :style="{
      left: `${left}px`,
      top: `${top}px`,
      opacity: String(opacity),
      transform: `translate(-50%, -100%) scale(${scale})`,
    }"
    role="status"
    :title="app.bubble.expanded ? '点击收起' : '点击展开全文'"
    @mouseenter="app.setBubbleHover(true)"
    @mouseleave="app.setBubbleHover(false)"
    @click="app.toggleBubbleExpanded()"
  >
    <span class="bubble__text">{{ text }}</span>
    <!-- 展开态给一个明确的收起入口，避免用户不知道还能点回去 -->
    <span v-if="app.bubble.expanded" class="bubble__hint">点击收起</span>
    <span v-else-if="app.bubble.streaming" class="bubble__hint">正在说…</span>
    <!--
      ★ 「看完整对话 →」：本窗口通往**独立 chat 窗口**的入口（返工轮新增）。
      对齐参考实现 DockPetWin 的做法（`ShowBubble(text, ("看完整对话", …))`），
      但那条实现有个真实缺陷：它调的是 `agentChatWindow?.Activate()`，
      窗口**还没创建**时按了等于什么都没发生（`?.` 静默吞掉）。
      这里改成走**唯一入口** `app.openConversation('bubble')` —— 主进程会负责
      "没建就建、已建就聚焦"，所以第一句话之后就能立刻点开。
      `-webkit-app-region` 无关：气泡本身不吃拖动（窗口拖动在角色画布上）。
    -->
    <button
      class="bubble__more"
      title="打开完整的对话窗口"
      @click.stop="app.openConversation('bubble')"
    >看完整对话 →</button>
  </div>
</template>
