/**
 * apps/desktop/src/main/legacy-state.ts —— 旧实例检测结果的进程内登记（供诊断读取）
 */
import type { LegacyScanResult } from '@airimate/shared'

let last: LegacyScanResult | null = null

export function setLastLegacyScan(r: LegacyScanResult): void {
  last = r
}

export function lastLegacyScan(): LegacyScanResult | null {
  return last
}
