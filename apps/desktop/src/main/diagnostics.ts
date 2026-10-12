/**
 * apps/desktop/src/main/diagnostics.ts —— 只读诊断快照（Tech-Spec §9）
 *
 * 用途：`tools/qa/*.mjs` 通过 `--diagnostics <file>` 让主进程在启动后把快照写到该文件，
 *       **不新开任何监听端口**（满足判据 A18）。
 *
 * 快照包含：
 *   - 应用实例/窗口计数（BrowserWindow.getAllWindows()，隐藏窗口按 isVisible() 判定）
 *   - 三层单实例结论、锁文件、互斥量持有者
 *   - 监听端口审计（环回判定）
 *   - 旧实例检测结果
 *   - 密钥后端状态（**只有** providerCount / backend，永远没有密钥材料）
 *   - renderer 侧舞台快照（Scene/Renderer/Mixer/VRM/Live2D 计数、骨骼、fps…）
 */
import { app, BrowserWindow, webContents } from 'electron'
import type { AppDiagnostics, StageSnapshot } from '@airimate/shared'
import { APP_ID, APP_NAME } from '@airimate/shared'
import { appPaths } from './paths.js'
import { instanceStatus } from './single-instance.js'
import { readCurrentLock } from './lock-file.js'
import { windowMode } from './window-manager.js'
import { conversationState } from './conversation.js'
import { secretStore } from './secrets-store.js'
import { hitRegionState } from './hit-region-registry.js'
import { auditListeningPorts } from './ports.js'
import { lastLegacyScan } from './legacy-state.js'
import { motionStatus } from './motion-state.js'
import { lastMemoryInjection } from './memory-state.js'
import { stageSnapshot, stageSnapshotAgeMs } from './stage-state.js'
import { currentActivity, proactiveStatus } from './proactive-engine.js'
import { permissionDigest } from './permission-store.js'
import { loadQuietHours, loadReminderPolicy } from './quiet-store.js'
import { loadReminders } from './reminder-store.js'
import { todayStats } from './activity-stats.js'
import { loadSchedules } from './schedule-store.js'
import { onboardingStatus } from './onboarding-store.js'
import { loadSettings } from './settings-store.js'
import { probeDiagnostics } from './activity-probe.js'
import { memoryCount } from './memory-store.js'
import { sessionMessageCount } from './session-store.js'

export interface PodInfo {
  /** 本应用进程组的所有 pid（用于端口归属判定） */
  pids: number[]
}

export function podPids(): number[] {
  const pids = new Set<number>([process.pid])
  try {
    for (const wc of webContents.getAllWebContents()) {
      const p = wc.getOSProcessId()
      if (p > 0) pids.add(p)
    }
  } catch { /* ignore */ }
  const s = instanceStatus()
  if (s?.mutexHolderPid) pids.add(s.mutexHolderPid)
  return [...pids]
}

/** 读取 renderer 主动推送的最新舞台快照（不做任何页面内脚本执行） */
export function collectStageSnapshot(): StageSnapshot | null {
  return stageSnapshot()
}

export function collectDiagnostics(): AppDiagnostics & {
  stage: StageSnapshot | null
  stageAgeMs: number | null
  /** 记忆层最后一次注入的**可判定证据**（不含正文，只有长度与指纹） */
  memory: ReturnType<typeof lastMemoryInjection>
  /**
   * ★ M1/M2 只读摘要。
   *
   * 为什么塞进诊断快照而不是另开取数通道：探针（`tools/qa/*.mjs`）只认诊断文件，
   * 而 M1/M2 的判据（向导进度、权限硬下限、提醒队列、静音时段、活动采样是否可用）
   * 都必须**可被机械验证**。这里全部只给**计数 / 枚举 / 时间戳**，不含任何正文
   * （`recentDecisions` 只有原因码，是刻意设计）。
   */
  m1: {
    onboarding: ReturnType<typeof onboardingStatus>
    providerCount: number
    providersWithKey: number
    chatMessageCount: number
    memoryCount: number
    telemetryEnabled: boolean
  }
  m2: {
    proactive: ReturnType<typeof proactiveStatus>
    permissions: ReturnType<typeof permissionDigest>
    quiet: { enabled: boolean, start: string, end: string }
    policy: { continuousMinutes: number, sedentaryMinutes: number, nightRestAt: string, maxRetries: number, maxQueue: number }
    schedules: { total: number, enabled: number, todayCount: number }
    reminders: { total: number, pending: number, queued: number, fired: number, failed: number }
    activity: { available: boolean, reason: string | null, probeScriptExists: boolean, shell: string | null, today: ReturnType<typeof todayStats> }
  }
} {
  const wins = BrowserWindow.getAllWindows().filter(w => !w.isDestroyed())
  const pids = podPids()
  const ports = auditListeningPorts(pids)
  const s = instanceStatus()
  const lock = readCurrentLock()
  const stage = collectStageSnapshot()
  const hit = hitRegionState()
  const legacy = lastLegacyScan()
  const store = secretStore()

  const diag: AppDiagnostics = {
    appId: APP_ID,
    version: app.getVersion(),
    pid: process.pid,
    bootId: process.env.AIRIMATE_BOOT_ID ?? 'unknown',
    uptimeSec: Math.round(process.uptime()),
    instances: 1,
    windows: wins.map(w => ({
      id: w.id,
      title: w.getTitle(),
      bounds: { ...w.getBounds() },
      visible: w.isVisible(),
      mode: windowMode(),
      alwaysOnTop: w.isAlwaysOnTop(),
      ignoreMouseEvents: hit.ignoring,
    })),
    browserWindowCount: wins.length,
    mutex: { holderPid: s?.mutexHolderPid ?? null, status: s?.l2 === 'held' ? 'held' : (s?.l2 === 'already-held' ? 'already-held' : 'unavailable') },
    lockFile: { path: appPaths().lockFile, pid: lock?.pid ?? null, stale: lock ? (Date.now() - Date.parse(lock.heartbeatAt || lock.startedAt) > 15_000) : false },
    listeningPorts: ports.sockets.filter(x => x.appOwned).map(x => ({ address: x.address, port: x.port, loopback: x.loopback })),
    legacy: {
      checked: legacy !== null,
      blocked: legacy?.blocked ?? false,
      hits: (legacy?.hits ?? []).map(h => ({ kind: h.kind, pid: h.pid, imagePath: h.imagePath, reason: h.reason })),
    },
    secrets: { backend: store.backendName, providerCount: store.list().length },
    motion: motionStatus(),
    /**
     * ★ 对话状态（本轮）：探针只认诊断文件，所以"对话框开没开、窗口在哪一种布局、
     *   全局快捷键到底注册上没有"必须在**同一份快照**里可读。
     *   包装成 try/catch：诊断**绝不允许**因为一个子模块异常而整体失败
     *   （快照是排障的唯一入口，见本文件顶部注释）。
     */
    conversation: conversationSafe(),
  }
  return {
    ...diag,
    stage,
    stageAgeMs: stageSnapshotAgeMs(),
    memory: lastMemoryInjection(),
    m1: {
      onboarding: onboardingStatus(),
      providerCount: secretStore().list().length,
      // `StoredSecretMeta` 只有 providerId/指纹/长度（**没有** hasKey 字段）——
      // 能列出元数据本身就等于"这把钥匙存在"。
      providersWithKey: secretStore().list().length,
      chatMessageCount: chatCountSafe(),
      memoryCount: memoryCountSafe(),
      telemetryEnabled: loadSettings().telemetryEnabled,
    },
    m2: {
      proactive: proactiveStatus(),
      permissions: permissionDigest(),
      quiet: (() => { const q = loadQuietHours(); return { enabled: q.enabled, start: q.start, end: q.end } })(),
      policy: (() => {
        const p = loadReminderPolicy()
        return {
          continuousMinutes: p.continuousMinutes, sedentaryMinutes: p.sedentaryMinutes,
          nightRestAt: p.nightRestAt, maxRetries: p.maxRetries, maxQueue: p.maxQueue,
        }
      })(),
      schedules: (() => {
        const all = loadSchedules().schedules
        const today = new Date()
        const dow = today.getDay()
        const dom = today.getDate()
        const todayCount = all.filter(s => s.enabled && (
          s.recurrence.kind === 'daily'
          || (s.recurrence.kind === 'weekdays' && dow >= 1 && dow <= 5)
          || (s.recurrence.kind === 'weekly' && s.recurrence.weekdays.includes(dow))
          || (s.recurrence.kind === 'monthly' && s.recurrence.dayOfMonth === dom)
        )).length
        return { total: all.length, enabled: all.filter(s => s.enabled).length, todayCount }
      })(),
      reminders: (() => {
        const all = loadReminders().reminders
        return {
          total: all.length,
          pending: all.filter(r => r.state === 'pending').length,
          queued: all.filter(r => r.state === 'queued').length,
          fired: all.filter(r => r.state === 'fired').length,
          failed: all.filter(r => r.state === 'failed').length,
        }
      })(),
      activity: (() => {
        const d = probeDiagnostics()
        return {
          available: activityAvailableSafe(),
          reason: activityReasonSafe(),
          probeScriptExists: d.scriptExists,
          shell: d.shell,
          today: todayStats(),
        }
      })(),
    },
  }
}

/** 计数包装：诊断**绝不允许**因为一个子模块异常而整体失败（快照是排障的唯一入口） */
function chatCountSafe(): number {
  try { return sessionMessageCount() } catch { return -1 }
}

/** 对话状态包装：同上，任何异常都降级成 `null` 而不是让整份诊断消失 */
function conversationSafe(): ReturnType<typeof conversationState> | null {
  try { return conversationState() } catch { return null }
}

function memoryCountSafe(): number {
  try { return memoryCount() } catch { return -1 }
}

function activityAvailableSafe(): boolean {
  try { return currentActivity()?.available ?? false } catch { return false }
}

function activityReasonSafe(): string | null {
  try { return currentActivity()?.unavailableReason ?? null } catch { return 'unavailable' }
}

export const APP_DISPLAY_NAME = APP_NAME
