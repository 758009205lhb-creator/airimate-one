/**
 * apps/desktop/src/main/settings-store.ts —— 设置持久化（原子写 + schema 校验）
 *
 * 纪律：所有设置都必须经 `AppSettingsSchema` 校验；非法值**不写盘**，回退到默认值并记日志。
 *       密钥**不在**这里（见 secrets-store.ts）。
 */
import { existsSync, mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AppSettings, SettingsPatch } from '@airimate/shared'
import { AppSettingsSchema, DEFAULT_SETTINGS } from '@airimate/shared'
import { storeDescriptor } from '@airimate/companion-kit'
import { migrateStore } from '@airimate/companion-kit'
import type { MigrationOutcome } from '@airimate/companion-kit'
import { appPaths } from './paths.js'
import { registerMigrationProbe } from './store-registry.js'
import { log } from './log.js'

let cache: AppSettings | null = null
let writeTimer: NodeJS.Timeout | null = null
/**
 * 上次读盘时的迁移结论。**不是摆设**：`kit:stores` / 隐私页 / 诊断靠它区分
 * "**没登记**"与"**登记了但没迁移**"。设置一旦升版却没人看得见，用户只会看到"设置被重置"。
 */
let lastMigration: MigrationOutcome | null = null

function atomicWrite(file: string, text: string): void {
  const tmp = `${file}.tmp`
  mkdirSync(dirname(file), { recursive: true })
  const fd = openSync(tmp, 'w')
  try {
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
}

export function loadSettings(): AppSettings {
  if (cache) return cache
  const file = appPaths().settingsFile
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
      /**
       * ★ 设置也要过迁移链。
       *
       * 为什么它单独处理（没走 `createJsonStore`）：设置必须**延迟落盘**（800ms 防抖，
       * 否则拖动窗口会把磁盘写爆），而 `createJsonStore` 是立即写。
       * 但"迁移能力"这件事不能因此缺席 —— 否则 `settings.json` 一旦升版，
       * 用户的全部设置（含向导进度、天气城市、静音时段）会回退默认值。
       */
      const desc = storeDescriptor('settings')
      let candidate: unknown = raw
      if (desc) {
        const out = migrateStore(raw, desc)
        lastMigration = out
        if (out.ok) {
          candidate = out.data
          if (out.steps.length > 0) {
            log().info('设置数据已迁移', {
              from: out.fromVersion ?? -1, to: out.toVersion, steps: out.steps.map(s => s.describe).join(' | ').slice(0, 200),
            }, 'settings.migrated')
          }
        } else if (!(out.reason === 'no-version-field' && desc.version === 1)) {
          log().warn('设置数据无法迁移 → 使用默认值（原文件保留）', {
            from: out.fromVersion ?? -1, to: out.toVersion, reason: out.reason, detail: out.detail.slice(0, 200),
          }, 'settings.migration-failed')
          cache = { ...DEFAULT_SETTINGS }
          return cache
        }
      }
      const parsed = AppSettingsSchema.safeParse(candidate)
      if (parsed.success) {
        cache = parsed.data
        return cache
      }
      log().warn('设置文件校验失败 → 使用默认值（原文件保留）', {
        issues: parsed.error.issues.slice(0, 5).map(i => `${i.path.join('.')}:${i.message}`).join(' | '),
      }, 'settings.invalid')
    }
  } catch (e) {
    log().warn('设置文件读取失败 → 使用默认值', { err: e instanceof Error ? e.message : String(e) }, 'settings.read-failed')
  }
  cache = { ...DEFAULT_SETTINGS }
  return cache
}

/** 立即落盘（用于退出前、窗口位置变更后等关键点） */
export function flushSettings(): void {
  if (!cache) return
  try {
    atomicWrite(appPaths().settingsFile, `${JSON.stringify(cache, null, 2)}\n`)
  } catch (e) {
    log().warn('设置写入失败', { err: e instanceof Error ? e.message : String(e) }, 'settings.write-failed')
  }
}

/** 合并补丁并**延迟**落盘（避免拖动窗口时频繁写盘） */
export function patchSettings(patch: SettingsPatch, opts: { immediate?: boolean } = {}): AppSettings {
  return mergeSettings(patch as Partial<AppSettings>, opts)
}

/**
 * 合并任意设置字段（含 `panelBounds` / `petPosition` 这类**非** IPC 可写字段）。
 * 主进程内部使用；renderer 只能通过 `SettingsPatchSchema` 白名单字段。
 */
export function mergeSettings(patch: Partial<AppSettings>, opts: { immediate?: boolean } = {}): AppSettings {
  const cur = loadSettings()
  const next = AppSettingsSchema.parse({ ...cur, ...patch })
  cache = next
  if (opts.immediate) {
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null }
    flushSettings()
  } else if (!writeTimer) {
    writeTimer = setTimeout(() => { writeTimer = null; flushSettings() }, 800)
    writeTimer.unref?.()
  }
  return next
}

/**
 * **仅供单测**：丢弃内存缓存（下一次 `loadSettings()` 重新读盘）。
 *
 * ⚠ 必须同时清掉待落盘的防抖计时器并**立即落盘** —— 否则"改完设置 → 清缓存 → 读回"
 *   这条最常用的单测路径会读到旧值（防抖还没触发），表现为"设置没保存"的假失败。
 */
export function __resetSettingsCacheForTest(): void {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null }
  if (cache) {
    try { atomicWrite(appPaths().settingsFile, `${JSON.stringify(cache, null, 2)}\n`) } catch { /* ignore */ }
  }
  cache = null
  lastMigration = null
}

/**
 * ★ 把设置接进**存储登记表**（本轮补的缺口）。
 *
 * 设置是"最该被看见"的存储之一（向导进度、天气城市、静音时段都在里面），
 * 却因为没走 `createJsonStore` 而在 `kit:stores` / 隐私页 / 诊断里**整个不出现**。
 * 与另外两个手写存储（`providers` / `secrets-meta`）同一处理。
 */
registerMigrationProbe('settings', 'settings', () => lastMigration)
