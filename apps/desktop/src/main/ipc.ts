/**
 * apps/desktop/src/main/ipc.ts —— 白名单 IPC 路由器（Tech-Spec §7.1）
 *
 * 纪律：
 *   ① 只注册 `@airimate/shared` 里 `IPC` 常量列出的通道；未注册通道不会被监听；
 *   ② 每个 handler 先做**运行时 schema 校验**，失败即拒绝（返回 ErrSchema，不抛给 renderer）；
 *   ③ 只接受本应用主窗口的 webContents 发来的消息（来源校验）；
 *   ④ main→renderer 方向同样先校验再 send；
 *   ⑤ 日志脱敏：失败只记通道名与字段路径，不记原值。
 */
import { BrowserWindow, Menu, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import {
  AlertSchema, AlwaysOnTopRequestSchema, AutoResizeRequestSchema, ChatDeltaSchema, ChatDoneSchema, ChatErrorSchema, ChatSendRequestSchema, parseStageCommand,
  ConversationCloseRequestSchema, ConversationOpenRequestSchema, ConversationStateSchema,
  DragBeginRequestSchema, DragEndRequestSchema, DragMoveSchema, HitRegionsSchema, IPC,
  MemoryAddRequestSchema, MemoryDeleteRequestSchema, MemoryRecallRequestSchema, MemorySearchRequestSchema, MemoryUpdateRequestSchema,
  OnboardingCompleteSchema, OnboardingSetStepSchema,
  PersonaSchema as PersonaContractSchema,
  PrivacyExportRequestSchema, PrivacyWipeRequestSchema,
  ProactiveEventSchema, ProactiveRadioRequestSchema,
  ProviderSelectSchema, ProviderUpsertSchema, QuietHoursSetSchema, ReminderAckSchema, ReminderDeleteSchema, ReminderPolicySetSchema,
  ReminderUpsertSchema, ScheduleDeleteSchema, ScheduleUpsertSchema, SetModeRequestSchema, SettingsPatchSchema, StageSnapshotSchema, TtsStateEventSchema,
  // ── ★ 桌宠常驻与呼出（2026-10-09 完善轮）
  PetControlRequestSchema, PetResidentRequestSchema, UiActionRequestSchema, UiActionRequestInputSchema, PetMenuStateSchema,
  // ── M3
  FsAllowDirRequestSchema, FsRevokeDirRequestSchema, ScreenPauseRequestSchema,
  ToolConfirmResultSchema, VoiceConfigRequestSchema, VoiceListenRequestSchema, VoiceWakeWatchRequestSchema,
  // ── M4
  ReflectionDecideSchema, ReflectionRunSchema,
} from '@airimate/shared'
import type { Alert, PetMenuState, ProactiveEvent, Result, StageCommand, TtsStateEvent, UiAction } from '@airimate/shared'
import { appPaths } from './paths.js'
import { log } from './log.js'
import {
  applyMode, autoResize, beginDrag, centerWindow, dragTo, endDrag,
  getWindow, hideWindow, sessionMode, setAlwaysOnTop, showWindow, windowBounds, windowMode,
} from './window-manager.js'
import {
  announceConversationState, applyConversationSettings, closeConversation, conversationState,
  openConversation,
} from './conversation.js'
import { hitRegions } from './hit-region-registry.js'
import { broadcast as broadcastImpl } from './event-sink.js'
import { petMenuState, setPetResident, showPet, togglePet, hidePet } from './pet-visibility.js'
import { collectDiagnostics } from './diagnostics.js'
import { loadSettings, patchSettings, mergeSettings, flushSettings } from './settings-store.js'
import { scanLegacyInstances } from './legacy-guard.js'
import { setLastLegacyScan } from './legacy-state.js'
import { loadManifests, refreshMotionStatus } from './motion-state.js'
import { setStageSnapshot } from './stage-state.js'
import { activeProvider, deleteProvider, getProvider, listProviderModels, loadProviders, setActive, testProvider, upsertProvider } from './provider-store.js'
import { appendMessage, buildPrompt, clearHistory, getPersona, nextMessageId, resetContext, setPersona, visibleHistory } from './session-store.js'
import { startChat } from './chat-client.js'
import { parseReply } from './act-parser.js'
import { PersonaSchema } from './session-store.js'
import {
  addMemory, buildMemoryBlock, deleteMemory, listMemory, memoryCount, previewRecall, recall, searchMemory, updateMemory,
} from './memory-store.js'
import { recordMemoryInjection } from './memory-state.js'
import { secretStore } from './secrets-store.js'
import { auditAutostart, inventoryAutostart, isAutoStartEnabled, setAutoStart } from './autostart.js'
import { getSession } from './session.js'
import {
  chooseVoice, listVoices, toVoiceInfo, TTS_ENGINE, type TtsSpeakResult,
} from './tts-engine.js'
// ── M1：向导 / 隐私
import {
  advanceOnboarding, completeOnboarding, onboardingStatus, recordOnboardingTest, resetOnboarding, setOnboardingStep,
} from './onboarding-store.js'
import { exportPersonalData, privacySummary, wipePersonalData } from './privacy.js'
// ── M2：日程 / 提醒 / 静音 / 权限 / 活动 / 主动引擎
import { deleteSchedule, loadSchedules, upsertSchedule } from './schedule-store.js'
import {
  ackReminder, deleteReminder, listReminders, loadReminders, upsertReminder,
} from './reminder-store.js'
import { loadQuietHours, loadReminderPolicy, setQuietHours, setReminderPolicy } from './quiet-store.js'
import { listPermissions, setPermission } from './permission-store.js'
import { adviceFromStats, currentStreakMinutes, todayStats } from './activity-stats.js'
import { currentActivity, currentBlocker, generateRadio, proactiveInbox, proactiveStatus, runTick } from './proactive-engine.js'
import { probeDiagnostics } from './activity-probe.js'
// ── 适配层框架（M5 §1）
import { capabilityDiagnostics, capabilityKit } from './capabilities/index.js'
import { projectLicenseForRenderer, redactDeep } from './capabilities/asset-adapter.js'
import { recentToolCalls, toolAuditDigest } from './tool-audit.js'
import { personalStoreNames, storeCatalogDigest } from '@airimate/companion-kit'
import { storeMigrationStates, unregisteredStoreTags } from './store-registry.js'
// ── M3：语音 / 屏幕 / 目录白名单 / 工具确认
import { listenOnce, probeVoice, setVoiceConfig, stopVoice, voiceStatus } from './voice-engine.js'
import {
  interruptVoiceCall, startVoiceCall, stopVoiceCall, voiceCallPreflight, voiceCallState,
  voiceClosedLoopStatus, startWakeWatch, stopWakeWatch, reconcileWakeWatch,
} from './voice-call.js'
import {
  addAllowlistedDir, allowlistEntriesForUi, lastCaptureNotice, revokeAllowlistedDir, screenStatus,
  setScreenPaused, syncScreenRedactFromSettings,
} from './computer-use.js'
import { resolveToolConfirm } from './tool-confirm.js'
import { ruleSummary } from './fs-allowlist.js'
// ── M4：每日自学习
import {
  getReflection, pendingItems, reflectionHistory, decideItem, clearAllReflections,
} from './reflection-store.js'
import { reflectionStatus, runReflection } from './reflection-engine.js'

const ok = (): Result => ({ ok: true })
const err = (code: string, message: string): Result => ({ ok: false, code, message })

/**
 * 在系统文件管理器里打开一个**应用自己固定的**目录（本轮唯一用它的地方：对话数据目录）。
 *
 * ⚠ 只接受主进程自己算出来的路径（`appPaths()`），**没有**任何来自 renderer 的路径入参 ——
 *   这条纪律是"不把任意路径打开能力交给渲染进程"的落点。
 * 返回 `false` 表示系统拒绝打开（如实回报，不当成成功）。
 */
async function openDirSafely(dir: string): Promise<boolean> {
  try {
    const r = await shell.openPath(dir)
    if (r) {
      log().warn('打开目录失败（系统拒绝）', { dir, detail: r.slice(0, 120) }, 'ipc.open-path.failed')
      return false
    }
    return true
  } catch (e) {
    log().warn('打开目录异常', { dir, err: e instanceof Error ? e.message : String(e) }, 'ipc.open-path.error')
    return false
  }
}

function fromOwnWindow(e: IpcMainInvokeEvent): boolean {
  const win = BrowserWindow.fromWebContents(e.sender)
  return win !== null && !win.isDestroyed()
}

/**
 * 已通过 `guarded()` 注册的通道名。
 *
 * 为什么要**自己记一份**，而不是问 `ipcMain`：
 *   · `ipcMain` 没有"这个通道注册了吗"的公开查询；
 *   · 我们**故意的**语义是"本进程有没有真的把这条通道接上"——
 *     这正是隐私适配器要如实报告的东西。自己记一份才能让这句话有确定答案，
 *     也才能在单测里被钉死（不依赖 Electron 内部实现）。
 */
const registeredChannels = new Set<string>()

/** 该 IPC 通道是否已注册（**纯读**；隐私适配器用它如实报告"通道接线了没"） */
export function isChannelRegistered(channel: string): boolean {
  return registeredChannels.has(channel)
}

function guarded<T>(
  channel: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown> | null,
  handler: (input: T, e: IpcMainInvokeEvent) => Promise<Result> | Result,
): void {
  ipcMain.handle(channel, async (e, raw): Promise<Result> => {
    if (!fromOwnWindow(e)) {
      log().warn('拒绝来自非本应用窗口的 IPC', { channel }, 'ipc.reject.origin')
      return err('IPC_ORIGIN', '来源不被信任')
    }
    let input = undefined as T
    if (schema) {
      const parsed = schema.safeParse(raw)
      if (!parsed.success) {
        const issues = parsed.error.issues.slice(0, 4).map(i => `${i.path.join('.') || '<root>'}:${i.message}`).join(' | ')
        log().warn('IPC 入参校验失败', { channel, issues }, 'ipc.reject.schema')
        return err('IPC_SCHEMA', `参数校验失败（${issues}）`)
      }
      input = parsed.data
    }
    try {
      return await handler(input, e)
    } catch (e2) {
      const msg = e2 instanceof Error ? e2.message : String(e2)
      log().error('IPC handler 异常', { channel, err: msg }, 'ipc.handler.error')
      return err('INTERNAL', msg.slice(0, 300))
    }
  })
  // 注册成功才记 —— 记在 `ipcMain.handle` 之后，保证"记了"就真的接上了
  registeredChannels.add(channel)
}

/**
 * 广播给**全部**存活窗口的通道白名单。
 *
 * ⚠ 为什么需要它（2026-10-08 返工轮，新架构的直接后果）：
 *   本应用现在有**两个**窗口，而这些事件**两个窗口都要**：
 *     · `evt:chat-delta`   —— pet 用它更新头顶气泡的"她正在说的这一句"；
 *                              chat 用它渲染流式输出。少一个 ⇒ "回复不流式"或"气泡不动"。
 *     · `evt:chat-done`    —— chat 落最后一段；pet 用它排程气泡消失。
 *     · `evt:chat-error`   —— 两个窗口都该显示失败。
 *     · `evt:tts-state`    —— pet 靠它驱动"朗读结束 + N 秒气泡消失"的倒计时（核心判据）。
 *     · `evt:alert`        —— 告警是给用户看的，用户在哪个窗口就该在哪里看到。
 *     · `evt:conversation-state` —— 对话开合状态；两个窗口都要知道。
 *     · `evt:voice-call`   —— 通话进度（气泡与对话区都显示）。
 *   只发 `getWindow()`（pet）会让 chat 窗口**永远收不到**，而且不报任何错。
 *
 * 不在白名单里的（stage-command / mode-changed / drag-pos / stage 快照类）保持
 * "只发 pet 窗口" —— 那些是**角色与窗口模式**专属的事件，chat 窗口没有角色可驱动。
 */
const BROADCAST_CHANNELS: ReadonlySet<string> = new Set<string>([
  IPC.EVT_CHAT_DELTA,
  IPC.EVT_CHAT_DONE,
  IPC.EVT_CHAT_ERROR,
  IPC.EVT_TTS_STATE,
  IPC.EVT_TTS_AUDIO,
  IPC.EVT_ALERT,
  IPC.EVT_CONVERSATION_STATE,
  IPC.EVT_CONVERSATION_LISTEN,
  IPC.EVT_VOICE_CALL,
  IPC.EVT_VOICE_NOTICE,
  IPC.EVT_SETTINGS_CHANGED,
  /** ★ 桌宠相关（2026-10-09 完善轮）：常驻/呼出状态与界面动作两个窗口都要知道 */
  IPC.EVT_PET_MENU_STATE,
  IPC.EVT_UI_ACTION,
])

function send(channel: string, schema: z.ZodTypeAny, payload: unknown): void {
  const parsed = schema.safeParse(payload)
  if (!parsed.success) {
    log().warn('出站消息校验失败，已丢弃', { channel }, 'ipc.reject.outbound')
    return
  }
  if (BROADCAST_CHANNELS.has(channel)) {
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed()) continue
      try { w.webContents.send(channel, parsed.data) } catch { /* 单窗失败不影响其它窗口 */ }
    }
    return
  }
  const w = getWindow()
  if (!w || w.isDestroyed()) return
  w.webContents.send(channel, parsed.data)
}

export function sendAlert(a: Alert): void {
  send(IPC.EVT_ALERT, AlertSchema, a)
}

export function sendStageCommand(cmd: StageCommand): void {
  send(IPC.EVT_STAGE_COMMAND, z.unknown(), cmd)
}

export function sendModeChanged(payload: { mode: string, bounds: unknown, windowId: number }): void {
  send(IPC.EVT_MODE_CHANGED, z.unknown(), payload)
}

/**
 * ★ 对话状态（main → renderer）。**带 schema 校验**再发：
 *   它是界面判断"该不该显示对话框"的唯一依据，形状漂移必须**可见**（丢弃 + 日志），
 *   而不是让 renderer 拿到一个半成品对象后静默什么都不显示。
 */
export function sendConversationState(s: ReturnType<typeof conversationState>): void {
  send(IPC.EVT_CONVERSATION_STATE, ConversationStateSchema, s)
}

/**
 * ★ 桌宠菜单状态快照（main → **两个**窗口）。
 *
 * 为什么必须广播而不是让界面各自去问：
 * C4 要求"三处菜单入口的「桌宠常驻」勾选状态完全同步"。
 * 三处各自 `getSettings()` 会得到三份**刷新时机不同**的副本，
 * 而"勾选和窗口对不上"这种读数没有任何报错 —— 只能靠唯一真源主动推送来避免。
 */
export function sendPetMenuState(s: PetMenuState): void {
  send(IPC.EVT_PET_MENU_STATE, PetMenuStateSchema, s)
}

/**
 * ★ 界面动作请求（main → pet 窗口）。
 *
 * ⚠ 走 `send()`（带 zod 校验）而不是裸 `broadcast`：形状漂移必须**可见**
 *   （丢弃 + 记日志），而不是让 renderer 收到一个半成品后静默什么都不做。
 *   它同时在 `BROADCAST_CHANNELS` 里 —— 两个窗口都收得到没有坏处：
 *   chat 窗口收到时只需忽略（它没有管理面板），而"只发 pet"需要额外一次反查，
 *   多一个会漂移的判断点。
 */
export function sendUiAction(action: UiAction, source: 'tray' | 'chat-menu' | 'pet-menu' | 'api' = 'api'): void {
  send(IPC.EVT_UI_ACTION, UiActionRequestSchema, { action, source, at: Date.now() })
}

/**
 * 主进程 → renderer 的**原始广播**（给 bootstrap 的主动引擎用）。
 *
 * 实现已抽到 `event-sink.ts`（打断 `ipc → capabilities → ipc` 的循环依赖，
 * 见那里的注释）；这里保留同名导出，调用方不用改。
 */
export const broadcast = broadcastImpl

/**
 * ★ M2：把**可以送达**的主动事件推给 renderer。
 *
 * 两条出口，各有分工：
 *   · `evt:proactive` —— 引擎的原始事件（气泡 / 提醒卡片 / 早安电台面板用它）；
 *   · 会话历史 —— 追加一条 `origin:'proactive'|'radio'` 的助手消息，
 *     这样"她主动说的"也能在聊天记录里回看（否则关掉气泡就什么都不剩）。
 * 音频**不在这里**：朗读由引擎在"未被阻断"时通过注入的 `speak` 显式调用。
 */
export function sendProactiveEvent(e: ProactiveEvent): void {
  send(IPC.EVT_PROACTIVE, ProactiveEventSchema, e)
  try {
    const origin = e.kind === 'morning-radio' ? 'radio' : 'proactive'
    appendMessage({
      id: nextMessageId('p'),
      role: 'assistant',
      text: e.text,
      createdAt: Date.now(),
      commands: [],
      origin,
    })
  } catch (err) {
    log().warn('主动消息写入会话失败', { kind: e.kind, err: err instanceof Error ? err.message : String(err) }, 'proactive.session.append-failed')
  }
  log().info('主动事件已送达', { kind: e.kind, priority: e.priority, chars: e.text.length, speak: e.speak }, 'proactive.delivered')
}

export function registerIpc(options: { selfExe: string, appArgs: string[], diagnosticsFile: string | null }): void {
  const writeDiagFile = (data: unknown): void => {
    if (!options.diagnosticsFile) return
    try {
      writeFileSync(options.diagnosticsFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    } catch (e) {
      log().warn('诊断文件写入失败', { err: e instanceof Error ? e.message : String(e) }, 'diag.write.failed')
    }
  }

  // ── 应用
  guarded(IPC.APP_DIAGNOSTICS, null, async () => {
    const d = await collectDiagnostics()
    writeDiagFile(d)
    return { ok: true, diagnostics: d } as unknown as Result
  })
  guarded(IPC.APP_SHOW, null, () => { showWindow(); return ok() })
  guarded(IPC.APP_HIDE, null, () => { hideWindow(); return ok() })
  guarded(IPC.APP_QUIT, null, () => { getSession().requestQuit(); return ok() })
  /**
   * ★ 重启应用（桌宠右键菜单）。
   * 真正的"先 relaunch 再退出"由 `bootstrap` 注入的 `requestRestart` 做 ——
   * 这里只表达意图，避免在 IPC 层直接拼启动参数（那是 bootstrap 的职责）。
   */
  guarded(IPC.APP_RESTART, null, () => {
    if (!getSession().requestRestart) return err('RESTART_UNWIRED', '重启入口未接线（这是缺陷，请上报日志）')
    getSession().requestRestart?.()
    return ok()
  })
  guarded(IPC.APP_STARTUP_GET, null, () => ({
    ok: true,
    enabled: isAutoStartEnabled(options.selfExe),
    entries: inventoryAutostart(),
  } as unknown as Result))
  guarded(IPC.APP_STARTUP_SET, z.object({ enabled: z.boolean(), dryRun: z.boolean().default(false) }), (input) => {
    const r = setAutoStart(input.enabled, options.selfExe, options.appArgs, input.dryRun)
    return { ok: r.ok, detail: r.detail, legacyMoved: r.legacyMoved, backupDir: r.backupDir } as unknown as Result
  })
  guarded(IPC.APP_STARTUP_AUDIT, null, () => {
    const a = auditAutostart()
    return { ok: true, audit: a } as unknown as Result
  })
  guarded(IPC.LEGACY_SCAN, null, () => {
    const r = scanLegacyInstances()
    setLastLegacyScan(r)
    return { ok: true, result: r } as unknown as Result
  })

  // ── 窗口
  guarded(IPC.WINDOW_GET_MODE, null, () => ({ ok: true, mode: windowMode(), bounds: windowBounds() } as unknown as Result))
  guarded(IPC.WINDOW_SET_MODE, SetModeRequestSchema, (input) => {
    const b = applyMode(input.mode, { resize: true })
    /**
     * ⚠ 这里曾经调用 `syncConversationAfterModeChange()`（把 pet 窗口拉到对话态尺寸）。
     *   返工轮**删除**：对话窗口是独立的第二个 BrowserWindow，
     *   panel ⇄ pet 的切换与它**完全无关** —— 任何"顺手同步一下"的调用都是在
     *   重新引入"打开对话就改 pet 窗口尺寸"那条被否决的路径。
     */
    if (input.center) centerWindow()
    patchSettings({ mode: input.mode })
    const w = getWindow()
    sendModeChanged({ mode: input.mode, bounds: b ?? windowBounds(), windowId: w?.id ?? -1 })
    return { ok: true, mode: input.mode, bounds: b } as unknown as Result
  })
  guarded(IPC.WINDOW_SET_ALWAYS_ON_TOP, AlwaysOnTopRequestSchema, (input) => {
    setAlwaysOnTop(input.on)
    patchSettings({ alwaysOnTop: input.on })
    return ok()
  })
  guarded(IPC.WINDOW_CENTER, null, () => { centerWindow(); return ok() })
  /**
   * 最小化**发起调用的那个窗口**（按 `event.sender` 反查）。
   *
   * 为什么不能复用 `window:center` 那种"操作主窗口"的写法：
   *   chat 窗口是 `frame:false` 的自绘标题栏，没有系统最小化按钮，
   *   它的「–」按钮必须能最小化**它自己**；而 pet 窗口也需要同样的能力
   *   （托盘里已有「隐藏窗口」，但最小化是另一件事）。
   *   按 sender 反查 ⇒ 一个通道服务两个窗口，不会出现"在 chat 里点最小化把桌宠收走了"。
   */
  guarded(IPC.WINDOW_MINIMIZE, null, (_input, e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed()) return err('NO_WINDOW', '找不到发起调用的窗口')
    win.minimize()
    log().info('窗口已最小化（按发起方）', { windowId: win.id }, 'window.minimize')
    return ok()
  })
  guarded(IPC.WINDOW_DRAG_BEGIN, DragBeginRequestSchema, (input) => {
    // 拖拽由主进程以 60Hz 自行推进（读真实光标位置），并把真实位移回报给 renderer
    beginDrag(input.cursor, (t) => {
      const w = getWindow()
      if (!w || w.isDestroyed()) return
      w.webContents.send(IPC.EVT_DRAG_POS, t)
    })
    return ok()
  })
  guarded(IPC.WINDOW_DRAG_END, DragEndRequestSchema, () => {
    const r = endDrag()
    if (r.bounds) {
      /**
       * 拖拽结束后**一次性**记录几何。
       * 拖拽期间**不**写设置 —— 实测：在 `moved`/`resized` 里写盘会让窗口尺寸漂移 12×9 px，
       * 违反"拖拽过程中窗口尺寸不能变化"的硬要求（见 bootstrap 的注释）。
       */
      if (windowMode() === 'pet') mergeSettings({ petPosition: { x: r.bounds.x, y: r.bounds.y } })
      else mergeSettings({ panelBounds: r.bounds })
    }
    return { ok: true, moved: r.moved, distance: r.distance, bounds: r.bounds } as unknown as Result
  })
  guarded(IPC.WINDOW_AUTO_RESIZE, AutoResizeRequestSchema, (input) => {
    const r = autoResize(input.width, input.height, input.anchor)
    return { ok: true, applied: r.applied, reason: r.reason ?? null } as unknown as Result
  })

  /**
   * ═══════ ★★ 桌宠窗口：呼出 / 收回 / 常驻（2026-10-09 完善轮）
   *
   * 三处菜单（对话窗口菜单栏 / 托盘 / 桌宠右键）**共用这四条通道**。
   * 为什么收敛成一条通道 + 一个 `action` 枚举（而不是四条通道）：
   * 四条意味着四处独立的校验与四份可以各自漂移的返回体，
   * 而它们的语义是强耦合的（"取消常驻"必须顺手收回窗口、"呼出"不该改常驻）。
   */
  guarded(IPC.PET_SHOW, PetControlRequestSchema, (input) => {
    const r = showPet(input.source)
    announceConversationState()
    return { ok: r.ok, changed: r.changed, pet: r.state, mode: windowMode(), reason: r.reason } as unknown as Result
  })
  guarded(IPC.PET_HIDE, PetControlRequestSchema, (input) => {
    const r = hidePet(input.source)
    announceConversationState()
    return { ok: r.ok, changed: r.changed, pet: r.state, mode: windowMode(), reason: r.reason } as unknown as Result
  })
  guarded(IPC.PET_TOGGLE, PetControlRequestSchema, (input) => {
    const r = togglePet(input.source)
    announceConversationState()
    return { ok: r.ok, changed: r.changed, pet: r.state, mode: windowMode(), reason: r.reason } as unknown as Result
  })
  /**
   * **打开管理面板** = 呼出 + 切 panel 模式 + 聚焦。
   *
   * 三步合成一条通道的理由：分三次调用时，中间任何一步失败都会留下
   * "窗口出来了但形态不对"的中间态，而那个中间态**没有任何界面表现**
   * （窗口在，只是是 340×420 的桌宠形态）。
   */
  guarded(IPC.PET_OPEN_PANEL, PetControlRequestSchema, (input) => {
    const shown = showPet(input.source)
    if (!shown.ok) {
      return { ok: false, code: 'PET_NO_WINDOW', message: '桌宠窗口不存在（启动流程没有创建它）', pet: shown.state } as unknown as Result
    }
    applyMode('panel', { resize: true })
    patchSettings({ mode: 'panel' })
    const w = getWindow()
    sendModeChanged({ mode: 'panel', bounds: windowBounds(), windowId: w?.id ?? -1 })
    showWindow()
    announceConversationState()
    return { ok: true, changed: shown.changed, mode: 'panel', pet: petMenuState() } as unknown as Result
  })
  /**
   * **写「桌宠常驻」并立即生效 + 落盘**（用户要求："切换要立即生效并落盘"）。
   *
   * 生效规则（唯一实现在 `pet-visibility.ts` 的 `setPetResident`）：
   *   勾上 ⇒ 显示桌宠 + `settings.petResident=true`；取消 ⇒ 隐藏桌宠 + `false`；
   *   两个方向都**立刻 flush**（不等 800ms 防抖）—— "重启后仍生效"完全依赖这一步。
   */
  guarded(IPC.PET_SET_RESIDENT, PetResidentRequestSchema, (input) => {
    const r = setPetResident(input.resident, input.source)
    announceConversationState()
    return {
      ok: r.ok, changed: r.changed, persisted: r.persisted, resident: input.resident,
      pet: r.state, reason: r.reason,
    } as unknown as Result
  })
  /**
   * ★ **界面动作**（renderer → main）：把"打开某个管理页"的意图**路由**给 pet 窗口。
   *
   * 为什么必须经主进程转一手：`tab` 是 **pet 窗口 renderer 的局部状态**，
   * 而发起方是 **chat 窗口**的菜单栏 —— 两个 renderer 之间没有直接通道
   * （也不该有：那会是一条绕开 IPC 白名单的窗口间通信）。
   * 主进程只做"收下意图 → 广播事件"，不解释也不记忆。
   *
   * ⚠ 白名单只收"打开视图"那一半（见 `UiActionRequestInputSchema`）：
   *   `pet-hidden` / `pet-shown` 是主进程**单向下发**的状态通知，
   *   让 renderer 也能发它们等于凭空造出"假装自己被收回了"的能力。
   */
  guarded(IPC.UI_ACTION, UiActionRequestInputSchema, (input) => {
    sendUiAction(input.action, input.source)
    log().info('界面动作已路由', { action: input.action, source: input.source }, 'ui.action')
    return { ok: true, routed: input.action } as unknown as Result
  })
  guarded(IPC.PET_FLUSH_SETTINGS, null, () => {
    flushSettings()
    log().info('常驻设置已立即落盘（不等防抖）', { resident: petMenuState().resident }, 'pet.resident.flushed')
    return { ok: true, flushed: true } as unknown as Result
  })
  /**
   * ★ 桌宠自身的**右键菜单**（原生 `Menu.popup`）。
   *
   * 为什么在主进程而不是 renderer 自绘：菜单项里有「重启应用」「退出应用」，
   * 把这类能力暴露给渲染进程的界面层是**没必要扩大的攻击面**。
   * ⇒ renderer 只能说"用户在我的窗口上右键了"（无入参），
   *   菜单项与它们的动作全部由这里持有。
   *
   * 对齐参考实现 `DockPetWin-Ameath` 的 `AddPetMenuItem` 逐项顺序。
   */
  guarded(IPC.PET_MENU, null, (_input, e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed()) return err('NO_WINDOW', '找不到发起右键的窗口')
    const pet = petMenuState()
    const mode = windowMode()
    /** 「摸摸她 / 让她散步·休息」需要 renderer 真的去做动作 ⇒ 复用界面动作通道 */
    const menu = Menu.buildFromTemplate([
      /** 当前状态：**禁用项**（只读展示；与参考实现的 `当前状态：{状态}` 同形） */
      { label: `当前状态：${pet.statusText}`, enabled: false },
      { type: 'separator' },
      { label: '摸摸她', click: () => sendUiAction('pet-hidden', 'pet-menu') },
      { label: mode === 'pet' ? '让她休息一下' : '让她散步', click: () => sendUiAction('pet-shown', 'pet-menu') },
      { label: '和她说说话', click: () => { const r = openConversation('pet-menu'); if (!r.ok) log().warn('桌宠菜单打开对话被拒绝', { reason: r.refusedReason ?? '' }, 'petmenu.chat.refused'); announceConversationState() } },
      { label: '打开管理面板', click: () => { applyMode('panel', { resize: true }); patchSettings({ mode: 'panel' }); const w = getWindow(); sendModeChanged({ mode: 'panel', bounds: windowBounds(), windowId: w?.id ?? -1 }); showWindow(); announceConversationState() } },
      { type: 'separator' },
      { label: `记忆`, click: () => sendUiAction('memory', 'pet-menu') },
      { label: `日程与提醒`, click: () => sendUiAction('schedule', 'pet-menu') },
      { label: `偏好设置`, click: () => sendUiAction('settings', 'pet-menu') },
      { type: 'separator' },
      {
        label: '桌宠常驻',
        type: 'checkbox',
        checked: pet.resident,
        click: (item) => { setPetResident(item.checked, 'pet-menu'); announceConversationState() },
      },
      { label: '暂时隐藏她', click: () => { hidePet('pet-menu'); announceConversationState() } },
      { type: 'separator' },
      { label: '重启应用', click: () => { getSession().requestRestart?.() } },
      { label: '退出应用', click: () => { getSession().requestQuit() } },
    ])
    try {
      menu.popup({ window: win })
    } catch (e2) {
      const msg = e2 instanceof Error ? e2.message : String(e2)
      log().warn('桌宠右键菜单弹出失败', { err: msg }, 'petmenu.popup-failed')
      return err('MENU_POPUP', msg.slice(0, 300))
    }
    log().info('桌宠右键菜单已弹出', { resident: pet.resident, visible: pet.visible, mode }, 'petmenu.shown')
    return { ok: true, shown: true, pet } as unknown as Result
  })

  /**
   * ── ★ 对话（返工轮）：三条通道就是"五个入口"的全部实现面
   *
   * ⚠ 返回体里的 `ok:false` 分支真的可能发生（窗口装配缺失 / 创建异常），
   *   而**不再有** "CONVERSATION_LAYOUT_REFUSED（正在拖动角色）" 那一种 ——
   *   那条拒绝的原因是"打开对话要改 pet 窗口尺寸，拖拽期间不许改"，
   *   而新架构下打开对话**根本不碰 pet 窗口** ⇒ 拖拽中按快捷键也能正常打开。
   */
  guarded(IPC.CONVERSATION_OPEN, ConversationOpenRequestSchema, (input) => {
    const r = openConversation(input.source, input.listen, input.focusInput)
    if (!r.ok) {
      return { ok: false, code: 'CONVERSATION_OPEN_FAILED', message: r.refusedReason ?? '无法打开对话窗口', state: r.state } as unknown as Result
    }
    return { ok: true, state: r.state } as unknown as Result
  })
  guarded(IPC.CONVERSATION_CLOSE, ConversationCloseRequestSchema, (input) => {
    const r = closeConversation(input.source)
    if (!r.ok) {
      return { ok: false, code: 'CONVERSATION_CLOSE_FAILED', message: r.refusedReason ?? '无法收起对话窗口', state: r.state } as unknown as Result
    }
    return { ok: true, state: r.state } as unknown as Result
  })
  guarded(IPC.CONVERSATION_STATE, null, () => ({ ok: true, state: conversationState() } as unknown as Result))

  // ── 高频通道（send，不 await）
  ipcMain.on(IPC.WINDOW_DRAG_MOVE, (e, raw) => {
    if (!fromOwnWindow(e)) return
    const parsed = DragMoveSchema.safeParse(raw)
    if (!parsed.success) return
    // 兼容路径：若 renderer 主动上报光标位置，也接受（主进程仍在自己推进）
    dragTo(parsed.data)
  })
  ipcMain.on(IPC.HIT_REGIONS, (e, raw) => {
    if (!fromOwnWindow(e)) return
    const parsed = HitRegionsSchema.safeParse(raw)
    if (!parsed.success) return
    hitRegions().update(parsed.data)
  })
  ipcMain.on(IPC.STAGE_SNAPSHOT, (e, raw) => {
    if (!fromOwnWindow(e)) return
    const parsed = StageSnapshotSchema.safeParse(raw)
    if (!parsed.success) return
    setStageSnapshot(parsed.data)
  })

  // ── 设置
  /**
   * `settings:get` 必须返回**本次会话实际生效**的模式。
   *
   * ⚠ 这里曾直接返回 `loadSettings()`（持久化值）。后果：`--mode=pet` 时主进程把窗口
   * 正确改成 pet（尺寸 / 不可缩放 / 上浮），但 renderer 读到的 `settings.mode` 仍是 `panel`
   * ⇒ **窗口是桌宠尺寸，界面却渲染整套面板**（标题栏 + 标签页 + 输入框挤在 340×420 里）。
   * 实测证据：`docs/evidence/phase1/screens/mine-pid8264-425x525-20260927-033033.png`。
   *
   * 这与"挡住 renderer 回写"是**两件都必须做**的事：只挡回写 ⇒ 界面仍按旧值绘制；
   * 只改返回值 ⇒ 界面可能再把旧值写回去。缺任何一个，CLI 覆盖都只是半个功能。
   */
  guarded(IPC.SETTINGS_GET, null, () => {
    const s = loadSettings()
    const session = sessionMode()
    return { ok: true, settings: session ? { ...s, mode: session } : s } as unknown as Result
  })
  guarded(IPC.SETTINGS_PATCH, SettingsPatchSchema, (input) => {
    /**
     * ⚠ 会话级模式覆盖生效时，**忽略**来自 renderer 的 `mode` 回写。
     *
     * 实测 bug：`--mode=pet` 启动后，renderer 的 `init()` 会先 `getMode()` 再 `patchSettings({mode})`，
     * 把持久化设置里的 `panel` 写回来 ⇒ CLI 参数被静默吃掉（窗口仍是 panel 尺寸）。
     * 会话级覆盖的语义是"本次运行以命令行参数为准"，因此这里必须挡住回写。
     */
    const patch = { ...input }
    if (sessionMode() !== null && patch.mode !== undefined) {
      log().info('忽略 renderer 的模式回写（会话级覆盖生效）', { requested: patch.mode, session: sessionMode() ?? '' }, 'window.mode.patch-ignored')
      delete patch.mode
    }
    const next = patchSettings(patch)
    /**
     * ★ M3：设置改动要**同步进运行时**，否则"设置里改了但行为没变"。
     *
     * 两处单向同步（设置 → 运行时），避免两个真源：
     *   · `screenRedactSensitive` → 权限表的 `redactSensitive`（截图时读权限表）；
     *   · `wakeWordEnabled` / `wakeWord` → 语音引擎的运行时配置。
     * 反向不成立：运行时状态（麦克风是否占用、是否暂停）**不写回设置**
     * （那是会话态，不是用户意愿）。
     */
    if (patch.screenRedactSensitive !== undefined) {
      syncScreenRedactFromSettings(patch.screenRedactSensitive)
    }
    if (patch.wakeWordEnabled !== undefined || patch.wakeWord !== undefined) {
      setVoiceConfig({
        ...(patch.wakeWordEnabled !== undefined ? { wakeWordEnabled: patch.wakeWordEnabled } : {}),
        ...(patch.wakeWord !== undefined ? { wakeWord: patch.wakeWord } : {}),
      })
    }
    /**
     * ★ 2026-10-06（A4）：**任何**可能改变"能不能待机监听"的设置改动之后都要对齐一次。
     *
     * 触发条件包含 `hearingEnabled` —— 它是语音识别总开关，而它**不走**
     * `voice:config`（那条通道只管唤醒词），所以只在上面的唤醒分支里对齐是不够的：
     * 用户单独关掉 `hearingEnabled` 时，待机循环会**继续占着麦克风**。
     * 这里用"三个开关里任意一个出现在 patch 里"作为触发条件（宁多对齐一次，不可漏）。
     */
    if (patch.hearingEnabled !== undefined || patch.wakeWordEnabled !== undefined) {
      reconcileWakeWatch()
    }
    /**
     * ★ 快捷键 / 对话窗口设置改动 ⇒ **立即**重新应用。
     *
     * 为什么必须在这里（而不是等下一次重启）：用户改键的目的就是"现在就能用"，
     * 而"设置保存了但快捷键还是旧的"是一种**静默失效**——设置面板显示新键、
     * 按下去毫无反应。重新注册的结果（成功 / 被占用）会同时进
     * `conversation:state`、诊断快照与界面告警。
     * `chatWindowAlwaysOnTop` 走同一个出口：置顶是即时可见的效果，不该等重启。
     */
    if (patch.conversationHotkey !== undefined || patch.conversationHotkeyEnabled !== undefined
      || patch.chatWindowAlwaysOnTop !== undefined) {
      applyConversationSettings()
    }
    send(IPC.EVT_SETTINGS_CHANGED, z.unknown(), next)
    return { ok: true, settings: next } as unknown as Result
  })

  // ── 动作与角色
  guarded(IPC.MOTION_LIST, null, () => {
    const r = loadManifests()
    const st = refreshMotionStatus()
    return { ok: true, manifests: r.manifests, failed: [...r.failed, ...st.failed], clipIds: st.clipIds } as unknown as Result
  })
  guarded(IPC.MOTION_RELOAD, null, () => {
    const r = loadManifests()
    const st = refreshMotionStatus()
    sendAlert({
      level: r.failed.length ? 'warn' : 'info',
      title: r.failed.length ? `动作清单有 ${r.failed.length} 项异常` : `动作清单已重新加载（${st.clipCount} 个 clip）`,
      detail: r.failed.slice(0, 5).join('\n') || undefined,
      code: 'MOTION_RELOAD',
      blocking: false,
    })
    return { ok: true, manifests: r.manifests, failed: [...r.failed, ...st.failed], clipIds: st.clipIds } as unknown as Result
  })
  guarded(IPC.AVATAR_CATALOG, null, () => {
    const file = appPaths().catalogFile
    try {
      if (!existsSync(file)) return err('AVATAR_MISSING', '角色清单文件不存在（assets/models/catalog.json）')
      const catalog = JSON.parse(readFileSync(file, 'utf8')) as unknown
      return { ok: true, catalog } as unknown as Result
    } catch (e) {
      return err('AVATAR_LOAD_FAILED', e instanceof Error ? e.message : String(e))
    }
  })

  // ── 会话/记忆/供应商/TTS
  /**
   * `chat:send` —— 唯一数据流的起点。
   *
   * 链路：用户输入 → 组装（人设 + 历史 + 本轮）→ 流式请求（主进程出网）
   *      → `evt:chat-delta` 增量广播 → 完成后 `parseReply()` **解析一次**
   *      → 校验后的 `StageCommand[]` 经 `evt:chat-done` 送达 renderer。
   * renderer **不解析**任何标记（禁止双驱动）。
   */
  let activeChat: { handle: { abort: () => void }, requestId: string, receivedChars: number, lastDeltaAt: number } | null = null
  let activeChatTimer: NodeJS.Timeout | null = null

  /**
   * 停止生成的两条路径（用户 M1 要求"停止生成"）：
   *   ① 用户点停止 / 发 `/stop` ⇒ `chat:abort`；
   *   ② **不活跃保护**：模型长时间没有任何增量（默认 120s，可关）⇒ 自动中止，
   *      否则界面会一直转圈，用户只能重启应用。两条都走同一个 `abortActive()`。
   */
  const abortActive = (reason: 'user' | 'idle'): { aborted: boolean, requestId: string | null, receivedChars: number } => {
    if (!activeChat) return { aborted: false, requestId: null, receivedChars: 0 }
    const { handle, requestId, receivedChars } = activeChat
    activeChat = null
    if (activeChatTimer) { clearInterval(activeChatTimer); activeChatTimer = null }
    try { handle.abort() } catch { /* ignore */ }
    send(IPC.EVT_CHAT_ERROR, ChatErrorSchema, {
      requestId,
      code: 'aborted',
      message: reason === 'idle' ? '已自动停止（模型长时间没有响应）' : '已停止生成',
      retryable: false,
    })
    log().info('生成已中止', { requestId, reason, chars: receivedChars }, 'chat.abort')
    return { aborted: true, requestId, receivedChars }
  }

  guarded(IPC.CHAT_SEND, ChatSendRequestSchema, (input) => {
    const prov = activeProvider()
    if (!prov) return err('PROVIDER_MISSING', '还没有配置供应商：请先在设置里添加 baseUrl / 模型 / 密钥')
    const key = secretStore().get(prov.id)
    if (!key) return err('PROVIDER_MISSING', `供应商「${prov.label}」尚未配置密钥`)
    if (activeChat) { try { activeChat.handle.abort() } catch { /* ignore */ } activeChat = null }

    const requestId = nextMessageId('req')
    const userMsg = { id: nextMessageId('u'), role: 'user' as const, text: input.text, createdAt: Date.now(), commands: [], origin: 'user' as const }
    appendMessage(userMsg)
    // ★ 记忆注入：把与本次输入相关的记忆拼进系统提示（无命中时返回 null，不塞空段落）
    const mem = buildMemoryBlock(input.text, 5, 800)
    // 记录可判定的注入证据（只存长度与指纹，不存正文）——见 memory-state.ts
    recordMemoryInjection(input.text, mem.block, mem.hits)
    const prompt = buildPrompt(input.text, {
      extraSystem: mem.block ?? undefined,
      historyLimit: loadSettings().chatHistoryLimit,
    })

    activeChat = { handle: { abort: () => { /* 在下方被真实赋值 */ } }, requestId, receivedChars: 0, lastDeltaAt: Date.now() }
    const h = startChat({ provider: prov, apiKey: key, messages: prompt }, {
      onDelta: (e) => {
        if (activeChat?.requestId === requestId) {
          activeChat.receivedChars += e.delta.length
          activeChat.lastDeltaAt = Date.now()
        }
        send(IPC.EVT_CHAT_DELTA, ChatDeltaSchema, { requestId, delta: e.delta, displayText: e.delta })
      },
      onDone: (done) => {
        const received = activeChat?.requestId === requestId ? activeChat.receivedChars : 0
        activeChat = null
        if (activeChatTimer) { clearInterval(activeChatTimer); activeChatTimer = null }
        // ★ 唯一解析点：完整文本 → StageCommand[]（未知标记被丢弃并报告）
        const parsed = parseReply(done.text)
        const commands: StageCommand[] = []
        const issues: string[] = []
        for (const c of parsed.commands) {
          const r = parseStageCommand(c)
          if (r.ok) commands.push(r.value)
          else issues.push(...r.issues)
        }
        appendMessage({
          id: nextMessageId('a'), role: 'assistant', text: parsed.displayText, createdAt: Date.now(),
          commands: commands.map(c => (c.type === 'motion' ? `motion:${c.motion}` : c.type === 'emotion' ? `emotion:${c.emotion}` : c.type)),
          origin: 'user',
        })
        if (parsed.unknown.length) log().info('丢弃未知动作标记', { count: parsed.unknown.length, sample: parsed.unknown.slice(0, 4).join(',') }, 'chat.marker.unknown')
        if (issues.length) log().warn('动作命令校验失败（已丢弃）', { count: issues.length, sample: issues.slice(0, 3).join(' | ') }, 'chat.command.invalid')
        send(IPC.EVT_CHAT_DONE, ChatDoneSchema, {
          requestId, text: parsed.displayText, commands,
          usage: done.usage, aborted: false, durationMs: 0,
        })
        void received
      },
      onError: (e) => {
        activeChat = null
        if (activeChatTimer) { clearInterval(activeChatTimer); activeChatTimer = null }
        send(IPC.EVT_CHAT_ERROR, ChatErrorSchema, { requestId, code: e.code, message: e.message, retryable: e.retryable })
      },
    })
    if (activeChat) activeChat.handle = h

    // 不活跃看门狗（可关：`chatIdleAbortMs = 0`）
    const idleMs = loadSettings().chatIdleAbortMs
    if (activeChatTimer) { clearInterval(activeChatTimer); activeChatTimer = null }
    if (idleMs > 0) {
      activeChatTimer = setInterval(() => {
        if (!activeChat || activeChat.requestId !== requestId) return
        if (Date.now() - activeChat.lastDeltaAt > idleMs) abortActive('idle')
      }, Math.min(5000, Math.max(1000, Math.floor(idleMs / 4))))
      activeChatTimer.unref?.()
    }

    return { ok: true, requestId } as unknown as Result
  })
  guarded(IPC.CHAT_ABORT, null, () => {
    const r = abortActive('user')
    return { ok: true, aborted: r.aborted, requestId: r.requestId, receivedChars: r.receivedChars } as unknown as Result
  })
  guarded(IPC.CHAT_CLEAR, null, () => {
    const n = clearHistory()
    return { ok: true, removed: n } as unknown as Result
  })
  guarded(IPC.CHAT_HISTORY, null, () => {
    const limit = loadSettings().chatHistoryLimit
    /**
     * ⚠ 读的是**当前这一段**（`visibleHistory`），不是全量（2026-10-09 完善轮）。
     *   上一段对话在她那边已经"不记得"了，界面上也不该继续摆着 ——
     *   否则会出现"她说她不记得，可那些话明明还在上面"。
     *   全量历史仍然可从隐私导出拿到（数据一条没删）。
     */
    const msgs = visibleHistory(limit)
    return { ok: true, messages: msgs, total: msgs.length } as unknown as Result
  })
  /**
   * ★★ 「新建对话」：**只重置上下文，不删历史**（2026-10-09 完善轮）。
   *
   * ⚠ 与 `CHAT_CLEAR` 的差别是**不可逆性**：这里一条都不删。
   *   出参带三个计数（archived / visible / total），
   *   探针据此断言"历史真的没被删"（`totalCount` 不减），而不是只看 `ok:true`。
   */
  guarded(IPC.CHAT_CONTEXT_RESET, null, () => {
    const r = resetContext()
    return { ok: true, ...r } as unknown as Result
  })
  /**
   * ★ 「对话 → 打开数据目录」。
   *
   * 出参含目录路径：与 `privacy:summary` 的 `userDataDir` **同一份来源、同一口径**
   * （那是本应用固定的 `%APPDATA%\AiriMateOne`，不含密钥、不含正文）。
   * 给它是为了让"这个菜单项真的有动作"可以被机械验证 ——
   * 否则只能靠人眼看着资源管理器弹出来。
   */
  guarded(IPC.CHAT_OPEN_DATA_DIR, null, async () => {
    const dir = appPaths().userData
    const logs = appPaths().logsDir
    const opened = await openDirSafely(dir)
    return { ok: true, dataDir: dir, logsDir: logs, opened } as unknown as Result
  })
  guarded(IPC.MEMORY_LIST, null, () => {
    const entries = listMemory(200)
    return { ok: true, entries, total: memoryCount() } as unknown as Result
  })
  /**
   * `memory:add` —— 显式写入一条长期记忆。
   * 入参校验在 main 侧（`MemoryAddRequestSchema`）：长度上限 4000，importance 夹到 [0,1]。
   * 出参**不含**任何密钥类字段；记忆正文回显给 renderer 是必要的（用户要看到记了什么）。
   */
  guarded(IPC.MEMORY_ADD, MemoryAddRequestSchema, (input) => {
    const entry = addMemory({ text: input.text, tags: input.tags, importance: input.importance })
    return { ok: true, entry, total: memoryCount() } as unknown as Result
  })
  /** `memory:update` —— 编辑正文/标签/重要度；找不到该条**如实返回失败**（不静默） */
  guarded(IPC.MEMORY_UPDATE, MemoryUpdateRequestSchema, (input) => {
    const entry = updateMemory({ id: input.id, text: input.text, tags: input.tags, importance: input.importance })
    if (!entry) return err('MEMORY_NOT_FOUND', '这条记忆已经不存在了（可能已被删除）')
    return { ok: true, entry, total: memoryCount() } as unknown as Result
  })
  guarded(IPC.MEMORY_DELETE, MemoryDeleteRequestSchema, (input) => {
    const removed = deleteMemory(input.id)
    return { ok: true, removed, total: memoryCount() } as unknown as Result
  })
  /**
   * `memory:search` —— 管理与浏览用的检索（**不写使用统计**，见 memory-store 注释）。
   * 空查询退化为"按重要度 + 时间"排序，便于用户扫一遍全部记忆。
   */
  guarded(IPC.MEMORY_SEARCH, MemorySearchRequestSchema, (input) => {
    const hits = searchMemory({ query: input.query, limit: input.limit, minImportance: input.minImportance, tag: input.tag })
    return { ok: true, hits, count: hits.length, total: memoryCount() } as unknown as Result
  })
  /**
   * `memory:recall` —— 只读召回（**不**触发"使用统计"写入之外的副作用）。
   * 为什么暴露给 renderer：设置面板需要让用户看到"这句话会让我想起什么"，
   * 否则记忆层是个黑盒，用户无法判断该记什么、该删什么。
   */
  guarded(IPC.MEMORY_RECALL, MemoryRecallRequestSchema, (input) => {
    const hits = recall(input.query, input.limit)
    return { ok: true, hits, count: hits.length } as unknown as Result
  })
  /**
   * `memory:recall-preview` —— 召回预览：命中条目 **+ 真正会被注入系统提示的文本**。
   * 与 `memory:recall` 共用一次召回（`previewRecall`），避免使用次数被算两遍。
   */
  guarded(IPC.MEMORY_RECALL_PREVIEW, MemoryRecallRequestSchema, (input) => {
    const r = previewRecall(input.query, input.limit)
    return {
      ok: true, query: input.query, hits: r.hits,
      injectedBlock: r.injectedBlock, injectedChars: r.injectedChars,
    } as unknown as Result
  })
  guarded(IPC.PERSONA_GET, null, () => ({ ok: true, persona: getPersona() } as unknown as Result))
  guarded(IPC.PERSONA_SET, PersonaContractSchema, (input) => {
    const p = setPersona({
      id: input.id, name: input.name, userTitle: input.userTitle,
      systemPrompt: input.systemPrompt, personality: input.personality,
      speakingStyle: input.speakingStyle, greeting: input.greeting,
      performance: input.performance,
    })
    return { ok: true, persona: p } as unknown as Result
  })
  guarded(IPC.PROVIDER_LIST, null, () => {
    const store = secretStore()
    const cfg = loadProviders()
    /**
     * **出参永不含 apiKey**：只给 { hasKey, keyFingerprint, keyLength }。
     * renderer 拿到的信息足以判断"配没配、是不是同一把钥匙"，但无法还原密钥。
     */
    const providers = cfg.providers.map(p => ({
      id: p.id, label: p.label, kind: p.kind, baseUrl: p.baseUrl, model: p.model,
      createdAt: p.createdAt, updatedAt: p.updatedAt,
      hasKey: store.has(p.id),
      keyFingerprint: store.fingerprintOf(p.id),
      keyLength: store.lengthOf(p.id),
      active: cfg.activeId === p.id,
    }))
    return { ok: true, backend: store.backendName, providers } as unknown as Result
  })
  guarded(IPC.PROVIDER_UPSERT, ProviderUpsertSchema, (input) => {
    const store = secretStore()
    const p = upsertProvider({ id: input.id, label: input.label, kind: input.kind as never, baseUrl: input.baseUrl, model: input.model })
    // 密钥：明文只在这一刻存在；写入后立即丢弃（safeStorage 落密文）
    if (typeof input.apiKey === 'string' && input.apiKey.length > 0) {
      try {
        store.set(p.id, input.apiKey)
      } catch (e) {
        log().warn('密钥保存失败', { id: p.id, err: e instanceof Error ? e.message : String(e) }, 'provider.key.save-failed')
        return err('SECRET_BACKEND', '密钥后端不可用：拒绝保存（绝不降级为明文）')
      }
    } else if (input.apiKey === '') {
      store.clear(p.id)
    }
    return {
      ok: true,
      provider: {
        id: p.id, label: p.label, kind: p.kind, baseUrl: p.baseUrl, model: p.model,
        hasKey: store.has(p.id), keyFingerprint: store.fingerprintOf(p.id), keyLength: store.lengthOf(p.id),
      },
    } as unknown as Result
  })
  guarded(IPC.PROVIDER_DELETE, z.object({ id: z.string().max(64) }), (input) => {
    const store = secretStore()
    store.clear(input.id)
    const removed = deleteProvider(input.id)
    return { ok: removed } as unknown as Result
  })
  /** `provider:select` —— 多供应商时显式选"用哪一个"（向导第 3 步也用它） */
  guarded(IPC.PROVIDER_SELECT, ProviderSelectSchema, (input) => {
    const okSel = setActive(input.id)
    if (!okSel) return err('PROVIDER_MISSING', '该供应商不存在')
    // 生效供应商变了 ⇒ 上一次的连接测试结果**作废**（不能拿旧结果解锁新配置）
    recordOnboardingTest(input.id, false, 'switched')
    return { ok: true } as unknown as Result
  })
  guarded(IPC.PROVIDER_TEST, z.object({ id: z.string().max(64) }), async (input) => {
    const p = getProvider(input.id)
    if (!p) return err('PROVIDER_MISSING', '供应商不存在')
    const key = secretStore().get(p.id)
    const r = await testProvider(p, key)
    // ★ 向导判据的唯一写入点：**只有真的连通**才记 ok
    recordOnboardingTest(p.id, r.ok, r.code)
    // 结果里**不含**密钥，也不含完整 URL（只有 code / latency / 文案 / 模型数）
    return { ...r, ok: r.ok } as unknown as Result
  })
  /** `provider:models` —— 从端点拉模型清单（向导"选择模型"；不支持时如实返回 supported:false） */
  guarded(IPC.PROVIDER_MODELS, z.object({ id: z.string().max(64) }), async (input) => {
    const p = getProvider(input.id)
    if (!p) return err('PROVIDER_MISSING', '供应商不存在')
    const r = await listProviderModels(p, secretStore().get(p.id))
    return { ok: true, ...r } as unknown as Result
  })

  // ── TTS（语音合成）：Windows 内置 SAPI，**主进程独占** ──────────────────
  //
  // 边界（Tech-Spec §7）：
  //   · 进程只由主进程起（renderer 没有 child_process，也不该有）；
  //   · 正文**只经 stdin** 进子进程，命令行里只有常量脚本 ⇒ 命令行/进程列表拿不到对话内容；
  //   · 日志只记 `{ chars, chunks, voice, engine, ms }`，**永不记正文**；
  //   · 失败一律结构化 Result（`TTS_FAILED`），不跨 IPC 抛异常。
  //
  // ⚠ **引擎实例来自适配层**（`capabilityKit().sapi()`），不在这里新建：
  //   tts-engine 是单实例语义的，两个实例＝两个 SAPI 子进程抢音频设备
  //   （声音交叠 + 取消语义混乱）。适配层把"用哪个 TTS"收敛成一次选型。
  const ttsRequest = z.object({
    text: z.string().min(1).max(20000),
    /** 幂等键 / 供 `evt:tts-state` 关联（与 SpeechCommandSchema.utteranceId 同形） */
    utteranceId: z.string().min(1).max(64),
    /** 覆盖本次朗读的声音名；缺省用设置里的 ttsVoice（再缺省 zh-CN 优先） */
    voice: z.string().max(64).nullable().optional(),
  })

  const ttsAdapter = capabilityKit().sapi()
  const ttsEngine = ttsAdapter.engine

  // ── M1：首次运行向导
  guarded(IPC.ONBOARDING_GET, null, () => ({ ok: true, status: onboardingStatus() } as unknown as Result))
  guarded(IPC.ONBOARDING_SET_STEP, OnboardingSetStepSchema, (input) => {
    // 前进时用 `advanceOnboarding`（会重新判定判据）；后退/跳步由 renderer 显式指定
    const status = advanceOnboarding(input.step)
    return { ok: true, status } as unknown as Result
  })
  guarded(IPC.ONBOARDING_COMPLETE, OnboardingCompleteSchema, (input) => {
    if (input.completed) {
      const st = onboardingStatus()
      // **不许跳过未满足的步骤**：向导的意义就是"每一步都真的做过"
      if (st.blockedBy !== null) {
        return err('ONBOARDING_INCOMPLETE', `还有未完成的步骤：${st.blockedBy}（${st.hint}）`)
      }
    }
    completeOnboarding(input.completed)
    return { ok: true, status: onboardingStatus() } as unknown as Result
  })
  guarded(IPC.ONBOARDING_RESET, null, () => {
    resetOnboarding()
    return { ok: true, status: onboardingStatus() } as unknown as Result
  })

  // ── M1：隐私与数据主体权利
  guarded(IPC.PRIVACY_EXPORT, PrivacyExportRequestSchema, (input) => {
    const r = exportPersonalData(input)
    return { ok: true, ...r } as unknown as Result
  })
  guarded(IPC.PRIVACY_WIPE, PrivacyWipeRequestSchema, (input) => {
    const r = wipePersonalData(input)
    return { ok: true, ...r } as unknown as Result
  })
  guarded(IPC.PRIVACY_SUMMARY, null, () => ({ ok: true, summary: privacySummary() } as unknown as Result))

  // ── 适配层框架（M5 §1）：把"现在到底在用哪个实现"变成可机械验证的事实
  //
  // 这四个通道**只读**，存在的意义是让设置页/隐私页/探针能如实回答：
  //   "这个应用有哪些能力？各类现在是哪个实现在生效？为什么别的候选没被选中？
  //    这个资产许不许用？工具调用被怎么判的？数据存在哪、什么版本？"
  //
  // ⚠ 下面这句原来是这么写的："出参里**没有密钥、没有绝对路径**、没有用户正文"。
  //    **那是假的**，而且是同一个错误犯第二次：真正的实测（打包载荷里跑 `kit` 探针）
  //    抓到了两条绝对路径 ——
  //      · `adapters[].unavailableReason` = `清单不存在：F:\…\catalog.json`
  //      · `assets.detail` / `assets.rejected[].detail` 同源
  //    逐字段修补救不了这个：新增一个说明性字段就又漏一次。
  //    所以现在**四个通道全部**在出口处过一遍 `redactDeep()`（见 KIT_CAPABILITIES 处的注释），
  //    并且按纪律：**关于安全的声明必须以实测为准，不能凭设计意图写。**
  guarded(IPC.KIT_CAPABILITIES, null, () => ({
    ok: true,
    /**
     * `redactDeep()` 不能只加在 assets 上：泄漏实测出现在**这个**通道里
     * （`adapters[].unavailableReason` / `origin` 是自由文本，会带上资产目录）。
     * 深度清洗放在**唯一出口**，比在 `capabilityDiagnostics()` 里逐个字段投影更可靠 ——
     * 后者依赖"每次加字段都记得再清洗一次"，而漏的永远是忘了的那次。
     */
    kit: redactDeep(capabilityDiagnostics()),
  } as unknown as Result))
  guarded(IPC.KIT_ASSETS, null, () => {
    const res = capabilityKit().asset().last() ?? capabilityKit().asset().resolve()
    /**
     * ⚠ **不返回绝对路径**。
     *
     * 这里**曾经**是逐字段点名处理：只投影 `license.note` 与 `licenseSource`。
     * 实测在**打包载荷**里跑探针时又抓到两条同类泄漏：
     *   · `assets.detail`           ← `readCatalog()` 的 `清单不存在：<绝对路径>`
     *   · `assets.rejected[].detail` ← `文件不存在：<绝对路径>`
     * 也就是同一个洞在同一批出参里**又漏了两个字段** —— 逐字段修补依赖
     * "每次加字段都记得再点一次名"，而那正是最容易忘的一步。
     *
     * 现在改成对**整个出参**做一次 `redactDeep()`：新增字段自动被覆盖。
     */
    const project = (a: { id: string, license: Parameters<typeof projectLicenseForRenderer>[0], verdict: unknown }) => ({
      id: a.id,
      license: projectLicenseForRenderer(a.license),
      verdict: a.verdict,
    })
    return {
      ok: true,
      assets: redactDeep({
        detail: res.detail,
        selectedId: res.selected?.id ?? null,
        usable: res.avatars.map(project),
        rejected: res.rejected,
        total: res.all.length,
      }),
    } as unknown as Result
  })
  guarded(IPC.KIT_TOOL_AUDIT, null, () => ({
    ok: true,
    // 同理走出口清洗：审计条目里有 `reason` 这类自由文本，将来可能带上路径
    ...redactDeep({
      calls: recentToolCalls(50),
      digest: toolAuditDigest(),
    }),
  } as unknown as Result))
  guarded(IPC.KIT_STORES, null, () => {
    /**
     * ⚠ 这里**不能**写死 `lastMigration: null`（早期就是那样，等于把
     *   `JsonStore.lastMigration()` 与 `toRecord()` 都实现了却没人读 ⇒
     *   "迁移到底发生没发生"在界面上永远看不见）。
     *   现在从**每个存储自己的实例**里读真实结论。
     */
    const states = storeMigrationStates()
    const stores = storeCatalogDigest().map(d => ({
      ...d,
      lastMigration: states[d.name] ?? null,
    }))
    return {
      ok: true,
      ...redactDeep({ stores, personal: personalStoreNames(), unregistered: unregisteredStoreTags() }),
    } as unknown as Result
  })

  // ── M3 语音（默认关闭；这里的通道只暴露"状态与开关"，不暴露识别正文之外的任何东西）
  guarded(IPC.VOICE_STATUS, null, () => ({ ok: true, status: voiceStatus() } as unknown as Result))
  guarded(IPC.VOICE_CONFIG, VoiceConfigRequestSchema, (input) => {
    const status = setVoiceConfig(input)
    /**
     * ★ 设置改了 ⇒ 立刻把"待机听唤醒"拉到应有状态（2026-10-06，A4）。
     *   不这样做的话：用户关掉唤醒开关，待机循环**还在听** ——
     *   那就是"开关显示关了、麦克风其实还开着"，属最不该出现的形态。
     */
    const wake = reconcileWakeWatch()
    return { ok: true, status, wakeWatch: wake } as unknown as Result
  })
  guarded(IPC.VOICE_STOP, null, () => {
    const cancelled = stopVoice('user')
    return { ok: true, cancelled, status: voiceStatus() } as unknown as Result
  })
  guarded(IPC.VOICE_PROBE, null, async () => {
    const r = await probeVoice()
    return { ok: true, probe: r, status: voiceStatus() } as unknown as Result
  })
  /**
   * `voice:listen-once` —— 识别一句。
   *
   * ⚠ **必须用户已在设置里开启语音**才允许（`hearingEnabled`）：
   *   否则 renderer 一句调用就能让麦克风被打开 —— 那正是"后台偷听"的形状，
   *   即使用户点了按钮也不行：开关必须在设置里，且状态可见。
   */
  guarded(IPC.VOICE_LISTEN_ONCE, VoiceListenRequestSchema, async (input) => {    if (!loadSettings().hearingEnabled) {
      return err('VOICE_DISABLED', '语音识别未启用（请在设置 → 语音里显式开启；默认关闭）')
    }
    const r = await listenOnce({ timeoutMs: input.timeoutMs ?? loadSettings().voiceListenTimeoutMs })
    /**
     * ⚠ 顺序：先展开 `r` 再写 `ok:true`。
     *   反过来会让 `r.ok` 覆盖掉 `ok:true` —— 而这里的 `ok` 是 **IPC 层**的成功标志
     *   （通道跑通了），`r.ok` 是**识别本身**的成功标志（听清了没有）。
     *   两者语义不同：识别失败（`r.ok=false`）时，IPC 仍然是成功的，
     *   且必须把 `r.reason` 如实带回。混成一个字段会让调用方无法区分
     *   "通道坏了"与"没听清"（tsc 用一个 TS2783 提醒了这一点）。
     */
    return { ...r, ok: true, recognized: r.ok } as unknown as Result
  })

  // ── M3 语音通话（全链路：STT → LLM → TTS；可打断、连续对话）
  guarded(IPC.VOICE_CALL_START, null, () => {
    const r = startVoiceCall()
    if (!r.ok) return err('VOICE_CALL_REFUSED', r.reason ?? '无法开始语音通话')
    return { ok: true, state: voiceCallState() } as unknown as Result
  })
  guarded(IPC.VOICE_CALL_STOP, null, () => {
    const r = stopVoiceCall('user')
    return { ok: true, stopped: r.stopped, state: voiceCallState() } as unknown as Result
  })
  guarded(IPC.VOICE_CALL_INTERRUPT, null, () => {
    const r = interruptVoiceCall()
    return { ok: true, interrupted: r.interrupted, state: voiceCallState() } as unknown as Result
  })
  guarded(IPC.VOICE_CALL_STATE, null, () => {
    return { ok: true, state: voiceCallState(), preflight: voiceCallPreflight() } as unknown as Result
  })
  /**
   * ── 闭环的**可机械验证**读数（2026-10-06，A4）
   *
   * 为什么单开一条只读通道：用户裁定"做闭环"之后，"闭环到底接上了没有"
   * 必须有**一个明确的读数字段**，而不是靠读源码或拿麦克风试。
   * 它只回布尔与计数 —— 不含任何识别正文或回复内容。
   */
  guarded(IPC.VOICE_LOOP_STATUS, null, () => {
    return { ok: true, loop: voiceClosedLoopStatus() } as unknown as Result
  })
  /** 待机听唤醒的开关（**双重前置条件**在 `startWakeWatch` 里强制，不在这里放宽） */
  guarded(IPC.VOICE_WAKE_WATCH, VoiceWakeWatchRequestSchema, (input) => {
    if (input.enabled) {
      const r = startWakeWatch()
      if (!r.ok) return err('WAKE_WATCH_REFUSED', r.reason ?? '无法开始待机监听')
    }
    else { stopWakeWatch('user') }
    return { ok: true, loop: voiceClosedLoopStatus() } as unknown as Result
  })

  // ── M3 屏幕理解（按需；状态与提示可读，画面内容永不出主进程）
  guarded(IPC.SCREEN_STATUS, null, () => ({ ok: true, status: screenStatus() } as unknown as Result))
  guarded(IPC.SCREEN_PAUSE, ScreenPauseRequestSchema, (input) => {
    setScreenPaused(input.paused)
    return { ok: true, status: screenStatus() } as unknown as Result
  })
  guarded(IPC.SCREEN_NOTICE, null, () => ({ ok: true, notice: lastCaptureNotice() } as unknown as Result))

  // ── M3 目录白名单（授权/撤销；**出参只给 id 与末级目录名**）
  guarded(IPC.FS_ALLOWLIST, null, () => {
    return {
      ok: true,
      entries: allowlistEntriesForUi(),
      rules: (() => { const s = ruleSummary(); return { file: s.fileRules, dir: s.dirRules } })(),
    } as unknown as Result
  })
  guarded(IPC.FS_ALLOW_DIR, FsAllowDirRequestSchema, (input) => {
    const added = addAllowlistedDir(input.path)
    if (!added.ok) return err(added.code, added.detail)
    return { ok: true, entries: allowlistEntriesForUi() } as unknown as Result
  })
  guarded(IPC.FS_REVOKE_DIR, FsRevokeDirRequestSchema, (input) => {
    const removed = revokeAllowlistedDir(input.id)
    return { ok: removed, entries: allowlistEntriesForUi() } as unknown as Result
  })

  /**
   * `tool:confirm-result` —— 确认弹窗回传。
   * ⚠ 只接受**当前挂起**的 `confirmId`（防重放）：未知 id 直接忽略并记日志。
   */
  guarded(IPC.TOOL_CONFIRM_RESULT, ToolConfirmResultSchema, (input) => {
    const accepted = resolveToolConfirm(input.confirmId, input.approved)
    if (!accepted) {
      log().warn('收到未知或已过期的确认结果（已忽略）', { confirmId: input.confirmId.slice(0, 24) }, 'tool.confirm.unknown')
    }
    return { ok: true, accepted } as unknown as Result
  })

  // ── M4 每日自学习
  guarded(IPC.REFLECTION_STATUS, null, () => ({ ok: true, status: reflectionStatus() } as unknown as Result))
  /**
   * `reflection:run` —— 手动跑一次。
   * ⚠ **允许在开关关闭时手动跑**（用户点"现在看看"是明确意图），
   *   但 `settings.selfLearningEnabled` 仍决定"自动跑不跑"。
   *   探针用 `dryRun` 避免污染用户记忆。
   */
  guarded(IPC.REFLECTION_RUN, ReflectionRunSchema, async (input) => {
    const r = await runReflection({ force: input.force, dryRun: input.dryRun })
    return {
      ok: true, ran: r.ran, skippedReason: r.skippedReason, reflection: r.reflection,
    } as unknown as Result
  })
  guarded(IPC.REFLECTION_HISTORY, z.object({ limit: z.number().int().min(1).max(400).default(30) }).default({ limit: 30 }), (input) => {
    const days = reflectionHistory(input.limit)
    return { ok: true, days, total: days.length } as unknown as Result
  })
  guarded(IPC.REFLECTION_DAY, z.object({ day: z.string().max(10) }), (input) => {
    const day = getReflection(input.day)
    if (!day) return err('REFLECTION_MISSING', '这一天没有反思记录')
    return { ok: true, reflection: day } as unknown as Result
  })
  guarded(IPC.REFLECTION_PENDING, null, () => {
    const items = pendingItems()
    return { ok: true, items, count: items.length } as unknown as Result
  })
  /**
   * `reflection:decide` —— 用户确认或拒绝一条待确认项。
   *
   * ★ 这是 M4 的核心语义入口：**低置信度内容只有经这里才会写进长期记忆**。
   *   拒绝会记指纹 ⇒ 同一结论不再重复提问（避免把"确认"变成骚扰）。
   */
  guarded(IPC.REFLECTION_DECIDE, ReflectionDecideSchema, (input) => {
    const r = decideItem(input.day, input.itemId, input.approve, (text, item) => {
      try {
        const mem = addMemory({
          text,
          tags: ['自学习', item.kind, input.approve ? '已确认' : '待确认'],
          importance: Math.min(1, item.confidence),
        })
        return typeof mem?.id === 'string' ? mem.id : null
      } catch (e) {
        log().warn('确认后写入记忆失败', { err: e instanceof Error ? e.message : String(e) }, 'reflection.decide.memory-failed')
        return null
      }
    })
    if (!r.ok) return err('REFLECTION_ITEM_MISSING', '这一条不存在或已经处理过了')
    return { ok: true, memoryId: r.memoryId, item: r.item } as unknown as Result
  })
  guarded(IPC.REFLECTION_CLEAR, null, () => {
    const removed = clearAllReflections()
    // ⚠ 只清反思记录，**不动已写入的记忆**：那是两回事，
    //   删记忆请在记忆页逐条删或走 `privacy:wipe`（界面会如实说明这一点）
    return { ok: true, removedDays: removed } as unknown as Result
  })

  // ── M2：日程
  guarded(IPC.SCHEDULE_LIST, null, () => {
    const all = loadSchedules().schedules
    return { ok: true, schedules: all, total: all.length } as unknown as Result
  })
  guarded(IPC.SCHEDULE_UPSERT, ScheduleUpsertSchema, (input) => {
    try {
      const schedule = upsertSchedule(input)
      return { ok: true, schedule } as unknown as Result
    } catch (e) {
      // 形态错误（如 weekly 没给星期几）必须**如实拒绝**，否则会存下一条永不触发的日程
      return err('SCHEDULE_INVALID', e instanceof Error ? e.message : String(e))
    }
  })
  guarded(IPC.SCHEDULE_DELETE, ScheduleDeleteSchema, (input) => {
    const removed = deleteSchedule(input.id)
    return { ok: true, removed } as unknown as Result
  })

  // ── M2：提醒
  guarded(IPC.REMINDER_LIST, null, () => {
    const all = listReminders({ limit: 200 })
    return { ok: true, reminders: all, total: loadReminders().reminders.length } as unknown as Result
  })
  guarded(IPC.REMINDER_UPSERT, ReminderUpsertSchema, (input) => {
    try {
      const r = upsertReminder(input)
      return { ok: true, reminder: r } as unknown as Result
    } catch (e) {
      return err('REMINDER_INVALID', e instanceof Error ? e.message : String(e))
    }
  })
  guarded(IPC.REMINDER_DELETE, ReminderDeleteSchema, (input) => {
    const removed = deleteReminder(input.id)
    return { ok: true, removed } as unknown as Result
  })
  guarded(IPC.REMINDER_ACK, ReminderAckSchema, (input) => {
    const r = ackReminder(input.id, input.acked)
    if (!r) return err('REMINDER_MISSING', '该提醒不存在')
    return { ok: true, reminder: r } as unknown as Result
  })

  // ── M2：静音时段与阈值
  guarded(IPC.QUIET_GET, null, () => {
    return { ok: true, quiet: loadQuietHours(), policy: loadReminderPolicy() } as unknown as Result
  })
  guarded(IPC.QUIET_SET, QuietHoursSetSchema, (input) => {
    const quiet = setQuietHours(input)
    return { ok: true, quiet } as unknown as Result
  })
  guarded(IPC.QUIET_POLICY_SET, ReminderPolicySetSchema, (input) => {
    const policy = setReminderPolicy(input)
    return { ok: true, policy } as unknown as Result
  })

  // ── M2：权限
  guarded(IPC.PERMISSION_LIST, null, () => {
    const permissions = listPermissions()
    return { ok: true, permissions } as unknown as Result
  })
  guarded(IPC.PERMISSION_SET, z.object({
    kind: z.string().max(40),
    tier: z.enum(['read-only', 'confirm', 'blocked']).optional(),
    enabled: z.boolean().optional(),
    pathAllowlist: z.array(z.string().max(400)).max(64).optional(),
    excludeRegions: z.array(z.object({
      x: z.number().min(0).max(1), y: z.number().min(0).max(1),
      w: z.number().min(0).max(1), h: z.number().min(0).max(1),
    })).max(16).optional(),
    redactSensitive: z.boolean().optional(),
  }), (input) => {
    try {
      const permission = setPermission(input as never)
      return { ok: true, permission } as unknown as Result
    } catch (e) {
      return err('PERMISSION_INVALID', e instanceof Error ? e.message : String(e))
    }
  })

  // ── M2：活动与主动引擎
  guarded(IPC.ACTIVITY_STATS, null, () => {
    return {
      ok: true,
      today: todayStats(),
      currentStreakMinutes: currentStreakMinutes(),
      advice: adviceFromStats(),
      activity: currentActivity(),
      blocker: currentBlocker(),
      probe: probeDiagnostics(),
    } as unknown as Result
  })
  guarded(IPC.PROACTIVE_STATUS, null, () => ({ ok: true, status: proactiveStatus() } as unknown as Result))
  guarded(IPC.PROACTIVE_INBOX, null, () => ({ ok: true, inbox: proactiveInbox() } as unknown as Result))
  guarded(IPC.PROACTIVE_TICK, null, async () => {
    // 手动推进一次（探针与"我刚改完设置，立刻看看对不对"用）
    const r = await runTick({
      settings: () => loadSettings(),
      patchSettings: (p) => { patchSettings(p) },
      sample: async () => currentActivity() ?? {
        at: Date.now(), idleMs: 0, inputEvents1m: 0, fullscreen: false, gameProcess: null,
        meeting: null, focusAssist: false, userSilent: loadSettings().userSilent, titleDigest: null,
        titleChars: 0, available: false, unavailableReason: '手动 tick 未采样', blockReason: 'none',
      },
      emit: (e) => sendProactiveEvent(e),
      speak: async () => { /* 手动 tick 不发声 */ },
      ready: async () => ({ network: true, provider: activeProvider() !== null, detail: 'manual' }),
    })
    return { ok: true, result: r } as unknown as Result
  })
  /**
   * `proactive:radio` —— 手动/探针触发一次早安电台。
   * `force:true` 时忽略冷却与"今天已播报"（探针要能反复拿到内容）；
   * `speak` 默认 **false**：探针环境不该突然放音吓到人。
   */
  guarded(IPC.PROACTIVE_RADIO, ProactiveRadioRequestSchema, async (input) => {
    const r = await generateRadio({
      settings: () => loadSettings(),
      patchSettings: (p) => { patchSettings(p) },
      sample: async () => currentActivity() ?? {
        at: Date.now(), idleMs: 0, inputEvents1m: 0, fullscreen: false, gameProcess: null,
        meeting: null, focusAssist: false, userSilent: loadSettings().userSilent, titleDigest: null,
        titleChars: 0, available: false, unavailableReason: 'radio 未采样', blockReason: 'none',
      },
      emit: (e) => sendProactiveEvent(e),
      speak: async (text, id) => {
        const settings = loadSettings()
        if (!settings.ttsEnabled) return
        await ttsEngine.speak(text, id, { voice: settings.ttsVoice ?? null, output: 'device' })
      },
      ready: async () => ({ network: true, provider: activeProvider() !== null, detail: 'radio' }),
    }, { force: input.force, speak: input.speak })
    return { ok: true, content: r.content, skippedReason: r.skippedReason, spoken: input.speak && r.skippedReason === null } as unknown as Result
  })
  /**
   * ── TTS 的 IPC 出口（引擎实例在文件上方创建，见那里的边界说明）──────────────
   */
  guarded(IPC.TTS_SPEAK, ttsRequest, async (input): Promise<Result> => {
    const settings = loadSettings()
    if (!settings.ttsEnabled) return err('TTS_FAILED', '语音合成未启用（请在设置里打开）')
    // 本次调用显式指定的声音优先于设置（缺省时引擎内部读 ttsVoice）
    // ⚠ 固定 `output:'device'`：`evt:tts-audio` 的静默档只给探针用，renderer 不得请求
    const r: TtsSpeakResult = await ttsEngine.speak(input.text, input.utteranceId, { voice: input.voice ?? null, output: 'device' })
    /**
     * 出参：**不含正文**。
     * `ok:false` 时 `completed:false reason:'failed'` 与 `error` 并存 ——
     * 与 Result 判别联合会合：先看 ok，再看 error.code。
     */
    return { ...r, engine: TTS_ENGINE, activeVoice: r.voice || null } as unknown as Result
  })

  /**
   * `tts:stop` —— 杀掉在飞的子进程。
   * ⚠ **必定立即 resolve**（不等待子进程真正退出）：等待会把 renderer 的
   *   停止按钮拖住几百毫秒；在飞的 speak promise 会自己以 `reason:'cancelled'` settle。
   */
  guarded(IPC.TTS_STOP, null, () => {
    const had = ttsEngine.stop()
    return { ok: true, cancelled: had, engine: TTS_ENGINE } as unknown as Result
  })

  /**
   * `tts:voices` —— 只读枚举本机声音（不调 Speak，不解锁音频设备，可随时调）。
   * 同时给出**当前会选中哪一个**（zh-CN 优先 + 用户偏好），
   * 让设置页能如实展示"实际会用哪个声音"，而不是让用户猜。
   */
  guarded(IPC.TTS_VOICES, null, async (): Promise<Result> => {
    const r = await listVoices()
    if (!r.ok) return err('TTS_FAILED', r.error ?? '声音枚举失败')
    const preferred = loadSettings().ttsVoice
    const selected = chooseVoice(r.voices, preferred)
    return {
      ok: true,
      engine: TTS_ENGINE,
      voices: r.voices.map(toVoiceInfo),
      selected,
      preferred: preferred ?? null,
      /** 偏好没命中时如实说明（不静默换声音） */
      preferredMissing: preferred !== null && selected !== preferred,
    } as unknown as Result
  })
  guarded(IPC.TELEMETRY, null, () => ok())

  log().info('IPC 白名单已注册', { channels: Object.values(IPC).length }, 'ipc.ready')
}

export function unregisterIpc(): void {
  for (const channel of Object.values(IPC)) {
    try { ipcMain.removeHandler(channel) } catch { /* ignore */ }
    try { ipcMain.removeAllListeners(channel) } catch { /* ignore */ }
  }
  // 断言账本必须跟着一起清 —— 否则"通道已注册"会在卸载后继续为真（假结论）
  registeredChannels.clear()
}
