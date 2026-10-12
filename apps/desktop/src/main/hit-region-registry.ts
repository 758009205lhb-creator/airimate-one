/**
 * apps/desktop/src/main/hit-region-registry.ts —— 命中区域服务的单例注册表
 *
 * 为什么单独一个文件：避免 `diagnostics ↔ hit-region` 与 `ipc ↔ hit-region` 之间的循环 import。
 */
import { HitRegionService } from './hit-region.js'

const service = new HitRegionService()

export function hitRegions(): HitRegionService {
  return service
}

export function hitRegionState(): { ignoring: boolean, regions: number, ids: string[], kinds: string[] } {
  return service.state()
}
