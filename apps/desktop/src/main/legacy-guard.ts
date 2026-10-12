/**
 * apps/desktop/src/main/legacy-guard.ts —— 启动前旧实例检测（PRD FR-3.1..3.3 / Tech-Spec §8.1）
 *
 * 硬纪律：
 *   ① **只读**。不结束、不挂起、不修改任何外部进程与注册表。
 *   ② 归属判定只允许依据：**完整映像路径、SHA256、项目标记（命令行/工作目录）、数字签名**。
 *      禁止仅凭进程名判定（同名进程可能是用户自己的东西）。
 *   ③ 命中"会显示角色或轮盘"的旧实例 ⇒ 返回 blocking=true，由上层弹阻断对话框；
 *      **绝不静默继续**，也**绝不自动杀进程**。
 *
 * 实现方式：一次 PowerShell 调用同时取
 *   - Win32_Process（PID / 映像路径 / 命令行 / 父 PID）
 *   - EnumWindows（可见顶层窗口 + 标题 + 归属 PID）
 * 并把结果以 JSON 返回，避免多次进程创建（每次 ~200ms）。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LegacyHit, LegacyScanResult } from '@airimate/shared'
import { log } from './log.js'

interface ProcRow {
  pid: number
  parentPid: number
  name: string
  imagePath: string | null
  commandLine: string | null
}

interface WinRow {
  pid: number
  title: string
  className: string
  visible: boolean
  rect: [number, number, number, number]
}

/** 旧工程根（用于路径前缀判定）；可由调用方覆盖以便测试 */
export const LEGACY_ROOTS = [
  'f:\\deepseek harness\\ai女友\\build\\',
  'f:\\deepseek harness\\ai女友\\src\\',
  'f:\\deepseek harness\\ai女友\\tools\\',
] as const

export const LEGACY_SCRIPT_MARKERS = [
  'start-airi-brain.ps1',
  'autostart-airi-brain.ps1',
  'install-shortcuts.ps1',
  'airi-brain.mjs',
  'mate-engine-airi-bridge.mjs',
  'llm-capture-proxy.mjs',
  'airi-host.mjs',
] as const

/**
 * 已实测的旧内核字节身份（E0 取证：全盘 5 份副本**逐字节相同**）。
 * 旧内核 PE 元数据为空且**未签名** ⇒ **哈希是唯一可信的归属令牌**（不能靠进程名）。
 * 来源：docs/evidence/E0-legacy-audit.md §2（SHA256, size 667648）。
 */
export const KNOWN_KERNEL_SHA256 = 'ADFF90320ABCF78236E79B87211A38552C846778D37527587C1B9622CB696783'
export const KNOWN_KERNEL_BYTES = 667_648

/** 旧宿主（`tools\host\airi-host.mjs`）的锁文件：E0 实测它是整条旧链的**根**，且**没有窗口**。 */
export const LEGACY_HOST_LOCK = join(process.env.LOCALAPPDATA ?? '', 'AiriMate', 'host.lock.json')
/** 旧宿主的固定控制端口（E0 实测常驻监听项之一；61966 为按次随机端口，故只比固定项）。 */
export const LEGACY_FIXED_PORTS = [18190, 18191, 6199] as const

const PS_ENUM = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$src = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinEnum {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static List<string> List() {
    var res = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint pid; GetWindowThreadProcessId(h, out pid);
      var t = new StringBuilder(512); GetWindowTextW(h, t, 512);
      var c = new StringBuilder(256); GetClassNameW(h, c, 256);
      RECT r; GetWindowRect(h, out r);
      res.Add(pid + "|" + (IsWindowVisible(h) ? "1" : "0") + "|" + r.L + "," + r.T + "," + r.R + "," + r.B + "|" + c.ToString() + "|" + t.ToString().Replace("|","/"));
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
'@
Add-Type -TypeDefinition $src -Language CSharp | Out-Null
$procs = Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid=$_.ProcessId; ppid=$_.ParentProcessId; name=$_.Name; path=$_.ExecutablePath; cmd=$_.CommandLine } }
$wins = [WinEnum]::List() | ForEach-Object {
  $p = $_ -split '\|', 5
  [pscustomobject]@{ pid=[int]$p[0]; visible=($p[1] -eq '1'); rect=$p[2]; cls=$p[3]; title=$p[4] }
}
[pscustomobject]@{ processes=$procs; windows=$wins } | ConvertTo-Json -Depth 4 -Compress
`

export interface RawEnumeration {
  processes: ProcRow[]
  windows: WinRow[]
}

/** 只读枚举（一次调用拿全量），失败返回空集并在诊断里标注 */
export function enumerateProcessesAndWindows(): RawEnumeration {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_ENUM,
    ], { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 })
    const trimmed = out.trim()
    if (!trimmed) return { processes: [], windows: [] }
    const parsed = JSON.parse(trimmed) as { processes?: unknown, windows?: unknown }
    const processes: ProcRow[] = Array.isArray(parsed.processes)
      ? (parsed.processes as Array<Record<string, unknown>>).map(p => ({
        pid: Number(p.pid ?? 0),
        parentPid: Number(p.ppid ?? 0),
        name: String(p.name ?? ''),
        imagePath: p.path ? String(p.path) : null,
        commandLine: p.cmd ? String(p.cmd) : null,
      })).filter(p => Number.isInteger(p.pid) && p.pid > 0)
      : []
    const windows: WinRow[] = Array.isArray(parsed.windows)
      ? (parsed.windows as Array<Record<string, unknown>>).map(w => {
        const rect = String(w.rect ?? '0,0,0,0').split(',').map(Number)
        return {
          pid: Number(w.pid ?? 0),
          title: String(w.title ?? ''),
          className: String(w.cls ?? ''),
          visible: w.visible === true,
          rect: [rect[0] ?? 0, rect[1] ?? 0, rect[2] ?? 0, rect[3] ?? 0] as [number, number, number, number],
        }
      }).filter(w => Number.isInteger(w.pid) && w.pid > 0)
      : []
    return { processes, windows }
  } catch (e) {
    log().warn('进程/窗口枚举失败（旧实例检测降级为"未检查"）', { err: e instanceof Error ? e.message : String(e) }, 'legacy.enum.failed')
    return { processes: [], windows: [] }
  }
}

function lower(s: string | null | undefined): string {
  return (s ?? '').toLowerCase()
}

function underLegacyRoot(p: string | null): boolean {
  const l = lower(p)
  return LEGACY_ROOTS.some(r => l.startsWith(r))
}

function mentionsLegacyScript(p: string | null): string | null {
  const l = lower(p)
  for (const m of LEGACY_SCRIPT_MARKERS) if (l.includes(m)) return m
  return null
}

function visibleWindowOf(windows: WinRow[], pid: number): WinRow | null {
  for (const w of windows) if (w.pid === pid && w.visible && w.rect[2] > w.rect[0] && w.rect[3] > w.rect[1]) return w
  return null
}

/** 对**已经**满足路径/标记谓词的候选做哈希确认（只对候选算，避免全盘哈希） */
function hashMatches(path: string, want: string): boolean | null {
  try {
    const h = createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase()
    return h === want
  } catch {
    return null
  }
}

export interface LegacyHostProbe {
  lockFileExists: boolean
  lockPid: number | null
  lockPidAlive: boolean
  fixedPortsInUse: number[]
}

/**
 * 旧宿主探测：E0 取证结论 —— **主要信号不是窗口**。
 * `tools\host\airi-host.mjs` 无窗口无 UI，却是整条旧链的根（内核与 airi.exe 的父进程，
 * 并持有 127.0.0.1:18190/18191/6199）。只看窗口会误判为"无旧实例"。
 */
export function probeLegacyHost(procs?: ProcRow[]): LegacyHostProbe {
  let lockPid: number | null = null
  const lockFileExists = existsSync(LEGACY_HOST_LOCK)
  if (lockFileExists) {
    try {
      const j = JSON.parse(readFileSync(LEGACY_HOST_LOCK, 'utf8')) as { pid?: number }
      lockPid = typeof j.pid === 'number' ? j.pid : null
    } catch { lockPid = null }
  }
  let lockPidAlive = false
  if (lockPid && lockPid > 0) {
    const list = procs ?? []
    if (list.length) lockPidAlive = list.some(p => p.pid === lockPid)
    else {
      try {
        const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `if (Get-Process -Id ${lockPid} -ErrorAction SilentlyContinue) { 'ALIVE' } else { 'GONE' }`], { encoding: 'utf8', windowsHide: true, timeout: 8_000 })
        lockPidAlive = out.includes('ALIVE')
      } catch { lockPidAlive = false }
    }
  }
  const fixedPortsInUse: number[] = []
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { @(${LEGACY_FIXED_PORTS.join(',')}) -contains $_.LocalPort } | Select-Object -ExpandProperty LocalPort -Unique) -join ','`], { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
    for (const s of out.trim().split(',')) {
      const n = Number.parseInt(s, 10)
      if (Number.isFinite(n) && n > 0) fixedPortsInUse.push(n)
    }
  } catch { /* 端口探测失败不影响主判定 */ }
  return { lockFileExists, lockPid, lockPidAlive, fixedPortsInUse }
}

/**
 * 扫描旧实例。**纯只读**。
 *
 * 判定矩阵（Tech-Spec §8.1）：
 *   - mate-engine-kernel：进程名 mateenginex.exe 且（映像路径在旧工程前缀内 或 命令行含 MateEngineX_Data）
 *   - legacy-pet：electron.exe 且 命令行含 build\pet\app\main.mjs
 *   - legacy-brain / legacy-bridge：命令行命中旧脚本标记
 *   - legacy-airi-combo：airi.exe 与旧桥**同时**存在
 * blocking 仅对"会显示角色或轮盘"的类别置真。
 */
export function scanLegacyInstances(raw?: RawEnumeration): LegacyScanResult {
  const { processes, windows } = raw ?? enumerateProcessesAndWindows()
  const hits: LegacyHit[] = []

  for (const p of processes) {
    const name = lower(p.name)
    const cmd = lower(p.commandLine)
    const img = p.imagePath

    if (name === 'mateenginex.exe') {
      const byPath = underLegacyRoot(img)
      const byMarker = cmd.includes('mateenginex_data')
      if (byPath || byMarker) {
        // 归属再确认：优先哈希（E0 实测 5 份副本逐字节相同；PE 元数据为空且未签名）
        const hashOk = img ? hashMatches(img, KNOWN_KERNEL_SHA256) : null
        const w = visibleWindowOf(windows, p.pid)
        hits.push({
          kind: 'mate-engine-kernel',
          pid: p.pid,
          imagePath: img ?? '<unknown>',
          commandLine: (p.commandLine ?? '').slice(0, 1200),
          hasVisibleWindow: w !== null,
          windowTitle: w?.title ?? null,
          reason: [
            byPath ? '映像路径位于旧工程前缀内' : '命令行包含 MateEngineX_Data 标记',
            hashOk === true ? 'SHA256 命中已知旧内核' : (hashOk === false ? 'SHA256 与已知旧内核不同（允许继续，但需人工确认）' : '哈希不可读'),
          ].join('；'),
          blocking: hashOk !== false,
        })
      } else {
        log().info('发现同名进程但不满足归属谓词 ⇒ 视为无关进程，不做任何动作', { pid: p.pid, imagePath: img ?? '' }, 'legacy.ignore.same-name')
      }
      continue
    }

    if (name === 'electron.exe' && (cmd.includes('build\\pet\\app\\main.mjs') || cmd.includes('build/pet/app/main.mjs') || cmd.includes('build\\pet\\app') || cmd.includes('build/pet/app'))) {
      const w = visibleWindowOf(windows, p.pid)
      hits.push({
        kind: 'legacy-pet',
        pid: p.pid,
        imagePath: img ?? '<unknown>',
        commandLine: (p.commandLine ?? '').slice(0, 1200),
        hasVisibleWindow: w !== null,
        windowTitle: w?.title ?? null,
        reason: 'Electron 进程命令行指向旧 build\\pet\\app 入口',
        blocking: true,
      })
      continue
    }

    const marker = mentionsLegacyScript(p.commandLine)
    if (marker) {
      const isBrain = marker.includes('brain')
      hits.push({
        kind: isBrain ? 'legacy-brain' : 'legacy-bridge',
        pid: p.pid,
        imagePath: img ?? '<unknown>',
        commandLine: (p.commandLine ?? '').slice(0, 1200),
        hasVisibleWindow: visibleWindowOf(windows, p.pid) !== null,
        windowTitle: visibleWindowOf(windows, p.pid)?.title ?? null,
        reason: `命令行命中旧入口标记：${marker}`,
        blocking: false,
      })
    }
  }

  // 旧宿主（无窗口、但是整条旧链的根）——E0 取证的"主信号不是窗口"结论
  const host = probeLegacyHost(processes)
  if (host.lockPidAlive && host.lockPid) {
    const row = processes.find(p => p.pid === host.lockPid)
    hits.push({
      kind: 'legacy-brain',
      pid: host.lockPid,
      imagePath: row?.imagePath ?? '<unknown>',
      commandLine: (row?.commandLine ?? '').slice(0, 1200),
      hasVisibleWindow: visibleWindowOf(windows, host.lockPid) !== null,
      windowTitle: visibleWindowOf(windows, host.lockPid)?.title ?? null,
      reason: `旧宿主锁文件存活（${LEGACY_HOST_LOCK}，pid=${host.lockPid}）；固定控制端口占用：${host.fixedPortsInUse.join(',') || '无'}`,
      // 旧宿主本身不显示角色/轮盘 ⇒ 不阻断，但必须显著告知
      blocking: false,
    })
  } else if (host.fixedPortsInUse.length > 0) {
    hits.push({
      kind: 'legacy-brain',
      pid: 0,
      imagePath: '<unknown>',
      hasVisibleWindow: false,
      windowTitle: null,
      reason: `旧宿主固定控制端口被占用（${host.fixedPortsInUse.join(',')}）但锁文件 pid 不存活 —— 可能是残留 socket 或另一份旧实例`,
      blocking: false,
    })
  }

  // 旧 AIRI + 独立桥组合
  const airi = processes.find(p => lower(p.name) === 'airi.exe')
  const bridge = hits.find(h => h.kind === 'legacy-bridge')
  if (airi && bridge) {
    hits.push({
      kind: 'legacy-airi-combo',
      pid: airi.pid,
      imagePath: airi.imagePath ?? '<unknown>',
      commandLine: (airi.commandLine ?? '').slice(0, 1200),
      hasVisibleWindow: visibleWindowOf(windows, airi.pid) !== null,
      windowTitle: visibleWindowOf(windows, airi.pid)?.title ?? null,
      reason: `AIRI 进程与旧桥进程（pid ${bridge.pid}）同时存在，属已废弃的"双窗口"组合`,
      blocking: false,
    })
  }

  const blocked = hits.some(h => h.blocking)
  if (hits.length) {
    log().warn('检测到旧实例', { count: hits.length, blocking: blocked, kinds: hits.map(h => h.kind).join(',') }, 'legacy.hits')
  } else {
    log().info('未检测到旧实例', {}, 'legacy.clean')
  }
  return { checkedAt: Date.now(), hits, blocked }
}
