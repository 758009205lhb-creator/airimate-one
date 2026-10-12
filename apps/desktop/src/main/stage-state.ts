/**
 * apps/desktop/src/main/stage-state.ts —— renderer 推送的舞台快照（只读缓存）
 *
 * 为什么不用 `webContents.executeJavaScript` 取数：
 *   ① 快照本来就是 renderer 自己维护的只读数据，主动推送更省 CPU；
 *   ② 诊断路径不引入任何"在页面里执行脚本"的能力，攻击面更小（Tech-Spec §7.1）。
 */
import type { StageSnapshot } from '@airimate/shared'

let latest: StageSnapshot | null = null
let latestAt = 0

export function setStageSnapshot(s: StageSnapshot): void {
  latest = s
  latestAt = Date.now()
}

export function stageSnapshot(): StageSnapshot | null {
  return latest
}

export function stageSnapshotAgeMs(): number | null {
  return latest ? Date.now() - latestAt : null
}
