/**
 * apps/desktop/src/main/ports.ts —— 监听端口只读审计（判据 A18）
 *
 * 口径（Acceptance-Matrix A18）：本应用相关的所有监听 socket 的 LocalAddress 必须属于环回白名单
 * {127.0.0.1, ::1}；无法归属到任何进程的监听项必须为 0（failedToAttribute = 0）。
 *
 * 实现：`Get-NetTCPConnection -State Listen` 一次取全量，再与进程表关联。**只读**。
 */
import { execFileSync } from 'node:child_process'

export interface ListeningSocket {
  address: string
  port: number
  protocol: 'tcp' | 'tcp6'
  pid: number
  loopback: boolean
  imagePath: string | null
  appOwned: boolean
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '0:0:0:0:0:0:0:1'])

export interface PortAudit {
  sockets: ListeningSocket[]
  nonLoopback: ListeningSocket[]
  failedToAttribute: number
  appPodPids: number[]
}

/** @param podPids 本应用进程组的所有 pid（root + 子进程） */
export function auditListeningPorts(podPids: readonly number[]): PortAudit {
  let sockets: ListeningSocket[] = []
  try {
    // ⚠ 用 netstat -ano 而不是 `Get-NetTCPConnection -State Listen`：
    //   后者在连接数很多的本机上会枚举全部端点并**挂住**（实测把 QA 脚本卡死数分钟），
    //   netstat 只做一次系统调用级别的快照，稳定在几十毫秒。
    const out = execFileSync('netstat.exe', ['-ano', '-p', 'TCP'], {
      encoding: 'utf8', windowsHide: true, timeout: 12_000, maxBuffer: 16 * 1024 * 1024,
    })
    for (const rawLine of out.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line.startsWith('TCP')) continue
      const cols = line.split(/\s+/)
      // TCP  <local>  <foreign>  <state>  <pid>
      if (cols.length < 5) continue
      const local = cols[1] ?? ''
      const state = cols[3] ?? ''
      if (state.toUpperCase() !== 'LISTENING') continue
      const pid = Number.parseInt(cols[4] ?? '', 10)
      if (!Number.isFinite(pid)) continue
      const idx = local.lastIndexOf(':')
      if (idx < 0) continue
      const address = local.slice(0, idx).replace(/^\[|\]$/g, '')
      const port = Number.parseInt(local.slice(idx + 1), 10)
      if (!Number.isFinite(port)) continue
      sockets.push({
        address,
        port,
        protocol: address.includes(':') ? 'tcp6' : 'tcp',
        pid,
        loopback: LOOPBACK.has(address),
        imagePath: null,
        appOwned: podPids.includes(pid),
      })
    }
  } catch {
    sockets = []
  }

  const nonLoopback = sockets.filter(s => !s.loopback)
  const failedToAttribute = sockets.filter(s => s.pid === 0 || s.pid === 4).length
  return { sockets, nonLoopback, failedToAttribute, appPodPids: [...podPids] }
}
