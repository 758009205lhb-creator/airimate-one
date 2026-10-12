/**
 * apps/desktop/src/main/single-instance.ts —— 三层单实例保护的编排（Tech-Spec §3）
 *
 *   L1 `app.requestSingleInstanceLock()`   —— 由 bootstrap 调用（最早）
 *   L2 命名互斥量 `Local\AiriMateOne.Singleton`
 *   L3 用户级运行锁文件（含 pid / 启动时间 / 心跳 / appId）
 *
 * 冲突裁决：L1 > L2 > L3；不一致时以 L1 为准并把三层结果写入诊断。
 * 第二次启动的**唯一**动作：把已有实例唤醒并聚焦，然后自己退出。绝不创建窗口。
 */
import { execFileSync } from 'node:child_process'
import { log } from './log.js'
import { acquireNamedMutex, releaseNamedMutex } from './mutex-keeper.js'
import {
  acquireLockFile, isOwnedByThisApp, lockFileExists, readCurrentLock, releaseLockFile,
  startHeartbeat, stopHeartbeat, type LockAcquireResult, type LockPayload,
} from './lock-file.js'

export interface SingleInstanceStatus {
  l1: boolean
  l2: 'held' | 'already-held' | 'unavailable' | 'skipped'
  l3: 'acquired' | 'acquired-stale' | 'held-by-other' | 'skipped'
  mutexHolderPid: number | null
  mutexMethod: 'dotnet' | 'powershell' | 'none'
  lock: LockPayload | null
  otherPid: number | null
  decision: 'primary' | 'secondary'
  notes: string[]
}

let status: SingleInstanceStatus | null = null
let heartbeatStarted = false

export function instanceStatus(): SingleInstanceStatus | null {
  return status
}

/**
 * 在 `app.whenReady()` **之前**调用。
 * @param l1Granted `app.requestSingleInstanceLock()` 的结果
 * @param selfExe process.execPath
 */
export async function initSingleInstance(l1Granted: boolean, selfExe: string, version: string, bootId: string): Promise<SingleInstanceStatus> {
  const notes: string[] = []

  // L1 未拿到 ⇒ 就是第二实例：不创建窗口，直接退出（唤醒由第一实例的 second-instance 事件处理）
  if (!l1Granted) {
    status = {
      l1: false, l2: 'skipped', l3: 'skipped',
      mutexHolderPid: null, mutexMethod: 'none',
      lock: readCurrentLock(), otherPid: null, decision: 'secondary',
      notes: ['L1 未取得锁：判定为第二实例'],
    }
    log().info('第二实例启动，退出（由第一实例处理唤醒）', {}, 'singleton.secondary')
    return status
  }

  // L2
  let mutex: Awaited<ReturnType<typeof acquireNamedMutex>>
  try {
    mutex = await acquireNamedMutex()
  } catch (e) {
    mutex = { status: 'unavailable', holderPid: null, method: 'none', error: e instanceof Error ? e.message : String(e) }
  }
  if (mutex.status === 'unavailable') notes.push(`L2 不可用：${mutex.error ?? 'unknown'}`)

  // L3
  let lock: LockAcquireResult = { status: 'skipped' as unknown as 'acquired', payload: null, otherPid: null }
  try {
    lock = acquireLockFile(selfExe, version, bootId)
  } catch (e) {
    notes.push(`L3 异常：${e instanceof Error ? e.message : String(e)}`)
  }

  const secondaryByL2 = mutex.status === 'already-held'
  const secondaryByL3 = lock.status === 'held-by-other'
  const decision: 'primary' | 'secondary' = secondaryByL2 ? 'secondary' : 'primary'
  if (secondaryByL2 && !secondaryByL3) notes.push('L2 与 L3 结论不一致（L2=已持有，L3=可接管）：按裁决顺序取 L2')
  if (!secondaryByL2 && secondaryByL3) notes.push('L2 与 L3 结论不一致（L2=已取得，L3=他进程持有）：按裁决顺序取 L2')

  status = {
    l1: true,
    l2: mutex.status,
    l3: lock.status,
    mutexHolderPid: mutex.holderPid,
    mutexMethod: mutex.method,
    lock: lock.payload,
    otherPid: secondaryByL2 ? null : (secondaryByL3 ? lock.otherPid : null),
    decision,
    notes,
  }

  if (decision === 'secondary') {
    log().warn('判定为第二实例（L2 命名互斥量已被持有），即将唤醒已有实例', { notes: notes.join(' | ') }, 'singleton.secondary')
  } else {
    log().info('取得主实例身份', {
      mutex: mutex.status, mutexMethod: mutex.method, lock: lock.status, staleReason: lock.staleReason ?? '',
    }, 'singleton.primary')
  }
  return status
}

export function startInstanceHeartbeat(getWindowMode: () => string): void {
  if (heartbeatStarted) return
  heartbeatStarted = true
  startHeartbeat(getWindowMode)
}

export function shutdownSingleInstance(): void {
  stopHeartbeat()
  releaseLockFile()
  releaseNamedMutex()
}

// ───────────────────────────────────────────────────────── 唤醒

/**
 * 唤醒并聚焦指定 pid 拥有的窗口。
 * 只做"前台化"，不做任何终止动作；失败只记日志。
 */
export function wakeExistingInstance(pid: number, selfExe: string): { ok: boolean, detail: string } {
  const own = isOwnedByThisApp(pid, selfExe)
  if (!own.owned) {
    return { ok: false, detail: `pid ${pid} 归属未确认（imagePath=${own.imagePath ?? '<unknown>'}）→ 不做前台化` }
  }
  try {
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);';
       $p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $h = $p.MainWindowHandle; if ($h -ne 0) { [W.U]::ShowWindow($h, 9) | Out-Null; [W.U]::SetForegroundWindow($h) | Out-Null; 'FOCUSED' } else { 'NO-WINDOW' } } else { 'NO-PROCESS' }`,
    ], { encoding: 'utf8', windowsHide: true, timeout: 8_000 })
    return { ok: true, detail: 'focus attempted' }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

/** 二次启动时：从锁文件里找到第一实例的 pid */
export function findPrimaryPid(selfExe: string): number | null {
  if (!lockFileExists()) return null
  const p = readCurrentLock()
  if (!p || p.pid === process.pid) return null
  const own = isOwnedByThisApp(p.pid, selfExe)
  return own.owned ? p.pid : null
}
