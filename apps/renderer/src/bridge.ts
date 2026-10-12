/**
 * apps/renderer/src/bridge.ts —— preload API 的类型化薄封装
 *
 * 目的：把 `Result` 判别联合在**一处**收敛成"成功取值 / 失败抛出可读错误"，
 * 避免每个调用点重复写 `if (!r.ok)`，也避免把失败当成成功。
 *
 * 同时是 renderer 侧唯一允许接触 `window.airimate` 的地方（便于审计）。
 */

export interface BridgeFailure {
  code: string
  message: string
}

export class BridgeError extends Error {
  readonly code: string
  constructor(f: BridgeFailure) {
    super(f.message)
    this.name = 'BridgeError'
    this.code = f.code
  }
}

function api(): NonNullable<Window['airimate']> {
  const a = window.airimate
  if (!a) throw new BridgeError({ code: 'PRELOAD_MISSING', message: 'preload 桥未就绪（window.airimate 不存在）' })
  return a
}

/** 断言 Result 成功并返回带附加字段的对象 */
export function assertOk<T extends { ok: boolean, code?: string, message?: string }>(r: T): T {
  if (!r.ok) throw new BridgeError({ code: r.code ?? 'UNKNOWN', message: r.message ?? '未知失败' })
  return r
}

/** 统一的调用包装：失败抛出 BridgeError（调用方用 try/catch 显示可见告警） */
export async function call<T extends { ok: boolean, code?: string, message?: string }>(fn: () => Promise<T>): Promise<T> {
  try {
    const r = await fn()
    return assertOk(r)
  } catch (e) {
    if (e instanceof BridgeError) throw e
    throw new BridgeError({ code: 'IPC_FAILED', message: e instanceof Error ? e.message : String(e) })
  }
}

export const bridge = {
  contractVersion: (): string => api().contractVersion,
  /** ★ 应用版本（「帮助 → 关于」显示用；preload 的只读字段） */
  appVersion: (): string => api().appVersion,
  platform: (): string => api().platform,
  diagnostics: () => call(() => api().diagnostics() as Promise<never>),
  show: () => call(() => api().show()),
  hide: () => call(() => api().hide()),
  quit: () => call(() => api().quit()),
  /** ★ 重启应用（先由主进程排程拉起新进程，再走正常退出流程） */
  restart: () => call(() => api().restart()),

  startupGet: () => call(() => api().startupGet()),
  startupSet: (on: boolean) => call(() => api().startupSet(on)),
  legacyScan: () => call(() => api().legacyScan()),

  getMode: () => call(() => api().getMode()),
  setMode: (mode: 'panel' | 'pet', center = false) => call(() => api().setMode(mode, center)),
  setAlwaysOnTop: (on: boolean) => call(() => api().setAlwaysOnTop(on)),
  center: () => call(() => api().center()),
  dragBegin: (cursor: { x: number, y: number }) => call(() => api().dragBegin(cursor)),
  dragMove: (cursor: { x: number, y: number }) => api().dragMove(cursor),
  dragEnd: () => call(() => api().dragEnd()),
  autoResize: (w: number, h: number, anchor: 'top-left' | 'bottom-center' = 'top-left') =>
    call(() => api().autoResize(w, h, anchor)),
  /**
   * 最小化**发起调用的那个窗口**。
   * chat 窗口是 `frame:false` 的自绘标题栏 ⇒ 没有系统最小化按钮，必须由界面提供。
   * 主进程按 `event.sender` 反查窗口，所以在 chat 里点它只会收起 chat。
   */
  minimizeSelf: () => call(() => api().minimizeSelf()),

  // ── ★★ 桌宠窗口：呼出 / 收回 / 常驻（2026-10-09 完善轮）
  /**
   * 三处菜单（对话窗口菜单栏 / 托盘 / 桌宠右键）**共用这一组调用**。
   * ⚠ 托盘那一侧走的是主进程内部的同一组函数（`pet-visibility.ts`），不是这条通道 ——
   *   但两者的**行为实现是同一份**，所以不可能出现"托盘点了会落盘、菜单点了不落盘"。
   */
  petShow: (source?: Parameters<NonNullable<Window['airimate']>['petShow']>[0]) => call(() => api().petShow(source)),
  petHide: (source?: Parameters<NonNullable<Window['airimate']>['petHide']>[0]) => call(() => api().petHide(source)),
  petToggle: (source?: Parameters<NonNullable<Window['airimate']>['petToggle']>[0]) => call(() => api().petToggle(source)),
  /** 呼出 + 切 panel 模式 + 聚焦（三步合成，避免"窗口出来了形态不对"的中间态） */
  petOpenPanel: (source?: Parameters<NonNullable<Window['airimate']>['petOpenPanel']>[0]) => call(() => api().petOpenPanel(source)),
  /** 写「桌宠常驻」并**立即生效 + 落盘** */
  petSetResident: (resident: boolean, source?: Parameters<NonNullable<Window['airimate']>['petSetResident']>[1]) =>
    call(() => api().petSetResident(resident, source)),
  petFlushSettings: () => call(() => api().petFlushSettings()),
  /** 让主进程在鼠标位置弹出**原生**桌宠右键菜单（菜单项与动作全部在主进程里） */
  petMenu: () => call(() => api().petMenu()),
  /** ★ 界面动作：打开某个管理页（记忆 / 日程 / 偏好 / 语音 / 快捷键 / 关于） */
  uiAction: (action: Parameters<NonNullable<Window['airimate']>['uiAction']>[0], source: Parameters<NonNullable<Window['airimate']>['uiAction']>[1] = 'api') =>
    call(() => api().uiAction(action, source)),

  // ── ★ 对话（返工轮）：**独立 chat 窗口**，五个入口 + 气泡按钮全部走这三条通道
  conversationOpen: (
    source?: Parameters<NonNullable<Window['airimate']>['conversationOpen']>[0],
    listen = false,
    focusInput = true,
  ) => call(() => api().conversationOpen(source, listen, focusInput)),
  conversationClose: (source?: Parameters<NonNullable<Window['airimate']>['conversationClose']>[0]) =>
    call(() => api().conversationClose(source)),
  conversationState: () => call(() => api().conversationState()),

  getSettings: () => call(() => api().getSettings()),
  patchSettings: (patch: Record<string, unknown>) => call(() => api().patchSettings(patch as never)),

  listMotions: () => call(() => api().listMotions()),
  reloadMotions: () => call(() => api().reloadMotions()),
  avatarCatalog: () => call(() => api().avatarCatalog()),

  listProviders: () => call(() => api().listProviders()),
  upsertProvider: (p: Record<string, unknown>) => call(() => api().upsertProvider(p as never)),
  deleteProvider: (id: string) => call(() => api().deleteProvider(id)),
  testProvider: (id: string) => call(() => api().testProvider(id)),
  selectProvider: (id: string) => call(() => api().selectProvider(id)),
  listProviderModels: (id: string) => call(() => api().listProviderModels(id)),

  onboardingGet: () => call(() => api().onboardingGet()),
  onboardingSetStep: (step: Parameters<NonNullable<Window['airimate']>['onboardingSetStep']>[0]) => call(() => api().onboardingSetStep(step)),
  onboardingComplete: (completed: boolean) => call(() => api().onboardingComplete(completed)),
  onboardingReset: () => call(() => api().onboardingReset()),

  privacyExport: (req: Parameters<NonNullable<Window['airimate']>['privacyExport']>[0]) => call(() => api().privacyExport(req)),
  privacyWipe: (req: Parameters<NonNullable<Window['airimate']>['privacyWipe']>[0]) => call(() => api().privacyWipe(req)),
  privacySummary: () => call(() => api().privacySummary()),

  // ── 适配层（M5 §1）：只读，用于"能力"页显示现在到底在用哪个实现
  kitCapabilities: () => call(() => api().kitCapabilities()),
  kitAssets: () => call(() => api().kitAssets()),
  kitToolAudit: () => call(() => api().kitToolAudit()),
  kitStores: () => call(() => api().kitStores()),

  // ── M3 语音（默认关闭；一键停用必须随时可用）
  voiceStatus: () => call(() => api().voiceStatus()),
  voiceConfig: (patch: { wakeWordEnabled?: boolean, wakeWord?: string }) => call(() => api().voiceConfig(patch)),
  voiceStop: () => call(() => api().voiceStop()),
  voiceProbe: () => call(() => api().voiceProbe()),
  voiceListenOnce: (timeoutMs?: number) => call(() => api().voiceListenOnce(timeoutMs)),

  // ── M3 语音通话（全链路：STT → LLM → TTS）
  voiceCallStart: () => call(() => api().voiceCallStart()),
  voiceCallStop: () => call(() => api().voiceCallStop()),
  voiceCallInterrupt: () => call(() => api().voiceCallInterrupt()),
  voiceCallState: () => call(() => api().voiceCallState()),
  /** ★ 闭环读数（A4）——只读，用于界面显示"闭环接上了没有" */
  voiceLoopStatus: () => call(() => api().voiceLoopStatus()),
  /** ★ 待机听唤醒开关（A4）——两条硬前置在主进程强制，这里只转发 */
  voiceWakeWatch: (enabled: boolean) => call(() => api().voiceWakeWatch(enabled)),

  // ── M3 屏幕理解（按需；画面内容不出主进程）
  screenStatus: () => call(() => api().screenStatus()),
  screenPause: (paused: boolean) => call(() => api().screenPause(paused)),
  screenNotice: () => call(() => api().screenNotice()),

  // ── M3 目录白名单（出参只给 id 与末级目录名）
  fsAllowlist: () => call(() => api().fsAllowlist()),
  fsAllowDir: (path: string) => call(() => api().fsAllowDir(path)),
  fsRevokeDir: (id: string) => call(() => api().fsRevokeDir(id)),

  submitToolConfirm: (confirmId: string, approved: boolean) => call(() => api().submitToolConfirm(confirmId, approved)),

  // ── M4 每日自学习
  reflectionStatus: () => call(() => api().reflectionStatus()),
  reflectionRun: (o?: { force?: boolean, dryRun?: boolean }) => call(() => api().reflectionRun(o)),
  reflectionHistory: (limit?: number) => call(() => api().reflectionHistory(limit)),
  reflectionDay: (day: string) => call(() => api().reflectionDay(day)),
  reflectionPending: () => call(() => api().reflectionPending()),
  reflectionDecide: (day: string, itemId: string, approve: boolean) => call(() => api().reflectionDecide(day, itemId, approve)),
  reflectionClear: () => call(() => api().reflectionClear()),

  getPersona: () => call(() => api().getPersona()),
  setPersona: (p: Record<string, unknown>) => call(() => api().setPersona(p as never)),

  sendChat: (text: string, clientId: string) => call(() => api().sendChat(text, clientId)),
  abortChat: () => call(() => api().abortChat()),
  history: () => call(() => api().history()),
  clearChat: () => call(() => api().clearChat()),
  /** ★ 只重置上下文**不删历史**（「新建对话」用它，与「清除对话」是两件事） */
  resetChatContext: () => call(() => api().resetChatContext()),
  /** ★ 打开对话数据目录（出参含目录本身，便于探针机械比对） */
  openChatDataDir: () => call(() => api().openChatDataDir()),

  listMemory: () => call(() => api().listMemory()),
  addMemory: (e: { text: string, tags?: string[], importance?: number }) => call(() => api().addMemory(e)),
  updateMemory: (e: { id: string, text?: string, tags?: string[], importance?: number }) => call(() => api().updateMemory(e)),
  deleteMemory: (id: string) => call(() => api().deleteMemory(id)),
  recallMemory: (query: string, limit?: number) => call(() => api().recallMemory(query, limit)),
  previewRecallMemory: (query: string, limit?: number) => call(() => api().previewRecallMemory(query, limit)),
  searchMemory: (req: Parameters<NonNullable<Window['airimate']>['searchMemory']>[0]) => call(() => api().searchMemory(req)),

  listSchedules: () => call(() => api().listSchedules()),
  upsertSchedule: (s: Record<string, unknown>) => call(() => api().upsertSchedule(s)),
  deleteSchedule: (id: string) => call(() => api().deleteSchedule(id)),

  listReminders: () => call(() => api().listReminders()),
  upsertReminder: (r: Record<string, unknown>) => call(() => api().upsertReminder(r)),
  deleteReminder: (id: string) => call(() => api().deleteReminder(id)),
  ackReminder: (id: string, acked = true) => call(() => api().ackReminder(id, acked)),

  getQuiet: () => call(() => api().getQuiet()),
  setQuiet: (patch: Record<string, unknown>) => call(() => api().setQuiet(patch)),
  setReminderPolicy: (patch: Record<string, unknown>) => call(() => api().setReminderPolicy(patch)),

  listPermissions: () => call(() => api().listPermissions()),
  setPermission: (patch: Record<string, unknown>) => call(() => api().setPermission(patch)),

  activityStats: () => call(() => api().activityStats()),
  proactiveStatus: () => call(() => api().proactiveStatus()),
  proactiveInbox: () => call(() => api().proactiveInbox()),
  proactiveTick: () => call(() => api().proactiveTick()),
  triggerRadio: (opts?: { force?: boolean, speak?: boolean }) => call(() => api().triggerRadio(opts)),

  speak: (text: string, utteranceId: string) => call(() => api().speak(text, utteranceId)),
  stopSpeak: () => call(() => api().stopSpeak()),
  listVoices: () => call(() => api().listVoices()),

  onStageCommand: (cb: Parameters<NonNullable<Window['airimate']>['onStageCommand']>[0]) => api().onStageCommand(cb),
  onAlert: (cb: Parameters<NonNullable<Window['airimate']>['onAlert']>[0]) => api().onAlert(cb),
  onChatDelta: (cb: Parameters<NonNullable<Window['airimate']>['onChatDelta']>[0]) => api().onChatDelta(cb),
  onChatDone: (cb: Parameters<NonNullable<Window['airimate']>['onChatDone']>[0]) => api().onChatDone(cb),
  onChatError: (cb: Parameters<NonNullable<Window['airimate']>['onChatError']>[0]) => api().onChatError(cb),
  onModeChanged: (cb: Parameters<NonNullable<Window['airimate']>['onModeChanged']>[0]) => api().onModeChanged(cb),
  onSettingsChanged: (cb: Parameters<NonNullable<Window['airimate']>['onSettingsChanged']>[0]) => api().onSettingsChanged(cb),
  onTtsState: (cb: Parameters<NonNullable<Window['airimate']>['onTtsState']>[0]) => api().onTtsState(cb),
  onProactive: (cb: Parameters<NonNullable<Window['airimate']>['onProactive']>[0]) => api().onProactive(cb),
  onActivity: (cb: Parameters<NonNullable<Window['airimate']>['onActivity']>[0]) => api().onActivity(cb),
  onReminderQueue: (cb: Parameters<NonNullable<Window['airimate']>['onReminderQueue']>[0]) => api().onReminderQueue(cb),
  onScreenNotice: (cb: Parameters<NonNullable<Window['airimate']>['onScreenNotice']>[0]) => api().onScreenNotice(cb),
  onVoiceNotice: (cb: Parameters<NonNullable<Window['airimate']>['onVoiceNotice']>[0]) => api().onVoiceNotice(cb),
  onToolConfirm: (cb: Parameters<NonNullable<Window['airimate']>['onToolConfirm']>[0]) => api().onToolConfirm(cb),
  onVoiceCall: (cb: Parameters<NonNullable<Window['airimate']>['onVoiceCall']>[0]) => api().onVoiceCall(cb),
  /** ★ 对话状态（托盘 / 快捷键 / 唤醒都能改它） */
  onConversationState: (cb: Parameters<NonNullable<Window['airimate']>['onConversationState']>[0]) => api().onConversationState(cb),
  /** ★ 唤醒词触发的"开始听" */
  onConversationListen: (cb: Parameters<NonNullable<Window['airimate']>['onConversationListen']>[0]) => api().onConversationListen(cb),
  /** ★ 界面动作请求（main → pet 窗口）：打开某个管理页 / 快捷键一览 / 关于 */
  onUiAction: (cb: Parameters<NonNullable<Window['airimate']>['onUiAction']>[0]) => api().onUiAction(cb),
  /** ★ 桌宠菜单状态快照（三处菜单勾选同步的唯一来源） */
  onPetMenuState: (cb: Parameters<NonNullable<Window['airimate']>['onPetMenuState']>[0]) => api().onPetMenuState(cb),

  reportHitRegions: (payload: Parameters<NonNullable<Window['airimate']>['reportHitRegions']>[0]) => api().reportHitRegions(payload),
  reportStageSnapshot: (payload: Parameters<NonNullable<Window['airimate']>['reportStageSnapshot']>[0]) => api().reportStageSnapshot(payload),
  onDragPos: (cb: Parameters<NonNullable<Window['airimate']>['onDragPos']>[0]) => api().onDragPos(cb),
}
