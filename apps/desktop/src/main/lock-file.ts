/**
 * apps/desktop/src/main/lock-file.ts —— L3 单实例保护：用户级运行锁文件
 *
 * 文件：`%APPDATA%\AiriMateOne\run\instance.lock`
 * 内容：{ appId, pid, startedAt, heartbeatAt, version, windowMode, bootId }
 *
 * 裁决规则（Tech-Spec §3.3）：
 *   ① 无文件 ⇒ 接管；② pid 不存在 ⇒ 陈旧，接管；③ pid 存在但**归属不是本应用** ⇒ 陈旧（pid 复用），接管；
 *   ④ pid 存在且归属本应用且心跳新鲜（<15s）⇒ "已有实例"，走唤醒路径；⑤ 否则接管。
 *
 * 归属判定**只允许**依据：镜像路径（可执行文件绝对路径）与可执行文件大小/哈希。
 *   —— 禁止只凭进程名判定（PRD FR-3.2）。
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, fsyncSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname } from 'node:path'
import { APP_ID } from '@airimate/shared'
import { appPaths } from './paths.js'
import { log } from './log.js'

export interface LockPayload {
  appId: string
  pid: number
  startedAt: string
  heartbeatAt: string
  version: string
  windowMode: string
  bootId: string
}

export const HEARTBEAT_INTERVAL_MS = 5_000
export const STALE_AFTER_MS = 15_000

let heartbeatTimer: NodeJS.Timeout | null = null
let currentPayload: LockPayload | null = null

function readPayload(file: string): LockPayload | null {
  try {
    if (!existsSync(file)) return null
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<LockPayload>
    if (typeof raw?.pid !== 'number' || typeof raw?.appId !== 'string') return null
    return {
      appId: raw.appId,
      pid: raw.pid,
      startedAt: String(raw.startedAt ?? ''),
      heartbeatAt: String(raw.heartbeatAt ?? ''),
      version: String(raw.version ?? ''),
      windowMode: String(raw.windowMode ?? ''),
      bootId: String(raw.bootId ?? ''),
    }
  } catch { return null }
}

/** 原子写：临时文件 → fsync → rename（避免半写文件被另一个实例读到） */
function writePayloadAtomic(file: string, payload: LockPayload): void {
  const tmp = `${file}.tmp`
  mkdirSync(dirname(file), { recursive: true })
  const body = `${JSON.stringify(payload, null, 2)}\n`
  const fd = openSync(tmp, 'w')
  try {
    writeFileSync(fd, body, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
}

export interface ProcessIdentity {
  exists: boolean
  imagePath: string | null
  imageBytes: number | null
}

/** 用 CIM 取目标 pid 的映像路径与大小（只读；不做任何终止动作） */
export function processIdentity(pid: number): ProcessIdentity {
  if (!Number.isInteger(pid) || pid <= 0) return { exists: false, imagePath: null, imageBytes: null }
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; if ($p) { $f = Get-Item -LiteralPath $p.ExecutablePath -ErrorAction SilentlyContinue; "$($p.ExecutablePath)|$($f.Length)" }`,
    ], { encoding: 'utf8', windowsHide: true, timeout: 8_000 })
    const line = out.trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
    if (!line) return { exists: false, imagePath: null, imageBytes: null }
    const [imagePath, sizeStr] = line.split('|')
    const size = Number.parseInt(sizeStr ?? '', 10)
    return { exists: true, imagePath: imagePath ?? null, imageBytes: Number.isFinite(size) ? size : null }
  } catch {
    return { exists: false, imagePath: null, imageBytes: null }
  }
}

export interface OwnershipCheck {
  owned: boolean
  reason: 'path-match' | 'no-image-path' | 'path-mismatch'
  imagePath: string | null
}

/**
 * 判定某 pid 是否属于**本应用**。
 * 依据：映像路径与当前进程的可执行文件路径同目录且同名（Electron 应用的 exe 名固定）。
 * 打包后也可加签名/哈希比对；开发期（electron.exe + 本项目）通过"命令行含本工程路径"补充判定。
 */
export function isOwnedByThisApp(pid: number, selfExe: string): OwnershipCheck {
  const id = processIdentity(pid)
  if (!id.exists || !id.imagePath) return { owned: false, reason: 'no-image-path', imagePath: id.imagePath }
  const norm = (s: string): string => s.replace(/\//g, '\\').toLowerCase()
  const owned = norm(id.imagePath) === norm(selfExe)
  return { owned, reason: owned ? 'path-match' : 'path-mismatch', imagePath: id.imagePath }
}

export interface LockAcquireResult {
  status: 'acquired' | 'held-by-other' | 'acquired-stale'
  payload: LockPayload | null
  staleReason?: string
  otherPid: number | null
}

/**
 * 尝试接管锁文件。**必须在创建窗口之前调用。**
 * @param selfExe 本进程可执行文件绝对路径（Electron: process.execPath）
 */
export function acquireLockFile(selfExe: string, version: string, bootId: string, windowMode = 'panel'): LockAcquireResult {
  const file = appPaths().lockFile
  const now = Date.now()
  const existing = readPayload(file)

  if (existing && existing.appId === APP_ID && existing.pid !== process.pid) {
    const id = processIdentity(existing.pid)
    if (!id.exists) {
      log().info('锁文件陈旧（pid 不存在）→ 接管', { lockPid: existing.pid }, 'singleton.lock.stale')
      return writeFresh(file, selfExe, version, bootId, windowMode, 'pid-not-exist')
    }
    const own = isOwnedByThisApp(existing.pid, selfExe)
    if (!own.owned) {
      log().info('锁文件陈旧（pid 被复用或非本应用）→ 接管', { lockPid: existing.pid, imagePath: own.imagePath ?? '' }, 'singleton.lock.stale')
      return writeFresh(file, selfExe, version, bootId, windowMode, 'pid-reused')
    }
    const hb = Date.parse(existing.heartbeatAt || existing.startedAt || '')
    const age = Number.isFinite(hb) ? now - hb : Number.POSITIVE_INFINITY
    if (age < STALE_AFTER_MS) {
      log().info('锁文件显示已有实例在运行', { lockPid: existing.pid, ageMs: Math.round(age) }, 'singleton.lock.held')
      return { status: 'held-by-other', payload: existing, otherPid: existing.pid }
    }
    log().info('锁文件心跳过期 → 接管', { lockPid: existing.pid, ageMs: Math.round(age) }, 'singleton.lock.stale')
    return writeFresh(file, selfExe, version, bootId, windowMode, 'heartbeat-stale')
  }

  if (existing && existing.appId !== APP_ID) {
    log().info('锁文件 appId 不匹配 → 接管', { appId: existing.appId.slice(0, 40) }, 'singleton.lock.stale')
    return writeFresh(file, selfExe, version, bootId, windowMode, 'appid-mismatch')
  }

  return writeFresh(file, selfExe, version, bootId, windowMode, undefined)
}

function writeFresh(file: string, _selfExe: string, version: string, bootId: string, windowMode: string, staleReason?: string): LockAcquireResult {
  const nowIso = new Date().toISOString()
  const payload: LockPayload = {
    appId: APP_ID,
    pid: process.pid,
    startedAt: nowIso,
    heartbeatAt: nowIso,
    version,
    windowMode,
    bootId,
  }
  try {
    writePayloadAtomic(file, payload)
  } catch (e) {
    log().warn('锁文件写入失败（L3 降级）', { err: e instanceof Error ? e.message : String(e) }, 'singleton.lock.write-failed')
  }
  currentPayload = payload
  return staleReason
    ? { status: 'acquired-stale', payload, staleReason, otherPid: null }
    : { status: 'acquired', payload, otherPid: null }
}

/** 心跳：5s 更新 heartbeatAt（含 windowMode），保证崩溃可被下次启动识别为陈旧 */
export function startHeartbeat(getWindowMode: () => string): void {
  if (heartbeatTimer) return
  heartbeatTimer = setInterval(() => {
    if (!currentPayload) return
    const p: LockPayload = { ...currentPayload, heartbeatAt: new Date().toISOString(), windowMode: getWindowMode() }
    currentPayload = p
    try { writePayloadAtomic(appPaths().lockFile, p) } catch { /* 心跳失败不致命 */ }
  }, HEARTBEAT_INTERVAL_MS)
  heartbeatTimer.unref?.()
}

export function stopHeartbeat(): void {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
}

/** 正常退出时删除锁文件（仅当它仍属于本进程） */
export function releaseLockFile(): void {
  stopHeartbeat()
  const file = appPaths().lockFile
  const p = readPayload(file)
  if (p && p.pid !== process.pid) return
  try { if (existsSync(file)) unlinkSync(file) } catch { /* ignore */ }
}

export function readCurrentLock(): LockPayload | null {
  return readPayload(appPaths().lockFile)
}

export function lockFileExists(): boolean {
  return existsSync(appPaths().lockFile)
}
