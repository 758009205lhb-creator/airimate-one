/**
 * apps/desktop/src/main/ps-runner.ts —— 调用 Windows PowerShell 的**统一底座**
 *
 * 为什么抽出来：`tts-engine.ts` 已经有一套经过实测的做法（`-EncodedCommand` 绕开三层转义、
 * 正文只走 stdin、超时后必定 settle）。M3 的语音识别（`System.Speech.Recognition`）
 * 与其它 Windows 集成要再用一次 —— 各写一份必然会漂移，而这里的每个细节
 * 都是踩过坑才定下来的（见下面注释）。
 *
 * 纪律（与 tts-engine 完全一致）：
 *   · 脚本是**常量**，经 `-EncodedCommand`（base64 UTF-16LE）传入；
 *   · **用户数据只走 stdin**，绝不进命令行（命令行对其他进程可见、会被日志采集）；
 *   · 超时后必须让调用方的 promise **必定 settle**（绝不悬挂）；
 *   · 不传 `shell: true`（避免 cmd.exe 二次解析）。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { log } from './log.js'

export function powershellExe(): string {
  return process.env.SystemRoot
    ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : 'powershell.exe'
}

export interface PsRunResult {
  stdout: string
  stderr: string
  exitCode: number | null
  /** 子进程收到了终止信号（被 kill 或超时） */
  killed: boolean
  /** 命中本侧超时 */
  timedOut: boolean
  /** spawn 本身失败（powershell 不存在等） */
  spawnFailed: boolean
}

/**
 * 把脚本编码成 `-EncodedCommand` 需要的 base64(UTF-16LE)。
 *
 * 为什么不用 `-Command "<脚本>"`：脚本里含引号与 `$_`，要穿过
 * Node 的 argv 转义 → CommandLineToArgvW 解析 → PowerShell 自己的 `-Command`
 * 再解析，**三层转义**；任何一层差异都会变成"静默产出错误结果"。
 * `-EncodedCommand` 只有一个不透明 token，彻底绕开转义问题。
 */
export function encodePsCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

export interface PsRunOptions {
  /** 超时（毫秒）。到点即 kill 并返回 `timedOut:true` */
  timeoutMs: number
  /** 日志事件前缀（如 `voice`）；只记长度与退出状态，不记内容 */
  tag?: string
  /** 句柄回调（用于外部提前取消，如 `stop()`） */
  onSpawn?: (child: ChildProcess) => void
  /** 单次 stdout 上限（防脚本失控刷屏打爆内存）；超出即截断并置 killed */
  maxStdout?: number
}

/**
 * 起一个 PowerShell，喂 stdin，收 stdout/stderr。
 *
 * ⚠ **正文只经 stdin**：命令行里只有 `-NoProfile -NonInteractive -EncodedCommand <常量>`。
 */
export function runPowerShell(script: string, stdin: string, o: PsRunOptions): Promise<PsRunResult> {
  const maxStdout = o.maxStdout ?? 2_000_000
  return new Promise<PsRunResult>((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(powershellExe(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePsCommand(script)], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        // 不传 shell：避免 cmd.exe 二次解析
      })
    } catch (e) {
      if (o.tag) log().warn('PowerShell 子进程启动失败', { tag: o.tag, err: e instanceof Error ? e.message : String(e) }, `${o.tag}.spawn.failed`)
      resolve({ stdout: '', stderr: '', exitCode: null, killed: false, timedOut: false, spawnFailed: true })
      return
    }

    o.onSpawn?.(child)

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let overflow = false
    let timer: NodeJS.Timeout | null = null

    const finish = (r: Omit<PsRunResult, 'stdout' | 'stderr'>): void => {
      if (settled) return
      settled = true
      if (timer) { clearTimeout(timer); timer = null }
      resolve({ ...r, stdout, stderr })
    }

    timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch { /* 已退出 */ }
    }, o.timeoutMs)
    timer.unref?.()

    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length > maxStdout) { overflow = true; try { child.kill() } catch { /* ignore */ } return }
      stdout += d.toString('utf8')
    })
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length > 32_000) return
      stderr += d.toString('utf8')
    })
    child.on('error', (e) => {
      if (o.tag) log().warn('PowerShell 子进程错误', { tag: o.tag, err: e.message }, `${o.tag}.child.error`)
      finish({ exitCode: null, killed: false, timedOut, spawnFailed: true })
    })
    child.on('close', (code, signal) => {
      finish({ exitCode: code, killed: signal !== null || timedOut || overflow, timedOut, spawnFailed: false })
    })

    // 喂 stdin 后**必须关掉**：脚本里的 `[Console]::In.ReadToEnd()` 会等到 EOF
    try {
      child.stdin?.end(stdin)
    } catch { /* 子进程已退出 */ }
  })
}

/** 从一段 stdout 里抽最后一个 JSON 对象（脚本用 `ConvertTo-Json` 输出） */
export function extractPsJson(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split(/\r?\n/).filter(l => l.trim().length > 0)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? '').trim()
    if (!line.startsWith('{') && !line.startsWith('[')) continue
    try {
      const v = JSON.parse(line) as unknown
      return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null
    } catch { /* 继续往前找 */ }
  }
  return null
}
