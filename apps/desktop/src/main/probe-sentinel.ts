/**
 * apps/desktop/src/main/probe-sentinel.ts —— 探针与外部的**桌面截图握手**
 *
 * 为什么需要它（本项目已经用同一套办法解决过一次）：
 *   验收要求的是**真实桌面全屏截图**（能看出"这是两个独立窗口"），
 *   而桌面截图只能由进程外的 PowerShell 用 `CopyFromScreen` 做 ——
 *   但外面的脚本不知道"气泡现在正显示着""chat 窗口刚被拖过"这种**时刻**。
 *   于是用一对哨兵文件把时间点交给它：
 *
 *     探针写 `<前缀>-<label>.ready`  →  外部截图并写 `<前缀>-<label>.done`  →  探针继续
 *
 * 两条纪律：
 *   ① **没有观察者也不会卡死**：超时（默认 12s）后照常继续，并把
 *      `waitedMs / observed` 如实记进探针结果 —— 不许把"没人截图"静默成"截过了"；
 *   ② 哨兵文件只用于握手，外部脚本收尾时会删掉它们（不与截图混在一个目录里）。
 */
import { existsSync, writeFileSync } from 'node:fs'

export interface SentinelReading {
  label: string
  readyPath: string
  waitedMs: number
  /** true = 外部观察者确实打了 done（截图**可能**真的发生了） */
  observed: boolean
  /** `--probe-shot` 没给前缀时为 true：这一项是**未执行**，不是通过 */
  skipped: boolean
}

/**
 * 写 ready 并等 done。
 *
 * @param prefix `--probe-shot` 给的路径前缀（不含 label 与扩展名）
 * @param label  这次截图的场景名（外部脚本按它匹配必需场景）
 * @param timeoutMs 等待上限（默认 12s）
 */
export async function sentinel(
  prefix: string | null,
  label: string,
  timeoutMs = 12_000,
): Promise<SentinelReading> {
  if (!prefix) {
    return { label, readyPath: '', waitedMs: 0, observed: false, skipped: true }
  }
  const readyPath = `${prefix}-${label}.ready`
  const donePath = `${prefix}-${label}.done`
  try {
    writeFileSync(readyPath, label, 'utf8')
  } catch {
    // 写不了 ready ⇒ 外部永远等不到；如实记 skipped，绝不假装截过
    return { label, readyPath, waitedMs: 0, observed: false, skipped: true }
  }
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (existsSync(donePath)) {
      return { label, readyPath, waitedMs: Date.now() - t0, observed: true, skipped: false }
    }
    await new Promise(r => setTimeout(r, 120))
  }
  return { label, readyPath, waitedMs: Date.now() - t0, observed: false, skipped: false }
}
