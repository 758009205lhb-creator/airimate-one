<script setup lang="ts">
/**
 * apps/renderer/src/components/PetShell.vue —— **角色窗口**（pet / panel）的外壳
 *
 * ⚠ 2026-10-08 返工轮：本文件是从 `App.vue` 原样搬过来的（内容基本未变），
 *   唯一的**减法**是删掉了 `<ConversationDock/>`。
 *
 * 为什么必须删（根因，留档以免有人再加回来）：
 *   上一轮把「对话框」做成了这个窗口**内部贴底的 dock**，并把窗口从 340×420
 *   放大到 380×560 来腾地方。用户明确否决该形态：
 *   **聊天对话框与桌宠必须是两个完全独立的 BrowserWindow**。
 *   ⇒ 本窗口里**不得出现任何输入框、不得出现任何对话文字流水**（判据 §7.5）。
 *     聊天输入框只活在 `ChatWindow.vue` 里（`?surface=chat` 的第二个窗口）。
 *
 * 两种模式共用**同一个** renderer / Scene / VRM（PRD FR-1.3）：
 *   - `panel`：不透明面板（左侧管理面板，右侧角色舞台），自绘标题栏（窗口是 frame:false）；
 *   - `pet`  ：透明、无边框、紧凑桌宠形态（340×420），只留角色与轮盘。
 * 模式切换只切 CSS 类，不重建任何渲染对象。
 *
 * ⚠ 新增的 M1/M2 界面（向导覆盖层、主动气泡、记忆/日程/提醒页）**全部是加法**：
 *   `<AvatarStage/>` 始终无条件挂载在 `<main>` 里，没有任何 `v-if` / `v-show` 碰它 ——
 *   一旦它被卸载重建，角色会黑屏、Mixer/Scene 状态全丢。
 *
 * ⚠ 也**不许**把它搬进 chat 窗口：全应用 WebGLRenderer 总数恒为 1，
 *   第二个 `AvatarStage` 会立刻变成 2（判据 §7.2）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { PERMISSION_TIER_FLOOR } from '@airimate/shared'
import AvatarStage from './AvatarStage.vue'
import SettingsPanel from './SettingsPanel.vue'
import MemoryPanel from './MemoryPanel.vue'
import SchedulePanel from './SchedulePanel.vue'
import CapabilityPanel from './CapabilityPanel.vue'
import VoiceScreenPanel from './VoiceScreenPanel.vue'
import LearningPanel from './LearningPanel.vue'
import ToolConfirmDialog from './ToolConfirmDialog.vue'
import OnboardingWizard from './OnboardingWizard.vue'
import ProactiveToast from './ProactiveToast.vue'
import SpeechBubble from './SpeechBubble.vue'
import { useApp } from '../store'
import { lastBubbleAutoHideReading } from '../store'
import { bridge } from '../bridge'
import { getOverlayRects, getOverlayTicks, getOverlayProbes } from '../stage-bus'

const app = useApp()
/**
 * ★ 侧边栏标签页：**没有「聊天」**。
 *
 * 为什么没有而不是"有但隐藏"：主界面不再回放对话文字
 * （对话内容只出现在独立 chat 窗口里），留一个空的「聊天」页只会让人以为功能坏了。
 * 对话历史仍然照常写入 session-store / 记忆（数据层不删）。
 */
const tab = ref<'schedule' | 'reminder' | 'memory' | 'voice' | 'learning' | 'capability' | 'settings'>('schedule')

const isPet = computed(() => app.mode === 'pet')
const stageOk = computed(() => app.stageStatus.warnings.length === 0)

/** 阻断原因 → 状态栏用的人话（状态栏不做长解释，一句话就够） */
const BLOCK_TEXT: Record<string, string> = {
  none: '可打扰',
  'quiet-hours': '静音时段',
  fullscreen: '全屏中',
  game: '游戏',
  meeting: '会议中',
  focus: '专注模式',
  'user-silent': '已静默',
  disabled: '已关闭',
  cooldown: '冷却中',
}
const blockText = computed(() => {
  const r = app.activity?.blockReason
  if (!r) return ''
  return BLOCK_TEXT[r] ?? r
})

/** 提醒中心角标：只数主进程真给的队列/待确认条数 */
const inboxBadge = computed(() => (app.inbox?.queued.length ?? 0) + (app.inbox?.unacked.length ?? 0))

/**
 * 「学习」页角标：**待确认条数**（M4）。
 * 为什么要有它：低置信度内容只有用户点头才会写进记忆；
 * 如果界面上没有提示，那些"等她确认"的条目会永远躺在那里没人看见 ——
 * 表现就是"她好像学到了什么，但我不确定她到底学到了什么"。
 */
const learningBadge = computed(() => app.proactive?.pendingReflections ?? 0)

onMounted(async () => {
  await app.init()
  /**
   * ★★ **界面动作订阅**（2026-10-09 完善轮）。
   *
   * 对话窗口的菜单栏 / 托盘里的「记忆 / 日程与提醒 / 偏好设置 / 语音与麦克风」
   * 最终要落到**这个窗口**的侧边栏 `tab` 上 —— 而 `tab` 是本组件的局部状态，
   * 别的上下文（chat renderer / 主进程）读不到也改不了。
   * ⇒ 主进程广播一条 `evt:ui-action`，由这里落实。
   *
   * ⚠ 一律**先切到 panel 模式**再切页：pet 模式下侧边栏根本不渲染
   *   （`.shell--pet .side { display: none }`），只切 `tab` 的话用户看不到任何变化 ——
   *   那就是"点了没反应"。
   * ⚠ 订阅必须**返回的取消函数**在卸载时调用：不取消的话热重载/重挂载会累积监听，
   *   一次事件切多次页（表现是"切页偶尔跳到别处"）。
   */
  unsubscribeUiAction = bridge.onUiAction((r) => {
    switch (r.action) {
      case 'memory': void openView('memory'); break
      case 'schedule': void openView('schedule'); break
      case 'settings': void openView('settings'); break
      case 'voice': void openView('voice'); break
      /**
       * 「快捷键一览」/「关于」的**面板在对话窗口里**（那边才有那个界面），
       * 由 `ChatWindow.vue` 自己订阅同一条事件去打开 —— 这里**不能**再切页，
       * 否则同一件事会在两个窗口里各做一半。
       */
      case 'shortcuts':
      case 'about':
        break
      /** `pet-hidden` / `pet-shown` 由 store 统一处理（气泡与镜像），这里不重复 */
      default: break
    }
  })

  /**
   * 验收探针：**界面读数**（只读，不改任何状态）。
   *
   * 为什么需要它：状态栏徽标（"动作 N 待机"）读的是 store 的 getter，
   * 而 getter 与 manifest 契约字段名一旦不一致，徽标会显示 0 而**不报任何错**
   * （实测：`idleCount` 读 `semantic`/`id`，而契约收敛后是 `name`/`set` ⇒ 恒为 0）。
   * 只测后端 `motionStatus()` 抓不到这类"契约漂移"，必须直接读界面用的那个值。
   *
   * 一切取值都带兜底（`?? 0` / `?? null`），并且**全程只读**。
   */
  ;(window as unknown as { __AIRIMATE_UI_PROBE__?: (op: string) => unknown }).__AIRIMATE_UI_PROBE__ = (op: string) => {
    /**
     * ★ 探针专用：让气泡显示一条**短预览**，供"气泡显示中（含「看完整对话 →」入口）"
     *   这张桌面截图取景。
     *
     * ⚠ 为什么不用真实 TTS 驱动它：
     *   那条路要过主进程的朗读子进程与音频设备，而验收要的只是**界面那一刻的样子**。
     *   这里直接调 store 的 `showBubble()`（气泡唯一的显示入口），
     *   连带的"悬停暂停 / 点击展开 / 自动消失倒计时"全部照常生效。
     *   文案是固定的中性短句 —— **不含任何真实对话正文**（脱敏纪律）。
     */
    if (op === 'bubble') {
      try {
        const shown = app.showBubble('我在这儿呢，有事随时叫我～', { streaming: false })
        return { shown, chars: app.bubble.text.length, visible: app.bubble.visible }
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    }
    if (op === 'read') {
      try {
        /** 只有确定登记在硬下限表里的 kind 才认（store 里 kind 的类型是 string） */
        const permissionEffective: Record<string, string> = {}
        for (const p of app.permissions) {
          if (p.kind in PERMISSION_TIER_FLOOR) permissionEffective[p.kind] = p.effective
        }
        /**
         * ⚠ 返回值必须**可结构化克隆**。
         *
         * 实测踩到：`executeJavaScript` 把这里的对象送回主进程时会抛
         * `An object could not be cloned` —— 因为 Pinia state 是 Vue 的 **reactive 代理**，
         * 深拷贝/克隆会踩到代理与内部标记。后果很严重：探针**当场整体失败**。
         * 统一在出口处做一次 JSON 往返 ⇒ 只留纯数据，任何人怎么读都不会炸。
         */
        return JSON.parse(JSON.stringify({
          idleCount: app.idleCount,
          manifestCount: app.motion.manifests.length,
          manifestNames: app.motion.manifests.map(m => m.name).slice(0, 20),
          manifestSets: [...new Set(app.motion.manifests.map(m => m.set).filter(Boolean))] as string[],
          stageIdleTotal: app.stageStatus.idleTotal,
          clipIds: app.motion.clipIds.length,
          failed: app.motion.failed.length,
          /** 界面模式。`--mode=pet` 的 bug 是"窗口按 pet 建好了，界面却仍按 panel 渲染" */
          uiMode: app.mode,
          isPetLayout: isPet.value,
          settingsMode: app.settings?.mode ?? null,

          // ── M1 配置闭环
          onboardingStep: app.onboarding?.state.step ?? null,
          onboardingBlockedBy: app.onboarding?.blockedBy ?? null,
          onboardingSatisfied: app.onboarding?.satisfied ?? null,
          onboardingHint: app.onboarding?.hint ?? null,
          onboardingCompleted: app.onboarding?.completed ?? false,
          personaName: app.persona?.name ?? null,
          personaUserTitle: app.persona?.userTitle ?? null,
          providerCount: app.providers.length,
          providerLabels: app.providers.map(p => p.label),
          activeProviderId: app.providers.find(p => p.active)?.id ?? null,
          providerHasKey: app.providers.map(p => p.hasKey),
          providerKeyFingerprints: app.providers.map(p => p.keyFingerprint ?? null),
          scheduleCount: app.schedules.length,
          reminderCount: app.reminders.length,
          queuedCount: app.inbox?.queued.length ?? 0,
          unackedCount: app.inbox?.unacked.length ?? 0,
          permissionKinds: app.permissions.map(p => p.kind),
          permissionEffective,
          blockedPermissionCount: app.permissions.filter(p => p.effective === 'blocked').length,
          telemetryEnabled: app.settings?.telemetryEnabled ?? null,
          activityAvailable: app.activity?.available ?? null,

          // ── M1 记忆页（只给计数与查询串长度；**不给正文**）
          memoryResultCount: app.memoryHits.length,
          memoryQueryChars: app.memoryQuery.length,
          recallPreviewHits: app.recallPreview?.hits.length ?? null,
          recallPreviewInjectedChars: app.recallPreview?.injectedChars ?? null,

          // ── M2 主动陪伴
          proactiveEnabled: app.settings?.proactiveEnabled ?? null,
          proactiveRunning: app.proactive?.running ?? false,
          proactiveBlockReason: app.activity?.blockReason ?? null,
          lastProactiveKind: app.lastProactive?.kind ?? null,
          lastProactivePriority: app.lastProactive?.priority ?? null,
          radioDay: app.radio?.day ?? null,
          radioNewsCount: app.radio?.news.length ?? null,
          radioDisclosures: app.radio?.disclosures ?? [],
          ttsEnabled: app.settings?.ttsEnabled ?? null,

          // ── ★ 对话（返工轮）：判据的读数口
          /**
           * ⚠ `conversationOpen` / `chatVisible` 现在是**独立 chat 窗口**的可见性，
           *   不再有任何"窗口布局"读数 —— `conversationLayout` 字段**已删除**
           *   （它的 `'conversation'` 取值随 `WINDOW_GEOMETRY.conversation` 一起作废）。
           *   `bubbleVisible` / `bubbleTextChars` 让"气泡出现、TTF 结束后 3 秒消失"
           *   可以被机械测量（**只给字符数，不给内容**）。
           */
          conversationOpen: app.conversationOpen,
          chatVisible: app.conversationChat.visible,
          chatWindowId: app.conversationChat.id,
          chatCreatedCount: app.conversationChat.createdCount,
          /**
           * ★★ **桌宠菜单状态的桌面侧镜像**（2026-10-09 完善轮，判据 C4）。
           *
           * 三处菜单（对话窗口菜单栏 / 托盘 / 桌宠右键）的「☑ 桌宠常驻」必须完全同步。
           * 本字段是**第三处**的读数口：它与 `conversation-state` 里主进程那份
           * 逐字段比对，就能机械发现"某一处显示的是旧值"。
           */
          petMenuState: {
            resident: app.petResident,
            visible: app.petVisible,
            statusText: app.petStatusText,
          },
          bubbleVisible: app.bubble.visible,
          bubbleTextChars: app.bubble.text.length,
          ttsActive: app.ttsActive,

          // ── 对话的补充读数（判据需要，且都不含正文）
          composing: app.composing,
          listening: app.listening,
          ttsAskVisible: app.ttsAskVisible,
          bubbleExpanded: app.bubble.expanded,
          bubbleFullChars: app.bubble.fullText.length,
          bubbleAutoHide: lastBubbleAutoHideReading(),
          sendCount: app.sendCount,
          conversationHotkey: {
            accelerator: app.conversationHotkey.accelerator,
            enabled: app.conversationHotkey.enabled,
            registered: app.conversationHotkey.registered,
            error: app.conversationHotkey.error,
          },
          /**
           * ★ 返工轮的**分离判据读数口**（§7.5）：本窗口里到底有没有**对话**输入控件。
           *
           * 为什么必须分角色数（实测踩到的真实情况）：
           *   pet 窗口里确实有 4 个 `<input>`，但它们**全部来自首次运行向导**
           *   （baseUrl / 模型 / 密钥），是**配置**表单 —— 不是聊天输入框。
           *   用户的要求原文针对的是"聊天对话框"（贴底 dock / panel 浮层两种旧形态），
           *   所以硬判据是"**对话类**输入 = 0"，而不是"任何输入都没有"。
           *
           * 分类规则（可机械复核，不靠人认）：
           *   · 落在 `.wizard` / `.side`（向导与管理面板）里的 ⇒ 配置输入；
           *   · 其余 ⇒ 按**对话输入**计（宁严勿宽：多出一个没有归属的输入框会判失败）。
           * 只给计数与标签名，不含任何内容。
           */
          textInputs: (() => {
            const ins = Array.from(document.querySelectorAll('input, textarea'))
            const isConfig = (e: Element): boolean => e.closest('.wizard') !== null || e.closest('.side') !== null
            const config = ins.filter(isConfig)
            return {
              count: ins.length,
              tags: ins.map(e => e.tagName.toLowerCase()),
              conversationCount: ins.length - config.length,
              conversationTags: ins.filter(e => !isConfig(e)).map(e => e.tagName.toLowerCase()),
              configCount: config.length,
              /** 对话文字流水的容器（旧形态的 `.dock` / `.msg` 一个都不该有） */
              dockInDom: document.querySelector('.dock') !== null,
              msgInDom: document.querySelectorAll('.msg').length,
            }
          })(),
          /**
           * ★★ **覆盖层占用读数**（2026-10-08 的教训换来的一条判据）。
           *
           * 为什么必须有它：本轮我把"桌宠看不见了"误判成"pet 窗口不上屏"，
           * 根因其实是**首次运行向导是 `position:absolute; inset:0` 的全屏覆盖层**，
           * 把角色整个盖住了（`rgba(8,9,14,.72)` + 模糊）。
           *
           * ⚠ 而"屏幕上那条区域有没有角色"**不能**作为判据 —— 实测：
           *   只要用户开着全屏应用（游戏），`CopyFromScreen` 拍到的是**游戏的画面**，
           *   本应用的窗口在更低的合成层，**截图里根本看不到**。
           *   我因此对着"遮挡物的像素数"下过一次错误结论。
           *
           * ⇒ 判据改为**读自己的 DOM**：这一层是谁、占多大 —— 与屏幕合成无关，
           *   不论前台是什么应用都成立。只给选择器名与计数，不含任何内容。
           */
          overlays: (() => {
            const q = (sel: string): number => document.querySelectorAll(sel).length
            const box = (sel: string): { w: number, h: number } | null => {
              const el = document.querySelector(sel)
              if (!el) return null
              const r = el.getBoundingClientRect()
              return { w: Math.round(r.width), h: Math.round(r.height) }
            }
            const vp = { w: window.innerWidth, h: window.innerHeight }
            const wizardBox = box('.wizard')
            return {
              /** 视口尺寸（覆盖层"是否铺满"要跟它比） */
              viewport: vp,
              /** 首次运行向导：pet 模式下**必须**是 0（它会把角色整个盖住） */
              wizardCount: q('.wizard'),
              wizardBox,
              /** 向导是否铺满整个视口（铺满 = 角色不可见） */
              wizardCoversAll: !!wizardBox && wizardBox.w >= vp.w && wizardBox.h >= vp.h,
              /** 告警条 / 主动气泡 / 工具确认：pet 下允许存在（它们是局部的） */
              toastsCount: q('.toast'),
              proactiveCount: q('.ptoa'),
              toolConfirmCount: q('.confirm, .toolconfirm'),
              /** 角色舞台是否仍在（覆盖层问题的对照读数） */
              stageRootCount: q('.stage-root'),
              canvasCount: q('canvas'),
            }
          })(),
          /**
           * 覆盖层矩形（组件写进 `stage-bus`、由 AvatarStage 统一上报给主进程）。
           * `dock` 字段保留但**恒为 null**：那个覆盖层已经不存在了。
           */
          overlayRects: (() => {
            const r = getOverlayRects()
            return {
              dock: r.dock ? { ...r.dock } : null,
              bubble: r.bubble ? { ...r.bubble } : null,
              ticks: getOverlayTicks(),
              probes: getOverlayProbes(),
              dockInDom: document.querySelector('.dock') !== null,
            }
          })(),
        }))
      } catch (e) {
        // 探针自己崩了也必须看得见（返回 error 而不是让主进程拿到 null）
        return { error: e instanceof Error ? e.message : String(e) }
      }
    }
    return { error: 'unknown-op' }
  }
})

async function closeWindow(): Promise<void> {
  // 关闭按钮 = 隐藏窗口（不退出）；退出只能在托盘里
  try { await bridge.hide() } catch (e) { app.reportFailure('隐藏窗口失败', e) }
}

async function toggleMode(): Promise<void> {
  await app.setMode(isPet.value ? 'panel' : 'pet')
}

async function center(): Promise<void> {
  try { await bridge.center() } catch (e) { app.reportFailure('居中失败', e) }
}

/** 打开独立对话窗口（轮盘 / 托盘 / 快捷键 / 双击 / 气泡都走主进程那一条实现） */
async function openChat(): Promise<void> {
  await app.openConversation('bubble')
}

/**
 * ★ 切到某个管理页（`evt:ui-action` 的落点；2026-10-09 完善轮）。
 *
 * ⚠ **先切 panel 模式再切 `tab`**：pet 模式下 `.side` 是 `display:none`，
 *   只改 `tab` 用户什么都看不到 —— 那就是"点了没反应"。
 *   顺序反过来（先切页再切模式）在视觉上等价，但会有一帧"页已经变了、面板还没出来"。
 */
async function openView(next: 'memory' | 'schedule' | 'settings' | 'voice'): Promise<void> {
  if (isPet.value) await app.setMode('panel')
  tab.value = next
}

/** `evt:ui-action` 的取消订阅（卸载时必须调用，否则重挂载会累积监听、一次事件切多次页） */
let unsubscribeUiAction: (() => void) | null = null
onBeforeUnmount(() => { try { unsubscribeUiAction?.() } catch { /* ignore */ } })

/**
 * ★ **桌宠自身的右键菜单**（2026-10-09 完善轮）。
 *
 * 菜单项与动作**全部在主进程**（`ipc.ts` 的 `PET_MENU`）：
 * 里面有「重启应用 / 退出应用」，把这类能力交给渲染进程的界面层是没必要扩大的攻击面。
 * ⇒ 这里只上报"用户在我的窗口上右键了"，然后由主进程 `Menu.popup()` 弹出**原生**菜单。
 *
 * ⚠ 只在 **pet 模式**接管右键：panel 模式下窗口里有管理面板，
 *   用户右键的意图很可能是文本操作（复制/粘贴），抢走它会毁掉那个功能。
 */
function onContextMenu(ev: MouseEvent): void {
  if (!isPet.value) return
  ev.preventDefault()
  void bridge.petMenu().catch((e) => app.reportFailure('打开右键菜单失败', e))
}
</script>

<template>
  <div
    class="shell"
    :class="{ 'shell--pet': isPet, 'shell--panel': !isPet }"
    @contextmenu="onContextMenu"
  >
    <!-- 自绘标题栏：frame:false 下必须自己实现拖动与窗口按钮 -->
    <header v-if="!isPet" class="titlebar">
      <div class="titlebar__brand">
        <span class="dot" />
        <b>AiriMate One</b>
        <span class="titlebar__hint">右键角色或按 F1 呼出轮盘 · 左键拖动</span>
      </div>
      <div class="titlebar__actions">
        <button class="tbtn" title="打开对话窗口" @click="openChat">对话</button>
        <button class="tbtn" title="切换为桌宠模式" @click="toggleMode">桌宠</button>
        <button class="tbtn" title="移到屏幕中央" @click="center">居中</button>
        <button class="tbtn tbtn--danger" title="隐藏窗口（不退出）" @click="closeWindow">×</button>
      </div>
    </header>

    <!-- pet 模式：只有角色 + 一个极小的悬浮按钮（用于回到面板模式） -->
    <div v-if="isPet" class="pet-float">
      <button class="tbtn tbtn--mini" title="回到面板模式" @click="toggleMode">面板</button>
    </div>

    <main class="shell__body">
      <aside v-if="!isPet" class="side">
        <nav class="tabs">
          <button :class="{ 'is-on': tab === 'schedule' }" @click="tab = 'schedule'">日程</button>
          <button :class="{ 'is-on': tab === 'reminder' }" @click="tab = 'reminder'">
            提醒<span v-if="inboxBadge" class="tabs__dot">{{ inboxBadge }}</span>
          </button>
          <button :class="{ 'is-on': tab === 'memory' }" @click="tab = 'memory'">记忆</button>
          <button :class="{ 'is-on': tab === 'voice' }" @click="tab = 'voice'">语音</button>
          <button :class="{ 'is-on': tab === 'learning' }" @click="tab = 'learning'">
            学习<span v-if="learningBadge" class="tabs__dot">{{ learningBadge }}</span>
          </button>
          <button :class="{ 'is-on': tab === 'capability' }" @click="tab = 'capability'">能力</button>
          <button :class="{ 'is-on': tab === 'settings' }" @click="tab = 'settings'">设置</button>
        </nav>
        <!-- 「日程」与「提醒」共用 SchedulePanel：提醒中心就在同一页，拆成两个 tab 会让人来回找 -->
        <SchedulePanel v-if="tab === 'schedule' || tab === 'reminder'" />
        <MemoryPanel v-else-if="tab === 'memory'" />
        <!-- 「语音」= 语音 / 屏幕理解 / 三档权限 / 文件目录白名单（M3） -->
        <VoiceScreenPanel v-else-if="tab === 'voice'" />
        <!-- 「学习」= 每日自学习与待确认项（M4） -->
        <LearningPanel v-else-if="tab === 'learning'" />
        <!-- 「能力」= 适配层与许可边界的可读视图（M5 §1/§2/§3） -->
        <CapabilityPanel v-else-if="tab === 'capability'" />
        <SettingsPanel v-else />
      </aside>

      <section class="stage-slot">
        <!-- ⚠ 永远无条件挂载：单实例硬约束，任何 v-if/v-show 都会让角色重建 -->
        <AvatarStage />
      </section>
    </main>

    <!--
      ★ 气泡是 AvatarStage 的**兄弟节点**，用 v-if 控制显隐（在组件内部）。
      ⚠ 它**不在** `.stage-slot` 里，也不用 `v-if` 包住 AvatarStage ——
        任何"顺手把角色一起条件渲染"的改动都会让 VRM/Mixer 重建（PRD FR-1.3）。
      ⚠ 气泡里的「看完整对话 →」按钮是本窗口通往 chat 窗口的入口（对齐 DockPetWin 的做法）。
      ⛔ 本窗口**不得**再出现输入框与对话文字流水（返工轮判据 §7.5）。
    -->
    <SpeechBubble />

    <!-- 状态栏：只显示真实读数（未实现的项显式标注） -->
    <footer v-if="!isPet" class="statusbar">
      <span :class="['badge', stageOk ? 'badge--ok' : 'badge--warn']">
        {{ stageOk ? '舞台正常' : `舞台告警 ${app.stageStatus.warnings.length}` }}
      </span>
      <span class="badge">动作 {{ app.stageStatus.idleTotal }} 待机</span>
      <span class="badge">当前 {{ app.stageStatus.baseClipId ?? '—' }}</span>
      <span class="badge">{{ app.stageStatus.fps1s }} fps</span>
      <span class="badge">{{ app.stageStatus.heapMB }} MB</span>
      <!-- 主动引擎状态：running 与阻断原因都来自真实 store 值 -->
      <span :class="['badge', app.proactive?.running ? 'badge--ok' : 'badge--muted']">
        主动 {{ app.proactive?.running ? 'on' : 'off' }}
      </span>
      <span v-if="app.proactive?.queueLength" class="badge badge--warn">队列 {{ app.proactive.queueLength }}</span>
      <span v-if="blockText" class="badge badge--muted">{{ blockText }}</span>
      <span class="badge badge--muted">密钥后端 {{ app.backend }}</span>
    </footer>

    <!-- 主动事件气泡（被动展示：不抢焦点，role=status） -->
    <ProactiveToast />

    <!--
      首次运行向导：覆盖层，只是 AvatarStage 的兄弟节点，不会卸载它。
      ⛔ **pet 模式下不挂它**（2026-10-08 用户裁定）。
        理由（实测踩到、后果很重）：它是 `position:absolute; inset:0` 的**全屏覆盖层**
        （`rgba(8,9,14,.72)` + 模糊），在 340×420 的 pet 窗口里会把**角色整个盖住** ——
        桌宠的核心体验直接没了，用户的直观感受是"桌宠不见了"。
        而它的显示条件依赖主进程的 `onboarding.completed`（要求"供应商已配置 + 测试通过"），
        没有密钥的用户**永远**满足不了 ⇒ 覆盖层**永久驻留**。
        ⇒ 改为：pet 模式不渲染向导；配置入口在管理面板里（切到「面板」模式即可），
          并且向导现在有显式的「稍后再说」（见 `OnboardingWizard.vue` 的 `skip()`）。
        ⚠ 这里**只**条件渲染向导自己 —— 绝不包住 `<AvatarStage/>`（那会重建 VRM/Mixer）。
    -->
    <OnboardingWizard v-if="!isPet" />

    <!--
      工具确认弹窗（M3）：**无条件挂载**，内部用 v-if 控制显示。
      组件必须一直活着 —— 否则"来了确认请求但没人订阅"会让 needs-confirm 档的工具
      全部超时按拒绝（那是正确的失败方向，但不是我们要的体验）。
    -->
    <ToolConfirmDialog />

    <!-- 告警条：阻断级不可自动消失（禁止静默失败） -->
    <div class="toasts">
      <div v-for="a in app.alerts" :key="a.id" :class="['toast', `toast--${a.level}`]" role="alert">
        <div class="toast__head">
          <b>{{ a.title }}</b>
          <button class="tbtn tbtn--mini" @click="app.dismiss(a.id)">×</button>
        </div>
        <pre v-if="a.detail" class="toast__detail">{{ a.detail }}</pre>
      </div>
    </div>
  </div>
</template>
