/**
 * @airimate/companion-kit/store-descriptors —— 本应用全部存储的**声明式登记表**
 *
 * 为什么集中在一处（而不是各 store 自己写）：
 *   · `privacy:wipe` 要"删干净"、隐私页要"如实列出本机存了什么"、
 *     升级要"迁移而不丢数据" —— 三件事都需要**一份完整的存储清单**；
 *   · 分散在各模块里就必然漏（M1 已经踩过一次：`privacy:wipe` 漏了 session 的内存缓存）。
 *
 * 现在所有存储的 v1 都在 `migrations: []`，`version: 1`。
 * **加新版本时只在这里加一条迁移**，业务代码不用改结构。
 */
import type { StoreDescriptor } from './types.js'

/** 构造一个描述子（省掉重复字段，并强制写清"是否含个人数据"） */
function store(
  name: string,
  personal: boolean,
  description: string,
  version = 1,
  migrations: StoreDescriptor['migrations'] = [],
): StoreDescriptor {
  return { name, version, migrations, personal, description }
}

export const STORE_DESCRIPTORS: readonly StoreDescriptor[] = [
  // ── 个人数据（`privacy:wipe` 必删）
  store('session', true, '对话历史与人设（本地文件，不进日志）'),
  store('memory', true, '长期记忆条目与使用统计'),
  store('schedules', true, '日程（含重复规则与按天去重标记）'),
  store('reminders', true, '提醒与队列（含送达时间与重试次数）'),
  store('activity', true, '按天的活动统计（**只有计数与时长**，无按键内容）'),
  store('reflections', true, '每日反思结果与待确认项（不存对话正文）'),

  // ── 配置（默认保留；用户可选连配置一起删）
  store('settings', false, '应用设置与向导进度'),
  store('providers', false, '供应商配置（**不含密钥**）'),
  store('secrets-meta', false, '密钥元数据（指纹 + 长度，无任何可还原密钥的材料）'),
  store('quiet-hours', false, '静音时段与提醒阈值'),
  store('permissions', false, '三档权限与目录白名单、截图排除区'),
  store('engine-state', false, '主动引擎的调度状态（按天去重、冷却、最近决策原因码）'),
  store('knowledge-cache', false, '资讯与天气缓存（含来源与日期）'),
] as const

/** 按名字取描述子（不存在返回 null，**不抛** —— 调用方要能如实报"未登记"） */
export function storeDescriptor(name: string): StoreDescriptor | null {
  return STORE_DESCRIPTORS.find(d => d.name === name) ?? null
}

/** 必删清单（`privacy:wipe` 的输入） */
export function personalStoreNames(): string[] {
  return STORE_DESCRIPTORS.filter(d => d.personal).map(d => d.name)
}

/** 隐私页用的摘要（只给名字/是否个人数据/版本/说明，**不含内容**） */
export function storeCatalogDigest(): Array<{ name: string, personal: boolean, version: number, description: string, migrations: number }> {
  return STORE_DESCRIPTORS.map(d => ({
    name: d.name,
    personal: d.personal,
    version: d.version,
    description: d.description,
    migrations: d.migrations.length,
  }))
}
