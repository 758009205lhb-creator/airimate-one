/**
 * apps/desktop/src/preload/index.ts —— 唯一的 renderer ↔ main 桥
 *
 * 安全（Tech-Spec §7.1）：
 *   - `contextIsolation: true` + `sandbox: true`；**沙箱化 preload 必须是 CommonJS**
 *     （Electron 的 ESM preload 仅在不启用 sandbox 时可用），因此本文件编译为 CJS；
 *   - 为了让 preload **零运行时依赖**（沙箱下最稳），通道名在这里内联，
 *     但由 `assertContract()` 在启动时与 `@airimate/shared` 的 `IPC` 常量逐条比对，
 *     不一致立即抛错 —— 内联不等于"各写一份、悄悄漂移"；
 *   - 暴露对象经 `Object.freeze` 冻结，只含白名单函数；**不暴露** ipcRenderer 本体；
 *   - 事件订阅返回取消函数，避免累积监听。
 */
import { contextBridge, ipcRenderer } from 'electron'
import type {
  AiriMateApi, Alert, AppDiagnostics, AppSettings, ChatDelta, ChatDone, ChatError, ChatMessage,
  ConversationListenRequest, ConversationSource, ConversationState,
  DragMove, HitRegions, LegacyScanResult, MemoryEntry, ModeChangedEvent, MotionClipManifest,
  Persona, ProviderPublic, Result, SettingsPatch, StageCommand, StageSnapshot, TtsStateEvent,
  WindowMode, WindowState,
  /** ★ 桌宠窗口（呼出 / 收回 / 常驻）与界面动作 —— 2026-10-09 完善轮 */
  PetControlRequest, PetMenuState, UiActionRequest, UiActionRequestInput,
} from '@airimate/shared'

/**
 * 「谁发起」的取值。
 *
 * ⚠ 不能写 `PetControlRequest['source']` 之外的自造联合：
 *   主进程的 zod 枚举是**唯一真源**，这里再造一份就等于第二份契约（本项目反复踩过契约漂移）。
 *   `NonNullable` 是为了在缺省参数（`undefined`）下仍然拿到枚举本身。
 */
type PetControlSource = NonNullable<PetControlRequest['source']>

/** 与 @airimate/shared 的 IPC 常量逐条比对（防内联漂移） */
export function assertContract(expected: Record<string, string>): void {
  for (const [key, value] of Object.entries(CHANNELS)) {
    if (expected[key] !== value) {
      throw new Error(`IPC 契约漂移：CHANNELS.${key}=${value} 但 shared.IPC.${key}=${String(expected[key])}`)
    }
  }
}

/**
 * 内联通道名（必须与 packages/shared/src/ipc.ts 的 IPC 完全一致）。
 *
 * ⚠ 导出它是为了**可被机械比对**：单测（`test/m1-contract.test.cjs`）会拿它与
 *   `shared.IPC` 双向对比 —— 只靠 `assertContract()` 能证明"preload 里有的都对"，
 *   证明不了"shared 里有的 preload 也有"（后者会静默失效，正是最难查的那种）。
 *   沙箱里 preload 只执行 `contextBridge.exposeInMainWorld`，多一个导出不影响安全面。
 */
export const CHANNELS = {
  APP_DIAGNOSTICS: 'app:diagnostics',
  APP_QUIT: 'app:quit',
  APP_SHOW: 'app:show',
  APP_HIDE: 'app:hide',
  APP_STARTUP_GET: 'app:startup:get',
  APP_STARTUP_SET: 'app:startup:set',
  APP_STARTUP_AUDIT: 'app:startup:audit',
  LEGACY_SCAN: 'legacy:scan',

  ONBOARDING_GET: 'onboarding:get',
  ONBOARDING_SET_STEP: 'onboarding:set-step',
  ONBOARDING_COMPLETE: 'onboarding:complete',
  ONBOARDING_RESET: 'onboarding:reset',

  SCHEDULE_LIST: 'schedule:list',
  SCHEDULE_UPSERT: 'schedule:upsert',
  SCHEDULE_DELETE: 'schedule:delete',
  REMINDER_LIST: 'reminder:list',
  REMINDER_UPSERT: 'reminder:upsert',
  REMINDER_DELETE: 'reminder:delete',
  REMINDER_ACK: 'reminder:ack',
  QUIET_GET: 'quiet:get',
  QUIET_SET: 'quiet:set',
  QUIET_POLICY_SET: 'quiet:policy:set',
  PERMISSION_LIST: 'permission:list',
  PERMISSION_SET: 'permission:set',
  ACTIVITY_STATS: 'activity:stats',
  PROACTIVE_TICK: 'proactive:tick',
  PROACTIVE_RADIO: 'proactive:radio',
  PROACTIVE_STATUS: 'proactive:status',
  PROACTIVE_INBOX: 'proactive:inbox',

  PRIVACY_EXPORT: 'privacy:export',
  PRIVACY_WIPE: 'privacy:wipe',
  PRIVACY_SUMMARY: 'privacy:summary',

  KIT_CAPABILITIES: 'kit:capabilities',
  KIT_ASSETS: 'kit:assets',
  KIT_TOOL_AUDIT: 'kit:tool-audit',
  KIT_STORES: 'kit:stores',

  VOICE_STATUS: 'voice:status',
  VOICE_CONFIG: 'voice:config',
  VOICE_STOP: 'voice:stop',
  VOICE_PROBE: 'voice:probe',
  VOICE_LISTEN_ONCE: 'voice:listen-once',
  VOICE_CALL_START: 'voice:call-start',
  VOICE_CALL_STOP: 'voice:call-stop',
  VOICE_CALL_INTERRUPT: 'voice:call-interrupt',
  VOICE_CALL_STATE: 'voice:call-state',
  /** ★ 闭环读数（A4）：桥是否接上 / 待机监听是否在跑 / 四段是否具备条件 */
  VOICE_LOOP_STATUS: 'voice:loop-status',
  /** ★ 待机听唤醒开关（A4）：打开需要识别与唤醒**两个**开关都为真 */
  VOICE_WAKE_WATCH: 'voice:wake-watch',

  SCREEN_STATUS: 'screen:status',
  SCREEN_PAUSE: 'screen:pause',
  SCREEN_NOTICE: 'screen:notice',
  FS_ALLOWLIST: 'fs:allowlist',
  FS_ALLOW_DIR: 'fs:allow-dir',
  FS_REVOKE_DIR: 'fs:revoke-dir',
  TOOL_CONFIRM_RESULT: 'tool:confirm-result',

  REFLECTION_STATUS: 'reflection:status',
  REFLECTION_RUN: 'reflection:run',
  REFLECTION_HISTORY: 'reflection:history',
  REFLECTION_DAY: 'reflection:day',
  REFLECTION_PENDING: 'reflection:pending',
  REFLECTION_DECIDE: 'reflection:decide',
  REFLECTION_CLEAR: 'reflection:clear',

  WINDOW_GET_MODE: 'window:get-mode',
  WINDOW_SET_MODE: 'window:set-mode',
  WINDOW_SET_ALWAYS_ON_TOP: 'window:set-always-on-top',
  WINDOW_CENTER: 'window:center',
  WINDOW_DRAG_BEGIN: 'window:drag-begin',
  WINDOW_DRAG_MOVE: 'window:drag-move',
  WINDOW_DRAG_END: 'window:drag-end',
  WINDOW_AUTO_RESIZE: 'window:auto-resize',
  /** ★ 最小化**发起调用的那个窗口**（2026-10-08：chat 窗口是自绘标题栏，没有系统按钮） */
  WINDOW_MINIMIZE: 'window:minimize',

  // ── ★★ 桌宠窗口的显示 / 收回 / 常驻（2026-10-09 完善轮）
  PET_SHOW: 'pet:show',
  PET_HIDE: 'pet:hide',
  PET_TOGGLE: 'pet:toggle',
  PET_OPEN_PANEL: 'pet:open-panel',
  PET_SET_RESIDENT: 'pet:set-resident',
  PET_FLUSH_SETTINGS: 'pet:flush-settings',

  CONVERSATION_OPEN: 'conversation:open',
  CONVERSATION_CLOSE: 'conversation:close',
  CONVERSATION_STATE: 'conversation:state',
  /** ★ 桌宠自身的右键菜单（原生菜单，动作全部在主进程；renderer 只能说"用户右键了"） */
  PET_MENU: 'pet:menu',
  /** ★ 界面动作（renderer → main）：请求打开某个管理页 */
  UI_ACTION: 'ui:action',

  SETTINGS_GET: 'settings:get',
  SETTINGS_PATCH: 'settings:patch',

  PROVIDER_LIST: 'provider:list',
  PROVIDER_UPSERT: 'provider:upsert',
  PROVIDER_DELETE: 'provider:delete',
  PROVIDER_TEST: 'provider:test',
  PROVIDER_SELECT: 'provider:select',
  PROVIDER_MODELS: 'provider:models',

  PERSONA_GET: 'persona:get',
  PERSONA_SET: 'persona:set',

  CHAT_SEND: 'chat:send',
  CHAT_ABORT: 'chat:abort',
  CHAT_HISTORY: 'chat:history',
  CHAT_CLEAR: 'chat:clear',
  CHAT_CONTEXT_RESET: 'chat:context-reset',
  CHAT_OPEN_DATA_DIR: 'chat:open-data-dir',
  /** ★ 重启应用（桌宠右键菜单） */
  APP_RESTART: 'app:restart',

  MEMORY_LIST: 'memory:list',
  MEMORY_ADD: 'memory:add',
  MEMORY_UPDATE: 'memory:update',
  MEMORY_DELETE: 'memory:delete',
  MEMORY_RECALL: 'memory:recall',
  MEMORY_RECALL_PREVIEW: 'memory:recall-preview',
  MEMORY_SEARCH: 'memory:search',

  TTS_SPEAK: 'tts:speak',
  TTS_STOP: 'tts:stop',
  TTS_VOICES: 'tts:voices',

  MOTION_LIST: 'motion:list',
  MOTION_RELOAD: 'motion:reload',
  AVATAR_CATALOG: 'avatar:catalog',

  HIT_REGIONS: 'hitregions:update',
  TELEMETRY: 'telemetry:report',
  STAGE_SNAPSHOT: 'stage:snapshot',

  EVT_STAGE_COMMAND: 'evt:stage-command',
  EVT_CHAT_DELTA: 'evt:chat-delta',
  EVT_CHAT_DONE: 'evt:chat-done',
  EVT_CHAT_ERROR: 'evt:chat-error',
  EVT_WINDOW_STATE: 'evt:window-state',
  EVT_MODE_CHANGED: 'evt:mode-changed',
  EVT_TTS_AUDIO: 'evt:tts-audio',
  EVT_TTS_STATE: 'evt:tts-state',
  EVT_ALERT: 'evt:alert',
  EVT_SETTINGS_CHANGED: 'evt:settings-changed',
  EVT_DRAG_POS: 'evt:drag-pos',
  EVT_PROACTIVE: 'evt:proactive',
  EVT_ACTIVITY: 'evt:activity',
  EVT_REMINDER_QUEUE: 'evt:reminder-queue',
  EVT_SCREEN_NOTICE: 'evt:screen-notice',
  EVT_VOICE_NOTICE: 'evt:voice-notice',
  EVT_TOOL_CONFIRM: 'evt:tool-confirm',
  EVT_VOICE_CALL: 'evt:voice-call',
  EVT_CONVERSATION_STATE: 'evt:conversation-state',
  EVT_CONVERSATION_LISTEN: 'evt:conversation-listen',
  /** ★ 界面动作请求（打开记忆页 / 日程 / 偏好 / 语音 / 快捷键一览 / 关于） */
  EVT_UI_ACTION: 'evt:ui-action',
  /** ★ 桌宠菜单状态快照（三处菜单的勾选同步靠它） */
  EVT_PET_MENU_STATE: 'evt:pet-menu-state',
} as const

const CONTRACT_VERSION = '1.0.0'

type InvokeResult = Result & Record<string, unknown>

async function inv<T extends InvokeResult>(channel: string, payload?: unknown): Promise<T> {
  return await ipcRenderer.invoke(channel, payload) as T
}

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: unknown, payload: unknown): void => cb(payload as T)
  ipcRenderer.on(channel, handler)
  return () => { ipcRenderer.removeListener(channel, handler) }
}

let hitSeq = 0

const api: AiriMateApi = {
  contractVersion: CONTRACT_VERSION,
  platform: process.platform,
  appVersion: '',

  diagnostics: () => inv<Result & { diagnostics: AppDiagnostics & { stage: StageSnapshot | null } }>(CHANNELS.APP_DIAGNOSTICS).then(r => (r.diagnostics ?? ({} as never))),
  show: () => inv(CHANNELS.APP_SHOW),
  hide: () => inv(CHANNELS.APP_HIDE),
  quit: () => inv(CHANNELS.APP_QUIT),
  /** ★ 重启应用（先排程拉起新进程，再退出当前进程 —— 顺序由主进程保证） */
  restart: () => inv(CHANNELS.APP_RESTART),

  startupGet: () => inv(CHANNELS.APP_STARTUP_GET),
  startupSet: (enabled: boolean) => inv(CHANNELS.APP_STARTUP_SET, { enabled }),
  legacyScan: () => inv<Result & { result?: LegacyScanResult }>(CHANNELS.LEGACY_SCAN),

  getMode: () => inv(CHANNELS.WINDOW_GET_MODE),
  setMode: (mode: WindowMode, center = false) => inv(CHANNELS.WINDOW_SET_MODE, { mode, center }),
  setAlwaysOnTop: (on: boolean) => inv(CHANNELS.WINDOW_SET_ALWAYS_ON_TOP, { on }),
  center: () => inv(CHANNELS.WINDOW_CENTER),
  dragBegin: (cursor: { x: number, y: number }) => inv(CHANNELS.WINDOW_DRAG_BEGIN, { cursor, windowOrigin: { x: 0, y: 0 } }),
  dragMove: (cursor: DragMove) => { ipcRenderer.send(CHANNELS.WINDOW_DRAG_MOVE, cursor) },
  dragEnd: () => inv(CHANNELS.WINDOW_DRAG_END, { moved: true, distance: 0 }),
  autoResize: (width: number, height: number, anchor: 'top-left' | 'bottom-center' = 'top-left') =>
    inv(CHANNELS.WINDOW_AUTO_RESIZE, { width, height, anchor }),
  /** 最小化**本窗口**（主进程按 event.sender 反查，所以在 chat 里点只会收起 chat） */
  minimizeSelf: () => inv(CHANNELS.WINDOW_MINIMIZE),

  // ── ★★ 桌宠窗口（呼出 / 收回 / 常驻）：2026-10-09 完善轮
  petShow: (source?: PetControlSource) => inv(CHANNELS.PET_SHOW, { action: 'show', source: source ?? 'api' }),
  petHide: (source?: PetControlSource) => inv(CHANNELS.PET_HIDE, { action: 'hide', source: source ?? 'api' }),
  petToggle: (source?: PetControlSource) => inv(CHANNELS.PET_TOGGLE, { action: 'toggle', source: source ?? 'api' }),
  /** 呼出 + 切 panel 模式 + 聚焦（三件事合成一步，避免"窗口出来了形态不对"的中间态） */
  petOpenPanel: (source?: PetControlSource) => inv(CHANNELS.PET_OPEN_PANEL, { action: 'open-panel', source: source ?? 'api' }),
  /** 写「桌宠常驻」：勾上 ⇒ 显示 + 落盘；取消 ⇒ 隐藏 + 落盘（立即生效） */
  petSetResident: (resident: boolean, source?: PetControlSource) =>
    inv(CHANNELS.PET_SET_RESIDENT, { resident, source: source ?? 'api' }),
  /** 把常驻设置**立即落盘**（不等 800ms 防抖；"重启后仍生效"这条判据要用它） */
  petFlushSettings: () => inv(CHANNELS.PET_FLUSH_SETTINGS),
  /** 让主进程在鼠标位置弹出**原生**桌宠右键菜单（菜单项与动作全部在主进程里） */
  petMenu: () => inv(CHANNELS.PET_MENU),
  /** ★ 界面动作：请求打开某个管理页（真正的"切页"由 pet 窗口做） */
  uiAction: (action: UiActionRequestInput['action'], source: UiActionRequestInput['source'] = 'api') =>
    inv(CHANNELS.UI_ACTION, { action, source }),

  // ── ★ 对话（返工轮）：三条通道就是五个入口 + 气泡按钮的全部实现面
  conversationOpen: (source?: ConversationSource, listen = false, focusInput = true) =>
    inv(CHANNELS.CONVERSATION_OPEN, { source: source ?? 'api', listen, focusInput }),
  conversationClose: (source?: ConversationSource) =>
    inv(CHANNELS.CONVERSATION_CLOSE, { source: source ?? 'api' }),
  conversationState: () => inv<Result & { state?: ConversationState }>(CHANNELS.CONVERSATION_STATE),

  reportHitRegions: (payload: HitRegions) => {
    hitSeq += 1
    ipcRenderer.send(CHANNELS.HIT_REGIONS, { ...payload, seq: hitSeq })
  },

  reportStageSnapshot: (payload: StageSnapshot) => {
    ipcRenderer.send(CHANNELS.STAGE_SNAPSHOT, payload)
  },

  getSettings: () => inv<Result & { settings?: AppSettings }>(CHANNELS.SETTINGS_GET),
  patchSettings: (patch: SettingsPatch) => inv<Result & { settings?: AppSettings }>(CHANNELS.SETTINGS_PATCH, patch),

  listMotions: () => inv<Result & { manifests?: MotionClipManifest[], failed?: string[] }>(CHANNELS.MOTION_LIST),
  reloadMotions: () => inv<Result & { manifests?: MotionClipManifest[], failed?: string[] }>(CHANNELS.MOTION_RELOAD),
  avatarCatalog: () => inv(CHANNELS.AVATAR_CATALOG),

  listProviders: () => inv<Result & { backend?: string, providers?: ProviderPublic[] }>(CHANNELS.PROVIDER_LIST),
  upsertProvider: (p) => inv(CHANNELS.PROVIDER_UPSERT, p),
  deleteProvider: (id: string) => inv(CHANNELS.PROVIDER_DELETE, { id }),
  testProvider: (id: string) => inv(CHANNELS.PROVIDER_TEST, { id }),
  selectProvider: (id: string) => inv(CHANNELS.PROVIDER_SELECT, { id }),
  listProviderModels: (id: string) => inv(CHANNELS.PROVIDER_MODELS, { id }),

  // ── M1 向导
  onboardingGet: () => inv(CHANNELS.ONBOARDING_GET),
  onboardingSetStep: (step) => inv(CHANNELS.ONBOARDING_SET_STEP, { step }),
  onboardingComplete: (completed: boolean) => inv(CHANNELS.ONBOARDING_COMPLETE, { completed }),
  onboardingReset: () => inv(CHANNELS.ONBOARDING_RESET),

  // ── M1 隐私
  privacyExport: (req) => inv(CHANNELS.PRIVACY_EXPORT, req),
  privacyWipe: (req) => inv(CHANNELS.PRIVACY_WIPE, req),
  privacySummary: () => inv(CHANNELS.PRIVACY_SUMMARY),

  kitCapabilities: () => inv(CHANNELS.KIT_CAPABILITIES),
  kitAssets: () => inv(CHANNELS.KIT_ASSETS),
  kitToolAudit: () => inv(CHANNELS.KIT_TOOL_AUDIT),
  kitStores: () => inv(CHANNELS.KIT_STORES),

  // ── M3 语音（默认关闭；一键停用必须随时可用）
  voiceStatus: () => inv(CHANNELS.VOICE_STATUS),
  voiceConfig: (patch: { wakeWordEnabled?: boolean, wakeWord?: string }) => inv(CHANNELS.VOICE_CONFIG, patch),
  voiceStop: () => inv(CHANNELS.VOICE_STOP),
  voiceProbe: () => inv(CHANNELS.VOICE_PROBE),
  voiceListenOnce: (timeoutMs?: number) => inv(CHANNELS.VOICE_LISTEN_ONCE, typeof timeoutMs === 'number' ? { timeoutMs } : {}),

  // ── M3 语音通话（全链路：STT → LLM → TTS）
  voiceCallStart: () => inv(CHANNELS.VOICE_CALL_START),
  voiceCallStop: () => inv(CHANNELS.VOICE_CALL_STOP),
  voiceCallInterrupt: () => inv(CHANNELS.VOICE_CALL_INTERRUPT),
  voiceCallState: () => inv(CHANNELS.VOICE_CALL_STATE),
  /** ★ 闭环读数（A4）——**只读**，让界面能显示"闭环接上了没有" */
  voiceLoopStatus: () => inv(CHANNELS.VOICE_LOOP_STATUS),
  /** ★ 待机听唤醒开关（A4）——两条硬前置在主进程强制，这里不判断 */
  voiceWakeWatch: (enabled: boolean) => inv(CHANNELS.VOICE_WAKE_WATCH, { enabled }),

  // ── M3 屏幕理解（按需；画面内容不出主进程）
  screenStatus: () => inv(CHANNELS.SCREEN_STATUS),
  screenPause: (paused: boolean) => inv(CHANNELS.SCREEN_PAUSE, { paused }),
  screenNotice: () => inv(CHANNELS.SCREEN_NOTICE),

  // ── M3 目录白名单（出参只给 id 与末级目录名）
  fsAllowlist: () => inv(CHANNELS.FS_ALLOWLIST),
  fsAllowDir: (path: string) => inv(CHANNELS.FS_ALLOW_DIR, { path }),
  fsRevokeDir: (id: string) => inv(CHANNELS.FS_REVOKE_DIR, { id }),

  /** 确认弹窗回传（只接受当前挂起的 confirmId，防重放） */
  submitToolConfirm: (confirmId: string, approved: boolean) => inv(CHANNELS.TOOL_CONFIRM_RESULT, { confirmId, approved }),

  // ── M4 每日自学习
  reflectionStatus: () => inv(CHANNELS.REFLECTION_STATUS),
  reflectionRun: (o?: { force?: boolean, dryRun?: boolean }) =>
    inv(CHANNELS.REFLECTION_RUN, { force: o?.force ?? false, dryRun: o?.dryRun ?? false }),
  reflectionHistory: (limit?: number) => inv(CHANNELS.REFLECTION_HISTORY, typeof limit === 'number' ? { limit } : {}),
  reflectionDay: (day: string) => inv(CHANNELS.REFLECTION_DAY, { day }),
  reflectionPending: () => inv(CHANNELS.REFLECTION_PENDING),
  reflectionDecide: (day: string, itemId: string, approve: boolean) =>
    inv(CHANNELS.REFLECTION_DECIDE, { day, itemId, approve }),
  reflectionClear: () => inv(CHANNELS.REFLECTION_CLEAR),

  getPersona: () => inv<Result & { persona?: Persona | null }>(CHANNELS.PERSONA_GET),
  setPersona: (p: Persona) => inv<Result & { persona?: Persona }>(CHANNELS.PERSONA_SET, p),

  sendChat: (text: string, clientId: string) => inv<Result & { requestId?: string }>(CHANNELS.CHAT_SEND, { text, clientId }),
  abortChat: () => inv<Result & { aborted?: boolean, requestId?: string | null, receivedChars?: number }>(CHANNELS.CHAT_ABORT),
  history: () => inv<Result & { messages?: ChatMessage[], total?: number }>(CHANNELS.CHAT_HISTORY),
  clearChat: () => inv<Result & { removed?: number }>(CHANNELS.CHAT_CLEAR),
  /** ★ 只重置上下文**不删历史**（「新建对话」用它，与「清除对话」是两件事） */
  resetChatContext: () => inv(CHANNELS.CHAT_CONTEXT_RESET),
  /** ★ 打开对话数据目录（返回目录本身，便于探针机械比对） */
  openChatDataDir: () => inv(CHANNELS.CHAT_OPEN_DATA_DIR),

  listMemory: () => inv<Result & { entries?: MemoryEntry[], total?: number }>(CHANNELS.MEMORY_LIST),
  addMemory: (entry) => inv(CHANNELS.MEMORY_ADD, entry),
  updateMemory: (entry) => inv(CHANNELS.MEMORY_UPDATE, entry),
  deleteMemory: (id: string) => inv(CHANNELS.MEMORY_DELETE, { id }),
  recallMemory: (query: string, limit?: number) => inv(CHANNELS.MEMORY_RECALL, { query, ...(typeof limit === 'number' ? { limit } : {}) }),
  previewRecallMemory: (query: string, limit?: number) => inv(CHANNELS.MEMORY_RECALL_PREVIEW, { query, ...(typeof limit === 'number' ? { limit } : {}) }),
  searchMemory: (req) => inv(CHANNELS.MEMORY_SEARCH, req),

  // ── M2
  listSchedules: () => inv(CHANNELS.SCHEDULE_LIST),
  upsertSchedule: (s) => inv(CHANNELS.SCHEDULE_UPSERT, s),
  deleteSchedule: (id: string) => inv(CHANNELS.SCHEDULE_DELETE, { id }),

  listReminders: () => inv(CHANNELS.REMINDER_LIST),
  upsertReminder: (r) => inv(CHANNELS.REMINDER_UPSERT, r),
  deleteReminder: (id: string) => inv(CHANNELS.REMINDER_DELETE, { id }),
  ackReminder: (id: string, acked = true) => inv(CHANNELS.REMINDER_ACK, { id, acked }),

  getQuiet: () => inv(CHANNELS.QUIET_GET),
  setQuiet: (patch) => inv(CHANNELS.QUIET_SET, patch),
  setReminderPolicy: (patch) => inv(CHANNELS.QUIET_POLICY_SET, patch),

  listPermissions: () => inv(CHANNELS.PERMISSION_LIST),
  setPermission: (patch) => inv(CHANNELS.PERMISSION_SET, patch),

  activityStats: () => inv(CHANNELS.ACTIVITY_STATS),
  proactiveStatus: () => inv(CHANNELS.PROACTIVE_STATUS),
  proactiveInbox: () => inv(CHANNELS.PROACTIVE_INBOX),
  proactiveTick: () => inv(CHANNELS.PROACTIVE_TICK),
  triggerRadio: (opts) => inv(CHANNELS.PROACTIVE_RADIO, { force: opts?.force ?? false, speak: opts?.speak ?? false }),

  speak: (text: string, utteranceId: string) => inv(CHANNELS.TTS_SPEAK, { text, utteranceId }),
  stopSpeak: () => inv(CHANNELS.TTS_STOP),
  listVoices: () => inv<Result & {
    engine?: string
    voices?: Array<{ id: string, label: string, lang: string, gender: string | null }>
    selected?: string | null
    preferred?: string | null
    preferredMissing?: boolean
  }>(CHANNELS.TTS_VOICES),

  onStageCommand: (cb: (cmd: StageCommand) => void) => on<StageCommand>(CHANNELS.EVT_STAGE_COMMAND, cb),
  onAlert: (cb: (a: Alert) => void) => on<Alert>(CHANNELS.EVT_ALERT, cb),
  onChatDelta: (cb: (d: ChatDelta) => void) => on<ChatDelta>(CHANNELS.EVT_CHAT_DELTA, cb),
  onChatDone: (cb: (d: ChatDone) => void) => on<ChatDone>(CHANNELS.EVT_CHAT_DONE, cb),
  onChatError: (cb: (e: ChatError) => void) => on<ChatError>(CHANNELS.EVT_CHAT_ERROR, cb),
  onModeChanged: (cb: (e: ModeChangedEvent) => void) => on<ModeChangedEvent>(CHANNELS.EVT_MODE_CHANGED, cb),
  onWindowState: (cb: (s: WindowState) => void) => on<WindowState>(CHANNELS.EVT_WINDOW_STATE, cb),
  onDragPos: (cb) => on(CHANNELS.EVT_DRAG_POS, cb),
  onTtsState: (cb: (s: TtsStateEvent) => void) => on<TtsStateEvent>(CHANNELS.EVT_TTS_STATE, cb),
  onSettingsChanged: (cb: (s: AppSettings) => void) => on<AppSettings>(CHANNELS.EVT_SETTINGS_CHANGED, cb),
  onProactive: (cb) => on(CHANNELS.EVT_PROACTIVE, cb),
  onActivity: (cb) => on(CHANNELS.EVT_ACTIVITY, cb),
  onReminderQueue: (cb) => on(CHANNELS.EVT_REMINDER_QUEUE, cb),
  /** M3：截图前提示（用户要求"截图前显示提示"） */
  onScreenNotice: (cb) => on(CHANNELS.EVT_SCREEN_NOTICE, cb),
  /** M3：语音事件（监听开始/停止、唤醒、听到一句、错误）——**不含识别正文** */
  onVoiceNotice: (cb) => on(CHANNELS.EVT_VOICE_NOTICE, cb),
  /** M3：某个工具需要用户确认（confirm 档） */
  onToolConfirm: (cb) => on(CHANNELS.EVT_TOOL_CONFIRM, cb),
  /** M3：语音通话进度；`replyText` 只有这一条事件带（用于气泡显示） */
  onVoiceCall: (cb) => on(CHANNELS.EVT_VOICE_CALL, cb),
  /** ★ 对话状态（托盘 / 快捷键 / 唤醒改了它，界面必须收到） */
  onConversationState: (cb: (s: ConversationState) => void) => on<ConversationState>(CHANNELS.EVT_CONVERSATION_STATE, cb),
  /** ★ 唤醒词触发的"开始听"（renderer 用它去调已有的 voice:listen-once） */
  onConversationListen: (cb: (r: ConversationListenRequest) => void) => on<ConversationListenRequest>(CHANNELS.EVT_CONVERSATION_LISTEN, cb),
  /** ★ 界面动作请求（打开某个管理页 / 快捷键一览 / 关于） */
  onUiAction: (cb: (r: UiActionRequest) => void) => on<UiActionRequest>(CHANNELS.EVT_UI_ACTION, cb),
  /** ★ 桌宠菜单状态快照（三处菜单勾选同步的唯一来源） */
  onPetMenuState: (cb: (s: PetMenuState) => void) => on<PetMenuState>(CHANNELS.EVT_PET_MENU_STATE, cb),
}

contextBridge.exposeInMainWorld('airimate', Object.freeze(api))
