/**
 * apps/renderer/src/store.ts —— 应用状态（Pinia）
 *
 * 纪律：这里是 renderer 侧唯一的状态真源；所有跨进程调用都经 `bridge`（统一错误处理）。
 *       动作事件**只**由主进程推送的 `StageCommand` 驱动，renderer 不解析任何文本标记。
 */
import { defineStore } from 'pinia'
import type {
  Alert, ChatMessage, MotionClipManifest, SettingsPatch, StageCommand, AppSettings, WindowMode,
  ProviderPublic, OnboardingStatus, OnboardingStep, Persona, ProactiveEvent, ProactiveStatus,
  ProactiveInbox, QuietHours, ReminderPolicy, Reminder, Schedule, ActivityDayStats, ActivityState,
  RadioContent, MemoryRecallHit, ConversationSource, ConversationState, ChatWindowState,
} from '@airimate/shared'
import { bridge, BridgeError } from './bridge'

/**
 * renderer 侧看到的供应商视图。
 * 直接用契约里的 `ProviderPublic`（**已保证不含密钥材料**），再补一个 `active` ——
 * `active` 由主进程的 `provider:list` 单独给出，不在 `ProviderPublicSchema` 里。
 */
export type ProviderView = ProviderPublic & { active?: boolean }

export interface ToastItem {
  id: string
  level: 'info' | 'warn' | 'error'
  title: string
  detail?: string
  blocking: boolean
  at: number
}

export interface AvatarEntry {
  id: string
  label: string
  path: string
  sha256?: string
  license?: string
  redistributable?: boolean
}

/**
 * 对话气泡。
 *
 * ⚠ **同一时刻只允许存在一个气泡** —— 所以它是**一个对象**而不是一个数组。
 *   规格的这条约束不是洁癖：两个气泡会互相重叠、遮住角色的脸，
 *   而"点击展开全文"在多个气泡上也没有唯一语义。
 */
export interface BubbleState {
  visible: boolean
  /** 当前**展示**的文本（未展开时是截断后的；展开后是全文） */
  text: string
  /** 全文（不含截断；探针只给字符数，不给内容） */
  fullText: string
  /** 展开态（点击切换） */
  expanded: boolean
  /** 鼠标是否悬停（悬停暂停自动消失倒计时） */
  hovered: boolean
  /** 是否处于"她还在生成"阶段（此时显示最后一句短预览，不逐字刷屏） */
  streaming: boolean
  updatedAt: number
}

const EMPTY_BUBBLE: BubbleState = {
  visible: false, text: '', fullText: '', expanded: false, hovered: false, streaming: false, updatedAt: 0,
}

/** 气泡展示上限（规格 §四：超过按 120 字截断并以「…」结尾） */
export const BUBBLE_MAX_CHARS = 120

/**
 * ★ 最近一次**自动消失**的精确读数（本轮验收判据的直接读数）。
 *
 * 为什么要在实现内部量一次（而不是只靠外面轮询）：
 *   判据是"TTS 结束后 3±0.5 秒消失"，而外面的探针只能按采样周期（实测 60ms 轮询
 *   + `executeJavaScript` 往返，实际周期常常 150–350ms）去"看见"两个时刻 ——
 *   两次观测各自最多滞后一个采样周期 ⇒ 差值可以少掉几百毫秒，
 *   于是一条**正确的实现**会被测成 2.45s 而判失败（实测就是这么发生的）。
 *   所以：内部量精确值作为**判据**，外部量作为**旁证**并如实带上采样周期。
 * 只在"TTS 结束 → 定时器到点自动消失"这条路径上写，手动关闭/清空不会污染它。
 */
let lastAutoHide: { ttsEndedAt: number, hiddenAt: number, delayMs: number, targetMs: number } | null = null

export function lastBubbleAutoHideReading(): typeof lastAutoHide {
  return lastAutoHide ? { ...lastAutoHide } : null
}

/**
 * 从一段文本里取"最后一句"（流式预览用）。
 *
 * 为什么是"最后一句"而不是全文或最后 N 字：
 *   · 全文 —— 生成过程中每来一个 token 就整段重排，视觉上像在刷屏；
 *   · 固定 N 字 —— 会把一个词从中间切开（中文尤其难看）；
 *   · 按句读切分最接近"她正在说的这一句"，且切点稳定。
 */
export function lastSentence(text: string): string {
  const t = text.replace(/\s+$/g, '')
  if (!t) return ''
  const parts = t.split(/(?<=[。！？!?；;\n])/)
  for (let i = parts.length - 1; i >= 0; i--) {
    const s = parts[i]?.trim()
    if (s) return s
  }
  return t
}

/** 按上限截断并以「…」结尾（**只在真的截断时**才加省略号） */
export function truncateBubble(text: string, max = BUBBLE_MAX_CHARS): string {
  const t = text.trim()
  if (t.length <= max) return t
  return `${t.slice(0, max)}…`
}

interface State {
  ready: boolean
  mode: WindowMode
  settings: AppSettings | null
  alerts: ToastItem[]
  chat: ChatMessage[]
  streaming: { requestId: string, text: string } | null
  motion: { manifests: MotionClipManifest[], failed: string[], clipIds: string[] }
  avatar: AvatarEntry | null
  wheelOpen: boolean
  stageStatus: { stageId: string, baseClipId: string | null, idleTotal: number, dragging: boolean, warnings: string[], fps1s: number, heapMB: number }
  lastError: string | null
  autoStart: boolean
  backend: string
  /**
   * 供应商列表。**出参永不含密钥**：主进程只给 `hasKey` / `keyFingerprint` / `keyLength`
   * （见 `ProviderPublicSchema`），renderer 拿到的信息足以判断"配没配、是不是同一把钥匙"，
   * 但**无法还原密钥**。
   */
  providers: ProviderView[]
  /** 主进程回报的"正在朗读"状态（`evt:tts-state`） */
  speaking: boolean
  /** 本机可用声音（设置面板懒加载；`null` = 未加载） */
  ttsVoices: Array<{ id: string, label: string, lang: string, gender: string | null }> | null

  // ── M1 配置闭环
  /** 首次运行向导状态（每一步是否满足由**主进程**判定） */
  onboarding: OnboardingStatus | null
  persona: Persona | null
  /** 聊天历史是否已加载（避免重复拉取） */
  chatLoaded: boolean

  // ── M2 主动陪伴
  schedules: Schedule[]
  reminders: Reminder[]
  quiet: QuietHours | null
  reminderPolicy: ReminderPolicy | null
  permissions: Array<{
    kind: string, label: string, tier: string, effective: string, enabled: boolean,
    pathAllowlist: string[], redactExcluded?: boolean, updatedAt: number, grantedBy: string
  }>
  activity: (ActivityState & { blocked: boolean }) | null
  activityToday: ActivityDayStats | null
  activityAdvice: string[]
  proactive: ProactiveStatus | null
  inbox: ProactiveInbox | null
  /** 最新一条主动事件（气泡/提醒卡片显示）；`null` = 无 */
  lastProactive: ProactiveEvent | null
  /** 主动事件历史（本次会话内；最多 20 条，供提醒中心回看） */
  proactiveLog: ProactiveEvent[]
  radio: RadioContent | null
  /** 记忆检索结果（记忆页） */
  memoryHits: MemoryRecallHit[]
  memoryQuery: string
  /** 召回预览（"这句话会让我想起什么" + 真正注入的文本） */
  recallPreview: { query: string, hits: MemoryRecallHit[], injectedBlock: string | null, injectedChars: number } | null

  // ── ★ 对话（返工轮）：**独立 chat 窗口** + 语音说话
  /**
   * 对话窗口是否打开（= 可见）。**真源在主进程**（托盘 / 全局快捷键 / 语音唤醒都从那边发起），
   * 这里只是它广播过来的镜像 —— 千万不要在 renderer 里自己翻转它。
   */
  conversationOpen: boolean
  /**
   * **pet 窗口自己**的形态（`panel` / `pet`）。
   *
   * ⚠ 返工轮：取值里的 `'conversation'` **已删除**（那个值表示"pet 窗口被放大到
   *   380×560 的对话态"，而"打开对话就改 pet 窗口尺寸"的做法已被用户否决）。
   *   这个字段现在与"对话窗口开没开"**完全无关**。
   */
  conversationLayout: 'panel' | 'pet'
  /**
   * 独立 chat 窗口的只读读数（hwnd / 可见性 / 是否置顶 / 创建次数 / 几何来源）。
   *
   * 为什么要在 renderer 里存一份：判据要求"重复打开只复用同一个窗口（hwnd 不变）"，
   * 而这件事**只有主进程能观测**；把它镜像过来，界面探针（`__AIRIMATE_UI_PROBE__`）
   * 就能在没有额外 IPC 的情况下读到 —— 探针少一条通道，就少一处可能漂移的契约。
   */
  conversationChat: ChatWindowState
  /** 主进程回报的快捷键状态（含**注册失败原因**，不许静默） */
  conversationHotkey: { accelerator: string, enabled: boolean, registered: boolean, error: string | null }
  /**
   * ★★ **桌宠常驻与可见性**的镜像（2026-10-09 完善轮）。
   *
   * 与 `conversationOpen` 同一条纪律：**真源在主进程**，这里只存广播过来的值 ——
   * renderer 绝不自己翻转它（否则三处菜单会各自显示不同的勾选态，
   * 而那正是 C4 要防的"勾选和窗口对不上"）。
   */
  petResident: boolean
  /** 桌宠窗口**此刻**是否可见（`false` 不等于"用户取消了常驻"） */
  petVisible: boolean
  /** 托盘 tooltip 用的同一份人话状态（主进程给的，界面不自己拼） */
  petStatusText: string
  /**
   * ★ 应用版本 / 契约版本（「帮助 → 关于」用；来自 preload 的只读字段）。
   * 放在 state 里而不是每次现读 `window.airimate`：renderer 只允许 `bridge.ts`
   * 接触那个对象（见 `bridge.ts` 的文件头纪律）。
   */
  appVersion: string
  contractVersion: string
  /** 输入法正在合成（中文候选期间 Enter 不得发送） */
  composing: boolean
  /** 正在听写（`voice:listen-once` 在飞；界面上必须能看出来麦克风是活的） */
  listening: boolean
  /** 本轮对话里是否已经问过"要不要开朗读"（问过就不再打扰） */
  ttsAskVisible: boolean
  /** TTS 是否正在朗读（气泡生命周期依赖它） */
  ttsActive: boolean
  /** 气泡（同一时刻只有一个） */
  bubble: BubbleState
  /** 统一的发送链调用次数（探针读数：证明对话框真的接上了同一条链） */
  sendCount: number
}

let toastSeq = 0

/**
 * 气泡的定时器与状态机（**模块级**，不进 Pinia）。
 *
 * 为什么不放 state：定时器句柄不是可序列化的状态（pinia 的 state 会被 devtools /
 * 结构化克隆碰到，本项目已踩过"reactive 代理无法克隆"的坑）；
 * 而且"谁在计时"必须唯一 —— 放进 state 就可能被两个组件各存一份。
 */
let bubbleHideTimer: ReturnType<typeof setTimeout> | null = null
/** 最近一次 TTS 结束的时刻（自动消失延时的起点；`null` = 还没有过） */
let bubbleTtsEndedAt: number | null = null

function clearBubbleTimer(): void {
  if (bubbleHideTimer) { clearTimeout(bubbleHideTimer); bubbleHideTimer = null }
}

export const useApp = defineStore('app', {
  state: (): State => ({
    ready: false,
    mode: 'panel',
    settings: null,
    alerts: [],
    chat: [],
    streaming: null,
    motion: { manifests: [], failed: [], clipIds: [] },
    avatar: null,
    wheelOpen: false,
    stageStatus: { stageId: '-', baseClipId: null, idleTotal: 0, dragging: false, warnings: [], fps1s: 0, heapMB: 0 },
    lastError: null,
    autoStart: false,
    backend: 'unknown',
    providers: [],
    speaking: false,
    ttsVoices: null,
    onboarding: null,
    persona: null,
    chatLoaded: false,
    schedules: [],
    reminders: [],
    quiet: null,
    reminderPolicy: null,
    permissions: [],
    activity: null,
    activityToday: null,
    activityAdvice: [],
    proactive: null,
    inbox: null,
    lastProactive: null,
    proactiveLog: [],
    radio: null,
    memoryHits: [],
    memoryQuery: '',
    recallPreview: null,
    conversationOpen: false,
    conversationLayout: 'panel',
    conversationChat: {
      id: null, visible: false, focused: false, minimized: false, bounds: null,
      alwaysOnTop: false, createdCount: 0, readyToShow: false, boundsSource: null,
    },
    conversationHotkey: { accelerator: '', enabled: false, registered: false, error: null },
    petResident: false,
    petVisible: false,
    petStatusText: '',
    appVersion: '',
    contractVersion: '',
    composing: false,
    listening: false,
    ttsAskVisible: false,
    ttsActive: false,
    bubble: { ...EMPTY_BUBBLE },
    sendCount: 0,
  }),

  getters: {
    hasBlockingAlert: (s): boolean => s.alerts.some(a => a.blocking),
    /**
     * 待机动作数量（状态栏徽标"动作 N 待机"的读数）。
     *
     * ⚠ 这里曾按 `m.semantic` / `m.id` 取字段 —— 但 manifest 契约在收敛后
     * （见 `MotionClipManifestSchema` 的注释：早期自造字段与管线产物不一致）
     * 用的是 `name` / `set`。于是这个 getter **恒为 0**，界面上永远显示"0 待机"，
     * 而实际有 10 个。类型检查（`npm run typecheck`）把它抓了出来。
     *
     * 判定口径与 `motion-runtime.load()` 保持一致：`set === 'idle'` 或名字里含 idle。
     */
    idleCount: (s): number => s.motion.manifests.filter(m =>
      m.set === 'idle' || /idle/i.test(m.name)).length,
    stageWarnings: (s): string[] => s.stageStatus.warnings,
  },

  actions: {
    toast(level: ToastItem['level'], title: string, detail?: string, blocking = false): void {
      toastSeq += 1
      const item: ToastItem = { id: `t${toastSeq}`, level, title, detail, blocking, at: Date.now() }
      this.alerts.push(item)
      if (this.alerts.length > 12) this.alerts.shift()
      // 非阻断的 8 秒后自动消失；阻断级必须手动关闭
      if (!blocking) setTimeout(() => this.dismiss(item.id), 8000)
    },

    dismiss(id: string): void {
      this.alerts = this.alerts.filter(a => a.id !== id)
    },

    async init(): Promise<void> {
      /**
       * ★ 版本读数（「帮助 → 关于」用）：来自 preload 的**只读**常量。
       *   放在 init 最前面 —— 它们不依赖任何 IPC，读不到也只是显示 `—`。
       */
      try {
        this.appVersion = bridge.appVersion()
        this.contractVersion = bridge.contractVersion()
      } catch { /* 读不到就留空，界面显示 '—' */ }
      // 事件订阅（只订阅一次）
      bridge.onAlert((a: Alert) => {
        this.toast(a.level, a.title, a.detail, a.blocking)
        if (a.level === 'error') this.lastError = a.title
      })
      bridge.onModeChanged((e) => { this.mode = e.mode })
      bridge.onSettingsChanged((s) => { this.settings = s })
      /**
       * ★ 流式增量（`evt:chat-delta` 是**广播**给两个窗口的，各取所需）：
       *   · chat 窗口：把增量渲染成正在生成的那一段（`ChatWindow.vue` 读 `streaming`）；
       *   · pet 窗口：把它压成"她正在说的这一句"喂给头顶气泡（不逐字刷屏）。
       * 两个窗口各自维护自己的 `streaming`，互不影响 —— 这**不是**两条生成链路，
       * 请求本身只有一条（主进程的会话层），这里只是同一份数据的两种呈现。
       */
      bridge.onChatDelta((d) => {
        if (!this.streaming || this.streaming.requestId !== d.requestId) this.streaming = { requestId: d.requestId, text: '' }
        this.streaming.text += d.delta
        /**
         * ★ 流式期间气泡只显示**最后一句短预览**，不逐字刷屏（规格 §五）。
         * 依据：整段重排会让气泡每来一个 token 就跳一次，看起来像故障；
         * 而"她正在说的那一句"才是用户此刻关心的信息。
         */
        if (this.settings?.bubbleEnabled ?? true) {
          const preview = lastSentence(this.streaming.text)
          if (preview) this.showBubble(preview, { streaming: true })
        }
      })
      bridge.onChatDone((d) => {
        /**
         * ★ 2026-10-08 返工轮：**去重**。
         *
         * 现在有**两个** renderer 都订阅 `evt:chat-done`（pet 要驱动气泡、
         * chat 要落最后一段），而事件是广播给全部窗口的 ⇒ 如果两边都无条件
         * `push` 一条助手消息，**每次回复都会出现两条一模一样的**。
         *
         * 去重键用 `requestId`（主进程给的那一个，幂等且全局唯一）：
         *   · 本窗口发起的请求 ⇒ 内存里已有占位消息 ⇒ **原地更新**，不新增；
         *   · 另一个窗口发起的请求（主进程也会广播过来）⇒ 本地没有 ⇒ 追加一条。
         * 这样两个窗口的历史始终一致，且各自都只看到一条。
         */
        const ph = this.chat.findIndex(m => m.role === 'assistant' && m.id === `r${d.requestId}`)
        if (ph >= 0) {
          const cur = this.chat[ph]!
          this.chat.splice(ph, 1, { ...cur, text: d.text, commands: d.commands, createdAt: Date.now() })
        } else {
          this.chat.push({
            id: `r${d.requestId}`, role: 'assistant', text: d.text,
            createdAt: Date.now(), commands: d.commands, origin: 'user',
          })
        }
        this.streaming = null
        /**
         * ★ 语音合成（TTS）挂载点 —— **回复文本说出口**。
         *
         * 纪律：
         *   · renderer **不**做任何合成，只调 `tts:speak`；进程与音频都在主进程；
         *   · 受设置 `ttsEnabled` 控制（默认关闭，见 `AppSettingsSchema`）；
         *   · 被 `/stop` 中断的回复不朗读（`aborted`）——用户明确表示不想听；
         *   · 只朗读 `displayText`（动作标记已由主进程剥离），不让 SAPI 念出 `[motion:wave]`；
         *   · 失败**不**弹阻断告警（朗读是增强，坏掉不该打断对话），只记 lastError。
         */
        const willSpeak = (this.settings?.ttsEnabled ?? false) && !d.aborted && d.text.trim().length > 0
        if (willSpeak) {
          // utteranceId 与请求同源，便于把 evt:tts-state 关联回这一轮回复
          this.speaking = true
          this.ttsActive = true
          void bridge.speak(d.text, `utt-${d.requestId}`)
            .catch((e) => { this.lastError = e instanceof Error ? e.message : String(e) })
            .finally(() => { this.speaking = false; this.ttsActive = false })
        }
        /**
         * 气泡（本轮）：有 TTS 时**等朗读结束**再倒计时（"她说完之后 3 秒消失"）；
         * 没有 TTS 时（朗读关着或被中断）直接按同一时长倒计时 ——
         * 否则气泡会永远挂在那里（那也是一种"说不清什么时候该消失"的坏状态）。
         */
        if (this.settings?.bubbleEnabled ?? true) {
          if (this.showBubble(d.text)) {
            if (!willSpeak) this.scheduleBubbleHide()
          }
        }
      })
      // 主进程回报朗读生命周期（start/end/error）——UI 的"正在说话"状态真源
      bridge.onTtsState((s) => {
        if (s.state === 'start') {
          this.speaking = true
          this.ttsActive = true
          // 朗读开始 ⇒ 气泡出现（规格 §四的生命周期起点）；取消待消失的倒计时
          if (this.bubble.visible) clearBubbleTimer()
        } else {
          this.speaking = false
          this.ttsActive = false
          if (s.error) this.lastError = s.error
          /**
           * TTS 结束 + `bubbleAutoHideSec` 秒 ⇒ 气泡消失（本轮的核心判据之一）。
           * 只在朗读**真的结束**（end/error）时排程，避免"没开始就结束"的空排程。
           */
          bubbleTtsEndedAt = Date.now()
          this.scheduleBubbleHide()
        }
      })
      /**
       * ★ 对话窗口开合（返工轮）：托盘 / 全局快捷键 / 语音唤醒都是**主进程发起**的入口，
       *   没有这条订阅，界面就不知道对话窗口已经被打开了（静默失效的典型形态）。
       *
       * ⚠ 只在"关掉对话窗口**且**当前没有在朗读"时才收起气泡：
       *   朗读是气泡生命周期的起点，如果关窗那一刻 TTS 还在跑，
       *   立刻把气泡抹掉会让"她说到一半突然闭嘴"——那比多显示两三秒更糟。
       *   让它在朗读结束后按 `bubbleAutoHideSec` 正常消失。
       */
      bridge.onConversationState((s) => {
        const wasOpen = this.conversationOpen
        this.applyConversationState(s)
        if (s.open && !wasOpen) this.maybeAskAutoTts()
        if (!s.open && wasOpen && !this.ttsActive) this.hideBubble()
      })
      /** ★ 唤醒词 → 打开对话框并**进入"听"状态**（复用已有的 voice:listen-once） */
      bridge.onConversationListen(() => { void this.listenOnce() })
      /**
       * ★★ **桌宠菜单状态快照**（2026-10-09 完善轮）。
       *
       * 为什么单独订阅它（`evt:conversation-state` 里已经带了 `pet`）：
       *   常驻/可见性的变化**可能不与对话状态同频**（例如托盘勾选常驻时
       *   对话窗口根本没开，`conversation:state` 也会发，但这条更直接）。
       *   两条都写同一组字段 ⇒ 无论哪条先到，最终值一致（幂等）。
       */
      bridge.onPetMenuState((p) => {
        this.petResident = p.resident === true
        this.petVisible = p.visible === true
        this.petStatusText = p.statusText ?? ''
      })
      /**
       * ★★ **界面动作**（main → pet 窗口）—— 2026-10-09 完善轮。
       *
       * 两类载荷，都从**这一处**分派（避免两个窗口各写一份 if）：
       *   · `pet-hidden` / `pet-shown` —— 桌宠被收回/呼出。
       *     收回时必须把**只有 renderer 做得了**的那部分干净态落实：
       *     气泡收起（看不见的窗口挂着气泡 = 下次呼出"带着旧气泡"出现）。
       *     命中区域那一半在主进程做（见 `pet-visibility.ts` 的 `announceVisibility`）。
       *   · 视图类（memory/schedule/settings/voice/shortcuts/about）——
       *     由 `PetShell.vue` 订阅同一个事件去切页；这里不处理（各管各的）。
       */
      bridge.onUiAction((r) => {
        if (r.action === 'pet-hidden') {
          this.hideBubble()
          this.wheelOpen = false
          this.petVisible = false
        } else if (r.action === 'pet-shown') {
          this.petVisible = true
        }
      })
      bridge.onChatError((e) => {
        this.streaming = null
        this.toast('error', '回复失败', `${e.code}: ${e.message}`, false)
      })
      /**
       * ★ M2：引擎送达的主动事件。
       * renderer **不做任何判定**（是否该打扰由主进程的 blocker 决定，见 blocker.ts）；
       * 这里只负责：记日志、更新提醒中心、把内容显示出来。
       * `focus` 恒为 false ⇒ **永不抢焦点**；`speak` 已由主进程按静音/阻断判定过。
       */
      bridge.onProactive((e) => {
        this.lastProactive = e
        this.proactiveLog = [e, ...this.proactiveLog].slice(0, 20)
        if (e.kind === 'morning-radio' && e.payload && typeof e.payload === 'object' && 'radio' in (e.payload as Record<string, unknown>)) {
          this.radio = (e.payload as Record<string, unknown>).radio as RadioContent
        }
        // 提醒类事件在聊天流里也留一条（origin 已由主进程标注），这样"她主动说的"能回看
        this.chat.push({
          id: `p${Date.now().toString(36)}`,
          role: 'assistant',
          text: e.text,
          createdAt: e.at,
          commands: [],
          origin: e.kind === 'morning-radio' ? 'radio' : 'proactive',
        })
        void this.loadInbox()
      })
      bridge.onActivity((a) => {
        this.activity = { ...a, blocked: a.blocked }
      })
      bridge.onReminderQueue((q) => {
        if (this.inbox) this.inbox = { ...this.inbox }
        void q
      })

      try {
        const s = await bridge.getSettings()
        this.settings = s.settings ?? null
        this.mode = s.settings?.mode ?? 'panel'
        const st = await bridge.startupGet()
        this.autoStart = st.enabled === true
      } catch (e) {
        this.reportFailure('读取设置失败', e)
      }
      /**
       * 供应商 + 密钥后端状态。
       *
       * ⚠ 必须在 init 里真的拉一次：`state.backend` 一直存在、也被界面读（"密钥后端 xxx"），
       * 但**从来没有人给它赋过值** ⇒ 截图里永远显示 `unknown`（实测：真实值是 `safeStorage`）。
       * 默认值 `'unknown'` 保留，语义是"还没问到"，不是"没有后端"。
       */
      await this.loadProviders()
      /**
       * ★ M1：把配置闭环需要的东西一次拉齐（向导 / 人设 / 历史）。
       * 这里不再逐个 try —— `loadXxx` 内部已各自 reportFailure（失败必须可见），
       * 外层再包一层只会把错误吞成"什么也没发生"。
       */
      await Promise.all([
        this.loadOnboarding(),
        this.loadPersona(),
        this.loadChat(),
        this.loadQuiet(),
        this.loadPermissions(),
        this.loadSchedules(),
        this.loadReminders(),
      ])
      this.chatLoaded = true
      /**
       * ★ 对话初始状态（本轮）：主动拉一次，见 `refreshConversationState` 的说明。
       * 放在最后 —— 它内部会读 `settings`（判断要不要问"开朗读"），设置必须先到位。
       */
      await this.refreshConversationState()
      this.ready = true
    },

    async loadProviders(): Promise<void> {
      try {
        const r = await bridge.listProviders()
        this.backend = r.backend ?? 'unknown'
        this.providers = r.providers ?? []
      } catch (e) {
        // 密钥后端读不到是**必须可见**的（它决定密钥是否加密落盘）
        this.reportFailure('读取供应商/密钥后端失败', e)
      }
    },

    reportFailure(prefix: string, e: unknown): void {
      const msg = e instanceof BridgeError ? `${e.code}: ${e.message}` : (e instanceof Error ? e.message : String(e))
      this.toast('error', prefix, msg, false)
      /**
       * 同时打进 renderer 控制台 —— 而这个控制台是**被主进程转发到日志文件**的
       * （见 main 的 `renderer console` 记录）。
       *
       * 为什么必须加这一条：拖拽启动失败等错误此前**只**变成一个 toast，
       * 关闭窗口后就不留痕迹，排障时日志里什么都查不到（实测：A11 的
       * "左键没开始拖拽"排查时，日志里完全没有失败原因）。
       * 失败必须留下可检索的痕迹，否则"静默失败"换个地方继续发生。
       */
      console.error(`[ui] ${prefix}: ${msg}`)
    },

    async loadMotion(): Promise<void> {
      try {
        const r = await bridge.listMotions()
        this.motion = { manifests: r.manifests ?? [], failed: r.failed ?? [], clipIds: (r as { clipIds?: string[] }).clipIds ?? [] }
        // 清单异常只报「清单」这一事实，不当成动作加载失败（它们是两件事）
        if ((r.failed ?? []).length) {
          this.toast('warn', `动作清单有 ${r.failed?.length} 项异常（动作文件仍会直接加载）`, (r.failed ?? []).slice(0, 4).join('\n'), false)
        }
      } catch (e) {
        // 动作资产缺失是**必须可见**的（不能静默）
        this.reportFailure('动作清单加载失败', e)
      }
    },

    async loadAvatarCatalog(): Promise<void> {
      try {
        const r = await bridge.avatarCatalog()
        const cat = r.catalog as { avatars?: AvatarEntry[] } | undefined
        this.avatar = cat?.avatars?.[0] ?? null
        if (!this.avatar) this.toast('error', '角色清单为空', 'assets/models/catalog.json 里没有可用角色', true)
      } catch (e) {
        this.reportFailure('角色清单加载失败', e)
      }
    },

    async patch(patch: SettingsPatch): Promise<void> {
      try {
        const r = await bridge.patchSettings(patch as Record<string, unknown>)
        this.settings = r.settings ?? this.settings
      } catch (e) {
        this.reportFailure('设置保存失败', e)
      }
    },

    async setMode(mode: WindowMode, center = false): Promise<void> {
      try {
        await bridge.setMode(mode, center)
        this.mode = mode
        if (this.settings) this.settings.mode = mode
      } catch (e) {
        this.reportFailure('切换模式失败', e)
      }
    },

    async toggleAutoStart(): Promise<void> {
      const next = !this.autoStart
      try {
        const r = await bridge.startupSet(next)
        this.autoStart = next
        this.toast('info', next ? '已启用开机自启' : '已关闭开机自启', r.legacyMoved?.length ? `同时移除了旧启动项：${r.legacyMoved.join('、')}` : undefined, false)
      } catch (e) {
        this.reportFailure('设置开机自启失败', e)
      }
    },

    async send(text: string): Promise<void> {
      await this.ask(text)
    },

    /**
     * 停止生成。
     * ⚠ `aborted:false` 表示"当时并没有在生成的回复" —— 如实提示，
     *   而不是假装停成功了（那会让用户以为按钮坏了）。
     */
    async stopGenerating(): Promise<void> {
      try {
        const r = await bridge.abortChat()
        if (r.aborted === true) {
          this.toast('info', '已停止生成', typeof r.receivedChars === 'number' ? `已收到 ${r.receivedChars} 字` : undefined, false)
        } else {
          this.toast('info', '当前没有正在生成的回复', undefined, false)
        }
      } catch (e) {
        this.reportFailure('停止生成失败', e)
      } finally {
        this.streaming = null
      }
    },

    /** 清空历史（主进程落盘，renderer 只同步内存） */
    async clearChat(): Promise<void> {
      try {
        const r = await bridge.clearChat()
        this.chat = []
        this.streaming = null
        this.hideBubble()
        this.toast('info', '对话历史已清空', `删除了 ${r.removed ?? 0} 条`, false)
      } catch (e) {
        this.reportFailure('清空历史失败', e)
      }
    },

    /** 从主进程加载历史（用户要求"聊天历史加载"） */
    async loadChat(): Promise<void> {
      try {
        const r = await bridge.history()
        this.chat = r.messages ?? []
      } catch (e) {
        this.reportFailure('加载对话历史失败', e)
      }
    },

    /**
     * ★★ **新建对话：只重置上下文，不删历史**（2026-10-09 完善轮）。
     *
     * 与 `clearChat()` 的区别是**不可逆性**：这里一条都不删。
     * 出参回传三个计数（archived / visible / total）—— 它们**如实**反映
     * "划到上一段的有几条、现在还能看到几条、历史总量有没有变"。
     * 界面上顺手清空当前列表：上一段她"不记得"了，继续摆在上面只会让人困惑。
     */
    async resetConversation(): Promise<{ ok: boolean, archivedCount?: number, visibleCount?: number, totalCount?: number }> {
      try {
        const r = await bridge.resetChatContext()
        this.chat = []
        this.streaming = null
        this.hideBubble()
        const archived = (r as { archivedCount?: number }).archivedCount ?? 0
        const total = (r as { totalCount?: number }).totalCount ?? 0
        this.toast('info', '已开始新的一段对话', `上一段 ${archived} 条**没有被删除**（共 ${total} 条仍在历史里）`, false)
        return { ok: true, archivedCount: archived, visibleCount: (r as { visibleCount?: number }).visibleCount, totalCount: total }
      } catch (e) {
        this.reportFailure('新建对话失败', e)
        return { ok: false }
      }
    },

    /**
     * ★ **界面动作**：让 pet 窗口切到某个管理页（记忆 / 日程 / 偏好 / 语音）。
     *
     * 为什么是"请求"而不是直接改状态：`tab` 是 **pet 窗口**的局部状态，
     * 而调用方可能来自对话窗口的菜单栏或托盘 —— 那些上下文里根本没有那个组件。
     * ⇒ 只能由主进程转发一条事件（`evt:ui-action`），由 pet 窗口自己落实。
     */
    async uiAction(action: 'memory' | 'schedule' | 'settings' | 'voice', source: 'chat-menu' | 'tray' | 'api' = 'api'): Promise<{ ok: boolean }> {
      try {
        const r = await bridge.uiAction(action, source)
        return { ok: r.ok !== false }
      } catch (e) {
        this.reportFailure(`打开视图失败（${action}）`, e)
        return { ok: false }
      }
    },

    /** 仅由主进程推送的 StageCommand 调用（唯一动作驱动链） */
    applyStageCommand(cmd: StageCommand): void {
      // 具体落到 stage 的动作由 AvatarStage 组件订阅；这里只维护可见性/窗口类状态
      if (cmd.type === 'visibility' && cmd.target === 'wheel') this.wheelOpen = cmd.visible
    },

    /**
     * 懒加载本机声音清单（设置面板打开时调）。
     * 出参只含 id/label/lang/gender，**不含**任何本机路径。
     */
    async loadTtsVoices(): Promise<void> {
      try {
        const r = await bridge.listVoices()
        this.ttsVoices = r.voices ?? []
        const sel = (r as { selected?: string | null }).selected ?? null
        // 偏好没命中时**如实提示**（而不是静默换成别的嗓子）
        if ((r as { preferredMissing?: boolean }).preferredMissing && this.settings?.ttsVoice) {
          this.toast('warn', '设置里的声音在本机不存在', `已回退到「${sel ?? '未知'}」`, false)
        }
      } catch (e) {
        this.reportFailure('读取声音清单失败', e)
        this.ttsVoices = []
      }
    },

    /** 手动打断朗读（"闭嘴"入口） */
    async stopSpeaking(): Promise<void> {
      try {
        await bridge.stopSpeak()
      } catch (e) {
        this.reportFailure('停止朗读失败', e)
      } finally {
        this.speaking = false
      }
    },

    updateStageStatus(s: Partial<State['stageStatus']>): void {
      this.stageStatus = { ...this.stageStatus, ...s }
    },

    // ═══════════════════════════════════════════════ ★ 对话（本轮）

    /** 应用主进程广播的对话状态（**唯一**的写入点） */
    applyConversationState(s: ConversationState): void {
      this.conversationOpen = s.open
      this.conversationLayout = s.layout
      if (s.chat) this.conversationChat = { ...s.chat }
      this.conversationHotkey = { ...s.hotkey }
      /**
       * ★ 桌宠快照（2026-10-09 完善轮）。
       *
       * ⚠ 这里**必须**容错：老的主进程（或一份老证据）可能不带 `pet` 字段。
       *   直接读 `s.pet.resident` 会在那种情况下抛，而后果是**整个状态广播失效**
       *   （连对话窗口的读数一起丢）—— 一个可选字段不该有这个破坏力。
       */
      const p = (s as { pet?: { resident?: boolean, visible?: boolean, statusText?: string } }).pet
      if (p) {
        this.petResident = p.resident === true
        this.petVisible = p.visible === true
        this.petStatusText = p.statusText ?? ''
      }
    },

    /**
     * 主动拉一次对话状态。
     *
     * 为什么必须拉（而不是只靠订阅）：主进程注册全局快捷键、以及"上一次会话遗留在
     * 设置里的热键"，都发生在 renderer 订阅**之前** —— 错过的那一次广播补不回来。
     * 不拉的话，界面会一直显示"快捷键正常"，而实际它根本没注册上（静默失效）。
     */
    async refreshConversationState(): Promise<void> {
      try {
        const r = await bridge.conversationState()
        const s = r.state
        if (!s) return
        const wasOpen = this.conversationOpen
        this.applyConversationState(s)
        if (s.open && !wasOpen) this.maybeAskAutoTts()
        /**
         * 快捷键注册失败**必须可见**（本轮硬要求）。
         * 这里给一条明确的告警，同时界面（对话坞 / 设置页）会常驻显示原因 ——
         * 只弹一次 toast 是不够的，用户很可能正看着别处。
         */
        if (s.hotkey.error) {
          this.toast('error', '全局快捷键注册失败', `${s.hotkey.error}\n可在「设置 → 对话」里换一个组合键，或直接关掉它。`, false)
        }
      } catch (e) {
        this.reportFailure('读取对话状态失败', e)
      }
    },

    /**
     * 打开**独立对话窗口**。
     *
     * ⚠ 不做乐观更新：只有主进程真的接受（窗口真的显示了）才把状态置开 ——
     *   否则界面会显示"已打开"而窗口其实不在（那是最难查的一类 bug）。
     *   被拒绝时把原因用 toast 显示出来，**不静默**。
     *
     * `source` 的默认值：返工轮把 `'dock'`（已删除的窗内底坞）换成 `'api'`。
     * 真正由用户操作触发的调用点都会显式给出来源（`'bubble'` / `'wake'` …），
     * 默认值只服务于"程序化调用"这一种情况。
     */
    async openConversation(source: ConversationSource = 'api', listen = false, focusInput = true): Promise<boolean> {
      try {
        const r = await bridge.conversationOpen(source, listen, focusInput)
        if (r.state) this.applyConversationState(r.state)
        return true
      } catch (e) {
        this.reportFailure('打开对话窗口失败', e)
        return false
      }
    },

    async closeConversation(source: ConversationSource = 'api'): Promise<boolean> {
      clearBubbleTimer()
      try {
        const r = await bridge.conversationClose(source)
        if (r.state) this.applyConversationState(r.state)
        this.hideBubble()
        return true
      } catch (e) {
        this.reportFailure('收起对话窗口失败', e)
        return false
      }
    },

    /**
     * 切换（**只给非用户入口用**）。
     * ⚠ 五个用户入口都不许调它：它们的语义是"只聚焦，绝不隐藏"
     *   （见 `conversation.ts` 的头部说明）。保留它只为脚本化验收的对称性。
     */
    async toggleConversation(source: ConversationSource = 'api'): Promise<void> {
      if (this.conversationOpen) await this.closeConversation(source)
      else await this.openConversation(source)
    },

    /** 进入对话时按设置决定要不要问"开启朗读"（**只问一次**，且绝不代替用户开启） */
    maybeAskAutoTts(): void {
      if (this.settings?.ttsEnabled) { this.ttsAskVisible = false; return }
      if (this.settings?.conversationAutoTtsConfirmed) { this.ttsAskVisible = false; return }
      this.ttsAskVisible = true
    },

    /** 用户对"是否开启朗读"的回答（同意才写设置；无论选什么都记下"问过了"） */
    async answerAutoTts(enable: boolean): Promise<void> {
      this.ttsAskVisible = false
      if (enable) await this.patch({ ttsEnabled: true })
      await this.patch({ conversationAutoTtsConfirmed: true })
    },

    /**
     * ★ **发送链路的唯一实现**（对话框与语音输入都走它）。
     *
     * 收敛成一处的理由（规格 §六）：如果"打字发"和"说完发"各写一套，
     * 两套迟早会在某个分支上分叉（比如 `/stop` 指令、幂等键、错误提示），
     * 而分叉出来的差异不会有任何测试覆盖到。
     */
    async ask(text: string): Promise<void> {
      const t = text.trim()
      if (!t) return
      this.sendCount += 1
      // `/stop` 是本地指令（用户要求"停止生成"）：不发给模型，直接中止在飞的生成
      if (/^\/(stop|停止|中止)\s*$/i.test(t)) {
        await this.stopGenerating()
        return
      }
      this.chat.push({
        id: `u${this.chat.length}-${Date.now().toString(36)}`, role: 'user', text: t,
        createdAt: Date.now(), commands: [], origin: 'user',
      })
      try {
        const r = await bridge.sendChat(t, `c${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
        /**
         * ★ 让**助手那条消息的 id 由 requestId 决定**（返工轮）。
         *
         * 为什么必须这样做（否则两个窗口会各显示一份重复的回复）：
         *   `evt:chat-done` 广播给全部窗口，而本窗口在发送时需要先放一个"占位"，
         *   否则流式输出没有落点。用 `r${requestId}` 作 id ⇒ `onChatDone` 能**原地更新**
         *   而不是再 push 一条（见那里的去重逻辑）。requestId 由主进程给，全局唯一且幂等。
         */
        const rid = typeof r.requestId === 'string' && r.requestId ? r.requestId : null
        if (rid && !this.chat.some(m => m.id === `r${rid}`)) {
          this.chat.push({
            id: `r${rid}`, role: 'assistant', text: '', createdAt: Date.now(), commands: [], origin: 'user',
          })
        }
      } catch (e) {
        this.reportFailure('发送失败', e)
      }
    },

    /**
     * 听一句（**复用已有的 `voice:listen-once`**，不新开麦克风、不加第二个监听）。
     *
     * 三层前置全部由上游把关，这里只做"如实报告"：
     *   · `hearingEnabled=false` ⇒ 主进程直接拒绝（不是这里偷偷打开）；
     *   · 已经在听 ⇒ 直接返回（避免两个并发识别抢麦克风）；
     *   · 没听清 ⇒ 如实提示 reason，而不是假装听到了。
     */
    async listenOnce(): Promise<void> {
      if (this.listening) return
      if (!(this.settings?.hearingEnabled ?? false)) {
        // 静默占用麦克风是本轮明令禁止的：拒绝要**看得见**，并告诉用户去哪里开
        this.toast('warn', '语音识别未开启', '请在「设置 → 语音」里显式打开「语音识别」后再用麦克风', false)
        return
      }
      this.listening = true
      try {
        const r = await bridge.voiceListenOnce(this.settings?.voiceListenTimeoutMs ?? 16_000) as unknown as {
          text?: string, confidence?: number, isWake?: boolean, recognized?: boolean, reason?: string | null, ok?: boolean
        }
        const text = typeof r.text === 'string' ? r.text : ''
        const recognized = r.recognized === true || (r.ok !== false && text.trim().length > 0)
        if (!recognized || !text.trim()) {
          this.toast('info', '没有听清', typeof r.reason === 'string' && r.reason ? r.reason : '再说一次试试', false)
          return
        }
        // 听清了 ⇒ 立刻打开对话窗口（若还没开）并走**同一条**发送链。
        // 来源记 `'wake'`：这是"语音那条路进来的"，排障时要能和打字区分开。
        if (!this.conversationOpen) await this.openConversation('wake')
        await this.ask(text)
      } catch (e) {
        this.reportFailure('语音识别失败', e)
      } finally {
        this.listening = false
      }
    },

    // ─────────────────────────────────────────────── 气泡生命周期

    /** 显示气泡（同一时刻只有一个；未展开时按 120 字截断）。返回"是否真的显示了" */
    showBubble(text: string, opts: { streaming?: boolean } = {}): boolean {
      if (!(this.settings?.bubbleEnabled ?? true)) return false
      const full = text.trim()
      if (!full) return false
      clearBubbleTimer()
      this.bubble = {
        visible: true,
        text: truncateBubble(full),
        fullText: full,
        expanded: false,
        hovered: false,
        streaming: opts.streaming === true,
        updatedAt: Date.now(),
      }
      return true
    },

    hideBubble(): void {
      clearBubbleTimer()
      this.bubble = { ...EMPTY_BUBBLE }
    },

    /**
     * 排程自动消失（`bubbleAutoHideSec` 秒后）。
     *
     * ⚠ 悬停与展开会**暂停**倒计时（规格 §四）：鼠标移开 / 收起时**重新**排一次完整时长，
     *   而不是"接着上次剩下的时间" —— 后者会让用户刚把鼠标移开气泡就消失。
     */
    scheduleBubbleHide(): void {
      clearBubbleTimer()
      if (!this.bubble.visible) return
      if (this.bubble.hovered || this.bubble.expanded) return
      const sec = this.settings?.bubbleAutoHideSec ?? 3
      const targetMs = Math.round(sec * 1000)
      bubbleHideTimer = setTimeout(() => {
        bubbleHideTimer = null
        // 再确认一次：倒计时期间可能被悬停/展开打断过
        if (this.bubble.hovered || this.bubble.expanded) return
        const hiddenAt = Date.now()
        /**
         * 精确记录"TTS 结束 → 自动消失"的实际延时（**内部时钟**，不受外部采样影响）。
         * 只有走过 "TTS 结束" 的倒计时才记 —— 手动关闭/清空不会污染这个读数。
         */
        if (bubbleTtsEndedAt !== null) {
          lastAutoHide = {
            ttsEndedAt: bubbleTtsEndedAt,
            hiddenAt,
            delayMs: hiddenAt - bubbleTtsEndedAt,
            targetMs,
          }
        }
        this.hideBubble()
      }, targetMs)
    },

    setBubbleHover(hovered: boolean): void {
      this.bubble.hovered = hovered
      if (hovered) clearBubbleTimer()
      else this.scheduleBubbleHide()
    },

    /** 点击气泡展开全文 / 再次点击收起 */
    toggleBubbleExpanded(): void {
      const next = !this.bubble.expanded
      this.bubble.expanded = next
      this.bubble.text = next ? this.bubble.fullText : truncateBubble(this.bubble.fullText)
      if (next) clearBubbleTimer()
      else this.scheduleBubbleHide()
    },

    // ═══════════════════════════════════════════════ M1 配置闭环

    /** 供应商：新建/更新（**apiKey 是唯一一次进入主进程的明文**，之后 renderer 再也拿不到） */
    async upsertProvider(p: { id?: string, label: string, kind: string, baseUrl: string, model: string, apiKey?: string }): Promise<boolean> {
      try {
        await bridge.upsertProvider(p as Record<string, unknown>)
        await this.loadProviders()
        await this.loadOnboarding()
        return true
      } catch (e) {
        this.reportFailure('保存供应商失败', e)
        return false
      }
    },

    async deleteProvider(id: string): Promise<void> {
      try {
        await bridge.deleteProvider(id)
        await this.loadProviders()
        await this.loadOnboarding()
      } catch (e) {
        this.reportFailure('删除供应商失败', e)
      }
    },

    /** 测试连接（结果同时决定向导能否进入下一步 —— 判据在主进程） */
    async testProvider(id: string): Promise<{ ok: boolean, code: string, message: string, latencyMs: number | null, modelCount: number | null } | null> {
      try {
        const r = await bridge.testProvider(id)
        await this.loadOnboarding()
        return {
          ok: r.ok === true,
          code: String(r.code ?? 'unknown'),
          message: String(r.message ?? ''),
          latencyMs: typeof r.latencyMs === 'number' ? r.latencyMs : null,
          modelCount: typeof r.modelCount === 'number' ? r.modelCount : null,
        }
      } catch (e) {
        this.reportFailure('测试连接失败', e)
        return null
      }
    },

    async selectProvider(id: string): Promise<void> {
      try {
        await bridge.selectProvider(id)
        await this.loadProviders()
        await this.loadOnboarding()
      } catch (e) {
        this.reportFailure('切换供应商失败', e)
      }
    },

    /** 从端点拉模型清单（端点不支持时 supported:false —— 如实提示，不报错） */
    async loadProviderModels(id: string): Promise<{ supported: boolean, models: string[], message: string }> {
      try {
        const r = await bridge.listProviderModels(id)
        return { supported: r.supported === true, models: r.models ?? [], message: String(r.message ?? '') }
      } catch (e) {
        this.reportFailure('读取模型清单失败', e)
        return { supported: false, models: [], message: e instanceof Error ? e.message : String(e) }
      }
    },

    async loadOnboarding(): Promise<void> {
      try {
        const r = await bridge.onboardingGet()
        this.onboarding = r.status ?? null
      } catch (e) {
        this.reportFailure('读取向导状态失败', e)
      }
    },

    async setOnboardingStep(step: OnboardingStep): Promise<void> {
      try {
        const r = await bridge.onboardingSetStep(step)
        this.onboarding = r.status ?? this.onboarding
      } catch (e) {
        this.reportFailure('切换向导步骤失败', e)
      }
    },

    async completeOnboarding(): Promise<void> {
      try {
        const r = await bridge.onboardingComplete(true)
        this.onboarding = r.status ?? this.onboarding
        this.toast('info', '设置完成，可以开始用了', undefined, false)
      } catch (e) {
        // 未满足判据时主进程会拒绝 —— 必须把原因如实显示出来
        this.reportFailure('完成设置失败', e)
      }
    },

    async resetOnboarding(): Promise<void> {
      try {
        const r = await bridge.onboardingReset()
        this.onboarding = r.status ?? null
        await this.patch({ onboarded: false })
      } catch (e) {
        this.reportFailure('重置向导失败', e)
      }
    },

    /** 人设（称呼 / 人设 / 声音） */
    async loadPersona(): Promise<void> {
      try {
        const r = await bridge.getPersona()
        this.persona = r.persona ?? null
      } catch (e) {
        this.reportFailure('读取人设失败', e)
      }
    },

    async savePersona(patch: Partial<Persona>): Promise<void> {
      const base = this.persona
      if (!base) {
        this.toast('error', '人设还没加载', '请稍后重试', false)
        return
      }
      const next: Persona = { ...base, ...patch, updatedAt: Date.now() }
      try {
        const r = await bridge.setPersona(next as unknown as Record<string, unknown>)
        this.persona = r.persona ?? next
        await this.loadOnboarding()
      } catch (e) {
        this.reportFailure('保存人设失败', e)
      }
    },

    // ═══════════════════════════════════════════════ M1 记忆

    async searchMemory(query: string, opts: { minImportance?: number, tag?: string | null } = {}): Promise<void> {
      this.memoryQuery = query
      try {
        const r = await bridge.searchMemory({ query, limit: 100, ...opts })
        this.memoryHits = r.hits ?? []
      } catch (e) {
        this.reportFailure('检索记忆失败', e)
      }
    },

    /**
     * 新增记忆。
     *
     * ⚠ 返回 boolean 不是为了好看：调用方（记忆页的表单）必须知道"到底存上了没有"，
     *   否则只能在失败后照样清空输入框 —— 那等于**伪造成功**（用户以为记住了，其实没有）。
     *   这里不做乐观更新：只有主进程真的接受了才返回 true。
     */
    async addMemory(text: string, tags: string[], importance: number): Promise<boolean> {
      try {
        await bridge.addMemory({ text, tags, importance })
        await this.searchMemory(this.memoryQuery)
        return true
      } catch (e) {
        this.reportFailure('新增记忆失败', e)
        return false
      }
    },

    async updateMemory(e: { id: string, text?: string, tags?: string[], importance?: number }): Promise<void> {
      try {
        await bridge.updateMemory(e)
        await this.searchMemory(this.memoryQuery)
      } catch (err) {
        this.reportFailure('修改记忆失败', err)
      }
    },

    async deleteMemory(id: string): Promise<void> {
      try {
        await bridge.deleteMemory(id)
        await this.searchMemory(this.memoryQuery)
        if (this.recallPreview) this.recallPreview = null
      } catch (e) {
        this.reportFailure('删除记忆失败', e)
      }
    },

    /** 召回预览：让用户看到"这句话会让我想起什么"以及真正注入的文本 */
    async previewRecall(query: string): Promise<void> {
      if (!query.trim()) { this.recallPreview = null; return }
      try {
        const r = await bridge.previewRecallMemory(query, 5)
        this.recallPreview = {
          query: r.query ?? query,
          hits: r.hits ?? [],
          injectedBlock: r.injectedBlock ?? null,
          injectedChars: r.injectedChars ?? 0,
        }
      } catch (e) {
        this.reportFailure('召回预览失败', e)
      }
    },

    // ═══════════════════════════════════════════════ M2 日程 / 提醒 / 静音 / 权限

    async loadSchedules(): Promise<void> {
      try {
        const r = await bridge.listSchedules()
        this.schedules = r.schedules ?? []
      } catch (e) {
        this.reportFailure('读取日程失败', e)
      }
    },

    async upsertSchedule(s: Record<string, unknown>): Promise<boolean> {
      try {
        await bridge.upsertSchedule(s)
        await this.loadSchedules()
        return true
      } catch (e) {
        // 形态错误（weekly 没给星期几等）会在这里如实报出
        this.reportFailure('保存日程失败', e)
        return false
      }
    },

    async deleteSchedule(id: string): Promise<void> {
      try {
        await bridge.deleteSchedule(id)
        await this.loadSchedules()
      } catch (e) {
        this.reportFailure('删除日程失败', e)
      }
    },

    async loadReminders(): Promise<void> {
      try {
        const r = await bridge.listReminders()
        this.reminders = r.reminders ?? []
      } catch (e) {
        this.reportFailure('读取提醒失败', e)
      }
    },

    async upsertReminder(r: Record<string, unknown>): Promise<boolean> {
      try {
        await bridge.upsertReminder(r)
        await this.loadReminders()
        return true
      } catch (e) {
        this.reportFailure('保存提醒失败', e)
        return false
      }
    },

    async deleteReminder(id: string): Promise<void> {
      try {
        await bridge.deleteReminder(id)
        await this.loadReminders()
      } catch (e) {
        this.reportFailure('删除提醒失败', e)
      }
    },

    async ackReminder(id: string): Promise<void> {
      try {
        await bridge.ackReminder(id, true)
        await this.loadReminders()
        await this.loadInbox()
      } catch (e) {
        this.reportFailure('确认提醒失败', e)
      }
    },

    async loadQuiet(): Promise<void> {
      try {
        const r = await bridge.getQuiet()
        this.quiet = r.quiet ?? null
        this.reminderPolicy = r.policy ?? null
      } catch (e) {
        this.reportFailure('读取静音时段失败', e)
      }
    },

    async setQuiet(patch: Record<string, unknown>): Promise<void> {
      try {
        const r = await bridge.setQuiet(patch)
        this.quiet = r.quiet ?? this.quiet
      } catch (e) {
        this.reportFailure('保存静音时段失败', e)
      }
    },

    async setReminderPolicy(patch: Record<string, unknown>): Promise<void> {
      try {
        const r = await bridge.setReminderPolicy(patch)
        this.reminderPolicy = r.policy ?? this.reminderPolicy
      } catch (e) {
        this.reportFailure('保存提醒阈值失败', e)
      }
    },

    async loadPermissions(): Promise<void> {
      try {
        const r = await bridge.listPermissions()
        this.permissions = (r.permissions ?? []) as State['permissions']
      } catch (e) {
        this.reportFailure('读取权限失败', e)
      }
    },

    async setPermission(patch: Record<string, unknown>): Promise<void> {
      try {
        await bridge.setPermission(patch)
        await this.loadPermissions()
        await this.loadOnboarding()
      } catch (e) {
        this.reportFailure('保存权限失败', e)
      }
    },

    // ═══════════════════════════════════════════════ M2 活动与主动引擎

    async loadActivity(): Promise<void> {
      try {
        const r = await bridge.activityStats()
        this.activityToday = r.today ?? null
        this.activityAdvice = r.advice ?? []
        this.activity = r.activity ? { ...r.activity, blocked: r.blocker?.blocked ?? false } : null
      } catch (e) {
        this.reportFailure('读取活动统计失败', e)
      }
    },

    async loadProactiveStatus(): Promise<void> {
      try {
        const r = await bridge.proactiveStatus()
        this.proactive = r.status ?? null
      } catch (e) {
        this.reportFailure('读取主动引擎状态失败', e)
      }
    },

    async loadInbox(): Promise<void> {
      try {
        const r = await bridge.proactiveInbox()
        this.inbox = r.inbox ?? null
      } catch (e) {
        this.reportFailure('读取提醒中心失败', e)
      }
    },

    /** 手动推进一次引擎（"我刚改完设置，立刻看看对不对"） */
    async tickEngine(): Promise<void> {
      try {
        const r = await bridge.proactiveTick()
        this.toast('info', '已检查一次主动任务', r.result
          ? `送达 ${r.result.delivered} 条，排队 ${r.result.queued} 条${r.result.blockReason !== 'none' ? `（当前被阻断：${r.result.blockReason}）` : ''}`
          : undefined, false)
        await this.loadProactiveStatus()
        await this.loadInbox()
      } catch (e) {
        this.reportFailure('推进引擎失败', e)
      }
    },

    /** 手动听一次早安电台（force = 忽略冷却与"今天已播报"） */
    async triggerRadio(speak = false): Promise<void> {
      try {
        const r = await bridge.triggerRadio({ force: true, speak })
        this.radio = r.content ?? null
        if (r.skippedReason) this.toast('warn', '电台已跳过', r.skippedReason, false)
      } catch (e) {
        this.reportFailure('生成早安电台失败', e)
      }
    },
  },
})
