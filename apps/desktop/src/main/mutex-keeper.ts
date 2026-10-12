/**
 * apps/desktop/src/main/mutex-keeper.ts —— L2 单实例保护：Windows 命名互斥量
 *
 * 目标：`Local\AiriMateOne.Singleton`
 *
 * 为什么用**子进程持有**而不是在主进程里开线程：
 *   互斥量归创建它的线程所有；主进程一旦崩溃/被强杀，线程结束即释放，锁不会悬挂。
 *   把持有者放进一个纯守卫子进程（无窗口、无其它职责），语义最干净，也不计入"可见窗口"。
 *
 * 实现路径（按优先级）：
 *   ① dotnet 构建的小工具 `AiriMateOne.MutexKeeper`（native/MutexKeeper），若已构建则直接用；
 *   ② 未构建 ⇒ 用 `powershell.exe`（Windows PowerShell 5.1，**非 PS7**）内联 C# 编译并持有；
 *      （PS 5.1 默认 FullLanguage，`Add-Type` 可用；本机实测 5.1.28000.2952 可用。）
 *   ③ 两条都不可用 ⇒ 返回 status='unavailable'，由上层降级到 L1+L3 并**在诊断里显式标注**（不假装成功）。
 *
 * 子进程协议（简单文本行）：
 *   stdout 首行：`HELD <pid>` 或 `ALREADY_HELD` 或 `ERROR <msg>`
 *   父进程关闭 stdin ⇒ 子进程释放互斥量并退出
 */
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { SINGLETON_MUTEX } from '@airimate/shared'
import { appPaths } from './paths.js'
import { log } from './log.js'

export interface MutexResult {
  status: 'held' | 'already-held' | 'unavailable'
  holderPid: number | null
  method: 'dotnet' | 'powershell' | 'none'
  error?: string
}

let child: ChildProcessWithoutNullStreams | null = null

const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Threading;
public static class MutexKeeper {
  public static int Main(string[] args) {
    bool createdNew;
    Mutex m = new Mutex(true, args[0], out createdNew);
    if (!createdNew) { Console.Out.WriteLine("ALREADY_HELD"); Console.Out.Flush(); return 3; }
    Console.Out.WriteLine("HELD " + System.Diagnostics.Process.GetCurrentProcess().Id);
    Console.Out.Flush();
    try { while (Console.In.ReadLine() != null) { } } catch { }
    try { m.ReleaseMutex(); } catch { }
    return 0;
  }
}
'@
Add-Type -TypeDefinition $src -Language CSharp | Out-Null
[MutexKeeper]::Main(@($env:AIRIMATE_MUTEX_NAME)) | Out-Null
`

function dotnetExe(): string | null {
  const p = join(appPaths().workspaceRoot, 'apps', 'desktop', 'native', 'MutexKeeper', 'bin', 'Release', 'net8.0', 'AiriMateOne.MutexKeeper.exe')
  return existsSync(p) ? p : null
}

function powershellExe(): string | null {
  const candidates = [
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

function firstLineWithin(stream: NodeJS.ReadableStream, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => { cleanup(); reject(new Error('mutex-keeper 首行超时')) }, timeoutMs)
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl >= 0) { const line = buf.slice(0, nl).trim(); cleanup(); resolve(line) }
    }
    const onErr = (): void => { /* 忽略 stderr 噪声，超时兜底 */ }
    const onExit = (code: number | null): void => { cleanup(); reject(new Error(`mutex-keeper 提前退出 code=${code ?? 'null'}`)) }
    function cleanup(): void {
      clearTimeout(timer)
      stream.off('data', onData)
      stream.off('error', onErr)
      stream.off('end', onExit as unknown as () => void)
    }
    stream.on('data', onData)
    stream.on('error', onErr)
    stream.on('end', onExit as unknown as () => void)
  })
}

/**
 * 尝试获取命名互斥量。**必须在创建窗口之前调用。**
 * 成功时返回持有者信息，并在本进程生命周期内保持子进程存活。
 */
export async function acquireNamedMutex(): Promise<MutexResult> {
  const dn = dotnetExe()
  const ps = powershellExe()

  const trySpawn = async (method: 'dotnet' | 'powershell'): Promise<MutexResult> => {
    const args = method === 'dotnet'
      ? [SINGLETON_MUTEX]
      : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT]
    const env = { ...process.env, AIRIMATE_MUTEX_NAME: SINGLETON_MUTEX }
    let c: ChildProcessWithoutNullStreams
    try {
      c = spawn(method === 'dotnet' ? (dn as string) : (ps as string), args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams
    } catch (e) {
      return { status: 'unavailable', holderPid: null, method: 'none', error: e instanceof Error ? e.message : String(e) }
    }
    try {
      const line = await firstLineWithin(c.stdout, 20_000)
      if (line.startsWith('HELD')) {
        child = c
        const pid = Number.parseInt(line.split(/\s+/)[1] ?? '', 10)
        return { status: 'held', holderPid: Number.isFinite(pid) ? pid : c.pid ?? null, method }
      }
      if (line.startsWith('ALREADY_HELD')) {
        try { c.stdin.end() } catch { /* ignore */ }
        return { status: 'already-held', holderPid: null, method }
      }
      try { c.stdin.end() } catch { /* ignore */ }
      return { status: 'unavailable', holderPid: null, method: 'none', error: `unexpected: ${line.slice(0, 120)}` }
    } catch (e) {
      try { c.kill() } catch { /* ignore */ }
      return { status: 'unavailable', holderPid: null, method: 'none', error: e instanceof Error ? e.message : String(e) }
    }
  }

  if (dn) {
    const r = await trySpawn('dotnet')
    if (r.status !== 'unavailable') return r
    log().warn('dotnet mutex keeper 不可用，回退 powershell 方式', { error: r.error ?? '' }, 'singleton.mutex.fallback')
  }
  if (ps) {
    const r = await trySpawn('powershell')
    if (r.status === 'already-held') {
      /**
       * ⚠ 关键判定：`ALREADY_HELD` **不足以**断定"已有实例在运行"。
       *
       * 实测踩到：上一次运行被强杀（或 QA 用 Stop-Process 收尾）时，Electron 主进程死了，
       * 但它 spawn 的 keeper 子进程会存活并继续持有互斥量 ⇒ 之后每次启动都被误判为
       * "第二实例"并直接退出（表现为"应用起不来"，且锁文件显示陈旧，两层结论矛盾）。
       *
       * 因此这里再做一次**归属判定**：找出所有 MutexKeeper 进程，只有当其中至少一个的
       * 父进程仍是**活着的 Electron** 时，才承认"已有实例"；否则清理孤儿 keeper 并重试一次。
       */
      const orphans = findMutexKeepers()
      /**
       * 只有"父进程仍是活着的 Electron"才承认这是**活跃实例**的 keeper；
       * 其它情况（父进程消失，或被 Windows reparent 到 node.exe 等）都按孤儿处理并清理。
       */
      const liveOwners = orphans.filter(k => (k.parentName ?? '').toLowerCase() === 'electron')
      if (liveOwners.length > 0) {
        log().info('命名互斥量由活着的实例持有（确认为已有实例）', { holders: liveOwners.map(k => k.pid).join(',') }, 'singleton.mutex.live-holder')
        return { status: 'already-held', holderPid: liveOwners[0]?.pid ?? null, method: 'powershell' }
      }
      if (orphans.length > 0) {
        const killed = killOrphanMutexKeepers(orphans)
        log().warn('发现孤儿互斥量持有者并已清理，重试获取', { orphans: orphans.map(k => k.pid).join(','), killed }, 'singleton.mutex.orphan-cleared')
        const retry = await trySpawn('powershell')
        if (retry.status !== 'unavailable') return retry
        return { status: 'unavailable', holderPid: null, method: 'none', error: retry.error }
      }
      log().warn('互斥量被持有但找不到持有者进程（可能刚退出）→ 判定为已有实例', {}, 'singleton.mutex.holder-unknown')
      return r
    }
    if (r.status !== 'unavailable') return r
    log().warn('powershell mutex keeper 也不可用：单实例降级为 L1+L3', { error: r.error ?? '' }, 'singleton.mutex.unavailable')
    return { status: 'unavailable', holderPid: null, method: 'none', error: r.error }
  }
  log().warn('找不到 powershell.exe：单实例降级为 L1+L3', {}, 'singleton.mutex.unavailable')
  return { status: 'unavailable', holderPid: null, method: 'none', error: 'no-shell' }
}

/** 退出时释放（关掉 stdin 即可让子进程释放并退出） */
export function releaseNamedMutex(): void {
  if (!child) return
  try { child.stdin.end() } catch { /* ignore */ }
  const c = child
  child = null
  setTimeout(() => { try { c.kill() } catch { /* ignore */ } }, 1500)
}

// ───────────────────────────────────────────────────────── 孤儿持有者判定

export interface MutexKeeperProc {
  pid: number
  parentPid: number
  parentAlive: boolean
  parentName: string | null
}

/**
 * 找出所有 MutexKeeper 进程（我们自己的守卫子进程）。
 * 只按**命令行标记**匹配（不按进程名），并带出父进程是否存活。
 */
export function findMutexKeepers(): MutexKeeperProc[] {
  const ps = powershellExe()
  if (!ps) return []
  try {
    const script = `
$ErrorActionPreference='SilentlyContinue'
$alive = @{}
Get-Process | ForEach-Object { $alive[[int]$_.Id] = $_.ProcessName }
Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and ($_.CommandLine -like '*AIRIMATE_MUTEX_NAME*' -or $_.CommandLine -like '*MutexKeeper*')
} | ForEach-Object {
  $ppid = [int]$_.ParentProcessId
  [pscustomobject]@{ pid=[int]$_.ProcessId; ppid=$ppid; parentAlive=$alive.ContainsKey($ppid); parentName=$alive[$ppid] }
} | ConvertTo-Json -Compress
`
    const out = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8', windowsHide: true, timeout: 20_000,
    }).trim()
    if (!out) return []
    const parsed = JSON.parse(out) as unknown
    const list = Array.isArray(parsed) ? parsed : [parsed]
    return (list as Array<Record<string, unknown>>).map(x => ({
      pid: Number(x.pid ?? 0),
      parentPid: Number(x.ppid ?? 0),
      parentAlive: x.parentAlive === true,
      parentName: x.parentName ? String(x.parentName) : null,
    })).filter(x => Number.isInteger(x.pid) && x.pid > 0 && x.pid !== process.pid)
  } catch {
    return []
  }
}

/**
 * 清理**孤儿** keeper（父进程已消失者）。
 * 安全边界：只结束"命令行带我们的标记 且 **父进程不是 electron**"的进程。
 *   为什么要判父进程名而不只是"父进程是否存活"（实测教训）：
 *   在 Windows 上父进程死后子进程会被重新挂到别的进程上（本机实测：
 *   被 reparent 到 `node.exe`）⇒ "父进程存活"不足以证明 keeper 仍然有主。
 *   而我们的 keeper **只可能**由 Electron 主进程创建，父进程不是 electron 就是孤儿。
 */
export function killOrphanMutexKeepers(list: MutexKeeperProc[]): number {
  const ps = powershellExe()
  if (!ps) return 0
  let killed = 0
  for (const k of list) {
    const parentIsElectron = (k.parentName ?? '').toLowerCase() === 'electron'
    if (parentIsElectron) continue
    try {
      execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Id ${k.pid} -Force -ErrorAction SilentlyContinue`], {
        encoding: 'utf8', windowsHide: true, timeout: 10_000,
      })
      killed++
    } catch { /* 单个失败不影响整体 */ }
  }
  return killed
}
