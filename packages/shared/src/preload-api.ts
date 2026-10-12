/**
 * packages/shared/src/preload-api.ts —— preload 暴露给渲染进程的 API 形状（唯一真源）
 *
 * 纪律：renderer 只看到这里声明的函数；**没有** ipcRenderer、没有 require、没有 process。
 *       任何函数都不得接收或返回密钥明文。
 */
import type {
  Alert, AppDiagnostics, ChatDelta, ChatDone, ChatError, ChatMessage, LegacyScanResult,
  MotionClipManifest, Persona, ProviderPublic, Result, SettingsPatch, StageCommand, StageSnapshot,
  WindowMode, WindowState, AppSettings, MemoryEntry, MemoryRecallHit, HitRegions, DragMove,
  OnboardingStatus, OnboardingStep, ProactiveEvent, ProactiveInbox, ProactiveStatus,
  QuietHours, RadioContent, Reminder, ReminderPolicy, Schedule, ActivityDayStats, ActivityState,
  VoiceStatus, ScreenStatus, VoiceNotice, ScreenNotice, ToolConfirmRequest,
  VoiceCallState, VoiceCallNotice, VoiceLoopStatus,
  ReflectionStatus, DailyReflection, ReflectionItem,
  ConversationState, ConversationSource, ConversationListenRequest,
  /** ★ 桌宠窗口（呼出 / 收回 / 常驻）与界面动作 —— 2026-10-09 完善轮 */
  PetControlRequest, PetMenuState, UiActionRequest,
} from './index.js'

export interface ModeChangedEvent {
  mode: WindowMode
  bounds: { x: number, y: number, width: number, height: number } | null
  windowId: number
}

export interface TtsStateEvent {
  utteranceId: string
  state: 'start' | 'end' | 'error'
  error?: string
}

export interface AiriMateApi {
  /** 契约版本，renderer 启动时校验（不一致即显示阻断告警） */
  readonly contractVersion: string
  readonly platform: string
  readonly appVersion: string

  diagnostics: () => Promise<AppDiagnostics & { stage: StageSnapshot | null }>
  show: () => Promise<Result>
  hide: () => Promise<Result>
  quit: () => Promise<Result>
  /** ★ 重启应用（先拉起新进程再退出当前进程；顺序由主进程保证） */
  restart: () => Promise<Result>

  startupGet: () => Promise<Result & { enabled?: boolean, entries?: unknown[] }>
  startupSet: (enabled: boolean) => Promise<Result & { detail?: string, legacyMoved?: string[], backupDir?: string | null }>
  legacyScan: () => Promise<Result & { result?: LegacyScanResult }>

  getMode: () => Promise<Result & { mode?: WindowMode, bounds?: unknown }>
  setMode: (mode: WindowMode, center?: boolean) => Promise<Result & { mode?: WindowMode, bounds?: unknown }>
  setAlwaysOnTop: (on: boolean) => Promise<Result>
  center: () => Promise<Result>
  dragBegin: (cursor: { x: number, y: number }) => Promise<Result>
  dragMove: (cursor: DragMove) => void
  dragEnd: () => Promise<Result & { moved?: boolean, distance?: number, bounds?: unknown }>
  autoResize: (width: number, height: number, anchor?: 'top-left' | 'bottom-center') => Promise<Result & { applied?: boolean, reason?: string | null }>
  /**
   * 最小化**发起调用的那个窗口**。
   * chat 窗口是 `frame:false` 的自绘标题栏，没有系统按钮 ⇒ 必须由界面自己提供入口。
   */
  minimizeSelf: () => Promise<Result>

  // ── ★★ 桌宠窗口：呼出 / 收回 / 常驻（2026-10-09 完善轮）
  /**
   * **呼出桌宠**（显示并聚焦 pet 窗口）。
   * 窗口不存在时按当前 `petResident` 创建它 —— **不改变常驻设置**。
   */
  petShow: (source?: PetControlRequest['source']) => Promise<Result & { state?: ConversationState, pet?: PetMenuState }>
  /** **收回桌宠**（隐藏）。⚠ **不写 `petResident`**：收回 ≠ 取消常驻 */
  petHide: (source?: PetControlRequest['source']) => Promise<Result & { state?: ConversationState, pet?: PetMenuState }>
  /** 呼出 ⇄ 收回 */
  petToggle: (source?: PetControlRequest['source']) => Promise<Result & { state?: ConversationState, pet?: PetMenuState }>
  /** 呼出 + 切 panel 模式 + 聚焦（管理面板） */
  petOpenPanel: (source?: PetControlRequest['source']) => Promise<Result & { state?: ConversationState, pet?: PetMenuState, mode?: WindowMode }>
  /**
   * 写「桌宠常驻」并**立即生效 + 落盘**。
   * 勾上 ⇒ 显示桌宠 + `settings.petResident=true`；取消 ⇒ 隐藏桌宠 + `false`。
   */
  petSetResident: (resident: boolean, source?: PetControlRequest['source']) => Promise<Result & { state?: ConversationState, pet?: PetMenuState, persisted?: boolean }>
  /** 把常驻设置**立即落盘**（不等防抖） */
  petFlushSettings: () => Promise<Result & { flushed?: boolean }>
  /** 在鼠标位置弹出**原生**桌宠右键菜单（菜单项与动作全部在主进程；renderer 只能说"用户右键了"） */
  petMenu: () => Promise<Result & { shown?: boolean }>
  /**
   * ★ **界面动作**：请求打开某个管理页（记忆 / 日程 / 偏好 / 语音 / 快捷键 / 关于）。
   * 真正的"切页"由 pet 窗口的界面完成（`tab` 是它的局部状态）。
   */
  uiAction: (action: 'memory' | 'schedule' | 'settings' | 'voice' | 'shortcuts' | 'about', source?: 'tray' | 'chat-menu' | 'pet-menu' | 'api') => Promise<Result & { routed?: string }>

  reportHitRegions: (payload: HitRegions) => void
  /** 主动推送舞台快照（只读）：主进程据此回答 diagnostics，无需 executeJavaScript */
  reportStageSnapshot: (payload: StageSnapshot) => void

  // ── ★ 对话（返工轮）：**独立 chat 窗口**，不再切 pet 窗口的任何布局
  /**
   * 显示并聚焦独立对话窗口。
   * 语义：**再次触发只聚焦，绝不隐藏**（隐藏走 `conversationClose` / Esc / × / 托盘「结束对话」）。
   */
  /**
   * 显示并聚焦独立对话窗口。
   * 语义：**再次触发只聚焦，绝不隐藏**（隐藏走 `conversationClose` / Esc / × / 托盘「结束对话」）。
   */
  conversationOpen: (source?: ConversationSource, listen?: boolean, focusInput?: boolean) => Promise<Result & { state?: ConversationState }>
  /** 隐藏对话窗口（不销毁、不退出应用；pet 窗口完全不受影响） */
  conversationClose: (source?: ConversationSource) => Promise<Result & { state?: ConversationState }>
  /** 只读状态（含快捷键注册结果与 chat 窗口 hwnd；界面与探针共用同一份读数） */
  conversationState: () => Promise<Result & { state?: ConversationState }>

  getSettings: () => Promise<Result & { settings?: AppSettings }>
  patchSettings: (patch: SettingsPatch) => Promise<Result & { settings?: AppSettings }>

  listMotions: () => Promise<Result & { manifests?: MotionClipManifest[], failed?: string[] }>
  reloadMotions: () => Promise<Result & { manifests?: MotionClipManifest[], failed?: string[] }>
  avatarCatalog: () => Promise<Result & { catalog?: unknown }>

  /**
   * 供应商列表 + 密钥后端名。
   *
   * ⚠ 返回类型**必须**与主进程真实出参一致。这里曾声明成
   * `ProviderPublic | { providerId, keyFingerprint, keyLength, updatedAt, hasKey }` 的联合 ——
   * 后半段是个**更窄且字段名不同**的猜测形状（`providerId` vs `id`，没有 `label`），
   * 于是 renderer 侧任何取 `p.label` 的代码都过不了类型检查，而这个联合的"另一半"
   * 在 `ipc.ts` 里**从来不存在**（主进程一直返回 `ProviderPublic` + `active`）。
   * 契约里一个不存在的分支比"缺一个字段"更坏：它会让人以为有两种返回形态。
   */
  listProviders: () => Promise<Result & { backend?: string, providers?: Array<ProviderPublic & { active?: boolean }> }>
  upsertProvider: (p: { id?: string, label: string, kind: string, baseUrl: string, model: string, apiKey?: string }) => Promise<Result>
  deleteProvider: (id: string) => Promise<Result>
  testProvider: (id: string) => Promise<Result & { ok?: boolean, latencyMs?: number | null, code?: string, message?: string, modelCount?: number | null }>
  /** 多供应商时显式选择生效项（向导第 3 步也用它） */
  selectProvider: (id: string) => Promise<Result>
  /** 从端点拉模型清单（端点不支持时 `supported:false`，不算错误） */
  listProviderModels: (id: string) => Promise<Result & { supported?: boolean, models?: string[], code?: string, message?: string }>

  // ── M1 首次运行向导
  onboardingGet: () => Promise<Result & { status?: OnboardingStatus }>
  onboardingSetStep: (step: OnboardingStep) => Promise<Result & { status?: OnboardingStatus }>
  onboardingComplete: (completed: boolean) => Promise<Result & { status?: OnboardingStatus }>
  onboardingReset: () => Promise<Result & { status?: OnboardingStatus }>

  // ── M1 隐私 / 数据主体权利
  privacyExport: (req: { format?: 'json' | 'markdown', includeChats?: boolean, includeMemory?: boolean }) => Promise<Result & { file?: string, bytes?: number, sections?: string[], excluded?: string[] }>
  privacyWipe: (req: { confirm: 'DELETE-ALL-PERSONAL-DATA', keepSettings?: boolean, revokeKeys?: boolean }) => Promise<Result & { removedFiles?: string[], removedBytes?: number, kept?: string[] }>
  privacySummary: () => Promise<Result & { summary?: {
    userDataDir: string
    files: Array<{ name: string, exists: boolean, bytes: number, kind: string }>
    secretFiles: number
    telemetryEnabled: boolean
    logFiles: number
    exportFiles: number
  } }>

  // ── 适配层框架（M5 §1）：让"现在到底在用哪个实现"成为可机械验证的事实
  /** 全部适配器（含许可与可用性）+ 工具清单 + 选型事件 */
  kitCapabilities: () => Promise<Result & { kit?: unknown }>
  /** 角色解析结论：可用列表 + 被拒条目与原因（**不含绝对路径**） */
  kitAssets: () => Promise<Result & { assets?: unknown }>
  /** 工具调用审计（只有摘要：参数与结果都是 sha256 前 12 位 + 原长） */
  kitToolAudit: () => Promise<Result & { calls?: unknown[], digest?: unknown }>
  /** 存储清单与迁移状态 */
  kitStores: () => Promise<Result & { stores?: unknown[], personal?: string[], unregistered?: string[] }>

  // ── M3 语音（默认关闭；启用后必须显示麦克风状态与一键停用）
  voiceStatus: () => Promise<Result & { status?: VoiceStatus }>
  voiceConfig: (patch: { wakeWordEnabled?: boolean, wakeWord?: string }) => Promise<Result & { status?: VoiceStatus }>
  voiceStop: () => Promise<Result & { cancelled?: boolean, status?: VoiceStatus }>
  voiceProbe: () => Promise<Result & { probe?: { ok: boolean, count: number, reason: string | null }, status?: VoiceStatus }>
  /**
   * 识别一句（语音通话循环调它 ⇒ 连续对话）。
   * ⚠ `ok` 是**通道**成功；`recognized` 才是"听清了没有"；`reason` 说明为什么没听清。
   */
  voiceListenOnce: (timeoutMs?: number) => Promise<Result & {
    text?: string, confidence?: number, isWake?: boolean, recognized?: boolean, reason?: string | null
  }>

  // ── M3 语音通话（全链路：STT → LLM → TTS，可打断、连续对话）
  /** 开始通话；未启用语音/未配置供应商时**结构化拒绝**（不会悄悄开麦） */
  voiceCallStart: () => Promise<Result & { state?: VoiceCallState }>
  voiceCallStop: () => Promise<Result & { stopped?: boolean, state?: VoiceCallState }>
  /** 打断：停止朗读并继续听（不结束通话） */
  voiceCallInterrupt: () => Promise<Result & { interrupted?: boolean, state?: VoiceCallState }>
  /** 通话状态 + 前置条件（UI 据此解释"为什么不能通话"） */
  voiceCallState: () => Promise<Result & {
    state?: VoiceCallState
    preflight?: { ready: boolean, reasons: string[] }
  }>
  /**
   * ★ 闭环读数（2026-10-06，A4）：桥是否接上 / 待机监听是否在跑 /
   * barge-in 是否开 / 四段（听·想·说·起）各自是否具备条件。**只读，无正文**。
   */
  voiceLoopStatus: () => Promise<Result & { loop?: VoiceLoopStatus }>
  /**
   * ★ 待机听唤醒开关（2026-10-06，A4）。
   * 打开需要 `hearingEnabled` **且** `wakeWordEnabled` —— 两条硬前置由主进程强制，
   * 不满足时**结构化拒绝**（不会悄悄开麦）。
   */
  voiceWakeWatch: (enabled: boolean) => Promise<Result & { loop?: VoiceLoopStatus }>

  // ── M3 屏幕理解（按需触发；画面内容永不出主进程）
  screenStatus: () => Promise<Result & { status?: ScreenStatus }>
  screenPause: (paused: boolean) => Promise<Result & { status?: ScreenStatus }>
  /** 最近一次截图提示（null = 从未截过） */
  screenNotice: () => Promise<Result & { notice?: unknown }>

  // ── M3 目录白名单（**出参只给 id 与末级目录名，不给完整路径**）
  fsAllowlist: () => Promise<Result & {
    entries?: Array<{ id: string, label: string }>
    rules?: { file: number, dir: number }
  }>
  fsAllowDir: (path: string) => Promise<Result & { entries?: Array<{ id: string, label: string }> }>
  fsRevokeDir: (id: string) => Promise<Result & { entries?: Array<{ id: string, label: string }> }>

  /** 确认弹窗回传（只接受当前挂起的 confirmId） */
  submitToolConfirm: (confirmId: string, approved: boolean) => Promise<Result & { accepted?: boolean }>

  // ── M4 每日自学习（默认关闭；高置信度自动写记忆，低置信度必须确认）
  reflectionStatus: () => Promise<Result & { status?: ReflectionStatus }>
  /** 手动跑一次；`dryRun` 不写任何记忆（探针用） */
  reflectionRun: (o?: { force?: boolean, dryRun?: boolean }) => Promise<Result & {
    ran?: boolean, skippedReason?: string | null, reflection?: DailyReflection
  }>
  reflectionHistory: (limit?: number) => Promise<Result & { days?: DailyReflection[], total?: number }>
  reflectionDay: (day: string) => Promise<Result & { reflection?: DailyReflection }>
  /** 待确认项（跨天）——**低置信度内容只有经这里确认才会写进长期记忆** */
  reflectionPending: () => Promise<Result & { items?: Array<ReflectionItem & { day: string }>, count?: number }>
  /** 确认 / 拒绝；拒绝后同一结论不再重复提问 */
  reflectionDecide: (day: string, itemId: string, approve: boolean) => Promise<Result & {
    memoryId?: string | null, item?: ReflectionItem
  }>
  /** 清空反思记录（**不动已写入的记忆**） */
  reflectionClear: () => Promise<Result & { removedDays?: number }>

  getPersona: () => Promise<Result & { persona?: Persona | null }>
  setPersona: (p: Persona) => Promise<Result & { persona?: Persona }>

  sendChat: (text: string, clientId: string) => Promise<Result & { requestId?: string }>
  /** 停止生成；`aborted:false` = 当时并没有在生成的回复（如实告知） */
  abortChat: () => Promise<Result & { aborted?: boolean, requestId?: string | null, receivedChars?: number }>
  history: () => Promise<Result & { messages?: ChatMessage[], total?: number }>
  clearChat: () => Promise<Result & { removed?: number }>
  /**
   * ★ **只重置上下文，不删历史**（「新建对话」用它）。
   * 与 `clearChat` 是两件事：删除不可逆，重置只是"从此刻起她不再记得之前聊过什么"。
   */
  resetChatContext: () => Promise<Result & { archivedCount?: number, visibleCount?: number, totalCount?: number, resetAt?: number }>
  /** ★ 打开对话数据目录（出参含目录本身，便于探针机械比对） */
  openChatDataDir: () => Promise<Result & { dataDir?: string, logsDir?: string, opened?: boolean }>

  listMemory: () => Promise<Result & { entries?: MemoryEntry[], total?: number }>
  addMemory: (entry: { text: string, tags?: string[], importance?: number }) => Promise<Result & { entry?: MemoryEntry, total?: number }>
  updateMemory: (entry: { id: string, text?: string, tags?: string[], importance?: number }) => Promise<Result & { entry?: MemoryEntry, total?: number }>
  deleteMemory: (id: string) => Promise<Result & { removed?: boolean, total?: number }>
  /** 只读召回：让用户能看到"这句话会让我想起什么"（记忆层不能是黑盒） */
  recallMemory: (query: string, limit?: number) => Promise<Result & { hits?: MemoryRecallHit[], count?: number }>
  /** 召回预览：命中条目 + **真正会被注入系统提示的文本** */
  previewRecallMemory: (query: string, limit?: number) => Promise<Result & {
    query?: string, hits?: MemoryRecallHit[], injectedBlock?: string | null, injectedChars?: number
  }>
  /** 检索（带过滤；空查询 = 浏览模式；**不写使用统计**） */
  searchMemory: (req: { query?: string, limit?: number, minImportance?: number, tag?: string | null }) => Promise<Result & { hits?: MemoryRecallHit[], count?: number, total?: number }>

  // ── M2 日程 / 提醒 / 静音 / 权限 / 活动 / 主动引擎
  listSchedules: () => Promise<Result & { schedules?: Schedule[], total?: number }>
  upsertSchedule: (s: Record<string, unknown>) => Promise<Result & { schedule?: Schedule }>
  deleteSchedule: (id: string) => Promise<Result & { removed?: boolean }>

  listReminders: () => Promise<Result & { reminders?: Reminder[], total?: number }>
  upsertReminder: (r: Record<string, unknown>) => Promise<Result & { reminder?: Reminder }>
  deleteReminder: (id: string) => Promise<Result & { removed?: boolean }>
  ackReminder: (id: string, acked?: boolean) => Promise<Result & { reminder?: Reminder }>

  getQuiet: () => Promise<Result & { quiet?: QuietHours, policy?: ReminderPolicy }>
  setQuiet: (patch: Record<string, unknown>) => Promise<Result & { quiet?: QuietHours }>
  setReminderPolicy: (patch: Record<string, unknown>) => Promise<Result & { policy?: ReminderPolicy }>

  listPermissions: () => Promise<Result & { permissions?: Array<{
    kind: string, label: string, tier: string, effective: string, enabled: boolean,
    pathAllowlist: string[], excludeRegions: Array<{ x: number, y: number, w: number, h: number }>,
    redactSensitive: boolean, updatedAt: number, grantedBy: string
  }> }>
  setPermission: (patch: Record<string, unknown>) => Promise<Result & { permission?: unknown }>

  activityStats: () => Promise<Result & {
    today?: ActivityDayStats
    currentStreakMinutes?: number
    advice?: string[]
    activity?: ActivityState | null
    blocker?: { blocked: boolean, reason: string, text: string }
    probe?: { scriptPath: string, scriptExists: boolean, shell: string | null }
  }>
  proactiveStatus: () => Promise<Result & { status?: ProactiveStatus }>
  proactiveInbox: () => Promise<Result & { inbox?: ProactiveInbox }>
  /** 手动推进一次引擎 tick（探针 / 改完设置立刻验证） */
  proactiveTick: () => Promise<Result & { result?: { at: number, blockReason: string, delivered: number, queued: number, skipped: string[] } }>
  /** 手动触发早安电台；`force` 忽略冷却，`speak` 默认 false（探针不该突然放音） */
  triggerRadio: (opts?: { force?: boolean, speak?: boolean }) => Promise<Result & {
    content?: RadioContent | null, skippedReason?: string | null, spoken?: boolean
  }>

  speak: (text: string, utteranceId: string) => Promise<Result>
  stopSpeak: () => Promise<Result>
  /**
   * 本机可用声音。
   * `id` 可直接写回 `SettingsPatch.ttsVoice`；`label` 供 UI 显示；**不含**任何本机路径。
   */
  listVoices: () => Promise<Result & {
    engine?: string
    voices?: Array<{ id: string, label: string, lang: string, gender: string | null }>
    /** 按"用户偏好 + zh-CN 优先"实际会选中的声音（null = 本机无可用声音） */
    selected?: string | null
    preferred?: string | null
    /** 偏好声音在本机不存在（UI 应如实提示，而不是静默换嗓子） */
    preferredMissing?: boolean
  }>

  onStageCommand: (cb: (cmd: StageCommand) => void) => () => void
  onAlert: (cb: (a: Alert) => void) => () => void
  onChatDelta: (cb: (d: ChatDelta) => void) => () => void
  onChatDone: (cb: (d: ChatDone) => void) => () => void
  onChatError: (cb: (e: ChatError) => void) => () => void
  onModeChanged: (cb: (e: ModeChangedEvent) => void) => () => void
  onWindowState: (cb: (s: WindowState) => void) => () => void
  onDragPos: (cb: (p: import('./ipc.js').DragPos) => void) => () => void
  onTtsState: (cb: (s: TtsStateEvent) => void) => () => void
  onSettingsChanged: (cb: (s: AppSettings) => void) => () => void
  /** ★ M2：引擎送达的主动事件（问候 / 日程播报 / 早安电台 / 提醒 / 队列补发） */
  onProactive: (cb: (e: ProactiveEvent) => void) => () => void
  /** ★ M2：活动/阻断状态变化（UI 显示"正在会议中，提醒已排队"这类真实状态） */
  onActivity: (cb: (a: ActivityState & { blocked: boolean, blockReason: string }) => void) => () => void
  /** ★ M2：提醒队列变化（提醒中心角标） */
  onReminderQueue: (cb: (q: { queued: number, unacked: number }) => void) => () => void
  /** ★ M3：截图前提示（用户要求"截图前显示提示"） */
  onScreenNotice: (cb: (n: ScreenNotice) => void) => () => void
  /** ★ M3：语音事件（监听/唤醒/听到一句/错误）——**不含识别正文** */
  onVoiceNotice: (cb: (n: VoiceNotice) => void) => () => void
  /** ★ M3：工具需要用户确认；回调只给工具名/权限/参数摘要，弹窗看不到参数原文 */
  onToolConfirm: (cb: (req: ToolConfirmRequest) => void) => () => void
  /** ★ M3：语音通话进度；`replyText` 是唯一承载回复正文的字段（只用于气泡显示） */
  onVoiceCall: (cb: (n: VoiceCallNotice) => void) => () => void
  /**
   * ★ 对话状态变化（托盘 / 快捷键 / 唤醒都能改它，renderer 必须能收到）。
   * 没有这条订阅，主进程发起的入口就是"窗口变了但界面不知道"的静默失效。
   */
  onConversationState: (cb: (s: ConversationState) => void) => () => void
  /** ★ 唤醒词触发的"开始听"（renderer 收到后去调已有的 `voice:listen-once`，不新开麦克风） */
  onConversationListen: (cb: (r: ConversationListenRequest) => void) => () => void
  /**
   * ★ 界面动作请求（main → pet 窗口）：打开记忆页 / 日程与提醒 / 偏好设置 /
   * 语音与麦克风 / 快捷键一览 / 关于。**只带一个枚举值**，不含任何用户内容。
   */
  onUiAction: (cb: (r: UiActionRequest) => void) => () => void
  /** ★ 桌宠菜单状态快照（三处菜单的「桌宠常驻」勾选同步靠它） */
  onPetMenuState: (cb: (s: PetMenuState) => void) => () => void
}